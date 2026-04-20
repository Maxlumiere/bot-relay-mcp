// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 4b.3 — `relay re-encrypt` subcommand.
 *
 * Scans all encrypted-column rows across 5 tables, decrypts rows tagged
 * with --from, re-encrypts with --to, writes back under a CAS guard so
 * concurrent daemon writes don't collide. Resumable via the
 * reencryption_progress table.
 *
 * Key retirement flow:
 *   1. Add new key to keyring, set current=new_key.
 *   2. relay re-encrypt --from old_key --to new_key
 *   3. relay re-encrypt --verify-clean old_key   (must return count=0)
 *   4. Remove old_key from keyring; restart daemon.
 *
 * Exit codes:
 *   0 — complete (all rows migrated, or verify-clean returned 0)
 *   1 — argv error, user aborted
 *   2 — environmental error (DB, keyring, I/O)
 *   3 — partial (resumable — re-run to continue)
 */
import os from "os";
import * as readline from "readline/promises";
import { randomUUID } from "crypto";

/** Five encrypted-column targets. table_name values map to this list. */
interface ColumnTarget {
  table: string;
  col: string;
  pkCol: string;
  progressTableName: string; // distinct per column for resumability
}

const TARGETS: ColumnTarget[] = [
  { table: "messages", col: "content", pkCol: "id", progressTableName: "messages" },
  { table: "tasks", col: "description", pkCol: "id", progressTableName: "tasks_description" },
  { table: "tasks", col: "result", pkCol: "id", progressTableName: "tasks_result" },
  { table: "audit_log", col: "params_json", pkCol: "id", progressTableName: "audit_log" },
  { table: "webhook_subscriptions", col: "secret", pkCol: "id", progressTableName: "webhook_subscriptions" },
];

