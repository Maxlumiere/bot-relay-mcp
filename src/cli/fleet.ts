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
  connectors: boolean;
  dbPath: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { json: false, connectors: false, dbPath: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--connectors") args.connectors = true;
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
    "Usage: relay fleet [--connectors] [--json] [--db-path P]\n\n" +
    "Lists every window binding the relay has recorded: which window holds which\n" +
    "identity, on which conversation, and whether that window is still alive.\n\n" +
    "Liveness is DERIVED from the recorded anchor each time you run this — it is\n" +
    "never stored, so it cannot drift from the live process:\n" +
    "  alive         the window's process is running on this host\n" +
    "  dead          the anchor is gone or was reused — the binding is STALE\n" +
    "  unverifiable  a different host, or no probe-able anchor (never a guess)\n\n" +
    "  --connectors List every relay connector process on this host and whether it\n" +
    "               runs the installed build (ADR-0047): CURRENT, STALE (restart\n" +
    "               needed), UNKNOWN, INSTALL INCONSISTENT (rebuild); a bound window\n" +
    "               with none reads NO CONNECTOR; plus the daemon's line. UNBOUND\n" +
    "               marks a connector no binding names.\n" +
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
  {
    // ADR-0048: the ONE strict resolver (RELAY_DB_PATH included: containment).
    const { pinResolvedDbPath } = await import("./_instance-db.js");
    const resolveFault = await pinResolvedDbPath();
    if (resolveFault) return fleetFailed(`instance resolution failed: ${resolveFault}`);
  }
  const dbPath = process.env.RELAY_DB_PATH as string;
  if (!fs.existsSync(dbPath)) {
    return fleetFailed(`no relay DB at ${dbPath} — nothing to list (the daemon has never initialised it)`);
  }

  let db: import("../sqlite-compat.js").CompatDatabase;
  try {
    // ADR-0048: the raw handle gets db.ts's post-open re-check (one function).
    const { openRawRelayDb } = await import("./_instance-db.js");
    db = await openRawRelayDb(dbPath, { readonly: true });
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
    if (args.connectors) return await listConnectors(db, dbPath, args.json);
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

/**
 * ADR-0047 PR 3 — `relay fleet --connectors`: the verdict engine (src/fleet-verdicts.ts)
 * over one snapshot. Read-only like the rest of this verb: the rows are read on the
 * readonly handle, at the instant of the process snapshot. Exit 0 when listed,
 * whatever the verdicts (the gate is `--deploy-check`); 1 when it cannot read.
 */
async function listConnectors(db: import("../sqlite-compat.js").CompatDatabase, dbPath: string, json: boolean): Promise<number> {
  const { hasConnectorsTable, liveConnectors, listAgentBindings } = await import("../db.js");
  const { anchorLivenessVerdict, getOwnHostId } = await import("../liveness.js");
  const { observeFleet, judgeFleet, CONNECTOR_KIND } = await import("../fleet-verdicts.js");
  const { realSystemDeps } = await import("../fleet-system.js");
  if (!hasConnectorsTable(db)) {
    return fleetFailed(
      `schema not migrated: ${dbPath} has no connectors table (schema v26). The daemon or a connector on the new build must open this DB once first.`,
    );
  }
  let port = parseInt(process.env.RELAY_HTTP_PORT || "3777", 10);
  try {
    const { loadConfig } = await import("../config.js");
    port = loadConfig().http_port;
  } catch {
    /* the env / default port: a wrong port reads the daemon UNKNOWN, never CURRENT */
  }
  const ownHost = getOwnHostId();
  const snapshot = await observeFleet(
    realSystemDeps,
    {
      liveRows: (startOf) => liveConnectors({ db, startOf }),
      liveBindings: () =>
        listAgentBindings(db)
          .filter(
            (b) => anchorLivenessVerdict({ host_id: b.host_id, agent_pid: b.window_pid, agent_pid_start: b.window_pid_start }, ownHost) === "alive",
          )
          .map((b) => ({ agent_name: b.agent_name, window_pid: b.window_pid, window_pid_start: b.window_pid_start })),
    },
    port,
  );
  const j = judgeFleet(snapshot);
  if (json) {
    process.stdout.write(JSON.stringify(j, null, 2) + "\n");
    return 0;
  }
  const head = ["VERDICT", "AGENT", "PID", "WINDOW", "INSTALL", "WHY"];
  const body = j.connectors.map((e) => [
    e.verdict,
    e.kind === CONNECTOR_KIND.unclassified ? "(unclassified)" : e.unbound ? "UNBOUND" : (e.agent as string),
    String(e.pid),
    e.window_pid === null ? "-" : String(e.window_pid),
    e.install_dir ?? "-",
    e.reason,
  ]);
  // Windows WITH connectors are already shown through them; list the ones without.
  for (const w of j.windows.filter((x) => x.connectors.length === 0)) {
    body.push([w.verdict, w.agent ?? "(unnamed)", "-", String(w.window_pid), "-", w.reason]);
  }
  if (body.length === 0) {
    process.stdout.write("[RELAY] No relay connector process on this host, and no live bound window.\n");
  } else {
    const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => (i === head.length - 1 ? 0 : row[i].length))));
    const line = (cells: string[]): string =>
      cells.map((c, i) => (i === cells.length - 1 ? c : pad(c, widths[i]))).join("  ").replace(/\s+$/, "");
    process.stdout.write(line(head) + "\n");
    for (const row of body) process.stdout.write(line(row) + "\n");
  }
  for (const e of j.connectors) for (const w of e.warnings) process.stdout.write(`[RELAY] warning, connector ${e.pid}: ${w}\n`);
  process.stdout.write(
    `[RELAY] daemon: ${j.daemon.verdict}${j.daemon.pid !== null ? ` (pid ${j.daemon.pid})` : ""}: ${j.daemon.reason}\n`,
  );
  process.stdout.write(
    j.failing === 0
      ? "[RELAY] every relay connector and the daemon run the installed build.\n"
      : `[RELAY] ${j.failing} not CURRENT: restart those windows (STALE/UNKNOWN), rebuild (INSTALL INCONSISTENT), or restart the daemon.\n`,
  );
  return 0;
}
