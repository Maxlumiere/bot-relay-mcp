// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * `relay fleet` — list every window binding the relay has recorded (ADR-0036 S1).
 *
 * S1 RECORDS AND LISTS. `relay bind` is the record half; this is the list half,
 * and it is what makes "this window became X" observable instead of silent. It
 * performs NO rebinding, NO takeover and NO write of any kind — automatic rebind
 * is S3-lite (rows 1/4/11).
 *
 * STATUS IS DERIVED AT READ TIME, NEVER STORED (§2.2). The schema deliberately
 * has no `status` / `is_live` / `needs_resume` column, because a stored status
 * drifts from the live process the moment the window dies and then reports health
 * that no longer exists. So liveness is computed HERE, per row, from the anchor.
 *
 * THE MAPPING BELOW IS LOAD-BEARING: anchorLivenessVerdict takes an AGENTS-shaped
 * row (`{host_id, agent_pid, agent_pid_start}`). A binding stores the same facts
 * under `window_pid` / `window_pid_start`. Hand it the binding row unmapped and
 * `agent_pid` is undefined, its guard returns "unverifiable" for EVERY row, and
 * the output still looks like a working listing — a column that is uniformly
 * plausible and uniformly meaningless. Pinned by the fleet test.
 *
 * READ-ONLY BY CONSTRUCTION: the handle is opened `readonly: true`, so a future
 * edit that tries to write fails loudly at the driver rather than quietly
 * mutating a guarded identity table.
 *
 * STREAM DISCIPLINE (matches every other verb): the listing is DATA and goes to
 * stdout; usage-on-error and every refusal go to stderr, so a failed
 * `$(relay fleet --json)` captures EMPTY instead of a plausible wrong value.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { readTranscriptMeter, type MeterResult } from "../fleet-meter.js";
import { validateLineFields, shellQuote } from "../fleet-line-fields.js";

interface Args {
  json: boolean;
  lines: boolean;
  dbPath: string | null;
  help: boolean;
}


/**
 * Status is DERIVED from the anchor verdict at read time, never stored (§2.2).
 * A dead anchor means the window is gone and the conversation is recorded, which
 * is row 13's needs-resume. It is not garbage.
 */
function statusFor(liveness: string): "live" | "needs-resume" | "unverifiable" {
  if (liveness === "alive") return "live";
  if (liveness === "dead") return "needs-resume";
  return "unverifiable";
}

function parseArgs(argv: string[]): Args {
  const args: Args = { json: false, lines: false, dbPath: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--lines") args.lines = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--db-path") {
      const v = argv[++i];
      if (!v) throw new Error("--db-path requires a path");
      args.dbPath = v;
    } else throw new Error(`unknown option: ${a}`);
  }
  if (args.json && args.lines) throw new Error("--json and --lines are mutually exclusive");
  return args;
}

function usage(requested = false): void {
  const text =
    "Usage: relay fleet [--json | --lines] [--db-path P]\n\n" +
    "Lists every window binding the relay has recorded: which window holds which\n" +
    "identity, on which conversation, and whether that window is still alive.\n\n" +
    "Status is DERIVED from the recorded anchor each time you run this — it is\n" +
    "never stored, so it cannot drift from the live process:\n" +
    "  live          the window's process is running on this host\n" +
    "  needs-resume  the window is gone; its conversation is recorded and can be resumed\n" +
    "  unverifiable  a different host, or no probe-able anchor (never a guess)\n\n" +
    "  --json       Emit the rows as JSON instead of a table.\n" +
    "  --lines      One checked restart line per window that needs resuming, with its\n" +
    "               context meter. Every field is validated and quoted; a row that\n" +
    "               fails gets a comment saying why and no line. Live windows get\n" +
    "               no line. Lines carry no --model (the transcript does not record\n" +
    "               the context window).\n" +
    "  --db-path P  Read the DB at P (default: $RELAY_DB_PATH or the active\n" +
    "               instance's DB).\n\n" +
    "Exit: 0 = listed (an empty fleet is not an error) · 1 = could not read ·\n" +
    "      2 = usage error.\n";
  if (requested) process.stdout.write(text);
  else process.stderr.write(text);
}

