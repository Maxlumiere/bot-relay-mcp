// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 4c.3 — schema_info table + getSchemaVersion + applyMigration stub.
 *
 * Retrofits the hardcoded SCHEMA_VERSION from Phase 2c (src/backup.ts) into
 * a real DB-level record. Backup manifest now reflects DB-actual.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-schema-info-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
// v2.1.3 I8: scrub inherited RELAY_AGENT_* env vars so isolated tests
// do not auth against a parent-shell spawn-agent.sh token.
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
delete process.env.RELAY_ALLOW_LEGACY;

const {
  initializeDb,
  getDb,
  closeDb,
  getSchemaVersion,
  applyMigration,
  CURRENT_SCHEMA_VERSION,
} = await import("../src/db.js");
const { exportRelayState } = await import("../src/backup.js");

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
}
beforeEach(cleanup);
afterEach(cleanup);

describe("v2.1 Phase 4c.3 — schema_info table", () => {
  it("(1) fresh initializeDb creates schema_info row with version = CURRENT_SCHEMA_VERSION", async () => {
    await initializeDb();
    const row = getDb()
      .prepare("SELECT id, version, initialized_at, last_migrated_at FROM schema_info WHERE id = 1")
      .get() as { id: number; version: number; initialized_at: string; last_migrated_at: string } | undefined;
    expect(row).toBeTruthy();
    expect(row!.id).toBe(1);
    expect(row!.version).toBe(CURRENT_SCHEMA_VERSION);
    expect(row!.initialized_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(row!.last_migrated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("(2) existing DB without schema_info: init inserts the row idempotently + preserves initialized_at", async () => {
    // Create a fresh DB and init it. Then close, DELETE the schema_info row
    // (simulating a pre-v2.1 DB), reopen — row should be reinserted by INSERT
    // OR IGNORE. Re-init a third time — initialized_at must NOT change.
    await initializeDb();
    const firstInit = getDb()
      .prepare("SELECT initialized_at FROM schema_info WHERE id = 1")
      .get() as { initialized_at: string };
    expect(firstInit.initialized_at).toBeTruthy();

    // Simulate pre-v2.1 DB: remove the row.
    getDb().prepare("DELETE FROM schema_info").run();
    closeDb();

    // Re-init — the row should be re-inserted.
    await initializeDb();
    const reInit = getDb()
      .prepare("SELECT initialized_at, last_migrated_at FROM schema_info WHERE id = 1")
      .get() as { initialized_at: string; last_migrated_at: string };
    expect(reInit.initialized_at).toBeTruthy();

    // Re-init a third time — initialized_at stays because INSERT OR IGNORE
    // won't re-write it, but last_migrated_at bumps every startup.
    const before = reInit.initialized_at;
    closeDb();
    await new Promise((r) => setTimeout(r, 50));
    await initializeDb();
    const third = getDb()
      .prepare("SELECT initialized_at FROM schema_info WHERE id = 1")
      .get() as { initialized_at: string };
    expect(third.initialized_at).toBe(before);
  });

  it("(3) getSchemaVersion returns the stored value", async () => {
    await initializeDb();
    expect(getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("(4) backup manifest now reflects schema_info.version (not a local constant)", async () => {
    await initializeDb();
    const result = await exportRelayState();
    // Extract manifest
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), "verify-"));
    try {
      spawnSync("tar", ["-xzf", result.archive_path, "-C", stage], { encoding: "utf-8" });
      const manifest = JSON.parse(fs.readFileSync(path.join(stage, "manifest.json"), "utf-8"));
      expect(manifest.schema_version).toBe(CURRENT_SCHEMA_VERSION);
      expect(manifest.schema_version).toBe(getSchemaVersion());
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  });

  it("(5) import refuses when archive's manifest version > getSchemaVersion()", async () => {
    // Reuse the existing Phase 2c test for the >version refusal path — this
    // test simply confirms the comparison now keys on getSchemaVersion() via
    // the CURRENT_SCHEMA_VERSION constant. Covered by tests/backup.test.ts
    // test (5) which patches a manifest to CURRENT_SCHEMA_VERSION + 1.
    // Here we just sanity-check the plumbing: CURRENT_SCHEMA_VERSION must
    // equal getSchemaVersion() for any freshly-inited DB.
    await initializeDb();
    expect(CURRENT_SCHEMA_VERSION).toBe(getSchemaVersion());
  });

  it("(6) applyMigration: 1→2, 2→3, 3→4, 4→5, 5→6 are registered no-ops; unregistered pairs throw", async () => {
    // v2.1 Phase 4b.1 v2 bumped 1 → 2 (auth_state); Phase 4p bumped 2 → 3
    // (webhook secret encryption); Phase 4b.2 bumped 3 → 4 (managed column
    // + rotation_grace state); Phase 4b.3 bumped 4 → 5 (reencryption_progress
    // table + keyring-aware encryption); Phase 7q bumped 5 → 6 (mailbox +
    // agent_cursor design-freeze tables, agents.visibility column). All
    // mutations are applied at init; the applyMigration hook is a semantic
    // ack for backup/restore's version dispatcher. Unregistered pairs throw.
    await initializeDb();
    expect(() => applyMigration(1, 2)).not.toThrow();
    expect(() => applyMigration(2, 3)).not.toThrow();
    expect(() => applyMigration(3, 4)).not.toThrow();
    expect(() => applyMigration(4, 5)).not.toThrow();
    expect(() => applyMigration(5, 6)).not.toThrow();
    expect(() => applyMigration(6, 7)).not.toThrow();
    // v2.1.6 registered 7→8 (migrateSchemaToV2_6: session_started_at column).
    expect(() => applyMigration(7, 8)).not.toThrow();
    // v2.2.0 registered 8→9 (migrateSchemaToV2_7: terminal_title_ref column).
    expect(() => applyMigration(8, 9)).not.toThrow();
    // v2.2.1 registered 9→10 (migrateSchemaToV2_8: dashboard_prefs table).
    expect(() => applyMigration(9, 10)).not.toThrow();
    expect(() => applyMigration(10, 11)).toThrow(/no migration registered|10→11/);
  });

  it("(7) CHECK constraint enforces single-row: INSERT id=2 fails", async () => {
    await initializeDb();
    expect(() =>
      getDb()
        .prepare(
          "INSERT INTO schema_info (id, version, initialized_at, last_migrated_at) VALUES (2, 1, ?, ?)"
        )
        .run(new Date().toISOString(), new Date().toISOString())
    ).toThrow();
  });
});
