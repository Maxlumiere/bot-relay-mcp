// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v2final-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;

const {
  registerAgent,
  sendMessage,
  getMessages,
  getAgents,
  setAgentStatus,
  getHealthSnapshot,
  runHealthMonitorTick,
  postTask,
  updateTask,
  closeDb,
  getDb,
} = await import("../src/db.js");

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) {
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  }
  delete process.env.RELAY_MAX_PAYLOAD_BYTES;
  delete process.env.RELAY_LOG_LEVEL;
}

beforeEach(cleanup);
afterEach(cleanup);

// ============================================================================
// #6 — Session-aware read receipts
// ============================================================================

describe("v2.0 final #6 — session-aware read receipts", () => {
  it("new terminal session sees previously-read messages again (handover fix)", () => {
    // Victra sends audit to victra-build — session 1 reads it.
    registerAgent("victra", "cos", []);
    registerAgent("victra-build", "builder", ["build"]);
    sendMessage("victra", "victra-build", "CRITICAL: 4 Codex HIGHs", "high");

    // Session 1 reads, message gets marked read_by_session = session-1.
    const s1Messages = getMessages("victra-build", "pending", 20);
    expect(s1Messages.length).toBe(1);
    expect(s1Messages[0].content).toBe("CRITICAL: 4 Codex HIGHs");

    // Same session re-reads pending → empty. Good.
    const s1Again = getMessages("victra-build", "pending", 20);
    expect(s1Again.length).toBe(0);

    // New terminal opens — re-registers → session rotates.
    const reReg = registerAgent("victra-build", "builder", ["build"]);
    const session2 = reReg.agent.session_id;
    expect(session2).toBeTruthy();

    // Session 2 pending inbox includes the previously-read message.
    const s2Messages = getMessages("victra-build", "pending", 20);
    expect(s2Messages.length).toBe(1);
    expect(s2Messages[0].content).toBe("CRITICAL: 4 Codex HIGHs");

    // Now session 2 has marked it read. A third session would see it again.
    const reReg3 = registerAgent("victra-build", "builder", ["build"]);
    expect(reReg3.agent.session_id).not.toBe(session2);
    const s3Messages = getMessages("victra-build", "pending", 20);
    expect(s3Messages.length).toBe(1);
  });

  it("session_id rotates on every register_agent call", () => {
    const r1 = registerAgent("alice", "r", []);
    const s1 = r1.agent.session_id;
    const r2 = registerAgent("alice", "r", []);
    const s2 = r2.agent.session_id;
    const r3 = registerAgent("alice", "r", []);
    const s3 = r3.agent.session_id;
    expect(s1).toBeTruthy();
    expect(s2).toBeTruthy();
    expect(s3).toBeTruthy();
    expect(new Set([s1, s2, s3]).size).toBe(3);
  });

  it("status='all' returns everything regardless of session", () => {
    registerAgent("sender", "r", []);
    registerAgent("recipient", "r", []);
    sendMessage("sender", "recipient", "m1", "normal");
    sendMessage("sender", "recipient", "m2", "normal");

    // Read all → marks them read for session 1.
    getMessages("recipient", "pending", 20);
    // Same session, status='all' still returns all 2.
    const all = getMessages("recipient", "all", 20);
    expect(all.length).toBe(2);
  });

  it("status='read' returns only messages read by THIS session", () => {
    registerAgent("sender", "r", []);
    const r1 = registerAgent("recipient", "r", []);
    const session1 = r1.agent.session_id;
    sendMessage("sender", "recipient", "m1", "normal");

    // Read as session 1
    getMessages("recipient", "pending", 20);
    const read1 = getMessages("recipient", "read", 20);
    expect(read1.length).toBe(1);

    // New session — "read" should return 0 (this session hasn't read anything).
    const r2 = registerAgent("recipient", "r", []);
    expect(r2.agent.session_id).not.toBe(session1);
    const read2 = getMessages("recipient", "read", 20);
    expect(read2.length).toBe(0);
  });
});

// ============================================================================
// #7 — Payload size limit
// ============================================================================

