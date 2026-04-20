// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v201-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;

const {
  registerAgent,
  unregisterAgent,
  getAgentSessionId,
  getAgents,
  setAgentStatus,
  postTask,
  updateTask,
  getTask,
  runHealthMonitorTick,
  scheduleWebhookRetry,
  claimDueWebhookRetries,
  recordWebhookRetryOutcome,
  closeDb,
  getDb,
} = await import("../src/db.js");

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) {
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  }
  delete process.env.RELAY_BUSY_TTL_MINUTES;
  delete process.env.RELAY_WEBHOOK_CLAIM_LEASE_SECONDS;
  delete process.env.RELAY_HEALTH_REASSIGN_GRACE_MINUTES;
}

beforeEach(cleanup);
afterEach(cleanup);

// ============================================================================
// HIGH 1 — session-scoped auto-unregister
// ============================================================================

describe("v2.0.1 Codex HIGH 1 — session-scoped unregister", () => {
  it("old session's unregister does NOT wipe a freshly-registered new session", () => {
    // First register → session_A.
    const r1 = registerAgent("agent-x", "r", ["x"]);
    const sessionA = r1.agent.session_id!;
    expect(sessionA).toBeTruthy();

    // Second register (new terminal) → session_B.
    const r2 = registerAgent("agent-x", "r", ["x"]);
    const sessionB = r2.agent.session_id!;
    expect(sessionB).not.toBe(sessionA);

    // Old terminal's SIGINT fires. It captured session_A. Old session's
    // auto-unregister must NOT delete the row (now holding session_B).
    const removed = unregisterAgent("agent-x", sessionA);
    expect(removed).toBe(false);

    // The agent is still registered with session_B.
    const live = getAgents().find((a) => a.name === "agent-x");
    expect(live).toBeTruthy();
    expect(live?.session_id).toBe(sessionB);
  });

  it("matching session_id unregister succeeds (normal single-terminal path)", () => {
    const r = registerAgent("solo", "r", []);
    const sid = r.agent.session_id!;
    expect(unregisterAgent("solo", sid)).toBe(true);
    expect(getAgents().find((a) => a.name === "solo")).toBeUndefined();
  });

  it("manual unregister without session_id still wipes by name (explicit operator action)", () => {
    registerAgent("ops-target", "r", []);
    expect(unregisterAgent("ops-target")).toBe(true);
    expect(getAgents().find((a) => a.name === "ops-target")).toBeUndefined();
  });

  it("getAgentSessionId returns the current session_id, null for unknown agent", () => {
    const r = registerAgent("lookup", "r", []);
    expect(getAgentSessionId("lookup")).toBe(r.agent.session_id);
    expect(getAgentSessionId("ghost")).toBeNull();
  });
});

// ============================================================================
// HIGH 2 — busy_expires_at TTL + CAS re-check
// ============================================================================

describe("v2.0.1 Codex HIGH 2 — busy TTL + CAS re-check", () => {
  it("unexpired busy shields the agent from health requeue", () => {
    process.env.RELAY_HEALTH_REASSIGN_GRACE_MINUTES = "1";
    // Generous TTL so the shield is still valid at check time.
    process.env.RELAY_BUSY_TTL_MINUTES = "60";
    registerAgent("r", "u", ["tasks"]);
    registerAgent("w", "b", ["build"]);
    const t = postTask("r", "w", "x", "d", "normal");
    updateTask(t.id, "w", "accept");

    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    getDb().prepare("UPDATE tasks SET lease_renewed_at = ? WHERE id = ?").run(tenMinAgo, t.id);
    getDb().prepare("UPDATE agents SET last_seen = ? WHERE name = ?").run(tenMinAgo, "w");
    setAgentStatus("w", "busy"); // sets busy_expires_at = now + 60 min

    expect(runHealthMonitorTick("test-shielded").length).toBe(0);
    expect(getTask(t.id)?.status).toBe("accepted");
  });

  it("expired busy lifts the shield — health requeue fires", () => {
    process.env.RELAY_HEALTH_REASSIGN_GRACE_MINUTES = "1";
    process.env.RELAY_BUSY_TTL_MINUTES = "60";
    registerAgent("r", "u", ["tasks"]);
    registerAgent("w", "b", ["build"]);
    const t = postTask("r", "w", "x", "d", "normal");
    updateTask(t.id, "w", "accept");
    setAgentStatus("w", "busy");

    // Age everything: lease, last_seen, AND busy_expires_at.
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    getDb().prepare("UPDATE tasks SET lease_renewed_at = ? WHERE id = ?").run(tenMinAgo, t.id);
    getDb().prepare("UPDATE agents SET last_seen = ?, busy_expires_at = ? WHERE name = ?")
      .run(tenMinAgo, tenMinAgo, "w");

    const requeued = runHealthMonitorTick("test-expired");
    expect(requeued.length).toBe(1);
    expect(getTask(t.id)?.status).toBe("queued");
  });

  it("set_status(online) clears busy_expires_at", () => {
    registerAgent("z", "u", []);
    setAgentStatus("z", "busy");
    let row = getDb().prepare("SELECT busy_expires_at FROM agents WHERE name = 'z'").get() as { busy_expires_at: string | null };
    expect(row.busy_expires_at).toBeTruthy();
    setAgentStatus("z", "online");
    row = getDb().prepare("SELECT busy_expires_at FROM agents WHERE name = 'z'").get() as { busy_expires_at: string | null };
    expect(row.busy_expires_at).toBeNull();
  });
});

// ============================================================================
// HIGH 3 — webhook retry claim lease (crash-safe)
// ============================================================================

