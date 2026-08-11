// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * #171 — MIGRATION-CHAIN EQUIVALENCE: the two DB init paths cannot drift.
 *
 * `src/db.ts` has two ways a database gets its schema:
 *   - `initializeDb()` — async, driver-aware; the path the server + every CLI
 *     subcommand use.
 *   - `getDb()`'s SYNCHRONOUS native fallback — reached only when getDb() is
 *     called before initializeDb() (some tests rely on it).
 * Before #171 each copy-pasted the entire pragmas + initSchema + migration chain
 * (migrateSchemaToV1_7 … migrateSchemaToV2_24) + seed + finalize + purge, so a
 * new migration had to be added in BOTH or the lazy path silently lagged.
 *
 * #171 single-sources that sequence into `applySchemaSetup`. This test is the
 * codex-required proof that the two paths are now equivalent: it builds a fresh
 * DB via EACH path and asserts an IDENTICAL schema — every sqlite_master object
 * (tables/indexes/triggers) + their DDL, every table's column set, and the
 * recorded `schema_info.version`. A structural guard also asserts the migration
 * chain has exactly one call site (in applySchemaSetup), so a future re-duplication
 * reds here rather than drifting silently.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.join(os.tmpdir(), "bot-relay-migchain-" + process.pid);
process.env.RELAY_DB_PATH = path.join(TEST_DIR, "relay.db");

// #171 / codex isolation fix: PIN the driver to native BEFORE importing db.js.
// This is a native-initializeDb() vs native-getDb()-fallback equivalence proof.
// Without the pin, an ambient RELAY_SQLITE_DRIVER=wasm silently makes Path A
// (initializeDb) run on WASM while Path B (getDb fallback) is ALWAYS native — the
// test would then pass as a cross-driver comparison, for the wrong reason. WASM
// schema coverage lives separately in tests/db-wasm.test.ts. Saved + restored
// (afterAll) so this file never leaks the override to another suite in the worker.
const PRIOR_SQLITE_DRIVER = process.env.RELAY_SQLITE_DRIVER;
process.env.RELAY_SQLITE_DRIVER = "native";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { closeDb, getDb, initializeDb, CURRENT_SCHEMA_VERSION } = await import("../src/db.js");
const { getActiveDriver } = await import("../src/sqlite-compat.js");

interface SchemaShape {
  objects: Array<{ type: string; name: string; sql: string | null }>;
  columns: Record<string, string[]>;
  version: number;
}

/** Full structural fingerprint of a built DB: DDL of every object + column sets + version. */
function schemaShape(db: ReturnType<typeof getDb>): SchemaShape {
  const objects = db
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all() as Array<{ type: string; name: string; sql: string | null }>;
  const columns: Record<string, string[]> = {};
  for (const o of objects) {
    if (o.type !== "table") continue;
    columns[o.name] = (db.prepare(`PRAGMA table_info("${o.name}")`).all() as { name: string }[])
      .map((c) => c.name)
      .sort();
  }
  const version = (db.prepare("SELECT version FROM schema_info WHERE id = 1").get() as {
    version: number;
  }).version;
  return { objects, columns, version };
}

beforeEach(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  try { closeDb(); } catch { /* ignore */ }
});

afterEach(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

afterAll(() => {
  if (PRIOR_SQLITE_DRIVER === undefined) delete process.env.RELAY_SQLITE_DRIVER;
  else process.env.RELAY_SQLITE_DRIVER = PRIOR_SQLITE_DRIVER;
});

describe("#171 migration-chain equivalence — initializeDb() vs getDb() native fallback", () => {
  it("both init paths produce an IDENTICAL schema (objects + columns) and schema_info.version", async () => {
    // Path A — the eager, driver-aware initializeDb().
    const pathA = path.join(TEST_DIR, "eager.db");
    process.env.RELAY_DB_PATH = pathA;
    closeDb();
    await initializeDb();
    // PIN AND ASSERT: self-verify the native pin actually took, so this can never
    // silently degrade into a cross-driver comparison under an ambient
    // RELAY_SQLITE_DRIVER=wasm (codex's repro). getActiveDriver() reports the
    // driver initializeDb() truly instantiated — pinning without asserting is
    // half the job (the pin can silently fail to take).
    expect(getActiveDriver()).toBe("native");
    const a = schemaShape(getDb()); // getDb() returns the already-initialized _db
    closeDb();

    // Path B — getDb()'s SYNCHRONOUS native lazy-init fallback (getDb() called on
    // a null singleton, no prior initializeDb()).
    const pathB = path.join(TEST_DIR, "lazy.db");
    process.env.RELAY_DB_PATH = pathB;
    closeDb();
    const b = schemaShape(getDb());
    closeDb();

    // Sanity: both actually built a schema at the current version.
    expect(a.version).toBe(CURRENT_SCHEMA_VERSION);
    expect(b.version).toBe(a.version);

    // The contract: identical table/column set and identical object DDL. If a
    // migration is ever added to one path but not the other, this diff reds.
    expect(b.columns).toEqual(a.columns);
    expect(b.objects).toEqual(a.objects);

    // The two DBs are different files (proves we exercised both paths, not one twice).
    expect(pathA).not.toBe(pathB);
    expect(fs.existsSync(pathA)).toBe(true);
    expect(fs.existsSync(pathB)).toBe(true);
  });

  it("STRUCTURAL GUARD — the migration chain is single-sourced (one call site, both paths delegate)", () => {
    const src = fs.readFileSync(path.join(PROJECT_ROOT, "src/db.ts"), "utf8");
    // The last migration in the chain must be invoked exactly ONCE (in
    // applySchemaSetup). Before #171 it appeared twice (both init paths).
    const chainCalls = (src.match(/migrateSchemaToV2_24\((?:_?db)\)/g) ?? []).length;
    expect(chainCalls, "migrateSchemaToV2_24 should have exactly ONE call site (in applySchemaSetup)").toBe(1);
    // Both init paths must delegate to the shared helper.
    expect(src).toMatch(/export async function initializeDb[\s\S]*?applySchemaSetup\(_db\)[\s\S]*?\n}/);
    expect(src).toMatch(/export function getDb[\s\S]*?applySchemaSetup\(_db\)[\s\S]*?return _db/);
    // The helper defines the chain exactly once.
    expect((src.match(/function applySchemaSetup\b/g) ?? []).length).toBe(1);
  });
});
