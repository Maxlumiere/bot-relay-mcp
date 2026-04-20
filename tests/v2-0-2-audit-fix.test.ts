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

const { registerAgent, getAgents, closeDb } = await import("../src/db.js");
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
// that re-opened the HIGH 1 bug: a null capturedSid could still wipe another
// terminal's fresh session (via live-read) or fall through to DELETE-by-name.
// v2.0.2 drops the fallback chain — null capturedSid is a hard no-op.
// ============================================================================

describe("v2.0.2 — SIGINT auto-unregister honours capturedSessionId contract", () => {
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

    // SIGINT fires on the old process with capturedSid=null. Must NOT wipe the
    // row — this is the exact failure mode victra's audit flagged.
    performAutoUnregister("handoff-target", null, "SIGINT");

    const live = getAgents().find((a) => a.name === "handoff-target");
    expect(live).toBeTruthy();
    expect(live?.session_id).toBe(sessionB);
  });

  it("null capturedSid + no row in DB → no-op, no throw", () => {
    // Agent never registered — SIGINT handler must not blow up and must not
    // accidentally DELETE anything it doesn't own.
    expect(() => performAutoUnregister("ghost-agent", null, "SIGTERM")).not.toThrow();
    expect(getAgents().find((a) => a.name === "ghost-agent")).toBeUndefined();
  });

  it("capturedSid matches DB → unregister succeeds (regression guard for single-terminal path)", () => {
    const r = registerAgent("solo-stdio", "r", []);
    const sid = r.agent.session_id!;

    performAutoUnregister("solo-stdio", sid, "SIGINT");

    expect(getAgents().find((a) => a.name === "solo-stdio")).toBeUndefined();
  });
});