/** One refusal vocabulary, mirroring BIND_FAILED. */
function fleetFailed(reason: string): number {
  process.stderr.write(`FLEET_FAILED: ${reason}\n`);
  return 1;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

/** Comment text: one line, no control characters (a pasted comment must stay a comment). */
function commentSafe(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]+/g, " ");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The transcript for `conversationId`, found by FILE NAME under the Claude projects
 * dir rather than by re-deriving the project-dir slug from the cwd. The id is
 * checked as a UUID before it goes near a path.
 */
function findTranscript(conversationId: string): string | null {
  if (!UUID.test(conversationId)) return null;
  const projects = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const f = path.join(projects, d, `${conversationId}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function tokens(n: number): string {
  if (n >= 1_000_000 && n % 1_000_000 === 0) return `${n / 1_000_000}M`;
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

function meterText(m: MeterResult | null): string {
  if (!m) return "context unknown (no transcript found)";
  if (m.contextTokens === null) return "context unknown (no usage in the transcript)";
  const comp = `${m.compactions} compaction${m.compactions === 1 ? "" : "s"}`;
  if (m.window === null || m.fraction === null) return `context ${tokens(m.contextTokens)}, window unknown, ${comp}`;
  return `context ${tokens(m.contextTokens)}/${tokens(m.window)} (${Math.round(m.fraction * 100)}%, ${m.level}), ${comp}`;
}

type FleetRow = {
  agent_name: string | null;
  conversation_id: string;
  cwd: string | null;
  status: "live" | "needs-resume" | "unverifiable";
};

/**
 * ADR-0040 restart lines. Built from the RECORD, never from a request, and every
 * field goes through validateLineFields + shellQuote. A row that fails gets a
 * comment naming why, and NO line. Everything that is not a command is a `#`
 * comment, so pasting the whole output runs only the checked lines.
 *
 * The line reproduces the persona launchers' launch intent (`RELAY_AGENT_NAME=<name>
 * claude …`, MEASURED in ~/.zshrc) and resumes the recorded conversation. NO
 * --model: a Claude transcript records `claude-opus-5-5` without its `[1m]` window
 * (MEASURED), so a --model taken from it could reopen a 900k conversation in a
 * 200k window.
 */
function renderLines(rows: FleetRow[], dbPath: string): string {
  if (rows.length === 0) return `# No window bindings recorded yet in ${commentSafe(dbPath)}\n`;
  const out: string[] = [];
  for (const r of rows) {
    const who = commentSafe(r.agent_name ?? "(unnamed)");
    const conv = commentSafe(r.conversation_id);
    const file = findTranscript(r.conversation_id);
    let meter: MeterResult | null = null;
    if (file) {
      try {
        meter = readTranscriptMeter(file);
      } catch {
        meter = null;
      }
    }
    out.push(`# ${who}  ${r.status}  ${conv}  ${meterText(meter)}`);
    if (r.status === "live") {
      out.push(`# ${who}: already open, do not paste (a second window would claim the same identity)`);
      continue;
    }
    if (r.status === "unverifiable") {
      out.push(`# ${who}: no line: liveness unverifiable (another host, or an unreadable anchor), so it may still be open`);
      continue;
    }
    const v = validateLineFields(
      {
        conversationId: r.conversation_id,
        name: r.agent_name,
        folder: r.cwd ?? "",
        parentThreadId: meter && meter.subagent ? (meter.resumeTarget ?? "(parent unknown)") : null,
      },
      { allowedRoots: [os.homedir()], knownModels: [] },
    );
    if (!v.ok) {
      out.push(`# ${who}: no line: ${commentSafe(v.reasons.join("; "))}`);
      continue;
    }
    const f = v.fields;
    const intent = f.name ? `RELAY_AGENT_NAME=${shellQuote(f.name)} ` : "";
    out.push(`cd ${shellQuote(f.folder)} && ${intent}claude --resume ${f.conversationId}`);
  }
  return out.join("\n") + "\n";
}

export async function run(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`relay fleet: ${err instanceof Error ? err.message : String(err)}\n\n`);
    usage();
    return 2;
  }
  if (args.help) {
    usage(true);
    return 0;
  }

  // --- resolve the DB (no daemon, same as bind: §2.2 DB-direct) -------------
  if (args.dbPath) process.env.RELAY_DB_PATH = args.dbPath;
  if (!process.env.RELAY_DB_PATH) {
    try {
      const { resolveInstanceDbPath } = await import("../instance.js");
      process.env.RELAY_DB_PATH = resolveInstanceDbPath();
    } catch (err) {
      return fleetFailed(`could not resolve the relay DB path: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const dbPath = process.env.RELAY_DB_PATH as string;
  if (!fs.existsSync(dbPath)) {
    return fleetFailed(`no relay DB at ${dbPath} — nothing to list (the daemon has never initialised it)`);
  }

  let db: import("../sqlite-compat.js").CompatDatabase;
  try {
    const Better = (await import("better-sqlite3")).default;
    db = new Better(dbPath, { readonly: true, fileMustExist: true }) as unknown as import("../sqlite-compat.js").CompatDatabase;
  } catch (err) {
    return fleetFailed(`could not open ${dbPath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const { hasAgentBindingsTable, listAgentBindings } = await import("../db.js");
    const { anchorLivenessVerdict, getOwnHostId } = await import("../liveness.js");

    // "0 windows" and "this DB cannot answer" are DIFFERENT FACTS. Reporting the
    // second as the first is the silence-as-health failure this arc exists to end,
    // so an unmigrated DB refuses loudly and exits non-zero.
    if (!hasAgentBindingsTable(db)) {
      return fleetFailed(
        `schema not migrated: ${dbPath} has no agent_bindings table (schema v25). ` +
          `The daemon or connector on the new build must open this DB once first.`,
      );
    }

    const ownHost = getOwnHostId();
    const rows = listAgentBindings(db).map((r) => {
      // THE MAPPING. window_pid/window_pid_start ARE this window's anchor; the
      // verdict helper names the same two facts agent_pid/agent_pid_start.
      const liveness = anchorLivenessVerdict(
        { host_id: r.host_id, agent_pid: r.window_pid, agent_pid_start: r.window_pid_start },
        ownHost,
      );
      return { ...r, liveness, status: statusFor(liveness) };
    });

    if (args.json) {
      process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
      return 0;
    }

    if (args.lines) {
      process.stdout.write(renderLines(rows, dbPath));
      return 0;
    }

    if (rows.length === 0) {
      // Empty is a legitimate answer, not a failure: exit 0 and say which DB was
      // read, so "no bindings" can be told apart from "wrong DB".
      process.stdout.write(`[RELAY] No window bindings recorded yet in ${dbPath}\n`);
      return 0;
    }

    const head = ["STATUS", "AGENT", "CONVERSATION", "WINDOW", "VIA", "CWD"];
    const body = rows.map((r) => [
      r.status,
      r.agent_name ?? "(unnamed)",
      // NEVER truncated: a partial conversation id cannot be resumed, which is
      // the one thing a reader most often wants this list for.
      r.conversation_id,
      String(r.window_pid),
      r.bound_via,
      r.cwd ?? "",
    ]);
    const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
    const line = (cells: string[]): string =>
      cells.map((c, i) => (i === cells.length - 1 ? c : pad(c, widths[i]))).join("  ").replace(/\s+$/, "");

    process.stdout.write(line(head) + "\n");
    for (const row of body) process.stdout.write(line(row) + "\n");

    const ended = rows.filter((r) => r.end_reason);
    for (const r of ended) {
      process.stdout.write(
        `[RELAY] ${r.agent_name ?? "(unnamed)"} on ${r.conversation_id} recorded a session end: "${r.end_reason}"\n`,
      );
    }
    // Row 13: a dead anchor is a window to RESTORE, not a record to delete. After a
    // reboot every binding is dead, and the old remedy (release-binding) pointed at
    // deleting exactly what a restore needs. The line names the columns rather than
    // interpolating a folder: a pasteable command needs every field validated and
    // quoted first (ADR-0040), which is not this listing's job.
    const needsResume = rows.filter((r) => r.status === "needs-resume").length;
    if (needsResume > 0) {
      process.stdout.write(
        `[RELAY] ${needsResume} window(s) need resuming: the window is gone but its conversation is recorded. ` +
          `To restore one, open a terminal in its CWD and run \`claude --resume <CONVERSATION>\`. ` +
          `Use \`relay release-binding <name>\` only for a window you do not want back.\n`,
      );
    }
    return 0;
  } catch (err) {
    return fleetFailed(`listing the fleet failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    try {
      (db as unknown as { close(): void }).close();
    } catch {
      /* best-effort */
    }
  }
}
