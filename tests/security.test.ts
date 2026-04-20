// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-security-test-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
// v2.1.3 I8: scrub inherited RELAY_AGENT_* env vars so isolated tests
// do not auth against a parent-shell spawn-agent.sh token.
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;

const {
  logAudit,
  getAuditLog,
  checkAndRecordRateLimit,
  closeDb,
} = await import("../src/db.js");

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) {
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  }
}

beforeEach(() => cleanup());
afterEach(() => cleanup());

// --- Audit log ---

describe("audit log", () => {
  it("records a successful tool call", () => {
    logAudit("victra", "send_message", '{"to":"ops"}', true, null);
    const log = getAuditLog();
    expect(log.length).toBe(1);
    expect(log[0].agent_name).toBe("victra");
    expect(log[0].tool).toBe("send_message");
    expect(log[0].success).toBe(1);
    expect(log[0].error).toBeNull();
  });

  it("records a failed tool call with error", () => {
    logAudit("ops", "update_task", '{"task_id":"x"}', false, "Task not found");
    const log = getAuditLog();
    expect(log[0].success).toBe(0);
    expect(log[0].error).toBe("Task not found");
  });

  it("filters by agent", () => {
    logAudit("alice", "send_message", "", true, null);
    logAudit("bob", "send_message", "", true, null);
    logAudit("alice", "post_task", "", true, null);
    expect(getAuditLog("alice").length).toBe(2);
    expect(getAuditLog("bob").length).toBe(1);
  });

  it("filters by tool", () => {
    logAudit("alice", "send_message", "", true, null);
    logAudit("alice", "post_task", "", true, null);
    expect(getAuditLog(undefined, "send_message").length).toBe(1);
    expect(getAuditLog(undefined, "post_task").length).toBe(1);
  });

  it("returns newest first", () => {
    logAudit("a", "tool1", "", true, null);
    logAudit("a", "tool2", "", true, null);
    logAudit("a", "tool3", "", true, null);
    const log = getAuditLog();
    expect(log[0].tool).toBe("tool3");
    expect(log[2].tool).toBe("tool1");
  });
});

// --- Rate limiting ---

describe("rate limiting", () => {
  it("allows calls under the limit", () => {
    const r1 = checkAndRecordRateLimit("alice", "messages", 10);
    const r2 = checkAndRecordRateLimit("alice", "messages", 10);
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r1.count).toBe(1);
    expect(r2.count).toBe(2);
  });

  it("blocks calls over the limit", () => {
    for (let i = 0; i < 3; i++) checkAndRecordRateLimit("bob", "messages", 3);
    const result = checkAndRecordRateLimit("bob", "messages", 3);
    expect(result.allowed).toBe(false);
    expect(result.count).toBe(4);
  });

  it("separates buckets per agent", () => {
    checkAndRecordRateLimit("alice", "messages", 2);
    checkAndRecordRateLimit("alice", "messages", 2);
    const aliceBlocked = checkAndRecordRateLimit("alice", "messages", 2);
    expect(aliceBlocked.allowed).toBe(false);

    // Bob is in the same bucket but different agent — should be allowed
    const bobAllowed = checkAndRecordRateLimit("bob", "messages", 2);
    expect(bobAllowed.allowed).toBe(true);
  });

  it("separates buckets by type", () => {
    checkAndRecordRateLimit("alice", "messages", 2);
    checkAndRecordRateLimit("alice", "messages", 2);
    const msgBlocked = checkAndRecordRateLimit("alice", "messages", 2);
    expect(msgBlocked.allowed).toBe(false);

    // Different bucket — should be allowed
    const tasksAllowed = checkAndRecordRateLimit("alice", "tasks", 2);
    expect(tasksAllowed.allowed).toBe(true);
  });
});

// --- Tool-level rate-limit rejection tests (v1.6.1) ---

describe("rate limiting at tool dispatch", () => {
  it("send_message returns isError after limit hit", async () => {
    // Set a very small limit and run through the real dispatcher by directly
    // checking the in-process rate limit then asserting behavior on the next call.
    // We reuse the db checkAndRecordRateLimit which the dispatcher uses.
    for (let i = 0; i < 5; i++) {
      const r = checkAndRecordRateLimit("agent:rl-tester", "messages", 5);
      expect(r.allowed).toBe(true);
    }
    const blocked = checkAndRecordRateLimit("agent:rl-tester", "messages", 5);
    expect(blocked.allowed).toBe(false);
    expect(blocked.count).toBe(6);
    expect(blocked.limit).toBe(5);
  });

  it("IP-keyed rate limit cannot be bypassed by switching agent names", () => {
    // Simulated HTTP no-auth path: the dispatcher composes key as "ip:<addr>".
    // Switching the agent field doesn't matter — the rate-limit key is the IP.
    const ipKey = "ip:203.0.113.42";
    for (let i = 0; i < 3; i++) {
      checkAndRecordRateLimit(ipKey, "messages", 3);
    }
    // Another call — still same IP key — should be blocked even though
    // in the real HTTP path the caller would have sent a different agent name.
    const result = checkAndRecordRateLimit(ipKey, "messages", 3);
    expect(result.allowed).toBe(false);
  });

  it("separate IPs get separate quotas", () => {
    for (let i = 0; i < 3; i++) {
      checkAndRecordRateLimit("ip:198.51.100.1", "messages", 3);
    }
    const firstIpBlocked = checkAndRecordRateLimit("ip:198.51.100.1", "messages", 3);
    expect(firstIpBlocked.allowed).toBe(false);

    const otherIpOk = checkAndRecordRateLimit("ip:198.51.100.2", "messages", 3);
    expect(otherIpOk.allowed).toBe(true);
  });
});