interface Args {
  from: string | null;
  to: string | null;
  yes: boolean;
  dryRun: boolean;
  batchSize: number;
  verifyClean: string | null;
  dbPath: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    from: null,
    to: null,
    yes: false,
    dryRun: false,
    batchSize: 100,
    verifyClean: null,
    dbPath: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--from") out.from = argv[++i] ?? null;
    else if (a === "--to") out.to = argv[++i] ?? null;
    else if (a === "--verify-clean") out.verifyClean = argv[++i] ?? null;
    else if (a === "--batch-size") {
      const n = parseInt(argv[++i] ?? "", 10);
      if (!Number.isFinite(n) || n < 1 || n > 10000) {
        throw new Error(`--batch-size must be in [1, 10000]; got "${argv[i]}"`);
      }
      out.batchSize = n;
    } else if (a === "--db-path") {
      out.dbPath = argv[++i] ?? null;
      if (!out.dbPath) throw new Error("--db-path requires a path argument");
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return out;
}

function printUsage(): void {
  process.stdout.write(
    "Usage: relay re-encrypt [--from KEY_ID] [--to KEY_ID] [--yes] [--dry-run]\n" +
      "                        [--batch-size N] [--verify-clean KEY_ID]\n" +
      "                        [--db-path PATH]\n\n" +
      "Re-encrypts stored ciphertext rows from one key_id to another.\n\n" +
      "Flags:\n" +
      "  --from KEY_ID         Source key to migrate away from. Required unless\n" +
      "                        --verify-clean is given.\n" +
      "  --to KEY_ID           Target key (defaults to keyring.current).\n" +
      "  --yes                 Skip the interactive confirmation prompt.\n" +
      "  --dry-run             Count rows per table/key_id, print plan, no writes.\n" +
      "  --batch-size N        Rows per txn (default 100, max 10000).\n" +
      "  --verify-clean KEY_ID Count rows still carrying KEY_ID across all 5\n" +
      "                        encrypted columns. Exit 0 if all zero (safe to\n" +
      "                        retire); exit 1 otherwise (breakdown on stderr).\n" +
      "  --db-path PATH        Operate on the DB at PATH (default RELAY_DB_PATH\n" +
      "                        or ~/.bot-relay/relay.db).\n" +
      "  --help                Show this message.\n\n" +
      "Key retirement flow:\n" +
      "  1. Add new key to keyring + set current=new_key.\n" +
      "  2. relay re-encrypt --from old --to new --yes\n" +
      "  3. relay re-encrypt --verify-clean old      # must return 0\n" +
      "  4. Remove old from keyring + restart daemon.\n\n" +
      "See docs/key-rotation.md for the full runbook.\n"
  );
}

export async function run(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  if (args.help) {
    printUsage();
    return 0;
  }

  if (args.dbPath) process.env.RELAY_DB_PATH = args.dbPath;

  let db: any;
  let keyringInfo: { current: string | null; known_key_ids: string[]; legacy_key_id: string };
  try {
    const { initializeDb, getDb } = await import("../db.js");
    await initializeDb();
    db = getDb();
    const { getKeyringInfo } = await import("../encryption.js");
    keyringInfo = getKeyringInfo();
  } catch (err) {
    process.stderr.write(
      `relay re-encrypt: could not open DB / load keyring: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 2;
  }

  try {
    if (args.verifyClean) {
      return runVerifyClean(db, args.verifyClean, keyringInfo);
    }

    if (!args.from) {
      process.stderr.write("relay re-encrypt: --from KEY_ID is required.\n\n");
      printUsage();
      return 1;
    }
    const toKey = args.to || keyringInfo.current;
    if (!toKey) {
      process.stderr.write(
        "relay re-encrypt: no --to KEY_ID given and no keyring.current resolved.\n"
      );
      return 2;
    }
    if (args.from === toKey) {
      process.stderr.write(
        `relay re-encrypt: --from "${args.from}" equals --to "${toKey}"; nothing to do.\n`
      );
      return 1;
    }
    if (!keyringInfo.known_key_ids.includes(toKey)) {
      process.stderr.write(
        `relay re-encrypt: --to "${toKey}" is not in the keyring. Known: ${keyringInfo.known_key_ids.join(", ")}\n`
      );
      return 2;
    }
    // --from MUST be resolvable too — either current keyring entry OR the
    // legacy_key_id (which maps enc1: rows). Otherwise decryption will fail
    // mid-run.
    const fromResolvable =
      keyringInfo.known_key_ids.includes(args.from) || args.from === keyringInfo.legacy_key_id;
    if (!fromResolvable) {
      process.stderr.write(
        `relay re-encrypt: --from "${args.from}" is not in the keyring and is not the configured legacy_key_id ("${keyringInfo.legacy_key_id}"). Add it to the keyring first.\n`
      );
      return 2;
    }

    // Print plan.
    const plan = countRows(db, args.from, keyringInfo.legacy_key_id);
    const totalPlan = plan.reduce((a, b) => a + b.count, 0);
    process.stdout.write(
      `Re-encrypt plan: ${totalPlan} row(s) from key_id="${args.from}" to key_id="${toKey}"\n`
    );
    for (const p of plan) {
      process.stdout.write(`  ${p.table}.${p.col}: ${p.count}\n`);
    }
    if (totalPlan === 0) {
      process.stdout.write("Nothing to do.\n");
      return 0;
    }

    if (args.dryRun) {
      process.stdout.write("DRY RUN — no writes.\n");
      return 0;
    }

    if (!args.yes) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const ans = (await rl.question("Proceed? [y/N]: ")).trim().toLowerCase();
        if (ans !== "y" && ans !== "yes") {
          process.stdout.write("Aborted.\n");
          return 1;
        }
      } finally {
        rl.close();
      }
    }

    // Run the migration.
    const partial = await runMigration(db, args.from, toKey, keyringInfo.legacy_key_id, args.batchSize);
    return partial ? 3 : 0;
  } finally {
    try {
      const { closeDb } = await import("../db.js");
      closeDb();
    } catch {
      /* ignore */
    }
  }
}

/** Build the SELECT predicate that matches rows carrying `fromKeyId`. */
function fromPredicate(fromKeyId: string, legacyKeyId: string): {
  clause: string;
  params: string[];
} {
  if (fromKeyId === legacyKeyId) {
    // Match BOTH enc:<legacy_id>:% (explicit) AND enc1:% (legacy prefix).
    return {
      clause: `{col} LIKE ? OR {col} LIKE 'enc1:%'`,
      params: [`enc:${fromKeyId}:%`],
    };
  }
  return {
    clause: `{col} LIKE ?`,
    params: [`enc:${fromKeyId}:%`],
  };
}

function countRows(
  db: any,
  fromKeyId: string,
  legacyKeyId: string
): Array<{ table: string; col: string; count: number }> {
  const out: Array<{ table: string; col: string; count: number }> = [];
  for (const t of TARGETS) {
    const pred = fromPredicate(fromKeyId, legacyKeyId);
    const clause = pred.clause.replace(/{col}/g, t.col);
    const sql = `SELECT COUNT(*) AS c FROM ${t.table} WHERE ${clause}`;
    const row = db.prepare(sql).get(...pred.params) as { c: number };
    out.push({ table: t.table, col: t.col, count: row.c });
  }
  return out;
}

function runVerifyClean(
  db: any,
  keyId: string,
  keyringInfo: { current: string | null; known_key_ids: string[]; legacy_key_id: string }
): number {
  const plan = countRows(db, keyId, keyringInfo.legacy_key_id);
  const total = plan.reduce((a, b) => a + b.count, 0);
  process.stdout.write(`Pending rows for key_id "${keyId}":\n`);
  for (const p of plan) {
    const marker = p.count > 0 ? "  ← blocks retirement" : "";
    process.stdout.write(`  ${p.table}.${p.col}: ${p.count}${marker}\n`);
  }
  process.stdout.write(`TOTAL: ${total}. Retirement ${total === 0 ? "SAFE." : "UNSAFE."}\n`);
  return total === 0 ? 0 : 1;
}

async function runMigration(
  db: any,
  fromKeyId: string,
  toKeyId: string,
  legacyKeyId: string,
  batchSize: number
): Promise<boolean> {
  const { reencryptRow } = await import("../encryption.js");
  const newRunId = randomUUID();
  const startedAt = new Date().toISOString();
  let anyPartial = false;

  // v2.1 Phase 7p MED #3: reclaim stale runs. A hard-interrupted prior run
  // (SIGKILL, crash, host reboot) leaves its progress row at status='running'
  // forever, blocking every subsequent invocation via the unique partial
  // index. Before INSERTing a fresh row, scan for any existing running row
  // for the same (from, to, table) triple; if its started_at is older than
  // the stale threshold, treat it as abandoned and RESUME from its cursor.
  // That turns a previously-fatal blocker into auto-healing.
  const STALE_RUN_SECONDS = 3600; // 1h — matches Codex spec
  const nowMs = Date.now();

  for (const t of TARGETS) {
    // First: check if a running row already exists for this (from, to, table).
    const existing = db.prepare(
      `SELECT run_id, last_row_id, rows_processed, started_at FROM reencryption_progress
       WHERE from_key_id = ? AND to_key_id = ? AND table_name = ? AND status = 'running'`
    ).get(fromKeyId, toKeyId, t.progressTableName) as
      | { run_id: string; last_row_id: string | null; rows_processed: number; started_at: string }
      | undefined;

    let runId: string = newRunId;
    let resumeLastRowId: string | null = null;
    let resumedRowsProcessed = 0;

    if (existing) {
      const ageSeconds = (nowMs - new Date(existing.started_at).getTime()) / 1000;
      if (ageSeconds < STALE_RUN_SECONDS) {
        // Fresh running row — treat as truly concurrent. Skip this table.
        process.stderr.write(
          `[re-encrypt] skipping ${t.table}.${t.col}: concurrent run_id=${existing.run_id} active ` +
            `(started ${Math.round(ageSeconds)}s ago, stale threshold ${STALE_RUN_SECONDS}s).\n`
        );
        anyPartial = true;
        continue;
      }
      // Stale — reclaim: reuse existing run_id + cursor, refresh started_at.
      runId = existing.run_id;
      resumeLastRowId = existing.last_row_id;
      resumedRowsProcessed = existing.rows_processed;
      db.prepare(
        `UPDATE reencryption_progress SET started_at = ? WHERE run_id = ? AND table_name = ? AND status = 'running'`
      ).run(startedAt, runId, t.progressTableName);
      process.stdout.write(
        `[re-encrypt] reclaiming stale run ${runId} for ${t.table}.${t.col} ` +
          `(age=${Math.round(ageSeconds)}s, resume from row_id=${resumeLastRowId ?? "<start>"}, processed=${resumedRowsProcessed}).\n`
      );
    } else {
      // No existing running row — insert a fresh one. This still takes the
      // unique-partial-index; any race with another starter is rejected by
      // the DB, matching the single-active-run invariant.
      try {
        db.prepare(
          `INSERT INTO reencryption_progress (run_id, from_key_id, to_key_id, table_name, started_at, status, rows_processed)
           VALUES (?, ?, ?, ?, ?, 'running', 0)`
        ).run(runId, fromKeyId, toKeyId, t.progressTableName, startedAt);
      } catch (err) {
        // Concurrent starter won the race between our SELECT and INSERT.
        // Surface and move on — resume will pick it up next invocation.
        process.stderr.write(
          `[re-encrypt] skipping ${t.table}.${t.col}: concurrent run landed mid-check (${err instanceof Error ? err.message : String(err)})\n`
        );
        anyPartial = true;
        continue;
      }
    }

    let rowsProcessed = resumedRowsProcessed;
    let lastRowId: string | null = resumeLastRowId;
    try {
      // Process in ordered batches. Each batch is its own transaction.
      // The CAS-on-original-ciphertext UPDATE (WHERE id=? AND col=?original)
      // makes concurrent daemon writes safe: if a row was touched between
      // our SELECT + UPDATE, changes=0, we skip it (the new write already
      // uses the current key, so it's correct either way).
      while (true) {
        const pred = fromPredicate(fromKeyId, legacyKeyId);
        const clause = pred.clause.replace(/{col}/g, t.col);
        const cursorClause = lastRowId ? ` AND ${t.pkCol} > ?` : "";
        const sql = `SELECT ${t.pkCol} AS pk, ${t.col} AS ct FROM ${t.table} WHERE ${clause}${cursorClause} ORDER BY ${t.pkCol} ASC LIMIT ${batchSize}`;
        const sqlParams = lastRowId ? [...pred.params, lastRowId] : pred.params;
        const batch = db.prepare(sql).all(...sqlParams) as Array<{ pk: string; ct: string }>;
        if (batch.length === 0) break;

        const update = db.prepare(
          `UPDATE ${t.table} SET ${t.col} = ? WHERE ${t.pkCol} = ? AND ${t.col} = ?`
        );

        const txFn = db.transaction(() => {
          let casMisses = 0;
          for (const row of batch) {
            try {
              const newCt = reencryptRow(row.ct, toKeyId);
              const r = update.run(newCt, row.pk, row.ct);
              if (r.changes === 0) casMisses++;
            } catch (err) {
              throw new Error(
                `reencrypt failed on ${t.table}.${t.pkCol}="${row.pk}": ${
                  err instanceof Error ? err.message : String(err)
                }`
              );
            }
          }
          return casMisses;
        });
        const casMisses = txFn();

        rowsProcessed += batch.length;
        lastRowId = batch[batch.length - 1].pk;
        db.prepare(
          `UPDATE reencryption_progress SET rows_processed = ?, last_row_id = ? WHERE run_id = ? AND table_name = ?`
        ).run(rowsProcessed, lastRowId, runId, t.progressTableName);

        process.stdout.write(
          `[re-encrypt] ${t.table}.${t.col}: batch of ${batch.length} (cumulative=${rowsProcessed}${
            casMisses > 0 ? `, ${casMisses} CAS miss${casMisses === 1 ? "" : "es"}` : ""
          })\n`
        );

        if (batch.length < batchSize) break;
      }
      // Done for this table.
      db.prepare(
        `UPDATE reencryption_progress SET status = 'completed', completed_at = ? WHERE run_id = ? AND table_name = ?`
      ).run(new Date().toISOString(), runId, t.progressTableName);
    } catch (err) {
      process.stderr.write(
        `[re-encrypt] aborted ${t.table}.${t.col}: ${err instanceof Error ? err.message : String(err)}\n`
      );
      db.prepare(
        `UPDATE reencryption_progress SET status = 'aborted' WHERE run_id = ? AND table_name = ?`
      ).run(runId, t.progressTableName);
      anyPartial = true;
    }
  }

  return anyPartial;
}

// Silence the unused-os warning when the module is imported but run() isn't called.
void os;
