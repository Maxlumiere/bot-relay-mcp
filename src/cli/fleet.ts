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

interface Args {
  json: boolean;
  dbPath: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { json: false, dbPath: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
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
    "Usage: relay fleet [--json] [--db-path P]\n\n" +
    "Lists every window binding the relay has recorded: which window holds which\n" +
    "identity, on which conversation, and whether that window is still alive.\n\n" +
    "Liveness is DERIVED from the recorded anchor each time you run this — it is\n" +
    "never stored, so it cannot drift from the live process:\n" +
    "  alive         the window's process is running on this host\n" +
    "  dead          the anchor is gone or was reused — the binding is STALE\n" +
    "  unverifiable  a different host, or no probe-able anchor (never a guess)\n\n" +
    "  --json       Emit the rows as JSON instead of a table.\n" +
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
    const { bindingSchemaGap, listAgentBindings } = await import("../db.js");
    const { anchorLivenessVerdict, getOwnHostId } = await import("../liveness.js");

    // "0 windows" and "this DB cannot answer" are DIFFERENT FACTS. Reporting the
    // second as the first is the silence-as-health failure this arc exists to end,
    // so an unmigrated DB refuses loudly and exits non-zero.
    const gap = bindingSchemaGap(db);
    if (gap) {
      return fleetFailed(
        `schema not migrated: ${dbPath} ${gap}. ` +
          `The daemon or connector on the new build must open this DB once first.`,
      );
    }

    const ownHost = getOwnHostId();
    const rows = listAgentBindings(db).map((r) => ({
      ...r,
      // THE MAPPING. window_pid/window_pid_start ARE this window's anchor; the
      // verdict helper names the same two facts agent_pid/agent_pid_start.
      liveness: anchorLivenessVerdict(
        { host_id: r.host_id, agent_pid: r.window_pid, agent_pid_start: r.window_pid_start },
        ownHost,
      ),
    }));

    if (args.json) {
      process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
      return 0;
    }

    if (rows.length === 0) {
      // Empty is a legitimate answer, not a failure: exit 0 and say which DB was
      // read, so "no bindings" can be told apart from "wrong DB".
      process.stdout.write(`[RELAY] No window bindings recorded yet in ${dbPath}\n`);
      return 0;
    }

    const head = ["LIVENESS", "AGENT", "CONVERSATION", "WINDOW", "VIA", "CWD"];
    const body = rows.map((r) => [
      r.liveness,
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
    const stale = rows.filter((r) => r.liveness === "dead").length;
    if (stale > 0) {
      process.stdout.write(
        `[RELAY] ${stale} binding(s) have a DEAD anchor: that window is gone, so no wake reaches it. ` +
          `Clear one with \`relay release-binding <name>\`.\n`,
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
