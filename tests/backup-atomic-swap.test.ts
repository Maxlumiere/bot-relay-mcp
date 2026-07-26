// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 4q MED #5 — backup restore uses atomic rename replace.
 * Re-tested to ADR-0015 (the guard-construction invariant): assert the HARM is
 * impossible, not a proxy for it.
 *
 * HARM: a concurrent reader (a daemon boot, a signal-interrupted restore)
 *   observes the DB at its expected path either MISSING or HALF-WRITTEN during a
 *   restore. The original bug unlinked srcDbPath BEFORE renaming `.new` into
 *   place, leaving a window where the path did not exist.
 * PREDICATE: during a restore, srcDbPath is replaced by EXACTLY ONE atomic
 *   `rename(2)` INTO place, and is NEVER removed, moved away, truncated, or
 *   written non-atomically. POSIX `rename(2)` is the only file op that swaps a
 *   path's contents with zero observable intermediate state, so "one rename-in,
 *   zero destructive/non-atomic ops on the path" IS the impossibility of the
 *   harm — not a sample of it.
 *
 * WHY THE OLD TEST WAS A PROXY: it polled `fs.existsSync(srcDbPath)` on a 1ms
 *   timer and asserted `polls >= 3` ("we looked enough") + `everMissing===false`.
 *   Counting samples establishes that we looked, not that the file was never torn
 *   — a sub-millisecond unlink→rename gap can slip between two 1ms samples, so a
 *   green run did NOT mean the window was closed, and `polls >= 3` flaked when the
 *   restore outran the timer (macOS CI, #140 run 30157698051). Sampling can miss
 *   the harm; INTERCEPTING every filesystem syscall cannot.
 *
 * BYPASS INVENTORY (every way the DB path could be left missing/torn, asserted):
 *   unlink-before-rename · rename-the-DB-AWAY-then-rename-in · truncate-then-write
 *   · a non-atomic copyFileSync/writeFileSync directly onto srcDbPath. Each is a
 *   distinct fs op whose effective target is srcDbPath; the test flags all of them
 *   and permits only `rename(newPath → srcDbPath)`.
 *
 * WINDOWS: `rename(2)`'s atomic-replace guarantee is POSIX; src/backup.ts falls
 *   back to a DOCUMENTED non-atomic copy+unlink on win32 (Node throws EPERM
 *   renaming onto an existing file). The atomicity assertion is therefore
 *   POSIX-only and skipped on win32 rather than asserting a guarantee the OS does
 *   not give — an honest boundary, not a hidden pass.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_ROOT = path.join(os.tmpdir(), "bot-relay-4q-swap-" + process.pid);
const TEST_DB_PATH = path.join(TEST_ROOT, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
// v2.1.3 I8: scrub inherited RELAY_AGENT_* env vars so isolated tests
// do not auth against a parent-shell spawn-agent.sh token.
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
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
  vi.restoreAllMocks();
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
  it.skipIf(process.platform === "win32")(
    "(1) HARM: srcDbPath is replaced by exactly ONE atomic rename-into-place, and is NEVER removed / moved away / non-atomically written mid-restore",
    async () => {
      const archive = await seedAndBackup();
      const DB = path.resolve(TEST_DB_PATH);

      // Intercept every fs op that could leave the DB path missing, moved, or
      // half-written. Spies RECORD and call through, so restore behaves exactly
      // as in production; we classify the syscall log AFTER the run. Observing
      // every syscall cannot miss a sub-millisecond torn window the way polling
      // can.
      const spies = {
        renameSync: vi.spyOn(fs, "renameSync"),
        unlinkSync: vi.spyOn(fs, "unlinkSync"),
        rmSync: vi.spyOn(fs, "rmSync"),
        truncateSync: vi.spyOn(fs, "truncateSync"),
        copyFileSync: vi.spyOn(fs, "copyFileSync"),
        writeFileSync: vi.spyOn(fs, "writeFileSync"),
      };
      let atomicReplaces = 0;
      const harmful: string[] = [];

      try {
        const { importRelayState } = await import("../src/backup.js?swaphm=1");
        // force:true bypasses the live-daemon probe — this harness runs
        // alongside a local dev daemon on :3777, which is expected.
        await importRelayState(archive, { force: true });
      } finally {
        // Classify only after the run, so nothing perturbs the restore.
        const isDb = (p: unknown) => typeof p === "string" && path.resolve(p) === DB;
        for (const [from, to] of spies.renameSync.mock.calls as unknown[][]) {
          if (isDb(to)) atomicReplaces++; // rename INTO place — the only safe swap
          if (isDb(from)) harmful.push(`rename moved the DB away (${String(from)} → ${String(to)})`);
        }
        for (const [p] of spies.unlinkSync.mock.calls as unknown[][]) if (isDb(p)) harmful.push("unlink removed the DB");
        for (const [p] of spies.rmSync.mock.calls as unknown[][]) if (isDb(p)) harmful.push("rm removed the DB");
        for (const [p] of spies.truncateSync.mock.calls as unknown[][]) if (isDb(p)) harmful.push("truncate emptied the DB");
        for (const [, dest] of spies.copyFileSync.mock.calls as unknown[][]) if (isDb(dest)) harmful.push("copyFileSync wrote the DB non-atomically");
        for (const [file] of spies.writeFileSync.mock.calls as unknown[][]) if (isDb(file)) harmful.push("writeFileSync wrote the DB non-atomically");
        vi.restoreAllMocks();
      }

      // THE HARM cannot happen: no op ever left the DB missing or half-written.
      expect(harmful, "the DB path must never be removed/moved/torn mid-restore").toEqual([]);
      // NON-VACUOUS (this replaces the flaky `polls >= 3`): the swap actually
      // happened, via exactly one atomic rename into the DB path — so the empty
      // `harmful` list is a real guarantee, not "nothing ran".
      expect(atomicReplaces, "restore must replace the DB by exactly one atomic rename-into-place").toBe(1);

      // INNOCENT TWIN (outcome): the DB is present and holds the restored data.
      expect(fs.existsSync(TEST_DB_PATH)).toBe(true);
      const { initializeDb, getAgents, closeDb } = await import("../src/db.js?swaphm-verify=1");
      await initializeDb();
      const names = getAgents().map((a) => a.name).sort();
      closeDb();
      expect(names).toContain("swap-alpha");
      expect(names).toContain("swap-beta");
    },
  );

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

    // Post-restore: the stale WAL/shm from the prior session are gone. SQLite
    // regenerates them on the next open from the restored DB. (A fresh WAL may
    // exist from the post-restore open step; we assert the stale content we
    // seeded is no longer present — the harm is a stale WAL applying to the new
    // DB, not the mere existence of a WAL.)
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
