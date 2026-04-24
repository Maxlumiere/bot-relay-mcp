// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.4.0 Part E — per-instance local isolation.
 *
 * v2.4.0 supports COEXISTENCE: two daemons on the same machine, same
 * user, DIFFERENT instance_ids, each with its own DB + config + agent
 * namespace. Cross-instance messaging is NOT supported (v2.5+
 * federation territory).
 *
 * E.1.1  Single-instance legacy mode default — getDbPath() returns
 *        ~/.bot-relay/relay.db when no env + no instances subdir.
 * E.1.2  RELAY_INSTANCE_ID flips to multi-instance mode +
 *        getDbPath() points at the per-instance DB.
 * E.1.3  createInstance + readInstance round-trip.
 * E.1.4  Invalid instance_id rejected (path traversal guard).
 * E.2.1  Two instances have separate DB paths.
 * E.2.2  Message sent under instance A does NOT appear on instance B.
 * E.2.3  acquireInstanceLock collides when another PID holds it.
 * E.2.4  acquireInstanceLock reclaims stale PID file.
 * E.3.1  listInstances returns every instance in the root.
 * E.3.2  setActiveInstance writes the symlink + resolveActiveInstanceId
 *        reads it back.
 * E.3.3  setActiveInstance refuses a non-existent instance.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

// Redirect the per-instance namespace via RELAY_HOME (test-friendly
// override) so nothing touches the operator's real $HOME. Set BEFORE
// the first import of ./src/instance.js.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bot-relay-v240-instance-"));
process.env.RELAY_HOME = TEST_HOME;

delete process.env.RELAY_INSTANCE_ID;
delete process.env.RELAY_DB_PATH;
delete process.env.RELAY_HTTP_SECRET;

const {
  isMultiInstanceMode,
  resolveActiveInstanceId,
  generateInstanceId,
  createInstance,
  readInstance,
  listInstances,
  resolveInstanceDbPath,
  acquireInstanceLock,
  setActiveInstance,
  instanceDir,
} = await import("../src/instance.js");
const dbMod = await import("../src/db.js");

function freshHome(): void {
  if (fs.existsSync(TEST_HOME)) fs.rmSync(TEST_HOME, { recursive: true, force: true });
  fs.mkdirSync(TEST_HOME, { recursive: true });
}

beforeEach(() => {
  delete process.env.RELAY_INSTANCE_ID;
  delete process.env.RELAY_DB_PATH;
  freshHome();
});
afterEach(() => {
  delete process.env.RELAY_INSTANCE_ID;
  delete process.env.RELAY_DB_PATH;
  freshHome();
});


describe("v2.4.0 E.1 — instance model", () => {
  it("(E.1.1) legacy mode: no env + no instances subdir → flat <root>/relay.db", () => {
    expect(isMultiInstanceMode()).toBe(false);
    expect(resolveActiveInstanceId()).toBeNull();
    const resolved = resolveInstanceDbPath();
    expect(resolved).toBe(path.join(TEST_HOME, "relay.db"));
  });

  it("(E.1.2) RELAY_INSTANCE_ID flips multi-instance mode + DB path nests under instances/<id>", () => {
    const id = generateInstanceId();
    process.env.RELAY_INSTANCE_ID = id;
    expect(isMultiInstanceMode()).toBe(true);
    expect(resolveActiveInstanceId()).toBe(id);
    const resolved = resolveInstanceDbPath();
    expect(resolved).toBe(path.join(TEST_HOME, "instances", id, "relay.db"));
  });

  it("(E.1.3) createInstance + readInstance round-trip", () => {
    const id = generateInstanceId();
    const meta = createInstance(id, "2.4.0", "work");
    expect(meta.instance_id).toBe(id);
    expect(meta.label).toBe("work");
    expect(meta.daemon_version_first_seen).toBe("2.4.0");
    expect(typeof meta.created_at).toBe("string");
    expect(meta.hostname).toBeTruthy();
    const read = readInstance(id);
    expect(read).toEqual(meta);
  });

  it("(E.1.4) invalid instance_id rejected (path traversal guard)", () => {
    expect(() => instanceDir("../escape")).toThrow(/invalid instance_id/);
    expect(() => instanceDir("../../etc/passwd")).toThrow(/invalid instance_id/);
    expect(() => instanceDir("with spaces")).toThrow(/invalid instance_id/);
    // Valid characters pass.
    expect(() => instanceDir("work-01")).not.toThrow();
    expect(() => instanceDir("personal.alpha")).not.toThrow();
    expect(() => instanceDir("3c0e0d84-0e07-4c5c-9f60-ab4f1a6a2b33")).not.toThrow();
  });

  it("(E.1.5) multi-instance mode defaults getDbPath to per-instance path", () => {
    const id = generateInstanceId();
    createInstance(id, "2.4.0");
    process.env.RELAY_INSTANCE_ID = id;
    // getDbPath reads env lazily — no module cache to invalidate.
    const p = dbMod.getDbPath();
    expect(p).toBe(path.join(TEST_HOME, "instances", id, "relay.db"));
  });
});

