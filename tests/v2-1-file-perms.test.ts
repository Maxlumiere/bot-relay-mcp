// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 4c.4 — DB + backup + directory perms narrowed to 0600/0700.
 *
 * Skipped on Windows: NTFS uses ACLs, not POSIX mode bits, so fs.chmodSync
 * is effectively a no-op for world-access bits there. The chmod calls are
 * harmless on Windows; the assertions aren't meaningful.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const IS_WIN = process.platform === "win32";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-fileperms-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
// v2.1.3 I8: scrub inherited RELAY_AGENT_* env vars so isolated tests
// do not auth against a parent-shell spawn-agent.sh token.
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
delete process.env.RELAY_ALLOW_LEGACY;
delete process.env.RELAY_HTTP_SECRET;

const { initializeDb, closeDb } = await import("../src/db.js");
const { exportRelayState, importRelayState } = await import("../src/backup.js");

function resetPath() {
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
}

beforeEach(() => {
  closeDb();
  resetPath();
});

afterEach(() => {
  closeDb();
  resetPath();
});

function modeOf(p: string): number {
  return fs.statSync(p).mode & 0o777;
}

describe("v2.1 Phase 4c.4 — filesystem perms (POSIX only)", () => {
  it.skipIf(IS_WIN)("(1) fresh initializeDb produces a DB file with mode 0600", async () => {
    await initializeDb();
    expect(fs.existsSync(TEST_DB_PATH)).toBe(true);
    expect(modeOf(TEST_DB_PATH)).toBe(0o600);
  });

  it.skipIf(IS_WIN)("(2) fresh initializeDb produces a parent directory with mode 0700", async () => {
    await initializeDb();
    expect(fs.existsSync(TEST_DB_DIR)).toBe(true);
    expect(modeOf(TEST_DB_DIR)).toBe(0o700);
  });

  it.skipIf(IS_WIN)("(3) exportRelayState writes the archive with mode 0600", async () => {
    await initializeDb();
    const result = await exportRelayState();
    expect(fs.existsSync(result.archive_path)).toBe(true);
    expect(modeOf(result.archive_path)).toBe(0o600);
  });

  it.skipIf(IS_WIN)("(4) importRelayState safety-backup tarball has mode 0600", async () => {
    await initializeDb();
    const exp = await exportRelayState();
    // Force to bypass the daemon-running check — test env may have a live
    // relay on the default port, unrelated to this test's throwaway DB.
    const imp = await importRelayState(exp.archive_path, { force: true });
    expect(imp.previous_backup_path).toBeTruthy();
    expect(fs.existsSync(imp.previous_backup_path)).toBe(true);
    expect(modeOf(imp.previous_backup_path)).toBe(0o600);
  });

  it("(5) Windows skip guard: platform-aware behavior is documented", () => {
    // This test runs on every platform. The POSIX-mode tests above auto-skip
    // on win32. On POSIX this asserts the guard is in place; on Windows it
    // asserts we didn't accidentally assert a mode that NTFS can't honor.
    if (IS_WIN) {
      expect(process.platform).toBe("win32");
    } else {
      // Sanity: POSIX platforms should be able to chmod + stat at all.
      const tmpFile = path.join(os.tmpdir(), `fp-guard-${process.pid}.tmp`);
      fs.writeFileSync(tmpFile, "x");
      fs.chmodSync(tmpFile, 0o600);
      expect(modeOf(tmpFile)).toBe(0o600);
      fs.unlinkSync(tmpFile);
    }
  });
});
