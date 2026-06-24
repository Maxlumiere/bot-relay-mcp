// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.7 Tether Phase 3 R1 — seeded-version migration regression.
 *
 * A Codex audit caught a P1 in the Phase 3 R0 release: on a live DB whose
 * recorded `schema_info.version` was 11, Phase 3's
 * `migrateSchemaToV2_10` created the `inbox_events` table (v12 content)
 * but the version field stayed at 11 forever — because
 * `initSchema`'s `INSERT OR IGNORE` is a no-op for existing rows and
 * the subsequent `UPDATE` only refreshed `last_migrated_at`.
 *
 * Impact pre-fix: `relay doctor` reports "DB at version 11, code
 * expects 12 — migration needed" forever on existing DBs even after a
 * daemon restart that runs every migration cleanly. The backup manifest
 * also reports the stale 11.
 *
 * Walk-analogous-surfaces: every prior schema bump (v9→v10, v10→v11, …)
 * had the same latent bug. The fix is structural: a single
 * `advanceSchemaVersionIfBehind` helper called from both init chains
 * and each applyMigration case. This test pins the contract for v11→v12
 * specifically and also walks the analogous v10→v12 case so future
 * bumps inherit the same coverage shape.
 *
 * Test pattern: seed a fresh tmp SQLite with a prior version row +
 * the minimum table shape needed for getDb() to not crash, then run
 * the init chain via getDb() and assert:
 *   - getSchemaVersion() === CURRENT_SCHEMA_VERSION
 *   - the new v12 table (`inbox_events`) exists
 *   - last_migrated_at advanced
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-r1-seeded-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
delete process.env.RELAY_ALLOW_LEGACY;

const {
  closeDb,
  getDb,
  getSchemaVersion,
  CURRENT_SCHEMA_VERSION,
} = await import("../src/db.js");

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
}
beforeEach(cleanup);
afterEach(cleanup);

/**
 * Seed a tmp SQLite file with a `schema_info` row at `seededVersion` and
 * no v12-specific tables. better-sqlite3 only — we bypass our own
 * driver wrapper because we want to write a minimum-shape file before
 * getDb()'s migration chain ever runs. The init chain's idempotent
 * helpers will then create everything else.
 */
async function seedDbAtVersion(seededVersion: number): Promise<void> {
  fs.mkdirSync(TEST_DB_DIR, { recursive: true, mode: 0o700 });
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = (await import("better-sqlite3")).default;
  const seed = new Database(TEST_DB_PATH);
  seed.pragma("journal_mode = WAL");
  // The minimum-required shape for initSchema to not double-insert:
  // the schema_info table itself + one seeded row at the requested
  // version. Every other table is created idempotently by initSchema /
  // migrateSchemaToV2_X via CREATE TABLE IF NOT EXISTS.
  seed.exec(`
    CREATE TABLE IF NOT EXISTS schema_info (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL,
      initialized_at TEXT NOT NULL,
      last_migrated_at TEXT NOT NULL
    );
  `);
  const seededInitTime = "2026-01-01T00:00:00.000Z";
  seed.prepare(
    "INSERT INTO schema_info (id, version, initialized_at, last_migrated_at) VALUES (1, ?, ?, ?)",
  ).run(seededVersion, seededInitTime, seededInitTime);
  seed.close();
}

describe("v2.7 Tether Phase 3 R1 — seeded-version migration sync", () => {
  it("seeded at v11 (no inbox_events table) advances to CURRENT_SCHEMA_VERSION and creates inbox_events", async () => {
    await seedDbAtVersion(11);
    // Sanity: the seed wrote v11 and no inbox_events table.
    {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Database = (await import("better-sqlite3")).default;
      const probe = new Database(TEST_DB_PATH, { readonly: true });
      const row = probe.prepare("SELECT version FROM schema_info WHERE id = 1").get() as { version: number };
      expect(row.version).toBe(11);
      const inboxEventsExists = probe
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='inbox_events'")
        .get();
      expect(inboxEventsExists).toBeUndefined();
      probe.close();
    }

    // Trigger the init chain by opening via the production getDb path.
    const db = getDb();

    // 1. Version field advanced.
    expect(getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION);

    // 2. v12 table exists.
    const inboxEventsRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='inbox_events'")
      .get() as { name: string } | undefined;
    expect(inboxEventsRow?.name).toBe("inbox_events");

    // 3. last_migrated_at advanced past the seeded timestamp.
    const meta = db
      .prepare("SELECT version, initialized_at, last_migrated_at FROM schema_info WHERE id = 1")
      .get() as { version: number; initialized_at: string; last_migrated_at: string };
    expect(meta.version).toBe(CURRENT_SCHEMA_VERSION);
    expect(meta.initialized_at).toBe("2026-01-01T00:00:00.000Z"); // preserved
    expect(new Date(meta.last_migrated_at).getTime()).toBeGreaterThan(
      new Date("2026-01-01T00:00:00.000Z").getTime(),
    );
  });

  it("walk-analogous: seeded at v10 advances to CURRENT_SCHEMA_VERSION (every prior bump shared the latent bug)", async () => {
    await seedDbAtVersion(10);
    const db = getDb();
    expect(getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
    // inbox_events still exists (the new v12 table) — proves migrations
    // ran past v10 too.
    const inboxEventsRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='inbox_events'")
      .get() as { name: string } | undefined;
    expect(inboxEventsRow?.name).toBe("inbox_events");
  });

  it("fresh DB (no schema_info row) reaches CURRENT_SCHEMA_VERSION cleanly (regression: helper must not over-write a fresh insert)", async () => {
    // No seed — first getDb() will both insert AND finalize. Both code
    // paths set the same version; the finalizer is a no-op (version
    // already at target).
    fs.mkdirSync(TEST_DB_DIR, { recursive: true, mode: 0o700 });
    const db = getDb();
    expect(getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
    const inboxEventsRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='inbox_events'")
      .get() as { name: string } | undefined;
    expect(inboxEventsRow?.name).toBe("inbox_events");
  });

  it("idempotent: second getDb() on an already-current DB does not bump version backward or re-touch last_migrated_at unnecessarily", async () => {
    fs.mkdirSync(TEST_DB_DIR, { recursive: true, mode: 0o700 });
    const db1 = getDb();
    expect(getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
    const t1 = db1
      .prepare("SELECT last_migrated_at FROM schema_info WHERE id = 1")
      .get() as { last_migrated_at: string };
    closeDb();

    await new Promise((res) => setTimeout(res, 20));
    const db2 = getDb();
    // Version still at current.
    expect(getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
    // last_migrated_at MAY advance (initSchema bumps it as a heartbeat),
    // but the finalizer must NOT have logged an "advanced from X → Y"
    // — that would mean a no-op write fired. We can't easily assert on
    // log output from in-process tests, so this is a soft check: the
    // version field is unchanged, no exception thrown.
    const t2 = db2
      .prepare("SELECT version, last_migrated_at FROM schema_info WHERE id = 1")
      .get() as { version: number; last_migrated_at: string };
    expect(t2.version).toBe(CURRENT_SCHEMA_VERSION);
    // Soft monotonicity: t2.last_migrated_at >= t1.last_migrated_at.
    expect(new Date(t2.last_migrated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(t1.last_migrated_at).getTime(),
    );
  });
});
