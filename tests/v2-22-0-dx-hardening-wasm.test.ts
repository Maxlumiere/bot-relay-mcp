// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0005 (v2.22.0) parity on the sql.js (wasm) driver — the orphan-cleanup
 * keystone (abandon can never touch an authed row) + auto-GC behave identically
 * to the native driver.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-2220-wasm-" + process.pid);
process.env.RELAY_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_ORPHAN_TTL_MINUTES;
process.env.RELAY_SQLITE_DRIVER = "wasm";

const { initializeDb, closeDb, getDb, registerAgent, abandonRegistration, purgeOldRecords, resolveAgentByToken, getAgentAuthData } =
  await import("../src/db.js");

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
}
beforeEach(async () => {
  cleanup();
  await initializeDb();
});
afterEach(() => cleanup());

describe("wasm driver — ADR-0005 parity", () => {
  it("schema v22 columns exist + orphan abandon keystone holds", () => {
    const cols = (getDb().prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("first_authed_at");
    expect(cols).toContain("registration_recovery_hash");

    const orphan = registerAgent("w-orphan", "worker", []);
    // abandon targets a session-LESS orphan; a fresh register carries a live session.
    getDb().prepare("UPDATE agents SET session_id = NULL WHERE name = ?").run("w-orphan");
    expect(abandonRegistration("w-orphan", orphan.registration_recovery!)).toEqual({ abandoned: true });

    // KEYSTONE: an authenticated agent can't be abandoned even with a valid handle.
    const live = registerAgent("w-live", "worker", []);
    resolveAgentByToken(live.plaintext_token!); // authenticates → first_authed_at set
    expect(abandonRegistration("w-live", live.registration_recovery!).abandoned).toBe(false);
    expect(getAgentAuthData("w-live")).not.toBeNull();
  });

  it("no auto-GC on the wasm driver either: the old reap-target shape survives the purge tick", () => {
    registerAgent("w-gc", "worker", []);
    getDb().prepare("UPDATE agents SET session_id = NULL, created_at = ? WHERE name = ?").run(new Date(Date.now() - 3600_000).toISOString(), "w-gc");
    purgeOldRecords(getDb());
    expect(getAgentAuthData("w-gc")).not.toBeNull();
  });
});
