// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * `relay pending <agent>` — what is pending for this agent, as METADATA ONLY
 * (F1, ADR-0044). The one read surface for "does this agent have mail?", so the
 * hooks carry no predicate SQL of their own (ADR-0039) and cannot drift from the
 * drain.
 *
 * SSOT: the answer comes from db.pendingMetadata, which builds its WHERE with the
 * drain's own buildMessageWhere("pending", ...), resolves the session the way
 * getMessages does, and defaults the window to get_messages' own default. Its ids
 * equal get_messages(pending, peek) ids, pinned by tests/f1-relay-pending.test.ts.
 *
 * READ-ONLY BY CONSTRUCTION: the handle is opened `readonly: true`, so even an
 * accidental write fails at the driver. Unlike a get_messages peek it stamps no
 * `seq`, because it observes no message. DB-direct: works with the daemon down.
 *
 * SILENCE IS NEVER SUCCESS: exit 0 with `count: 0` means VERIFIED empty. Anything
 * that prevents a verified answer (no DB, not a relay DB, corrupt, locked, an
 * agent this DB has never registered) exits 1 with PENDING_FAILED on stderr and
 * NOTHING on stdout, so `$(relay pending X --json)` can never capture a plausible
 * "no mail".
 */
import fs from "fs";

interface Args {
  name: string | null;
  json: boolean;
  since: string | null;
  dbPath: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { name: null, json: false, since: null, dbPath: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--since" || a === "--db-path") {
      const v = argv[++i];
      if (!v) throw new Error(`${a} requires a value`);
      if (a === "--since") args.since = v;
      else args.dbPath = v;
    } else if (a.startsWith("-")) throw new Error(`unknown option: ${a}`);
    else if (args.name === null) args.name = a;
    else throw new Error(`unexpected argument: ${a}`);
  }
  return args;
}

function usage(requested = false): void {
  const text =
    "Usage: relay pending AGENT [--json] [--since S] [--db-path P]\n\n" +
    "What is pending for AGENT, exactly as get_messages(status=pending) would return\n" +
    "it, as METADATA ONLY: count, top priority, and per message the id, sender,\n" +
    "priority and age. Never the content. Reads the DB read-only and marks nothing.\n\n" +
    "  --json       Emit JSON.\n" +
    "  --since S    The drain's window: a duration (24h), an ISO time, session_start\n" +
    "               or all. Default: get_messages' own default (24h).\n" +
    "  --db-path P  Read the DB at P (default: $RELAY_DB_PATH or the active\n" +
    "               instance's DB).\n\n" +
    "Exit: 0 = answered (count 0 is a VERIFIED empty) · 1 = could not answer ·\n" +
    "      2 = usage error (including the unresolved name `default`).\n";
  if (requested) process.stdout.write(text);
  else process.stderr.write(text);
}

function pendingFailed(reason: string): number {
  process.stderr.write(`PENDING_FAILED: ${reason}\n`);
  return 1;
}

export async function run(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`relay pending: ${err instanceof Error ? err.message : String(err)}\n\n`);
    usage();
    return 2;
  }
  if (args.help) {
    usage(true);
    return 0;
  }

  // --- the name: a RESOLVED identity, never `default` (ADR-0044 point 5) -------
  const { AGENT_NAME_PATTERN, GET_MESSAGES_DEFAULT_SINCE } = await import("../types.js");
  const name = args.name;
  if (!name) {
    process.stderr.write("relay pending: AGENT is required\n\n");
    usage();
    return 2;
  }
  if (!AGENT_NAME_PATTERN.test(name)) {
    process.stderr.write(`relay pending: ${JSON.stringify(name)} is not a valid agent name (${AGENT_NAME_PATTERN})\n`);
    return 2;
  }
  if (name.toLowerCase() === "default") {
    process.stderr.write(
      "relay pending: refusing the name `default` — it is the unresolved fallback, not an identity. " +
        "Resolve this window's agent name first.\n",
    );
    return 2;
  }

  // --- resolve the DB (no daemon, same as bind / fleet) ----------------------
  let dbPath = args.dbPath ?? process.env.RELAY_DB_PATH ?? null;
  if (!dbPath) {
    try {
      const { resolveInstanceDbPath } = await import("../instance.js");
      dbPath = resolveInstanceDbPath();
    } catch (err) {
      return pendingFailed(`could not resolve the relay DB path: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!fs.existsSync(dbPath)) {
    return pendingFailed(`no relay DB at ${dbPath} — cannot answer (this is NOT "no mail")`);
  }

  let db: import("../sqlite-compat.js").CompatDatabase | null = null;
  try {
    const Better = (await import("better-sqlite3")).default;
    db = new Better(dbPath, { readonly: true, fileMustExist: true }) as unknown as import("../sqlite-compat.js").CompatDatabase;
    db.pragma("busy_timeout = 1000");

    const { pendingSchemaGap, pendingMetadata, agentSessionStartOn } = await import("../db.js");
    const gap = pendingSchemaGap(db);
    if (gap) return pendingFailed(`${dbPath} ${gap}`);

    const { resolveSinceBoundWith } = await import("../since.js");
    const since = args.since ?? GET_MESSAGES_DEFAULT_SINCE;
    let sinceIso: string | null;
    try {
      const handle = db;
      sinceIso = resolveSinceBoundWith(since, () => agentSessionStartOn(handle, name));
    } catch (err) {
      process.stderr.write(`relay pending: ${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }

    const meta = pendingMetadata(db, name, sinceIso);
    if (!meta.registered) {
      return pendingFailed(
        `agent ${JSON.stringify(name)} is not registered in ${dbPath} — the wrong instance's DB, or an agent that ` +
          `has never registered. Cannot say what is pending (this is NOT "no mail").`,
      );
    }

    if (args.json) {
      process.stdout.write(
        JSON.stringify({
          ok: true,
          agent: name,
          db_path: dbPath,
          since,
          since_bound: sinceIso,
          session_bound: meta.session_bound,
          count: meta.count,
          top_priority: meta.top_priority,
          messages: meta.messages,
        }) + "\n",
      );
    } else {
      process.stdout.write(
        meta.count === 0
          ? `[RELAY] 0 pending for ${name} (verified, ${dbPath})\n`
          : `[RELAY] ${meta.count} pending for ${name} (top priority: ${meta.top_priority ?? "unknown"})\n`,
      );
    }
    return 0;
  } catch (err) {
    return pendingFailed(`could not read ${dbPath}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    try {
      db?.close();
    } catch {
      /* closing a failed handle is best-effort */
    }
  }
}
