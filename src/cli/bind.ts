// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * `relay bind` — record THIS window's identity binding (ADR-0036 S1).
 *
 * The hook pipes its SessionStart (or SessionEnd, with --end) payload to this
 * verb on stdin. S1 RECORDS and LISTS: it changes no auth and performs NO
 * automatic rebind — that is S3-lite (rows 1/4/11).
 *
 * DB-DIRECT, NEVER THROUGH THE DAEMON (ADR-0036 §2.2): a daemon that is slow to
 * start after a reboot must not be able to cause a missed bind.
 *
 * RULING 1 (victra, 2026-09-16): open a RAW handle with busy_timeout only — NO
 * applySchemaSetup — and PROBE the schema first. A schema migration and a record
 * purge must never ride a path that fires dozens of times a day under a 10s hook
 * timeout, beside old code mid-rollout. S3-lite (architect ruling 1): the probe
 * reads the RECORDED schema version against MIN_BIND_SCHEMA_VERSION..
 * MAX_SUPPORTED_SCHEMA (probeBindSchema), not table existence, and refuses
 * loudly in one of three states that each name their remedy — never a silent skip.
 *
 * REFUSE RATHER THAN GUESS (§8a amendment d): missing/malformed stdin, no
 * conversation id, or an anchor that cannot be resolved all write NOTHING and
 * exit non-zero. A binding on the wrong window is worse than no binding, because
 * the fleet list would then point Maxime at the wrong terminal.
 *
 * ANNOUNCE (victra, 2026-09-16 04:04Z): a window that becomes X without saying so
 * is the same silence-as-health failure this arc exists to end. Every bind prints
 * what it bound, to which conversation, and on what evidence.
 *
 * STREAM DISCIPLINE (matches the other verbs): stdout carries the announcement
 * only; usage, refusals and every error go to stderr; a refusal exits non-zero
 * with nothing on stdout, so a capture fails loudly.
 */
import fs from "fs";

interface Args {
  end: boolean;
  json: boolean;
  dbPath: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { end: false, json: false, dbPath: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--end") args.end = true;
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--db-path") {
      const v = argv[++i];
      if (!v) throw new Error("--db-path requires a path");
      args.dbPath = v;
    } else throw new Error(`unknown option: ${a}`);
  }
  return args;
}

function usage(requested = false): void {
  const text =
    "Usage: relay bind [--end] [--json] [--db-path P]\n\n" +
    "Records THIS window's identity binding from the hook payload on stdin.\n" +
    "Reads the payload's session_id (the conversation), the window anchor\n" +
    "(CLAUDE_PID cross-checked against the process walk), and the cwd.\n\n" +
    "  --end        Record SessionEnd's reason verbatim on the current binding.\n" +
    "  --json       Emit the result as JSON instead of a sentence.\n" +
    "  --db-path P  Operate on the DB at P (default: $RELAY_DB_PATH or the\n" +
    "               active instance's DB).\n\n" +
    "Exit: 0 = recorded · 1 = BIND_FAILED (nothing written) · 2 = usage error.\n";
  if (requested) process.stdout.write(text);
  else process.stderr.write(text);
}

/** BIND_FAILED is the one refusal vocabulary; the hook copies it into its verdict. */
function bindFailed(reason: string): number {
  process.stderr.write(`BIND_FAILED: ${reason}\n`);
  return 1;
}

/**
 * Read the hook payload. Claude Code writes it and closes the pipe, so this is
 * instant in practice; the idle deadline only stops a manual TTY run from
 * hanging. A TTY with no redirect is treated as no payload at all.
 */
function readStdin(idleMs = 2000, cap = 16 * 1024 * 1024): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let buf = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(buf);
    };
    let timer = setTimeout(finish, idleMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > cap) {
        buf = buf.slice(0, cap);
        finish();
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(finish, idleMs);
    });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

