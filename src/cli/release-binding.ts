// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * `relay release-binding <agent-name>` — the operator remedy the dead-anchor
 * diagnostic (hooks/check-relay.sh) names when it detects a STALE, UNWAKEABLE
 * binding (ADR-0012 amended / Fork B).
 *
 * Clears EXACTLY the binding — session_id + host_shell_pids (the Tether terminal
 * chain) + the agent_pid/agent_pid_start liveness anchor — via the sanctioned
 * db.releaseAgentBinding, and PRESERVES the identity: token, name, capabilities,
 * host_id. So the next SessionStart re-registers a fresh binding WITHOUT freeing
 * the name, invalidating the token, or resetting the immutable capabilities —
 * the three hazards that disqualified `relay recover` (a destructive DELETE) as
 * the remedy.
 *
 * DB-direct + filesystem-gated (same trust model as `relay recover`): the whole
 * point is that the agent is UNWAKEABLE / its MCP transport may be down, so this
 * must not depend on the daemon. It NEVER forces / registers / takes over and
 * touches NO mailbox path.
 *
 * SAFETY — it REFUSES when the diagnosis is wrong (NOT "no-op-safe when wrong").
 * Releasing a LIVE binding NULLs host_shell_pids, and a still-running IDLE agent
 * makes no relay calls to re-register — so it would be stranded unwakeable, the
 * exact self-inflicted silent-mute this arc exists to kill. So it releases ONLY
 * on an OBSERVED-DEAD anchor via `anchorLivenessVerdict` — the ANCHOR-ONLY probe
 * (host_id + the stored agent PID/start), the SAME rule the hook's bash
 * `relay_anchor_liveness` mirrors (pinned by the conformance test).
 *
 * DELIBERATELY NOT `computeLivenessVerdict`: that OR's in an argv scan — it
 * answers PRESENCE ("is there ANY process for this name?", the dashboard
 * question) — so an argv-advertised agent (every codex terminal carries
 * RELAY_AGENT_NAME in its argv) would read ALIVE despite a dead anchor, the
 * diagnostic would name this command, and this command would then REFUSE →
 * a stale binding permanently unrecoverable for the whole argv-advertised half
 * of the fleet. This gate asks ELIGIBILITY ("is THIS binding's anchor dead?"),
 * which is anchor-only. ALIVE → refuse loudly; UNVERIFIABLE (cross-host row /
 * no probe-able anchor) → refuse (TAKEOVER_LIVENESS_UNVERIFIABLE). `--override`
 * is a separate deliberate opt-out that prints what it overrides.
 *
 * STREAM DISCIPLINE (matches the other CLI verbs): STDOUT carries ONLY the
 * released agent name (a clean, parseable value); usage + confirmation + every
 * error go to STDERR; a no-such-agent / bad-DB / parse failure exits NON-ZERO
 * with empty stdout so a capture fails loudly.
 */
import fs from "fs";
import path from "path";
import os from "os";

interface Args {
  name: string | null;
  dbPath: string | null;
  dryRun: boolean;
  override: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { name: null, dbPath: null, dryRun: false, override: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--override") out.override = true;
    else if (a === "--db-path") {
      const v = argv[++i];
      if (!v) throw new Error("--db-path requires a path argument");
      out.dbPath = v;
    } else if (!a.startsWith("-") && !out.name) {
      out.name = a;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return out;
}

function usage(requested = false): void {
  (requested ? process.stdout : process.stderr).write(
    "Usage: relay release-binding <agent-name> [--dry-run] [--db-path PATH]\n\n" +
      "Clear a STALE, UNWAKEABLE binding so the next launch re-binds cleanly —\n" +
      "the remedy the SessionStart dead-anchor diagnostic names. NULLs session_id +\n" +
      "host_shell_pids + the agent_pid liveness anchor; PRESERVES the token, name,\n" +
      "and (immutable) capabilities. Non-destructive: it does NOT delete the row,\n" +
      "free the name, or invalidate the token (unlike `relay recover`).\n\n" +
      "Options:\n" +
      "  --dry-run     Report what would be cleared, change nothing.\n" +
      "  --override    Release even when the anchor does NOT read positively-dead.\n" +
      "                Deliberate, never the default; prints exactly what it overrides.\n" +
      "  --db-path P   Operate on the DB at P (default: $RELAY_DB_PATH or\n" +
      "                ~/.bot-relay/relay.db).\n" +
      "  --help        Show this message.\n\n" +
      "SAFETY: refuses unless the agent's anchor reads OBSERVED-DEAD (same-host PID\n" +
      "probe) — releasing a LIVE (esp. idle) agent's binding would strand it\n" +
      "unwakeable. Trust model: filesystem access = operator authority (same as\n" +
      "`relay recover`). Safe with the daemon running. Messages/tasks are untouched.\n"
  );
}

export async function run(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`relay release-binding: ${err instanceof Error ? err.message : String(err)}\n\n`);
    usage();
    return 1;
  }
  if (args.help) {
    usage(true);
    return 0;
  }
  if (!args.name) {
    process.stderr.write("relay release-binding: missing <agent-name>\n\n");
    usage();
    return 1;
  }
  if (args.dbPath) process.env.RELAY_DB_PATH = args.dbPath;

