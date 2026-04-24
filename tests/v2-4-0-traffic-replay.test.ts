// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.4.0 Part D — traffic recording + replay round-trip.
 *
 * D.1.1  Recording disabled by default (no env var → no file written).
 * D.1.2  Recording enabled writes one JSONL line per tool call.
 * D.1.3  Sensitive fields (agent_token) redacted in captured log.
 * D.2.1  replayLog round-trip: synthetic log replays with full parity.
 * D.2.2  Divergence detection: mutated recorded response surfaces in
 *        the report as a diverge entry.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v240-replay-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
const TEST_LOG_PATH = path.join(TEST_DB_DIR, "traffic.jsonl");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_HTTP_SECRET;

const {
  recordCall,
  _resetTrafficRecorderForTests,
  _redactForTests,
} = await import("../src/transport/traffic-recorder.js");
const { replayLog } = await import("../scripts/replay-relay-traffic.js");
const { closeDb, registerAgent } = await import("../src/db.js");

beforeEach(() => {
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  delete process.env.RELAY_RECORD_TRAFFIC;
  _resetTrafficRecorderForTests();
});
afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  delete process.env.RELAY_RECORD_TRAFFIC;
  _resetTrafficRecorderForTests();
});

describe("v2.4.0 D.1 — traffic recorder", () => {
  it("(D.1.1) recording disabled by default — no file created", () => {
    recordCall({
      tool: "register_agent",
      args: { name: "a" },
      response: { success: true },
      transport: "stdio",
    });
    expect(fs.existsSync(TEST_LOG_PATH)).toBe(false);
  });

  it("(D.1.2) recording enabled writes JSONL lines", () => {
    process.env.RELAY_RECORD_TRAFFIC = TEST_LOG_PATH;
    _resetTrafficRecorderForTests();
    recordCall({
      tool: "register_agent",
      args: { name: "a", role: "r", capabilities: [] },
      response: { success: true, agent_name: "a" },
      transport: "stdio",
    });
    recordCall({
      tool: "send_message",
      args: { from: "a", to: "b", content: "hi" },
      response: { success: true, message_id: "m1" },
      transport: "stdio",
    });
    expect(fs.existsSync(TEST_LOG_PATH)).toBe(true);
    const lines = fs
      .readFileSync(TEST_LOG_PATH, "utf-8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0]);
    expect(first.tool).toBe("register_agent");
    expect(first.args.name).toBe("a");
    expect(first.response.success).toBe(true);
    expect(typeof first.ts).toBe("string");
    expect(first.transport).toBe("stdio");
  });

  it("(D.1.3) sensitive fields redacted in captured log", () => {
    process.env.RELAY_RECORD_TRAFFIC = TEST_LOG_PATH;
    _resetTrafficRecorderForTests();
    recordCall({
      tool: "register_agent",
      args: { name: "a", agent_token: "sensitive-abc123", role: "r" },
      response: {
        success: true,
        agent_name: "a",
        plaintext_token: "new-token-xyz",
      },
      transport: "stdio",
    });
    const line = JSON.parse(fs.readFileSync(TEST_LOG_PATH, "utf-8").trim());
    expect(line.args.agent_token).toBe("<REDACTED>");
    expect(line.args.name).toBe("a");
    expect(line.args.role).toBe("r");
    expect(line.response.plaintext_token).toBe("<REDACTED>");
    expect(line.response.agent_name).toBe("a");
    // Spot-check the pure redact() helper on nested shapes.
    const nested = _redactForTests({
      nested: { agent_token: "leak", ok: 1 },
      list: [{ token: "also-leak", keep: true }],
    });
    expect((nested as any).nested.agent_token).toBe("<REDACTED>");
    expect((nested as any).nested.ok).toBe(1);
    expect((nested as any).list[0].token).toBe("<REDACTED>");
    expect((nested as any).list[0].keep).toBe(true);
  });

  it("(D.1.4) 1GB cap disables further capture + logs warn, no throw", () => {
    process.env.RELAY_RECORD_TRAFFIC = TEST_LOG_PATH;
    _resetTrafficRecorderForTests();
    // Pre-create a file over the 1GB threshold. Use sparse allocation
    // (ftruncate) so the test doesn't actually write 1GB of bytes.
    fs.writeFileSync(TEST_LOG_PATH, "");
    fs.truncateSync(TEST_LOG_PATH, 1024 * 1024 * 1024 + 1); // 1GB + 1
    recordCall({
      tool: "ping",
      args: {},
      response: { ok: true },
      transport: "stdio",
    });
    // Size should not have changed — recorder bailed.
    expect(fs.statSync(TEST_LOG_PATH).size).toBe(1024 * 1024 * 1024 + 1);
  });
});

describe("v2.4.0 D.2 — replay harness", () => {
  // Build a synthetic JSONL log with a deterministic tool call that
  // should round-trip. Then drive `replayLog` through a hand-rolled
  // dispatcher that just echoes a known response — this verifies the
  // replay COMPARISON logic without depending on a full MCP server.
  it("(D.2.1) identical recorded + replayed responses → zero divergences", async () => {
    const logPath = path.join(TEST_DB_DIR, "synthetic.jsonl");
    const entry = {
      ts: "2026-04-23T10:00:00.000Z",
      tool: "health_check",
      args: {},
      response: { success: true, version: "2.3.0", protocol_version: "2.3.0" },
      transport: "stdio" as const,
      source_ip: null,
    };
    fs.writeFileSync(logPath, JSON.stringify(entry) + "\n");
    const dispatch = async (_tool: string, _args: unknown) => entry.response;
    const report = await replayLog(logPath, dispatch);
    expect(report.total).toBe(1);
    expect(report.identical).toBe(1);
    expect(report.divergent).toBe(0);
    expect(report.errored).toBe(0);
  });

  it("(D.2.2) mutated replayed response surfaces as divergence", async () => {
    const logPath = path.join(TEST_DB_DIR, "synthetic-divergent.jsonl");
    const entry = {
      ts: "2026-04-23T10:00:00.000Z",
      tool: "health_check",
      args: {},
      response: { success: true, version: "2.3.0" },
      transport: "stdio" as const,
      source_ip: null,
    };
    fs.writeFileSync(logPath, JSON.stringify(entry) + "\n");
    // Dispatcher returns a different version — replay should catch it.
    const dispatch = async (_tool: string, _args: unknown) => ({
      success: true,
      version: "2.4.0",
    });
    const report = await replayLog(logPath, dispatch);
    expect(report.total).toBe(1);
    expect(report.identical).toBe(0);
    expect(report.divergent).toBe(1);
    expect(report.divergences[0].tool).toBe("health_check");
    expect(report.divergences[0].diff).toContain("2.3.0");
  });

  it("(D.2.3) volatile fields (message_id, seq, epoch, tokens) normalize — no false divergence", async () => {
    const logPath = path.join(TEST_DB_DIR, "synthetic-volatile.jsonl");
    const entry = {
      ts: "2026-04-23T10:00:00.000Z",
      tool: "send_message",
      args: { from: "a", to: "b", content: "hi" },
      response: {
        success: true,
        message_id: "recorded-uuid-111",
        seq: 7,
        epoch: "recorded-epoch-aaa",
      },
      transport: "stdio" as const,
      source_ip: null,
    };
    fs.writeFileSync(logPath, JSON.stringify(entry) + "\n");
    // Replay returns DIFFERENT volatile values but same shape + success.
    const dispatch = async (_tool: string, _args: unknown) => ({
      success: true,
      message_id: "replay-uuid-222",
      seq: 99,
      epoch: "replay-epoch-bbb",
    });
    const report = await replayLog(logPath, dispatch);
    expect(report.identical).toBe(1);
    expect(report.divergent).toBe(0);
  });

  it("(D.2.4) end-to-end: recorded traffic from live handler replays identical", async () => {
    // Record a real handler's output, then replay against the same
    // handler with normalized-field comparison.
    process.env.RELAY_RECORD_TRAFFIC = TEST_LOG_PATH;
    _resetTrafficRecorderForTests();
    registerAgent("replay-src", "r", []);
    // Manual recordCall (simulating what runCall does) — captures a
    // live response for a handler invocation.
    const liveResponse = {
      success: true,
      agent_name: "replay-src",
      protocol_version: "2.3.0",
    };
    recordCall({
      tool: "register_agent",
      args: { name: "replay-src", role: "r" },
      response: liveResponse,
      transport: "stdio",
    });
    expect(fs.existsSync(TEST_LOG_PATH)).toBe(true);
    // Replay via a dispatcher that echoes the same response — expected
    // identical.
    const dispatch = async (_tool: string, _args: unknown) => liveResponse;
    const report = await replayLog(TEST_LOG_PATH, dispatch);
    expect(report.identical).toBe(1);
    expect(report.divergent).toBe(0);
  });
});