export async function run(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`relay bind: ${err instanceof Error ? err.message : String(err)}\n\n`);
    usage();
    return 2;
  }
  if (args.help) {
    usage(true);
    return 0;
  }

  // --- the payload ---------------------------------------------------------
  const raw = (await readStdin()).trim();
  if (!raw) {
    return bindFailed("no hook payload on stdin (expected the SessionStart/SessionEnd JSON)");
  }
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a JSON object");
    payload = parsed as Record<string, unknown>;
  } catch (err) {
    return bindFailed(
      `the hook payload is not valid JSON (${err instanceof Error ? err.message : String(err)}) — refusing to guess`,
    );
  }

  const conversationId = typeof payload.session_id === "string" ? payload.session_id.trim() : "";
  if (!conversationId) {
    return bindFailed("the payload carries no session_id — refusing to record a binding with a guessed conversation id");
  }
  const source = typeof payload.source === "string" ? payload.source : null;
  const stdinCwd = typeof payload.cwd === "string" ? payload.cwd : null;
  const endReason = typeof payload.reason === "string" ? payload.reason : null;

  // --- the window anchor ---------------------------------------------------
  const { detectAgentProcess, getOwnHostId } = await import("../liveness.js");
  const { resolveWindowAnchor, resolveBindCwd, boundViaForSource, resolveAgentName } = await import("../binding.js");

  const rawClaudePid = Number.parseInt(process.env.CLAUDE_PID ?? "", 10);
  const claudePid = Number.isInteger(rawClaudePid) && rawClaudePid > 0 ? rawClaudePid : null;
  const anchorRes = resolveWindowAnchor({ claudePid, detected: detectAgentProcess() });
  if (!anchorRes.ok) return bindFailed(anchorRes.reason);

  const hostId = getOwnHostId();
  if (!hostId) {
    return bindFailed("this host has no resolvable machine id, so the anchor could not be scoped to a host");
  }

  const agentName = resolveAgentName(process.env.RELAY_AGENT_NAME);
  const cwd = resolveBindCwd({
    projectDir: process.env.CLAUDE_PROJECT_DIR,
    stdinCwd,
    processCwd: process.cwd(),
  });

  // --- the DB: raw handle, busy_timeout only, NO applySchemaSetup ----------
  if (args.dbPath) process.env.RELAY_DB_PATH = args.dbPath;
  if (!process.env.RELAY_DB_PATH) {
    try {
      const { resolveInstanceDbPath } = await import("../instance.js");
      process.env.RELAY_DB_PATH = resolveInstanceDbPath();
    } catch (err) {
      return bindFailed(`could not resolve the relay DB path: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const dbPath = process.env.RELAY_DB_PATH as string;
  if (!fs.existsSync(dbPath)) {
    return bindFailed(`no relay DB at ${dbPath} — nothing to record into (the daemon has never initialised it)`);
  }

  const anchor = { hostId, windowPid: anchorRes.anchor.pid, windowPidStart: anchorRes.anchor.startedAt };
  let db: import("../sqlite-compat.js").CompatDatabase;
  try {
    const Better = (await import("better-sqlite3")).default;
    db = new Better(dbPath, { fileMustExist: true }) as unknown as import("../sqlite-compat.js").CompatDatabase;
    // MODEST, and deliberately not 5000 (audit, codex-5-5). This value governs
    // the statements OUTSIDE the writer's retry loop — the schema probe and
    // `--end`. Those are precisely the ones that CAN sit in SQLite's own busy
    // wait, because each runs in its own autocommit transaction and so reaches
    // its write without a preceding read in the same transaction. A fixed 5s here
    // was a second uncounted clock against a MEASURED 10s SessionStart timeout.
    //
    // NOT a "six retries x 5s" ceiling. That arithmetic was sound but MISLOCATED:
    // upsertAgentBinding's in-loop attempts read first, so they fast-fail on a
    // snapshot conflict rather than each burning a busy wait.
    //
    // upsertAgentBinding OVERRIDES this per attempt from its remaining deadline
    // budget, so this is only the floor for everything else on this handle.
    db.pragma("busy_timeout = 1000");
  } catch (err) {
    return bindFailed(`could not open ${dbPath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const {
      probeBindSchema,
      upsertAgentBinding,
      endAgentBinding,
      getCurrentBinding,
      getCurrentBindingByConversation,
      getAgentIdentityAnchor,
      rebindAgentToWindow,
    } = await import("../db.js");

    // The RECORDED version, not table existence (architect ruling 1): a
    // table-exists probe passes after a future column change, then breaks on write.
    const schema = probeBindSchema(db, dbPath);
    if (!schema.ok) return bindFailed(schema.message);

    if (args.end) {
      if (!endReason) {
        return bindFailed("--end needs the SessionEnd payload's reason, and this payload carries none");
      }
      const ok = endAgentBinding(db, anchor, endReason);
      if (!ok) {
        return bindFailed(
          `this window (pid ${anchor.windowPid}) has no current binding to end — nothing was recorded`,
        );
      }
      const line = `[RELAY] session end recorded: reason="${endReason}" for the binding on conversation ${conversationId}`;
      process.stdout.write(args.json ? JSON.stringify({ ok: true, action: "ended", end_reason: endReason }) + "\n" : line + "\n");
      return 0;
    }

    // --- ADR-0036 S3-lite: CONTINUITY (rows 1 and 4) ----------------------
    // An UNNAMED window resuming C, where the relay's own record says C belongs to
    // X and X's window anchor is provably DEAD, becomes X: rebind under CAS, one
    // transaction, zero steps. Gated on anchorLivenessVerdict ONLY (never the
    // argv-inclusive verdict); alive AND unverifiable refuse. A NAMED window never
    // inherits: its launch intent wins, and row 3 (launcher X resuming Y's
    // conversation) is S3, not S3-lite. Only `resume` asks.
    let continuityRefusal: string | null = null;
    let continuityName: string | null = null;
    if (agentName === null && source === "resume") {
      const prior = getCurrentBindingByConversation(db, conversationId);
      if (prior) {
        continuityName = prior.agent_name;
        const { anchorLivenessVerdict } = await import("../liveness.js");
        const { resolveContinuityClaim } = await import("../binding.js");
        const claim = resolveContinuityClaim({
          priorBinding: prior,
          priorAnchorVerdict: anchorLivenessVerdict(
            { host_id: prior.host_id, agent_pid: prior.window_pid, agent_pid_start: prior.window_pid_start },
            hostId,
          ),
          thisAnchor: { hostId, pid: anchor.windowPid, startedAt: anchor.windowPidStart },
        });
        if (claim.ok && claim.action === "claim") {
          const held = getAgentIdentityAnchor(db, claim.agentName);
          const rebind = rebindAgentToWindow(db, {
            agentName: claim.agentName,
            conversationId,
            newAnchor: anchor,
            cwd,
            expected: {
              bindingId: prior.binding_id,
              bindingVersion: claim.expectedBindingVersion,
              sessionId: held?.session_id ?? null,
              agentPid: held?.agent_pid ?? null,
              agentPidStart: held?.agent_pid_start ?? null,
            },
          });
          if (rebind.ok) {
            process.stdout.write(
              args.json
                ? JSON.stringify({
                    ok: true,
                    action: "claimed",
                    agent_name: claim.agentName,
                    conversation_id: conversationId,
                    bound_via: "continuity",
                    binding_id: rebind.bindingId,
                    binding_version: rebind.bindingVersion,
                    window_pid: anchor.windowPid,
                    host_id: hostId,
                    cwd,
                  }) + "\n"
                : rebind.announce + "\n",
            );
            return 0;
          }
          // Lost the CAS (row 10: another window claimed it first). Never retried:
          // this window is recorded as itself, and says why.
          continuityRefusal = rebind.reason;
        } else if (!claim.ok) {
          continuityRefusal = claim.reason;
        }
      }
    }

    // IDENTITY CARRIES (row 8): an unnamed window's identity is its BINDING, not its
    // env. After a continuity claim the env still has no name, so `/clear` (a new
    // conversation, same window) would otherwise bind the new conversation as
    // nobody and drop X. `/compact` keeps the same conversation, so it lands on the
    // refresh path by construction; carrying the name costs it nothing.
    const effectiveName =
      agentName ?? (source === "clear" ? (getCurrentBinding(db, anchor)?.agent_name ?? null) : null);

    // `compact` keeps the same conversation id, so it lands on the refresh path
    // by construction — no special case, and no second current row (§8a D2).
    const boundVia = boundViaForSource(source, effectiveName !== null);
    const result = upsertAgentBinding(
      db,
      {
        ...anchor,
        agentName: effectiveName,
        agentClass: null,
        conversationId,
        conversationTitle: null,
        cwd,
        boundVia,
      },
      { supersedeReason: source === "clear" ? "clear-carry" : "resume-switch" },
    );

    // ANNOUNCE — a human and an agent both read this. Name the identity, the
    // conversation and the evidence, so a window can never become X silently.
    const who = effectiveName ?? "an unnamed window";
    const line =
      `[RELAY] bound ${who} to conversation ${conversationId} ` +
      `(${result.action}, via ${boundVia}, window pid ${anchor.windowPid} on this host)` +
      // ONE line: the hook collapses bind stdout to its first line.
      (continuityRefusal
        ? ` — did not take ${continuityName ?? "the conversation's identity"}: ${continuityRefusal}`
        : "");
    process.stdout.write(
      args.json
        ? JSON.stringify({
            ok: true,
            action: result.action,
            agent_name: effectiveName,
            ...(continuityRefusal ? { continuity_refused: continuityRefusal } : {}),
            conversation_id: conversationId,
            bound_via: boundVia,
            binding_id: result.bindingId,
            binding_version: result.bindingVersion,
            superseded_binding_id: result.supersededBindingId,
            window_pid: anchor.windowPid,
            host_id: hostId,
            cwd,
          }) + "\n"
        : line + "\n",
    );
    return 0;
  } catch (err) {
    return bindFailed(`recording the binding failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    try {
      (db as unknown as { close(): void }).close();
    } catch {
      /* best-effort */
    }
  }
}
