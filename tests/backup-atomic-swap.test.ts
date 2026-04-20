// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 4q MED #5 — backup restore uses atomic rename replace.
 *
 * Broken-before: restore unlinked srcDbPath BEFORE renaming `.new` →
 * srcDbPath. Between the two syscalls, the expected DB path didn't exist.
 * A signal-interrupted restore or a concurrent daemon boot would find a
 * missing DB.
 *
 * Fixed: direct `fs.renameSync(newPath, srcDbPath)` (POSIX atomic replace).
 * WAL/shm cleanup runs AFTER the rename, so an in-progress restore never
 * exposes a window where the DB file is absent. Windows falls back to
 * copy+unlink (documented as non-atomic).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_ROOT = path.join(os.tmpdir(), "bot-relay-4q-swap-" + process.pid);
const TEST_DB_PATH = path.join(TEST_ROOT, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
process.env.RELAY_CONFIG_PATH = path.join(TEST_ROOT, "config.json");

function resetRoot() {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
}

beforeEach(async () => {
  resetRoot();
  const { closeDb } = await import("../src/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db.js");
  closeDb();
  resetRoot();
});

async function seedAndBackup(): Promise<string> {
  const { initializeDb, registerAgent } = await import("../src/db.js");
  await initializeDb();
  registerAgent("swap-alpha", "r", []);
  registerAgent("swap-beta", "r", []);
  const { exportRelayState } = await import("../src/backup.js");
  const result = await exportRelayState();
  const { closeDb } = await import("../src/db.js");
  closeDb();
  return result.archive_path;
}

describe("v2.1 Phase 4q MED #5 — atomic backup swap", () => {
  it("(1) srcDbPath exists continuously through restore (no unlink-before-rename window)", async () => {
    const archive = await seedAndBackup();

    // Poll DB file existence from a sibling timer while the restore runs.
    // Any moment where the file is MISSING → fix is incomplete.
    let everMissing = false;
    let polls = 0;
    const interval = setInterval(() => {
      polls++;
      if (!fs.existsSync(TEST_DB_PATH)) {
        everMissing = true;
      }
    }, 1);

    try {
      const { importRelayState } = await import("../src/backup.js?swap1=1");
      // force:true bypasses the live-daemon probe — this test harness
      // runs alongside Maxime's dev daemon on :3777 which is expected.
      await importRelayState(archive, { force: true });
    } finally {
      clearInterval(interval);
    }

    // Sanity: we actually polled. Without this the assertion is vacuous.
    // Sanity: we actually polled — non-vacuous assertion below.
    expect(polls).toBeGreaterThanOrEqual(3);
    expect(everMissing).toBe(false);
    // DB ends up present post-restore.
    expect(fs.existsSync(TEST_DB_PATH)).toBe(true);
  });

  it("(2) stale WAL/shm from the pre-restore session is removed after the rename", async () => {
    const archive = await seedAndBackup();

    // Simulate a stale WAL + shm left behind by a prior DB session. These
    // files typically exist when the daemon exits without a clean close.
    fs.writeFileSync(TEST_DB_PATH + "-wal", "stale-wal-content");
    fs.writeFileSync(TEST_DB_PATH + "-shm", "stale-shm-content");
    expect(fs.existsSync(TEST_DB_PATH + "-wal")).toBe(true);
    expect(fs.existsSync(TEST_DB_PATH + "-shm")).toBe(true);

    const { importRelayState } = await import("../src/backup.js?swap2=1");
    await importRelayState(archive, { force: true });

    // Post-restore: the WAL/shm from the prior session are gone. SQLite
    // regenerates them on the next open from the restored DB. (A fresh WAL
    // may exist from the post-restore open step; we assert that the stale
    // content we seeded is no longer present.)
    const walContent = fs.existsSync(TEST_DB_PATH + "-wal")
      ? fs.readFileSync(TEST_DB_PATH + "-wal", "utf-8")
      : "";
    const shmContent = fs.existsSync(TEST_DB_PATH + "-shm")
      ? fs.readFileSync(TEST_DB_PATH + "-shm", "utf-8")
      : "";
    expect(walContent).not.toContain("stale-wal-content");
    expect(shmContent).not.toContain("stale-shm-content");
    // DB itself is present.
    expect(fs.existsSync(TEST_DB_PATH)).toBe(true);
  });
});
