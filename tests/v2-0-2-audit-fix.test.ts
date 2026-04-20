// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v202-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
// v2.1.3 I8: scrub inherited RELAY_AGENT_* env vars so isolated tests
// do not auth against a parent-shell spawn-agent.sh token.
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;

const { registerAgent, getAgents, closeDb, getAgentAuthData } = await import("../src/db.js");
const { performAutoUnregister } = await import("../src/transport/stdio.js");

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) {
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  }
}

beforeEach(cleanup);
afterEach(cleanup);

// ============================================================================
// v2.0.2 — SIGINT handler must honour the captured-session-id contract.
// v2.0.1 introduced a fallback chain (capturedSid ?? live-read ?? undefined)
// that re-opened the HIGH 1 bug: a null capturedSid could still clobber another
// terminal's fresh session (via live-read) or fall through to act-by-name.
// v2.0.2 drops the fallback chain — null capturedSid is a hard no-op.
//
// v2.1.3 (I9 fix): SIGINT no longer DELETEs the agent row; it transitions
// the row to agent_status='offline' with session_id cleared, preserving
// token_hash + capabilities + description + auth_state. The concurrent-
// instance-protection CAS semantics are unchanged.
// ============================================================================

describe("v2.0.2 — SIGINT auto-offline honours capturedSessionId contract", () => {
  it("null capturedSid + another terminal rotated the session → row is unchanged", () => {
    // Old terminal never captured a session_id (registered via tool after stdio
    // start, or no hook installed). A new terminal has since registered and
    // owns a fresh session_id.
    const r1 = registerAgent("handoff-target", "r", []);
    const sessionA = r1.agent.session_id!;
    expect(sessionA).toBeTruthy();

    const r2 = registerAgent("handoff-target", "r", []);
    const sessionB = r2.agent.session_id!;
    expect(sessionB).not.toBe(sessionA);

    // SIGINT fires on the old process with capturedSid=null. Must NOT touch the
    // row — this is the exact failure mode victra's audit flagged.
    performAutoUnregister("handoff-target", null, "SIGINT");

    const live = getAgents().find((a) => a.name === "handoff-target");
    expect(live).toBeTruthy();
    expect(live?.session_id).toBe(sessionB);
  });

  it("null capturedSid + no row in DB → no-op, no throw", () => {
    // Agent never registered — SIGINT handler must not blow up and must not
    // accidentally touch anything it doesn't own.
    expect(() => performAutoUnregister("ghost-agent", null, "SIGTERM")).not.toThrow();
    expect(getAgents().find((a) => a.name === "ghost-agent")).toBeUndefined();
  });

  it("capturedSid matches DB → row is PRESERVED but marked offline (v2.1.3 semantic)", () => {
    const r = registerAgent("solo-stdio", "r", ["tasks"]);
    const sid = r.agent.session_id!;
    const tokenHashBefore = getAgentAuthData("solo-stdio")?.token_hash;
    expect(tokenHashBefore).toBeTruthy();

    performAutoUnregister("solo-stdio", sid, "SIGINT");

    // v2.1.3: row is preserved (not deleted). session_id is cleared. Token
    // hash and capabilities stay intact so a new terminal with the same
    // RELAY_AGENT_TOKEN can resume via the active-state re-register path.
    const row = getAgentAuthData("solo-stdio");
    expect(row).toBeTruthy();
    expect(row?.session_id).toBeNull();
    expect(row?.agent_status).toBe("offline");
    expect(row?.token_hash).toBe(tokenHashBefore);
    expect(row?.auth_state).toBe("active");
  });

  it("capturedSid mismatch (sibling rotated session) → row untouched", () => {
    // Old terminal captured sessionA, but a sibling has since re-registered
    // with sessionB. Old terminal's SIGINT must not clear sessionB.
    const r1 = registerAgent("race-target", "r", []);
    const sessionA = r1.agent.session_id!;
    const r2 = registerAgent("race-target", "r", []);
    const sessionB = r2.agent.session_id!;
    expect(sessionA).not.toBe(sessionB);

    // Old terminal exits with its stale captured session_id.
    performAutoUnregister("race-target", sessionA, "SIGTERM");

    const row = getAgentAuthData("race-target");
    expect(row).toBeTruthy();
    expect(row?.session_id).toBe(sessionB);
    expect(row?.agent_status).not.toBe("offline");
  });
});