describe("v2.4.0 E.2 — two-instance coexistence", () => {
  it("(E.2.1) two instances have separate DB paths", () => {
    const idA = generateInstanceId();
    const idB = generateInstanceId();
    createInstance(idA, "2.4.0", "personal");
    createInstance(idB, "2.4.0", "work");
    process.env.RELAY_INSTANCE_ID = idA;
    const pathA = resolveInstanceDbPath();
    process.env.RELAY_INSTANCE_ID = idB;
    const pathB = resolveInstanceDbPath();
    expect(pathA).not.toBe(pathB);
    expect(pathA).toContain(idA);
    expect(pathB).toContain(idB);
  });

  it("(E.2.2) messages sent under instance A do not appear on instance B", () => {
    const idA = generateInstanceId();
    const idB = generateInstanceId();
    createInstance(idA, "2.4.0");
    createInstance(idB, "2.4.0");
    // Instance A: register alice, send alice → bob (bob doesn't exist
    // on A, so we register him too).
    process.env.RELAY_INSTANCE_ID = idA;
    dbMod.closeDb();
    dbMod.registerAgent("alice", "r", []);
    dbMod.registerAgent("bob", "r", []);
    dbMod.sendMessage("alice", "bob", "A-hello", "normal");
    const bobOnA = dbMod.getMessages("bob", "pending", 100, true);
    expect(bobOnA.length).toBe(1);
    // Switch to instance B — should be a fresh DB with no rows.
    process.env.RELAY_INSTANCE_ID = idB;
    dbMod.closeDb();
    const agentsOnB = dbMod.getAgents();
    expect(agentsOnB.length).toBe(0);
    dbMod.registerAgent("alice", "r", []); // same name, different instance
    dbMod.registerAgent("bob", "r", []);
    const bobOnB = dbMod.getMessages("bob", "pending", 100, true);
    expect(bobOnB.length).toBe(0); // A's message doesn't bleed into B
  });

  it("(E.2.3) acquireInstanceLock collides when a live PID holds it", () => {
    const id = generateInstanceId();
    createInstance(id, "2.4.0");
    // Fake a lock from our own PID — then a second acquire should
    // detect "live PID" and refuse. We use process.pid which is
    // definitively alive.
    const dir = instanceDir(id)!;
    const pidFile = path.join(dir, "instance.pid");
    fs.mkdirSync(dir, { recursive: true });
    // Use a PID that we KNOW is alive: PID 1 (init) on POSIX, or this
    // test's parent-shell PID. process.ppid is alive by definition.
    fs.writeFileSync(pidFile, String(process.ppid));
    expect(() => acquireInstanceLock(id)).toThrow(/already running/);
  });

  it("(E.2.4) acquireInstanceLock fails-closed on stale PID file (Codex R2 hardening)", () => {
    // v2.4.0 Codex re-audit removed the auto-reclaim path because it
    // had a TOCTOU race: process A pauses before unlink, process B
    // reclaims + writes its live PID, process A resumes + unlinks B's
    // LIVE file. Both end up believing they hold the lock. The R2 fix
    // is to refuse EVERY EEXIST, regardless of liveness, and point
    // the operator at manual cleanup.
    const id = generateInstanceId();
    createInstance(id, "2.4.0");
    const dir = instanceDir(id)!;
    const pidFile = path.join(dir, "instance.pid");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(pidFile, "999999"); // stale (dead)
    expect(() => acquireInstanceLock(id)).toThrow(/stale pidfile.*rm/);
    // Manual cleanup → next acquisition succeeds.
    fs.unlinkSync(pidFile);
    const lock = acquireInstanceLock(id);
    expect(fs.readFileSync(pidFile, "utf-8").trim()).toBe(String(process.pid));
    lock.release();
    expect(fs.existsSync(pidFile)).toBe(false);
  });
});

describe("v2.4.0 E.3 — CLI-supporting helpers", () => {
  it("(E.3.1) listInstances returns every instance in the root", () => {
    const ids = [generateInstanceId(), generateInstanceId(), generateInstanceId()];
    for (const id of ids) createInstance(id, "2.4.0", "label-" + id.slice(0, 4));
    const list = listInstances();
    expect(list.length).toBe(3);
    const listedIds = list.map((m) => m.instance_id).sort();
    expect(listedIds).toEqual([...ids].sort());
  });

  it("(E.3.2) setActiveInstance persists + resolveActiveInstanceId reads it back", () => {
    const id = generateInstanceId();
    createInstance(id, "2.4.0");
    delete process.env.RELAY_INSTANCE_ID;
    setActiveInstance(id);
    expect(resolveActiveInstanceId()).toBe(id);
    expect(isMultiInstanceMode()).toBe(true);
  });

  it("(E.3.3) setActiveInstance refuses a non-existent instance", () => {
    expect(() => setActiveInstance("does-not-exist")).toThrow(/not found/);
  });
});
