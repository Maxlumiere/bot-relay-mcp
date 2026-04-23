// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.3.0 Part A.2 — live consistency probe.
 *
 * Probe is off by default. When `RELAY_CONSISTENCY_PROBE=1` is set, every
 * Nth `get_messages` call compares MCP result vs a raw-SQL superset query
 * against `messages.to_agent`. A v2.2.1-style "session marked rows read,
 * subsequent pending poll dropped them" regression surfaces as a count
 * mismatch + stderr warning.
 *
 * A.2.1  probe-disabled: no divergences logged even when MCP drops rows.
 * A.2.2  probe-enabled + artificial divergence: warning is logged + the
 *        divergence counter increments.
 * A.2.3  probe-enabled + clean state: no divergence, counter stays 0.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v230-probe-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_CONSISTENCY_PROBE;
delete process.env.RELAY_CONSISTENCY_PROBE_RATE;

const { closeDb, getDb, registerAgent, sendMessage, getMessages } = await import("../src/db.js");
const {
  sampleGetMessagesConsistency,
  _resetProbeCounterForTests,
  _probeDivergenceCountForTests,
} = await import("../src/transport/consistency-probe.js");

beforeEach(() => {
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  _resetProbeCounterForTests();
});
afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  delete process.env.RELAY_CONSISTENCY_PROBE;
  delete process.env.RELAY_CONSISTENCY_PROBE_RATE;
});

describe("v2.3.0 A.2 — live consistency probe", () => {
  it("(A.2.1) probe disabled: no divergence counted even when MCP returns empty for pending rows", () => {
    // Probe is off — no warnings, no counter increment.
    registerAgent("a1-from", "r", []);
    registerAgent("a1-to", "r", []);
    sendMessage("a1-from", "a1-to", "ghost", "normal");
    // Forcibly simulate a v2.2.1-style drop: MCP result empty even
    // though a pending row exists. Rate=1 so any probe call fires.
    process.env.RELAY_CONSISTENCY_PROBE_RATE = "1";
    _resetProbeCounterForTests();
    sampleGetMessagesConsistency({
      agentName: "a1-to",
      status: "pending",
      limit: 100,
      peek: false,
      mcpResult: [],
    });
    expect(_probeDivergenceCountForTests()).toBe(0);
  });

  it("(A.2.2) probe enabled + simulated v2.2.1 drop: divergence logged + counter increments", () => {
    process.env.RELAY_CONSISTENCY_PROBE = "1";
    process.env.RELAY_CONSISTENCY_PROBE_RATE = "1";
    _resetProbeCounterForTests();
    registerAgent("a2-from", "r", []);
    registerAgent("a2-to", "r", []);
    sendMessage("a2-from", "a2-to", "m1", "normal");
    sendMessage("a2-from", "a2-to", "m2", "normal");
    const warnSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    sampleGetMessagesConsistency({
      agentName: "a2-to",
      status: "pending",
      limit: 100,
      peek: false,
      mcpResult: [], // simulate the drop
    });
    expect(_probeDivergenceCountForTests()).toBe(1);
    const warned = warnSpy.mock.calls.some((args) =>
      args.some((arg) => typeof arg === "string" && arg.includes("[consistency-probe] divergence")),
    );
    expect(warned).toBe(true);
    warnSpy.mockRestore();
  });

  it("(A.2.3) probe enabled + healthy MCP result: no divergence", () => {
    process.env.RELAY_CONSISTENCY_PROBE = "1";
    process.env.RELAY_CONSISTENCY_PROBE_RATE = "1";
    _resetProbeCounterForTests();
    registerAgent("a3-from", "r", []);
    registerAgent("a3-to", "r", []);
    sendMessage("a3-from", "a3-to", "healthy", "normal");
    const mcpResult = getMessages("a3-to", "pending", 100, true);
    expect(mcpResult.length).toBe(1);
    sampleGetMessagesConsistency({
      agentName: "a3-to",
      status: "pending",
      limit: 100,
      peek: true,
      mcpResult,
    });
    expect(_probeDivergenceCountForTests()).toBe(0);
  });

  it("(A.2.4) sample rate respected: only every Nth call probes", () => {
    process.env.RELAY_CONSISTENCY_PROBE = "1";
    process.env.RELAY_CONSISTENCY_PROBE_RATE = "3";
    _resetProbeCounterForTests();
    registerAgent("a4-from", "r", []);
    registerAgent("a4-to", "r", []);
    sendMessage("a4-from", "a4-to", "m1", "normal");
    // 5 calls at rate=3 → the 3rd call is the only sample. Simulate drop
    // on every call; only the 3rd should count a divergence.
    for (let i = 0; i < 5; i++) {
      sampleGetMessagesConsistency({
        agentName: "a4-to",
        status: "pending",
        limit: 100,
        peek: true,
        mcpResult: [], // drop — would flag
      });
    }
    // Calls 3 and... actually at rate=3 over 5 calls: call 3 → sample
    // (first fire). Next sample at call 6. So exactly 1 divergence.
    expect(_probeDivergenceCountForTests()).toBe(1);
  });
});
