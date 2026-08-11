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

const { closeDb, initializeDb, getDb, registerAgent, sendMessage, getAgents, getMessages } =
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

describe("#190 requested-vs-actual driver seam — dispatch follows the LIVE connection, not the mutable env", () => {
  it("WASM-initialized, RELAY_SQLITE_DRIVER mutated to native WITHOUT closeDb → export still succeeds", async () => {
    process.env.RELAY_SQLITE_DRIVER = "wasm";
    closeDb();
    await initializeDb();
    expect(getActiveDriver()).toBe("wasm");
    registerAgent("seam-w", "role", []);
    sendMessage("seam-w", "seam-w", "seam", "normal");
    // Mutate the REQUESTED env WITHOUT re-initializing. Pre-#190, snapshotToFile
    // branched on getDriverType() (env) → it would take native's VACUUM INTO
    // path against the live WasmDatabase and throw "unable to open database".
    // The fix dispatches on getActiveDriver() (the live connection), so export
    // succeeds. Reds on the pre-fix env-based dispatch.
    process.env.RELAY_SQLITE_DRIVER = "native";
    const res = await exportRelayState();
    expect(fs.existsSync(res.archive_path), "wasm-initialized export must succeed despite the native env").toBe(true);
    closeDb();
  });

  it("NATIVE-initialized, RELAY_SQLITE_DRIVER mutated to wasm WITHOUT closeDb → export still succeeds", async () => {
    process.env.RELAY_SQLITE_DRIVER = "native";
    closeDb();
    await initializeDb();
    expect(getActiveDriver()).toBe("native");
    registerAgent("seam-n", "role", []);
    sendMessage("seam-n", "seam-n", "seam", "normal");
    // The mirror seam: a native connection with the env mutated to wasm must
    // still VACUUM INTO (the live driver), not try wasm serialize on a
    // better-sqlite3 handle (which lacks serialize()).
    process.env.RELAY_SQLITE_DRIVER = "wasm";
    const res = await exportRelayState();
    expect(fs.existsSync(res.archive_path), "native-initialized export must succeed despite the wasm env").toBe(true);
    closeDb();
  });
});

describe("#190 r2 — tracker completeness (sync fallback) + restore ordering (no manufacture)", () => {
  it("FINDING 1: a DB reached via the SYNCHRONOUS getDb() fallback still exports (driverOf reads the object, no tracker)", async () => {
    process.env.RELAY_SQLITE_DRIVER = "native";
    closeDb();
    // Reach the DB via getDb()'s synchronous native fallback — it sets db.ts _db
    // directly and bypasses initializeDb, so getActiveDriver() stays null. r2
    // patched the tracker; r3 removed that — snapshotToFile/openReadOnly read the
    // driver from the OBJECT (driverOf(getDb())), so export works with no reliance
    // on the tracker at all.
    getDb();
    registerAgent("sync-seed", "role", []);
    sendMessage("sync-seed", "sync-seed", "via-sync-getdb", "normal");
    const res = await exportRelayState();
    expect(fs.existsSync(res.archive_path)).toBe(true);
    const { agents } = await restoreAndRead(res.archive_path, "native");
    expect(agents).toContain("sync-seed");
    closeDb();
  });

  it("IMPORT under the mutation seam: a WASM restore with the env mutated to native binds the probe to the ACTUAL driver", async () => {
    process.env.RELAY_SQLITE_DRIVER = "wasm";
    closeDb();
    await initializeDb();
    registerAgent("imp-seam", "role", []);
    const res = await exportRelayState(); // wasm-made archive; an existing wasm DB is on disk
    closeDb();
    // Mutate the env to native WITHOUT re-init. importRelayState captures the probe
    // driver via driverOf(getDb()) from the safety-backup's LIVE wasm connection —
    // BEFORE Step 2 closes it — so the Step-5 probe binds to wasm, not the mutated
    // env. (In a scripts-off deployment the native binary is absent and a native
    // probe would fail; here both drivers exist, so this asserts the restore
    // succeeds and data survives under the env mutation.)
    process.env.RELAY_SQLITE_DRIVER = "native";
    await importRelayState(res.archive_path, { force: true });
    await initializeDb();
    expect(getAgents().map((a: { name: string }) => a.name)).toContain("imp-seam");
    closeDb();
  });

  it("FINDING 2: a corrupt archive on a FRESH machine (no DB) fails WITHOUT manufacturing a database", async () => {
    process.env.RELAY_SQLITE_DRIVER = "native";
    closeDb();
    const dbPath = process.env.RELAY_DB_PATH as string;
    expect(fs.existsSync(dbPath), "precondition: fresh machine, no DB yet").toBe(false);
    const badArchive = path.join(TEST_ROOT, "corrupt.tar.gz");
    fs.writeFileSync(badArchive, "this is not a valid relay archive");
    await expect(importRelayState(badArchive, { force: true })).rejects.toThrow();
    // THE SAFETY PROPERTY: validation failed before anything was created. Pre-fix,
    // the eager init created a blank DB before the archive was ever validated.
    expect(fs.existsSync(dbPath), "a failed restore must not manufacture a DB").toBe(false);
    closeDb();
  });
});
