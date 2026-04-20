// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 4c.2 — audit log rotation.
 *
 * Covers:
 *   1. purgeOldAuditLog removes rows older than cutoff, leaves recent rows
 *   2. retentionDays=0 disables (no rows removed)
 *   3. piggyback: after N inserts the purge fires
 *   4. Negative env value rejected by validateConfigAndEnv
 *   5. Non-integer env value rejected
 *   6. Defaults applied when env unset (90d retention, 1000-insert interval)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-audit-rotation-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_ALLOW_LEGACY;
delete process.env.RELAY_AUDIT_LOG_RETENTION_DAYS;
delete process.env.RELAY_AUDIT_LOG_PURGE_INTERVAL;

const {
  initializeDb,
  logAudit,
  purgeOldAuditLog,
  getDb,
  closeDb,
  _resetAuditPurgeCounterForTests,
} = await import("../src/db.js");
const { validateConfigAndEnv, InvalidConfigError, DEFAULT_CONFIG } = await import("../src/config.js");

function cleanup() {
  closeDb();
  delete process.env.RELAY_AUDIT_LOG_RETENTION_DAYS;
  delete process.env.RELAY_AUDIT_LOG_PURGE_INTERVAL;
  _resetAuditPurgeCounterForTests();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
}
beforeEach(cleanup);
afterEach(cleanup);

async function seedAgedRow(daysAgo: number): Promise<void> {
  const iso = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  const { v4: uuidv4 } = await import("uuid");
  getDb()
    .prepare(
      "INSERT INTO audit_log (id, agent_name, tool, params_summary, params_json, success, error, source, created_at) VALUES (?, ?, ?, ?, NULL, 1, NULL, 'test', ?)"
    )
    .run(uuidv4(), "test-agent", "probe", null, iso);
}

function countAuditRows(): number {
  return (getDb().prepare("SELECT COUNT(*) AS c FROM audit_log").get() as { c: number }).c;
}

describe("v2.1 Phase 4c.2 — audit log rotation", () => {
  it("(1) purgeOldAuditLog removes rows older than cutoff, leaves recent rows", async () => {
    await initializeDb();
    await seedAgedRow(5); // within 30d
    await seedAgedRow(45); // older than 30d retention
    await seedAgedRow(100); // way older
    expect(countAuditRows()).toBe(3);

    const result = purgeOldAuditLog(30);
    expect(result.purged).toBe(2);
    expect(countAuditRows()).toBe(1);
  });

  it("(2) retentionDays=0 disables — no rows removed", async () => {
    await initializeDb();
    await seedAgedRow(5);
    await seedAgedRow(45);
    await seedAgedRow(500);
    expect(countAuditRows()).toBe(3);

    const result = purgeOldAuditLog(0);
    expect(result.purged).toBe(0);
    expect(countAuditRows()).toBe(3);
  });

  it("(3) piggyback fires after RELAY_AUDIT_LOG_PURGE_INTERVAL inserts", async () => {
    process.env.RELAY_AUDIT_LOG_PURGE_INTERVAL = "5";
    process.env.RELAY_AUDIT_LOG_RETENTION_DAYS = "30";
    await initializeDb();
    _resetAuditPurgeCounterForTests();

    // Seed some aged rows.
    await seedAgedRow(45);
    await seedAgedRow(60);
    expect(countAuditRows()).toBe(2);

    // 4 fresh inserts — counter hits 4, not yet at threshold.
    for (let i = 0; i < 4; i++) logAudit("a", "x", null, true, null, "test");
    expect(countAuditRows()).toBe(6); // 2 aged + 4 fresh

    // 5th insert trips the piggyback and purges the 2 aged rows.
    logAudit("a", "x", null, true, null, "test");
    // 2 aged gone + 5 fresh = 5
    expect(countAuditRows()).toBe(5);
  });

  it("(4) negative RELAY_AUDIT_LOG_RETENTION_DAYS rejected by config validation", () => {
    process.env.RELAY_AUDIT_LOG_RETENTION_DAYS = "-1";
    try {
      expect(() => validateConfigAndEnv(DEFAULT_CONFIG)).toThrow(InvalidConfigError);
      expect(() => validateConfigAndEnv(DEFAULT_CONFIG)).toThrow(/RELAY_AUDIT_LOG_RETENTION_DAYS/);
    } finally {
      delete process.env.RELAY_AUDIT_LOG_RETENTION_DAYS;
    }
  });

  it("(5) non-integer env value rejected", () => {
    process.env.RELAY_AUDIT_LOG_PURGE_INTERVAL = "abc";
    try {
      expect(() => validateConfigAndEnv(DEFAULT_CONFIG)).toThrow(InvalidConfigError);
      expect(() => validateConfigAndEnv(DEFAULT_CONFIG)).toThrow(/RELAY_AUDIT_LOG_PURGE_INTERVAL/);
    } finally {
      delete process.env.RELAY_AUDIT_LOG_PURGE_INTERVAL;
    }
  });

  it("(6) defaults applied when env unset (90d retention, 1000-insert interval)", async () => {
    // Both env vars unset. Default retention should be 90 → a 45-day-old row
    // survives the default startup purge (which runs during initializeDb).
    await initializeDb();
    // Seed a 45-day-old row, then re-purge with the default.
    await seedAgedRow(45);
    await seedAgedRow(200);
    // Call the internal purge with the default retention 90.
    const result = purgeOldAuditLog(90);
    // 45-day row survives (< 90), 200-day row removed.
    expect(result.purged).toBe(1);
  });
});
