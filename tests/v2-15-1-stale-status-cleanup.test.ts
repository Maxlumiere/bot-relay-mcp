// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.15.1 — one-time cleanup of STALE stored terminal agent_status values.
 *
 * The migration (migrateSchemaToV2_19, version-guarded 18→19, data-only, runs
 * ONCE) clears the leftover terminal states the pre-v2.15.0 model stored, so the
 * live presence verdict governs. Narrowed contract:
 *   - 'closed'/'abandoned'/'stale' → ALWAYS cleared (set_status can't produce them).
 *   - session-PRESENT 'offline' → PRESERVED (a genuine set_status declaration).
 *   - session-NULL 'offline' → INTENTIONALLY cleared (ambiguous provenance);
 *     the live verdict governs. Documented, re-assertable, can't false-alive.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v2151-test-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_ALLOW_LEGACY;

const {
  closeDb,
  getDb,
  getSchemaVersion,
  registerAgent,
  getAgents,
  setAgentStatus,
  setAgentLivenessAnchor,
  _resetLivenessProbeCacheForTests,
} = await import("../src/db.js");
const { _resetOwnHostIdForTests } = await import("../src/liveness.js");

const OWN_HOST = "v2151-own-host";
const LIVE_PID = process.pid;
const DEAD_PID = 2_147_483_646;

function cleanup() {
  closeDb();
  _resetOwnHostIdForTests(undefined);
  _resetLivenessProbeCacheForTests();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
}
function rawStatus(name: string): { agent_status: string; session_id: string | null } {
  return getDb().prepare("SELECT agent_status, session_id FROM agents WHERE name = ?").get(name) as never;
}
function derived(name: string) {
  return getAgents().find((a) => a.name === name)!;
}
/** Simulate a pre-v2.15.1 DB and re-open so the version-guarded migration runs. */
function reopenAtVersion18() {
  getDb().prepare("UPDATE schema_info SET version = 18 WHERE id = 1").run();
  closeDb();
  getDb(); // re-runs the migration chain; migrateSchemaToV2_19 sees stored 18 < 19
}
function setStoredStatus(name: string, status: string) {
  getDb().prepare("UPDATE agents SET agent_status = ? WHERE name = ?").run(status, name);
}
function clearSession(name: string) {
  getDb().prepare("UPDATE agents SET session_id = NULL WHERE name = ?").run(name);
}

beforeEach(() => {
  cleanup();
  _resetOwnHostIdForTests(OWN_HOST);
});
afterEach(() => cleanup());

describe("v2.15.1 — stale stored terminal-state cleanup migration", () => {
  it("(a) session-PRESENT set_status('offline') is PRESERVED (a genuine declaration; R1 keeps honoring it)", () => {
    registerAgent("genuine-offline", "builder", [], { host_id: OWN_HOST }); // registerAgent sets a session
    setAgentStatus("genuine-offline", "offline"); // set_status leaves session_id intact
    expect(rawStatus("genuine-offline").session_id).not.toBeNull();

    reopenAtVersion18();

    expect(rawStatus("genuine-offline").agent_status).toBe("offline"); // stored value preserved
    expect(derived("genuine-offline").agent_status).toBe("offline"); // R1 still declares offline
  });

  it("(b) session-NULL 'offline' is INTENTIONALLY cleared → verdict governs (the exact false-clear case, as designed)", () => {
    // Both a signal-derived pollution AND a genuine-but-sessionless set_status
    // land here; the narrowed contract clears BOTH by design.
    registerAgent("sessionless-offline", "builder", [], { host_id: OWN_HOST });
    setAgentStatus("sessionless-offline", "offline");
    clearSession("sessionless-offline"); // now session-NULL 'offline'

    reopenAtVersion18();

    expect(rawStatus("sessionless-offline").agent_status).toBe("idle"); // stored value wiped — INTENDED
    // No probe-able anchor → the live verdict is 'unknown' (never a stale offline, never a false-alive).
    expect(derived("sessionless-offline").agent_status).toBe("unknown");
    expect(derived("sessionless-offline").liveness).toBe("unknown");
  });

  it("(c) stored 'closed' / 'abandoned' / 'stale' are ALWAYS cleared (set_status can't produce them)", () => {
    for (const s of ["closed", "abandoned", "stale"]) {
      registerAgent(`row-${s}`, "builder", [], { host_id: OWN_HOST });
      setStoredStatus(`row-${s}`, s);
    }
    reopenAtVersion18();
    for (const s of ["closed", "abandoned", "stale"]) {
      expect(rawStatus(`row-${s}`).agent_status, `stored ${s}`).toBe("idle");
      expect(derived(`row-${s}`).agent_status, `derived ${s}`).toBe("unknown"); // no anchor → unknown
    }
  });

  it("(d) runs EXACTLY ONCE (version-guarded) + idempotent — a post-migration sessionless offline PERSISTS", () => {
    registerAgent("pollution", "builder", [], { host_id: OWN_HOST });
    setStoredStatus("pollution", "closed");
    reopenAtVersion18();
    expect(rawStatus("pollution").agent_status).toBe("idle"); // cleaned
    expect(getSchemaVersion()).toBe(22); // version advanced to CURRENT_SCHEMA_VERSION (ADR-0005)

    // Now an operator/dashboard sets a NEW sessionless offline AFTER the migration.
    registerAgent("post-mig", "builder", [], { host_id: OWN_HOST });
    setAgentStatus("post-mig", "offline");
    clearSession("post-mig");
    // Re-open normally (version already 19 → the migration must NOT re-run).
    closeDb();
    getDb();
    expect(rawStatus("post-mig").agent_status).toBe("offline"); // NOT re-wiped — runs once
    // And re-running the whole thing is a no-op for the already-cleaned row.
    closeDb();
    getDb();
    expect(rawStatus("pollution").agent_status).toBe("idle");
    expect(rawStatus("post-mig").agent_status).toBe("offline");
  });

  it("(e) NO false-alive: a signal-marked row reads its REAL probe after clearing — dead→closed, alive→idle", () => {
    // Dead process behind the cleared pollution → 'closed' (a positive dead probe), NOT idle.
    registerAgent("was-marked-dead", "builder", [], { host_id: OWN_HOST });
    setStoredStatus("was-marked-dead", "offline");
    clearSession("was-marked-dead");
    setAgentLivenessAnchor("was-marked-dead", DEAD_PID, null);

    // Genuinely-alive process behind the cleared pollution → 'idle' (a real positive probe).
    registerAgent("was-marked-alive", "builder", [], { host_id: OWN_HOST });
    setStoredStatus("was-marked-alive", "closed");
    setAgentLivenessAnchor("was-marked-alive", LIVE_PID, null);

    reopenAtVersion18();
    _resetLivenessProbeCacheForTests();

    expect(derived("was-marked-dead").agent_status).toBe("closed"); // dead probe, never idle-from-clearing
    expect(derived("was-marked-alive").agent_status).toBe("idle"); // real live probe
    expect(derived("was-marked-alive").liveness).toBe("alive");
  });
});
