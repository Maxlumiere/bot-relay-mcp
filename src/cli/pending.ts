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
 * accidental write fails at the driver: NO LOGICAL WRITES (no row, seq, read-mark,
 * inbox_events or last_drain_at change; the main DB file is byte-identical after
 * a run). It is not zero filesystem activity: SQLite may create the WAL sidecar
 * files (-wal, -shm), as any reader of a WAL database does. Unlike a
 * get_messages peek it stamps no `seq`, because it observes no message. DB-direct: works with the daemon down.
 *
 * SILENCE IS NEVER SUCCESS: exit 0 with `count: 0` means VERIFIED empty. Anything
 * that prevents a verified answer (no DB, not a relay DB, corrupt, locked, an
 * agent this DB has never registered) exits 1 with PENDING_FAILED on stderr and
 * NOTHING on stdout, so `$(relay pending X --json)` can never capture a plausible
 * "no mail". "There is no local instance here" is exit 3 (see resolvePendingSource),
 * so a hook can tell it from a local read that failed, which must stay loud and
 * must never be taken as a reason to go remote (the F1 mode rule).
 */
import fs from "fs";
import path from "path";

/** Exit code for "no local relay instance is configured or present here" (never "could not read"). */
export const EXIT_NO_LOCAL = 3;

export type PendingSource =
  | { kind: "local"; dbPath: string; basis: string }
  | { kind: "no-local"; reason: string }
  | { kind: "ambiguous"; reason: string }
  | { kind: "unreadable"; reason: string };

/** The CLI's handle: READ-ONLY at the driver, so a write through it throws (SQLITE_READONLY). */
export async function openPendingDb(dbPath: string): Promise<import("../sqlite-compat.js").CompatDatabase> {
  const Better = (await import("better-sqlite3")).default;
  const db = new Better(dbPath, { readonly: true, fileMustExist: true }) as unknown as import("../sqlite-compat.js").CompatDatabase;
  db.pragma("busy_timeout = 1000");
  return db;
}

/**
 * WHERE the answer comes from. ADR-0048: through the ONE strict resolver
 * (src/instance.ts resolveInstance), which reads the marker ONCE, applies the
 * approved-roots containment on REAL paths, and never turns a fault into the flat
 * DB. This command keeps only its own POLICY on top of that fact:
 *   1. explicit local (--db-path, RELAY_DB_PATH, RELAY_INSTANCE_ID) → that DB; a
 *      missing file is a READ failure (exit 1), never "no local instance";
 *   2. explicit remote (RELAY_HTTP_HOST) with no explicit local → "no-local"
 *      (exit 3): a caller with a remote relay is not redirected to a stray file;
 *   3. otherwise the resolver's answer: `error` (the ambiguous state included) is
 *      exit 1; `flat` whose file does not exist is "no local relay here" (exit 3);
 *      anything else is read.
 */
export async function decidePendingSource(
  dbPathFlag: string | null,
): Promise<{ source: PendingSource; resolution: import("../instance.js").ResolvedInstance | null }> {
  const { resolveInstance } = await import("../instance.js");
  const explicitLocal = Boolean(dbPathFlag || process.env.RELAY_DB_PATH || process.env.RELAY_INSTANCE_ID);
  if (!explicitLocal && process.env.RELAY_HTTP_HOST) {
    return {
      source: {
        kind: "no-local",
        reason: "a remote relay is configured (RELAY_HTTP_HOST) and no local instance is configured explicitly",
      },
      resolution: null,
    };
  }
  const r = resolveInstance(dbPathFlag ? { dbPath: dbPathFlag } : {});
  switch (r.kind) {
    case "error":
      return { source: r.ambiguous ? { kind: "ambiguous", reason: r.reason } : { kind: "unreadable", reason: r.reason }, resolution: r };
    case "flat":
      return r.exists
        ? { source: { kind: "local", dbPath: r.dbPath, basis: "legacy DB file" }, resolution: r }
        : { source: { kind: "no-local", reason: `no local relay instance here (nothing at ${r.dbPath}, no active instance)` }, resolution: r };
    case "instance":
      return { source: { kind: "local", dbPath: r.dbPath, basis: r.basis }, resolution: r };
    case "explicit-db":
      return { source: { kind: "local", dbPath: r.dbPath, basis: r.basis }, resolution: r };
  }
}

/** The source alone (see decidePendingSource). */
export async function resolvePendingSource(dbPathFlag: string | null): Promise<PendingSource> {
  return (await decidePendingSource(dbPathFlag)).source;
}

interface Args {
  name: string | null;
  json: boolean;
  dbPath: string | null;
  /** OPT-IN body window (SessionStart delivery): 0 = metadata only, the default. */
  withContent: number;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { name: null, json: false, dbPath: null, withContent: 0, help: false };
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
    } else if (a === "--with-content") {
      const v = argv[++i];
      if (!v || !/^[0-9]{1,3}$/.test(v) || Number(v) < 1 || Number(v) > 100) {
        throw new Error("--with-content requires a whole number from 1 to 100");
      }
      args.withContent = Number(v);
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
    "  --db-path P  Read the DB at P.\n" +
    "  --with-content N  OPT-IN: add the DECRYPTED body to the first N messages\n" +
    "               (drain order, 1-100), read in the same statement as the ids.\n" +
    "               For SessionStart delivery. Off by default: no content key.\n\n" +
    "Source: --db-path, RELAY_DB_PATH or RELAY_INSTANCE_ID (explicit) win; then a\n" +
    "configured remote (RELAY_HTTP_HOST) means no local answer; then the active\n" +
    "instance or the legacy DB file.\n\n" +
    "Exit: 0 = answered (count 0 is a VERIFIED empty) · 1 = could not answer ·\n" +
    "      2 = usage error (including the unresolved name `default`) ·\n" +
    "      3 = no local relay instance here (nothing was read; stdout empty).\n";
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

  // --- resolve the SOURCE (no daemon, same as bind / fleet) --------------------
  let source: PendingSource;
  let resolution: import("../instance.js").ResolvedInstance | null = null;
  try {
    ({ source, resolution } = await decidePendingSource(args.dbPath));
  } catch (err) {
    return pendingFailed(`could not resolve the relay DB path: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (source.kind === "no-local") {
    process.stderr.write(`PENDING_NO_LOCAL: ${source.reason}\n`);
    return EXIT_NO_LOCAL;
  }
  if (source.kind === "ambiguous" || source.kind === "unreadable") return pendingFailed(source.reason);
  const dbPath = source.dbPath;
  if (!fs.existsSync(dbPath)) {
    return pendingFailed(`no relay DB at ${dbPath} (${source.basis}) — cannot answer (this is NOT "no mail")`);
  }

  let db: import("../sqlite-compat.js").CompatDatabase | null = null;
  try {
    db = await openPendingDb(dbPath);

    const { pendingSchemaGap, pendingMetadata } = await import("../db.js");
    const { serializeResolution } = await import("../instance.js");
    const gap = pendingSchemaGap(db);
    if (gap) {
      return pendingFailed(
        `${dbPath} ${gap}. Remedy: start the current relay once against this DB (the daemon migrates the schema in place), then retry.`,
      );
    }

    const meta = pendingMetadata(db, name, { contentFor: args.withContent });
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
          // ADR-0048: the SAME resolution object `relay where --json` prints, from
          // the SAME serializer (a contract test holds the two equal).
          resolution: resolution ? serializeResolution(resolution) : null,
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
