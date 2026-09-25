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
 * drain's own buildMessageWhere("pending", ...) and resolves the session the way
 * getMessages does. It takes NO window (ADR-0045 R1/R4): it IS the canonical
 * pending set, so there is no `--since` to pass. Its ids equal
 * get_messages(pending, peek, since='all') ids, pinned by tests/f1-relay-pending.test.ts.
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
  dbPath: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { name: null, json: false, dbPath: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--since") {
      // Refused, not ignored: a caller passing a window expects one to apply.
      throw new Error("--since is not accepted: this is the canonical pending set, which has no window (ADR-0045)");
    } else if (a === "--db-path") {
      const v = argv[++i];
      if (!v) throw new Error("--db-path requires a path");
      args.dbPath = v;
    } else if (a.startsWith("-")) throw new Error(`unknown option: ${a}`);
    else if (args.name === null) args.name = a;
    else throw new Error(`unexpected argument: ${a}`);
  }
  return args;
}

function usage(requested = false): void {
  const text =
    "Usage: relay pending AGENT [--json] [--db-path P]\n\n" +
    "What is pending for AGENT: the canonical pending set, exactly what\n" +
    "get_messages(status=pending, since='all') would return, as METADATA ONLY:\n" +
    "count, top priority, and per message the id, sender, priority and age. Never\n" +
    "the content. No time window. Reads the DB read-only and marks nothing.\n\n" +
    "  --json       Emit JSON.\n" +
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
  const { AGENT_NAME_PATTERN } = await import("../types.js");
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

    const { pendingSchemaGap, pendingMetadata } = await import("../db.js");
    const gap = pendingSchemaGap(db);
    if (gap) return pendingFailed(`${dbPath} ${gap}`);

    const meta = pendingMetadata(db, name);
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