  const resolvedDbPath = process.env.RELAY_DB_PATH;
  if (args.dbPath && resolvedDbPath) {
    const parent = path.dirname(resolvedDbPath);
    if (parent && parent !== "." && !fs.existsSync(parent)) {
      process.stderr.write(`relay release-binding: --db-path parent directory does not exist: ${parent}\n`);
      return 2;
    }
  }

  // Refuse to operate on a DB that isn't a bot-relay-mcp DB (mirrors `relay
  // recover`). Probe read-only BEFORE initializeDb so a migration can't turn an
  // unknown DB into a "valid" one.
  if (resolvedDbPath && fs.existsSync(resolvedDbPath)) {
    try {
      const Better = (await import("better-sqlite3")).default;
      const probe = new Better(resolvedDbPath, { readonly: true, fileMustExist: true });
      try {
        const tables = probe
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('agents','agent_capabilities','audit_log')")
          .all() as { name: string }[];
        if (tables.length !== 3) {
          const present = tables.map((t) => t.name).sort().join(", ") || "(none)";
          process.stderr.write(
            `relay release-binding: DB at ${resolvedDbPath} is missing bot-relay-mcp schema ` +
              `(found: ${present}). Refusing to operate on an unknown DB.\n`
          );
          return 2;
        }
      } finally {
        probe.close();
      }
    } catch (err) {
      process.stderr.write(
        `relay release-binding: could not probe DB schema: ${err instanceof Error ? err.message : String(err)}\n`
      );
      return 2;
    }
  }