describe("v2.0 final #7 — payload size limit", () => {
  it("rejects message content beyond RELAY_MAX_PAYLOAD_BYTES at zod boundary", async () => {
    process.env.RELAY_MAX_PAYLOAD_BYTES = "100";
    // Re-import schema so the new env is picked up (payloadMaxBytes reads at eval time).
    // Our refine reads env at call time, so no re-import needed.
    const { SendMessageSchema } = await import("../src/types.js");
    const big = "a".repeat(200);
    const result = SendMessageSchema.safeParse({
      from: "x",
      to: "y",
      content: big,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(JSON.stringify(result.error.issues)).toMatch(/RELAY_MAX_PAYLOAD_BYTES/);
    }
  });

  it("accepts content within the limit", async () => {
    process.env.RELAY_MAX_PAYLOAD_BYTES = "100";
    const { SendMessageSchema } = await import("../src/types.js");
    const ok = "a".repeat(50);
    const result = SendMessageSchema.safeParse({
      from: "x",
      to: "y",
      content: ok,
    });
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// #2 — Dead agent purge
// ============================================================================

describe("v2.0 final #2 — dead agent purge on startup", () => {
  it("purges agents offline >30 days during purgeOldRecords (called by getDb)", () => {
    // Register a fresh agent.
    registerAgent("fresh", "r", ["x"]);
    // Directly age another agent into the dead zone via raw SQL.
    const db = getDb();
    db.prepare(
      "INSERT INTO agents (id, name, role, capabilities, last_seen, created_at, token_hash, session_id, agent_status) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'online')"
    ).run("stale-id", "stale-agent", "r", "[]", "2020-01-01T00:00:00Z", "2020-01-01T00:00:00Z", "stale-sess");
    db.prepare("INSERT INTO agent_capabilities (agent_name, capability) VALUES (?, ?)").run("stale-agent", "cap1");

    // Close + reopen to re-trigger startup purge.
    closeDb();
    const freshDb = getDb();
    const agents = getAgents();
    expect(agents.find((a) => a.name === "fresh")).toBeTruthy();
    expect(agents.find((a) => a.name === "stale-agent")).toBeUndefined();
    // Normalized caps are cleaned up.
    const caps = freshDb.prepare("SELECT * FROM agent_capabilities WHERE agent_name = ?").all("stale-agent") as unknown[];
    expect(caps.length).toBe(0);
  });
});

// ============================================================================
// #34 — Debug log level
// ============================================================================

describe("v2.0 final #34 — RELAY_LOG_LEVEL debug mode", () => {
  it("log.debug emits to stderr when RELAY_LOG_LEVEL=debug", async () => {
    process.env.RELAY_LOG_LEVEL = "debug";
    const { log } = await import("../src/logger.js");
    const chunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr.write as any) = (s: string) => { chunks.push(String(s)); return true; };
    try {
      log.debug("test-debug-marker");
    } finally {
      (process.stderr.write as any) = origWrite;
    }
    expect(chunks.join("")).toMatch(/test-debug-marker/);
  });

  it("log.debug is silent at default (info) level", async () => {
    delete process.env.RELAY_LOG_LEVEL;
    delete process.env.RELAY_LOG_DEBUG;
    const { log } = await import("../src/logger.js");
    const chunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr.write as any) = (s: string) => { chunks.push(String(s)); return true; };
    try {
      log.debug("should-not-appear");
    } finally {
      (process.stderr.write as any) = origWrite;
    }
    expect(chunks.join("")).not.toMatch(/should-not-appear/);
  });
});

// ============================================================================
// #29 — Agent description
// ============================================================================

// ============================================================================
// #26 — Busy/DND status
// ============================================================================

describe("v2.0 final #26 — busy/DND status exempts agent from health-monitor requeue", () => {
  it("busy agent with stale lease + stale last_seen is NOT requeued", () => {
    process.env.RELAY_HEALTH_REASSIGN_GRACE_MINUTES = "1";
    registerAgent("r", "user", ["tasks"]);
    registerAgent("w", "builder", ["build"]);
    const t = postTask("r", "w", "x", "d", "normal");
    updateTask(t.id, "w", "accept");

    // Age BOTH lease + last_seen — would normally requeue.
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    getDb().prepare("UPDATE tasks SET lease_renewed_at = ? WHERE id = ?").run(tenMinAgo, t.id);
    getDb().prepare("UPDATE agents SET last_seen = ? WHERE name = ?").run(tenMinAgo, "w");

    // But mark busy → exempt.
    setAgentStatus("w", "busy");

    const requeued = runHealthMonitorTick("test-busy");
    expect(requeued.length).toBe(0);
  });

  it("away status is also exempt; online with stale last_seen is requeued", () => {
    process.env.RELAY_HEALTH_REASSIGN_GRACE_MINUTES = "1";
    registerAgent("r", "user", ["tasks"]);
    registerAgent("away-agent", "b", ["build"]);
    registerAgent("online-agent", "b", ["build"]);
    const t1 = postTask("r", "away-agent", "x", "d", "normal");
    const t2 = postTask("r", "online-agent", "x", "d", "normal");
    updateTask(t1.id, "away-agent", "accept");
    updateTask(t2.id, "online-agent", "accept");

    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    getDb().prepare("UPDATE tasks SET lease_renewed_at = ? WHERE id IN (?, ?)").run(tenMinAgo, t1.id, t2.id);
    getDb().prepare("UPDATE agents SET last_seen = ? WHERE name IN ('away-agent','online-agent')").run(tenMinAgo);
    setAgentStatus("away-agent", "away");
    // online-agent stays 'online'

    const requeued = runHealthMonitorTick("test-away");
    expect(requeued.length).toBe(1);
    expect(requeued[0].previous_agent).toBe("online-agent");
  });

  it("setAgentStatus returns false for unknown agent", () => {
    expect(setAgentStatus("ghost", "busy")).toBe(false);
  });
});

// ============================================================================
// #20 — health_check snapshot
// ============================================================================

describe("v2.0 final #20 — health snapshot", () => {
  it("reports counts across agents, messages, tasks, channels", () => {
    registerAgent("a", "r", ["x"]);
    registerAgent("b", "r", ["x"]);
    sendMessage("a", "b", "hello", "normal");
    postTask("a", "b", "build", "d", "normal");

    const snap = getHealthSnapshot();
    expect(snap.status).toBe("ok");
    expect(snap.agent_count).toBe(2);
    expect(snap.message_count_pending).toBeGreaterThanOrEqual(1);
    expect(snap.task_count_active).toBe(1);
    expect(snap.task_count_queued).toBe(0);
    expect(snap.channel_count).toBe(0);
  });
});

// ============================================================================
// #18 — config validation
// ============================================================================

describe("v2.0 final #18 — config validation", () => {
  it("rejects invalid log level with clear aggregate error", async () => {
    const { validateConfigAndEnv, InvalidConfigError, DEFAULT_CONFIG } = await import("../src/config.js");
    const prev = process.env.RELAY_LOG_LEVEL;
    process.env.RELAY_LOG_LEVEL = "verbose";
    try {
      expect(() => validateConfigAndEnv(DEFAULT_CONFIG)).toThrow(InvalidConfigError);
      expect(() => validateConfigAndEnv(DEFAULT_CONFIG)).toThrow(/RELAY_LOG_LEVEL/);
    } finally {
      if (prev === undefined) delete process.env.RELAY_LOG_LEVEL;
      else process.env.RELAY_LOG_LEVEL = prev;
    }
  });

  it("rejects non-integer RELAY_HEALTH_REASSIGN_GRACE_MINUTES", async () => {
    const { validateConfigAndEnv, InvalidConfigError, DEFAULT_CONFIG } = await import("../src/config.js");
    process.env.RELAY_HEALTH_REASSIGN_GRACE_MINUTES = "not-a-number";
    try {
      expect(() => validateConfigAndEnv(DEFAULT_CONFIG)).toThrow(InvalidConfigError);
    } finally {
      delete process.env.RELAY_HEALTH_REASSIGN_GRACE_MINUTES;
    }
  });

  it("rejects HTTP secret shorter than 32 chars", async () => {
    const { validateConfigAndEnv, InvalidConfigError, DEFAULT_CONFIG } = await import("../src/config.js");
    expect(() => validateConfigAndEnv({ ...DEFAULT_CONFIG, http_secret: "tooshort" })).toThrow(InvalidConfigError);
  });

  it("accepts a fully valid default config", async () => {
    const { validateConfigAndEnv, DEFAULT_CONFIG } = await import("../src/config.js");
    expect(() => validateConfigAndEnv(DEFAULT_CONFIG)).not.toThrow();
  });
});

// ============================================================================
// Webhook retry with CAS
// ============================================================================

describe("v2.0 final — webhook retry with CAS", () => {
  it("schedules retry with next_retry_at, claim is CAS-protected, retry_count increments", async () => {
    const { scheduleWebhookRetry, claimDueWebhookRetries, recordWebhookRetryOutcome } = await import("../src/db.js");
    registerAgent("sender", "r", []);
    // Seed a webhook subscription directly since we're testing retry mechanics, not routing.
    const db = getDb();
    db.prepare(
      "INSERT INTO webhook_subscriptions (id, url, event, filter, secret, created_at) VALUES (?, ?, ?, NULL, NULL, ?)"
    ).run("wh-1", "http://127.0.0.1:1/never", "*", new Date().toISOString());

    // Schedule a failed initial delivery → retry_count=1, next_retry_at=now+60s.
    scheduleWebhookRetry("wh-1", "message.sent", "{}", "HTTP 500");

    // Not yet due (60s ahead) → claim returns empty.
    expect(claimDueWebhookRetries().length).toBe(0);

    // Force next_retry_at to the past so claim matures.
    db.prepare(
      "UPDATE webhook_delivery_log SET next_retry_at = ? WHERE webhook_id = ? AND terminal_status IS NULL"
    ).run("2000-01-01T00:00:00Z", "wh-1");

    const jobs = claimDueWebhookRetries();
    expect(jobs.length).toBe(1);
    expect(jobs[0].webhook_id).toBe("wh-1");
    expect(jobs[0].retry_count).toBe(1);

    // CAS worked: claiming again immediately returns empty.
    expect(claimDueWebhookRetries().length).toBe(0);

    // Record failure → retry_count increments, next_retry_at reschedules.
    recordWebhookRetryOutcome(jobs[0].log_id, false, 500, "HTTP 500");
    const row = db.prepare(
      "SELECT retry_count, next_retry_at, terminal_status FROM webhook_delivery_log WHERE id = ?"
    ).get(jobs[0].log_id) as { retry_count: number; next_retry_at: string | null; terminal_status: string | null };
    expect(row.retry_count).toBe(2);
    expect(row.next_retry_at).toBeTruthy();
    expect(row.terminal_status).toBeNull();
  });

  it("third failure goes terminal (failed); success goes terminal (delivered)", async () => {
    const { scheduleWebhookRetry, recordWebhookRetryOutcome } = await import("../src/db.js");
    const db = getDb();
    db.prepare(
      "INSERT INTO webhook_subscriptions (id, url, event, filter, secret, created_at) VALUES (?, ?, ?, NULL, NULL, ?)"
    ).run("wh-2", "http://127.0.0.1:1/x", "*", new Date().toISOString());

    scheduleWebhookRetry("wh-2", "message.sent", "{}", "HTTP 500");
    const row = db.prepare(
      "SELECT id FROM webhook_delivery_log WHERE webhook_id = ? ORDER BY attempted_at DESC LIMIT 1"
    ).get("wh-2") as { id: string };

    // Fail attempts 1 → 2, then 2 → 3 (scheduled next), then 3 → terminal failed.
    recordWebhookRetryOutcome(row.id, false, 500, "500");
    recordWebhookRetryOutcome(row.id, false, 500, "500");
    recordWebhookRetryOutcome(row.id, false, 500, "500");
    const final = db.prepare(
      "SELECT retry_count, terminal_status FROM webhook_delivery_log WHERE id = ?"
    ).get(row.id) as { retry_count: number; terminal_status: string };
    expect(final.terminal_status).toBe("failed");
    // retry_count caps at the ladder length (3)
    expect(final.retry_count).toBeGreaterThanOrEqual(3);

    // Success path
    db.prepare(
      "INSERT INTO webhook_subscriptions (id, url, event, filter, secret, created_at) VALUES (?, ?, ?, NULL, NULL, ?)"
    ).run("wh-3", "http://127.0.0.1:1/y", "*", new Date().toISOString());
    scheduleWebhookRetry("wh-3", "message.sent", "{}", "HTTP 500");
    const row3 = db.prepare(
      "SELECT id FROM webhook_delivery_log WHERE webhook_id = ? ORDER BY attempted_at DESC LIMIT 1"
    ).get("wh-3") as { id: string };
    recordWebhookRetryOutcome(row3.id, true, 200, null);
    const final3 = db.prepare(
      "SELECT terminal_status FROM webhook_delivery_log WHERE id = ?"
    ).get(row3.id) as { terminal_status: string };
    expect(final3.terminal_status).toBe("delivered");
  });
});

describe("v2.0 final #29 — agent description field", () => {
  it("description set on first register, visible in discover_agents", () => {
    registerAgent("worker", "builder", ["x"], { description: "Runs nightly builds for the API" } as any);
    const agents = getAgents();
    const w = agents.find((a) => a.name === "worker");
    expect(w?.description).toBe("Runs nightly builds for the API");
  });

  it("description preserved on re-register if omitted; updated if provided", () => {
    registerAgent("worker", "builder", ["x"], { description: "original" } as any);
    // re-register without description → preserved
    registerAgent("worker", "builder", ["x"]);
    let w = getAgents().find((a) => a.name === "worker");
    expect(w?.description).toBe("original");
    // re-register with new description → updated
    registerAgent("worker", "builder", ["x"], { description: "updated" } as any);
    w = getAgents().find((a) => a.name === "worker");
    expect(w?.description).toBe("updated");
  });
});
