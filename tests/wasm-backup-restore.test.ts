// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * #171 — backup/restore ON THE WASM DRIVER + cross-driver archive interop.
 *
 * RELAY_SQLITE_DRIVER=wasm is the published npm-12 install remedy, but until #171
 * `relay backup`/`relay restore` failed on it: `VACUUM INTO '<host>'` can't write
 * through sql.js's in-memory Emscripten FS, and the manifest/integrity probes
 * opened the snapshot with the native better-sqlite3 binary — absent in the very
 * scripts-off scenario the wasm driver works around.
 *
 * The fix (sqlite-compat.snapshotToFile + openReadOnly) makes both driver-aware.
 * These tests prove:
 *   1. a full backup -> restore round-trip works under the wasm driver, and
 *   2. archives INTEROP across drivers — a native-made archive restores under
 *      wasm and a wasm-made archive restores under native (the property a
 *      consumer depends on after switching drivers post-npm-12).
 *
 * The driver is PINNED per phase and ASSERTED via getActiveDriver() (the
 * pin-and-assert rule) so a silent native fallback reds rather than passing.
 * HOME is sandboxed so the mandatory pre-restore safety-backup never touches the
 * real ~/.bot-relay.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const TEST_ROOT = path.join(os.tmpdir(), "bot-relay-wasm-backup-" + process.pid);
process.env.RELAY_DB_PATH = path.join(TEST_ROOT, "relay.db");
process.env.HOME = TEST_ROOT;        // safety-backup + default backups dir live under HOME
process.env.RELAY_HOME = TEST_ROOT;
process.env.RELAY_CONFIG_PATH = path.join(TEST_ROOT, "config.json");
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;

const PRIOR_DRIVER = process.env.RELAY_SQLITE_DRIVER;

const { closeDb, initializeDb, registerAgent, sendMessage, getAgents, getMessages } =
  await import("../src/db.js");
const { getActiveDriver } = await import("../src/sqlite-compat.js");
const { exportRelayState, importRelayState } = await import("../src/backup.js");

type Driver = "native" | "wasm";

function resetRoot(): void {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
}

/** Seed two agents + a message under `driver`, back up, return the archive path.
 *  closeDb() between phases resets the driver singleton (closeInitializedDb),
 *  so switching RELAY_SQLITE_DRIVER + re-initializing selects the new driver. */
async function seedAndBackup(driver: Driver): Promise<string> {
  process.env.RELAY_SQLITE_DRIVER = driver;
  closeDb();
  await initializeDb();
  expect(getActiveDriver(), `seed must run on the ${driver} driver`).toBe(driver);
  registerAgent("wbr-alpha", "role", []);
  registerAgent("wbr-beta", "role", []);
  sendMessage("wbr-alpha", "wbr-beta", "survive-the-round-trip", "normal");
  const res = await exportRelayState(); // default dest → HOME/.bot-relay/backups (sandboxed)
  closeDb();
  return res.archive_path;
}

/** Restore `archive` under `driver`, return the restored agent names + message flag. */
async function restoreAndRead(
  archive: string,
  driver: Driver,
): Promise<{ agents: string[]; hasMessage: boolean }> {
  process.env.RELAY_SQLITE_DRIVER = driver;
  closeDb();
  // importRelayState closes its own handle before the atomic swap (backup.ts:295),
  // so no stale wasm image flushes back over the restored file. force:true skips
  // the live-daemon probe (a local dev daemon may be up).
  await importRelayState(archive, { force: true });
  await initializeDb();
  expect(getActiveDriver(), `restore-read must run on the ${driver} driver`).toBe(driver);
  const agents = getAgents().map((a: { name: string }) => a.name).sort();
  const hasMessage = getMessages("wbr-beta", "all", 100, true).some(
    (m: { content: string }) => m.content === "survive-the-round-trip",
  );
  closeDb();
  return { agents, hasMessage };
}

beforeEach(() => { resetRoot(); });
afterEach(() => { try { closeDb(); } catch { /* ignore */ } resetRoot(); });
afterAll(() => {
  if (PRIOR_DRIVER === undefined) delete process.env.RELAY_SQLITE_DRIVER;
  else process.env.RELAY_SQLITE_DRIVER = PRIOR_DRIVER;
});

describe("#171 backup/restore on the wasm driver + cross-driver interop", () => {
  it("full backup -> restore ROUND-TRIP works under the wasm driver", async () => {
    const archive = await seedAndBackup("wasm");
    expect(fs.existsSync(archive), "wasm backup must produce an archive").toBe(true);

    const { agents, hasMessage } = await restoreAndRead(archive, "wasm");
    expect(agents).toContain("wbr-alpha");
    expect(agents).toContain("wbr-beta");
    expect(hasMessage, "the message must survive backup+restore under wasm").toBe(true);
  });

  it("a NATIVE-made archive restores under WASM (interop: consumer switches to wasm post-npm-12)", async () => {
    const archive = await seedAndBackup("native");
    const { agents, hasMessage } = await restoreAndRead(archive, "wasm");
    expect(agents).toEqual(["wbr-alpha", "wbr-beta"]);
    expect(hasMessage).toBe(true);
  });

  it("a WASM-made archive restores under NATIVE (interop: consumer switches back)", async () => {
    const archive = await seedAndBackup("wasm");
    const { agents, hasMessage } = await restoreAndRead(archive, "native");
    expect(agents).toEqual(["wbr-alpha", "wbr-beta"]);
    expect(hasMessage).toBe(true);
  });
});