describe("v2.0.1 Codex HIGH 3 — webhook retry claim lease", () => {
  it("active lease blocks concurrent claim; expired lease is re-claimable", () => {
    process.env.RELAY_WEBHOOK_CLAIM_LEASE_SECONDS = "60";
    const db = getDb();
    db.prepare(
      "INSERT INTO webhook_subscriptions (id, url, event, filter, secret, created_at) VALUES (?, ?, ?, NULL, NULL, ?)"
    ).run("wh-lease", "http://127.0.0.1:1/x", "*", new Date().toISOString());

    scheduleWebhookRetry("wh-lease", "message.sent", "{}", "HTTP 500");
    // Mature the next_retry_at so the row is due.
    db.prepare(
      "UPDATE webhook_delivery_log SET next_retry_at = ? WHERE webhook_id = ? AND terminal_status IS NULL"
    ).run("2000-01-01T00:00:00Z", "wh-lease");

    // First claim succeeds; second sees the active lease and returns 0.
    const first = claimDueWebhookRetries();
    expect(first.length).toBe(1);
    const second = claimDueWebhookRetries();
    expect(second.length).toBe(0);

    // Simulate crash: expire the lease manually.
    db.prepare(
      "UPDATE webhook_delivery_log SET claim_expires_at = ? WHERE id = ?"
    ).run("2000-01-01T00:00:00Z", first[0].log_id);

    // Now a new caller can re-claim the stranded row.
    const third = claimDueWebhookRetries();
    expect(third.length).toBe(1);
    expect(third[0].log_id).toBe(first[0].log_id);
  });

  it("recordWebhookRetryOutcome clears the claim so next retry can claim again", () => {
    const db = getDb();
    db.prepare(
      "INSERT INTO webhook_subscriptions (id, url, event, filter, secret, created_at) VALUES (?, ?, ?, NULL, NULL, ?)"
    ).run("wh-clear", "http://127.0.0.1:1/y", "*", new Date().toISOString());
    scheduleWebhookRetry("wh-clear", "message.sent", "{}", "HTTP 500");
    db.prepare(
      "UPDATE webhook_delivery_log SET next_retry_at = ? WHERE webhook_id = ? AND terminal_status IS NULL"
    ).run("2000-01-01T00:00:00Z", "wh-clear");

    const [job] = claimDueWebhookRetries();
    expect(job).toBeTruthy();

    // Record failure → schedules a new next_retry_at + clears claim.
    recordWebhookRetryOutcome(job.log_id, false, 500, "HTTP 500");
    const row = db.prepare(
      "SELECT claimed_at, claim_expires_at, next_retry_at FROM webhook_delivery_log WHERE id = ?"
    ).get(job.log_id) as { claimed_at: string | null; claim_expires_at: string | null; next_retry_at: string | null };
    expect(row.claimed_at).toBeNull();
    expect(row.claim_expires_at).toBeNull();
    expect(row.next_retry_at).toBeTruthy();
  });
});

// ============================================================================
// MEDIUM 4 — strict numeric + DB path + transport
// ============================================================================

describe("v2.0.1 Codex MEDIUM 4 — strict config validation", () => {
  it("rejects parseInt-garbage env values like RELAY_HTTP_PORT=3000abc", async () => {
    const { validateConfigAndEnv, InvalidConfigError, DEFAULT_CONFIG } = await import("../src/config.js");
    process.env.RELAY_HTTP_PORT = "3000abc";
    try {
      expect(() => validateConfigAndEnv(DEFAULT_CONFIG)).toThrow(InvalidConfigError);
      expect(() => validateConfigAndEnv(DEFAULT_CONFIG)).toThrow(/RELAY_HTTP_PORT/);
    } finally {
      delete process.env.RELAY_HTTP_PORT;
    }
  });

  it("rejects RELAY_DB_PATH outside approved roots", async () => {
    const { validateConfigAndEnv, InvalidConfigError, DEFAULT_CONFIG } = await import("../src/config.js");
    const prev = process.env.RELAY_DB_PATH;
    process.env.RELAY_DB_PATH = "/etc/passwd-relay.db";
    try {
      expect(() => validateConfigAndEnv(DEFAULT_CONFIG)).toThrow(InvalidConfigError);
      expect(() => validateConfigAndEnv(DEFAULT_CONFIG)).toThrow(/RELAY_DB_PATH/);
    } finally {
      if (prev === undefined) delete process.env.RELAY_DB_PATH;
      else process.env.RELAY_DB_PATH = prev;
    }
  });

  it("accepts well-formed integer values", async () => {
    const { validateConfigAndEnv, DEFAULT_CONFIG } = await import("../src/config.js");
    const prev = process.env.RELAY_HTTP_PORT;
    process.env.RELAY_HTTP_PORT = "3777";
    try {
      expect(() => validateConfigAndEnv(DEFAULT_CONFIG)).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.RELAY_HTTP_PORT;
      else process.env.RELAY_HTTP_PORT = prev;
    }
  });
});

// ============================================================================
// MEDIUM 5 — concurrent same-name session warning
// ============================================================================

describe("v2.0.1 Codex MEDIUM 5 — concurrent same-name register warning", () => {
  it("emits log.warn when re-registering an online agent with rotated session_id", async () => {
    const { log } = await import("../src/logger.js");
    const warnings: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr.write as any) = (s: string) => {
      warnings.push(String(s));
      return true;
    };
    try {
      registerAgent("concurrent", "r", []);
      // Immediate re-register — existing row has fresh last_seen (< 10 min old).
      registerAgent("concurrent", "r", []);
    } finally {
      (process.stderr.write as any) = origWrite;
    }
    const joined = warnings.join("");
    expect(joined).toMatch(/concurrent/);
    expect(joined.toLowerCase()).toMatch(/online session|v2\.0 limitation/);
  });
});