  let dbOpen = false;
  try {
    const { initializeDb, getAgentAuthData, releaseAgentBinding, logAudit } = await import("../db.js");
    const { anchorLivenessVerdict } = await import("../liveness.js");
    await initializeDb();
    dbOpen = true;

    const row = getAgentAuthData(args.name);
    if (!row) {
      process.stderr.write(
        `relay release-binding: agent "${args.name}" is not registered — nothing to release.\n`
      );
      return 1;
    }

    // SAFETY GATE (ADR-0012 amended) — release ONLY on OBSERVED death. Releasing a
    // LIVE binding NULLs host_shell_pids; a still-running agent that is IDLE makes
    // no relay calls to re-register, so it is stranded UNWAKEABLE — the exact
    // self-inflicted silent-mute this whole arc exists to kill. So the remedy
    // enforces the SAME rule as the diagnostic: observed death, never assumed.
    // ANCHOR-ONLY (not computeLivenessVerdict) — see the header block: the gate
    // asks ELIGIBILITY, and the argv scan in the presence verdict would mask a
    // dead anchor for argv-advertised agents. This is the exact TS twin of the
    // hook's bash relay_anchor_liveness (pinned by the conformance test).
    const verdict = anchorLivenessVerdict({
      host_id: row.host_id,
      agent_pid: row.agent_pid,
      agent_pid_start: row.agent_pid_start,
    });
    if (verdict === "alive" && !args.override) {
      // anchorLivenessVerdict collapses "observed alive (start-time matched)" and
      // "present-but-unverifiable (no/unreadable start anchor → PID reuse can't be
      // excluded)" into ONE `alive` verdict (isAgentProcessAlive's narrow-dead
      // rule). The RULE is correct (fail toward NOT acting); only the MESSAGE must
      // not assert liveness it hasn't observed. Message-only — adds no verdict
      // state, so it cannot drift the two probes apart.
      const observed = row.agent_pid_start
        ? `agent_pid ${row.agent_pid} is present and was NOT observed dead (start anchor on record; treated as a live process)`
        : `agent_pid ${row.agent_pid} exists but has NO start anchor — PID reuse cannot be excluded, so it cannot be confirmed dead`;
      process.stderr.write(
        `relay release-binding: REFUSING — ${observed}. Releasing this binding could strand a healthy ` +
          "(especially idle) agent unwakeable. Verify it is truly dead; re-run with --override if you are certain.\n"
      );
      return 3;
    }
    if (verdict === "unverifiable" && !args.override) {
      process.stderr.write(
        `relay release-binding: REFUSING — cannot verify "${args.name}" is dead ` +
          "(TAKEOVER_LIVENESS_UNVERIFIABLE: cross-host row or no probe-able anchor). Refusing to guess. " +
          "Verify liveness out-of-band; re-run with --override ONLY if you are certain it is dead.\n"
      );
      return 3;
    }

    if (args.dryRun) {
      const ov = verdict !== "dead" ? ` [--override: anchor reads ${verdict}]` : "";
      process.stderr.write(
        `relay release-binding: [dry-run] would clear the binding for "${args.name}"${ov} ` +
          "(session_id, host_shell_pids, agent_pid/agent_pid_start) and preserve token, name, capabilities. " +
          "No change made.\n"
      );
      return 0;
    }

    if (verdict !== "dead") {
      // --override on a non-dead anchor: print EXACTLY what is being overridden.
      process.stderr.write(
        `relay release-binding: ⚠️ OVERRIDING the liveness gate for "${args.name}" — anchor reads ${verdict}` +
          (verdict === "alive" ? ` (agent_pid ${row.agent_pid} is a live process)` : " (unverifiable)") +
          ". Releasing anyway per --override.\n"
      );
    }

    // CAS on the EXACT binding the liveness probe evaluated — "the row I am
    // writing is the row I looked at" (codex #136 P1). A legitimate fresh rebind
    // that landed between the probe above and this write rotates session_id +
    // overwrites the anchor; releasing blind would clear that NEW live binding
    // and report success, stranding a healthy terminal — the exact write-race
    // Fork B exists to refuse. changes=0 → the binding moved → refuse, don't
    // guess. Same shape as a FORCE_PRECONDITION_FAILED loser.
    const released = releaseAgentBinding(args.name, {
      session_id: row.session_id ?? null,
      agent_pid: row.agent_pid ?? null,
      agent_pid_start: row.agent_pid_start ?? null,
    });
    if (!released.changed) {
      process.stderr.write(
        `relay release-binding: REFUSING — the binding for "${args.name}" CHANGED since it was probed ` +
          "(a fresh session rebound between the liveness check and the release). Re-read, NOT released — " +
          "the current binding was NOT touched. Re-run to evaluate the new binding.\n"
      );
      return 3;
    }

    let operator = "unknown";
    try {
      operator = os.userInfo().username || "unknown";
    } catch {
      /* best-effort */
    }
    try {
      logAudit(args.name, "release_binding", `binding released by operator ${operator}`, true, null, "cli", {
        tool: "release_binding",
        source: "relay release-binding CLI",
      });
    } catch {
      /* audit is best-effort — never fail the release over it */
    }

    process.stderr.write(
      `✓ released the binding for "${args.name}" — session/terminal/anchor cleared, identity preserved. ` +
        "Relaunch the agent; its next SessionStart re-registers a fresh binding.\n"
    );
    process.stdout.write(`${args.name}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(
      `relay release-binding: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 2;
  } finally {
    if (dbOpen) {
      try {
        const { closeDb } = await import("../db.js");
        closeDb();
      } catch {
        /* ignore */
      }
    }
  }
}
