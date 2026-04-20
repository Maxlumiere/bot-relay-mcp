// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 4e — webhook hardening bundle.
 *
 * Covers four same-surface fixes:
 *   A. DNS-rebinding defense at fire time (tests 1–3)
 *   B. Replay-defense infrastructure: delivery_id + Date header (tests 4–5)
 *   C. Error-message redaction at the DB sink (tests 6–7)
 *   D. Idempotency-key payload field (tests 8–9)
 *   + Combined / end-to-end (test 10)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import http from "http";
import path from "path";
import os from "os";
import type { Server as HttpServer } from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-webhook-harden-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_ALLOW_LEGACY;
delete process.env.RELAY_HTTP_SECRET;

const { fireWebhooks, deriveIdempotencyKey } = await import("../src/webhooks.js");
const { redactErrorMessage, registerAgent, getDb, closeDb } = await import("../src/db.js");

function cleanup() {
  closeDb();
  delete process.env.RELAY_ALLOW_PRIVATE_WEBHOOKS;
  if (fs.existsSync(TEST_DB_DIR)) {
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  }
}

beforeEach(() => {
  cleanup();
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
});
afterEach(cleanup);

function seedWebhook(url: string, event = "*", secret: string | null = null): string {
  const id = "wh-" + Math.random().toString(36).slice(2, 10);
  getDb().prepare(
    "INSERT INTO webhook_subscriptions (id, url, event, filter, secret, created_at) VALUES (?, ?, ?, NULL, ?, ?)"
  ).run(id, url, event, secret, new Date().toISOString());
  return id;
}

function getLatestLogError(webhookId: string): string | null {
  const row = getDb().prepare(
    "SELECT error FROM webhook_delivery_log WHERE webhook_id = ? ORDER BY attempted_at DESC LIMIT 1"
  ).get(webhookId) as { error: string | null } | undefined;
  return row?.error ?? null;
}

// --- A. DNS-rebinding defense at fire time (3 tests) ---

describe("v2.1 Phase 4e (A) — DNS rebinding defense at fire time", () => {
  it("(1) webhook URL resolving to loopback at fire time → refused, no retry", async () => {
    registerAgent("a", "r", []);
    registerAgent("b", "r", []);
    // Seed with RELAY_ALLOW_PRIVATE_WEBHOOKS=1 so the URL gets into the table
    // (simulating a register-time-safe hostname that later flips to loopback).
    const id = seedWebhook("http://127.0.0.1:1/fake");
    // Ensure private-allow is OFF at fire time (the attacker has won DNS).
    delete process.env.RELAY_ALLOW_PRIVATE_WEBHOOKS;
    fireWebhooks("message.sent" as any, "a", "b", { message_id: "m1" });
    await new Promise((r) => setTimeout(r, 150));

    const err = getLatestLogError(id);
    expect(err).toBeTruthy();
    expect(err).toMatch(/DNS rebinding/i);
    // No retry scheduled — row should have no retry_count>0 AND have terminal_status set, OR be the terminal log entry.
    const rows = getDb().prepare(
      "SELECT retry_count, terminal_status, next_retry_at FROM webhook_delivery_log WHERE webhook_id = ?"
    ).all(id) as Array<{ retry_count: number; terminal_status: string | null; next_retry_at: string | null }>;
    for (const row of rows) {
      expect(row.next_retry_at).toBeNull();
    }
  });

  it("(2) webhook URL with a private IP literal → refused at fire time", async () => {
    registerAgent("a", "r", []);
    registerAgent("b", "r", []);
    const id = seedWebhook("http://10.0.0.5:3333/internal");
    delete process.env.RELAY_ALLOW_PRIVATE_WEBHOOKS;
    fireWebhooks("message.sent" as any, "a", "b", { message_id: "m2" });
    await new Promise((r) => setTimeout(r, 150));
    const err = getLatestLogError(id);
    expect(err).toMatch(/DNS rebinding/i);
  });

  it("(3) webhook URL pointing to a real public-reachable test server → fires normally", async () => {
    // Stand up a tiny local server but REGISTER it via RELAY_ALLOW_PRIVATE_WEBHOOKS=1
    // AND keep the flag on at fire time — this simulates the operator-opt-in
    // path where private is intentional. The DNS re-check at fire time reads
    // the flag too, so it passes.
    process.env.RELAY_ALLOW_PRIVATE_WEBHOOKS = "1";
    let received = 0;
    const server = http.createServer((_req, res) => {
      received += 1;
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;
    try {
      registerAgent("a", "r", []);
      registerAgent("b", "r", []);
      seedWebhook(`http://127.0.0.1:${port}/h`);
      fireWebhooks("message.sent" as any, "a", "b", { message_id: "m3" });
      // wait for async delivery
      await new Promise((r) => setTimeout(r, 400));
      expect(received).toBeGreaterThanOrEqual(1);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

// --- B. Replay-defense infrastructure: delivery_id + Date (2 tests) ---

describe("v2.1 Phase 4e (B) — replay defense (delivery_id + Date)", () => {
  it("(4) payload includes delivery_id (uuidv4) AND X-Relay-Delivery-Id header matches", async () => {
    process.env.RELAY_ALLOW_PRIVATE_WEBHOOKS = "1";
    let capturedHeaders: Record<string, string | string[] | undefined> = {};
    let capturedBody = "";
    const server = http.createServer((req, res) => {
      capturedHeaders = req.headers;
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        capturedBody = body;
        res.writeHead(200);
        res.end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;
    try {
      registerAgent("a", "r", []);
      registerAgent("b", "r", []);
      seedWebhook(`http://127.0.0.1:${port}/h`);
      fireWebhooks("message.sent" as any, "a", "b", { message_id: "m4" });
      await new Promise((r) => setTimeout(r, 400));
      const parsed = JSON.parse(capturedBody);
      expect(parsed.delivery_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(capturedHeaders["x-relay-delivery-id"]).toBe(parsed.delivery_id);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("(5) response has a Date header (RFC 7231 parseable) on every fire", async () => {
    process.env.RELAY_ALLOW_PRIVATE_WEBHOOKS = "1";
    let capturedDate: string | undefined;
    const server = http.createServer((req, res) => {
      capturedDate = req.headers.date as string | undefined;
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;
    try {
      registerAgent("a", "r", []);
      registerAgent("b", "r", []);
      seedWebhook(`http://127.0.0.1:${port}/h`);
      fireWebhooks("message.sent" as any, "a", "b", { message_id: "m5" });
      await new Promise((r) => setTimeout(r, 400));
      expect(capturedDate).toBeTruthy();
      // RFC 7231 is parseable by Date constructor.
      const parsedMs = Date.parse(capturedDate!);
      expect(Number.isFinite(parsedMs)).toBe(true);
      expect(Math.abs(Date.now() - parsedMs)).toBeLessThan(10_000); // within 10s
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

// --- C. Redaction (2 tests) ---

describe("v2.1 Phase 4e (C) — error message redaction", () => {
  it("(6) redactErrorMessage strips IPs, paths, URLs, bcrypt, long tokens", () => {
    const raw =
      "Failed POST https://evil.example.com/ingest: connect to 10.0.0.5:3333 via /usr/local/lib/node_modules/foo. token=abc123def456ghi789jkl0123 hash=$2b$10$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const out = redactErrorMessage(raw)!;
    expect(out).not.toContain("evil.example.com");
    expect(out).not.toContain("10.0.0.5");
    expect(out).not.toContain("/usr/local/lib");
    expect(out).not.toContain("abc123def456ghi789jkl0123");
    expect(out).not.toContain("$2b$10$");
    expect(out).toContain("<url>");
    expect(out).toContain("<ip>");
  });

  it("(7) redaction applies to scheduleWebhookRetry's error column", async () => {
    // Fire to an unreachable port so the error_message gets populated from fetch's failure.
    process.env.RELAY_ALLOW_PRIVATE_WEBHOOKS = "1";
    registerAgent("a", "r", []);
    registerAgent("b", "r", []);
    const id = seedWebhook("http://127.0.0.1:1/nope"); // port 1 unreachable
    fireWebhooks("message.sent" as any, "a", "b", { message_id: "m7" });
    await new Promise((r) => setTimeout(r, 500));
    const err = getLatestLogError(id);
    expect(err).toBeTruthy();
    // Redaction should have scrubbed the internal path + IP from the fetch error.
    expect(err).not.toContain("127.0.0.1");
  });
});

// --- D. Idempotency key (2 tests) ---

describe("v2.1 Phase 4e (D) — idempotency key", () => {
  it("(8) deriveIdempotencyKey prefers message_id over task_id over channel_name over timestamp", () => {
    const withMsg = deriveIdempotencyKey("message.sent" as any, "a", "b", { message_id: "m-1", task_id: "t-1" });
    expect(withMsg).toBe("message.sent:a:b:m-1");

    const withTask = deriveIdempotencyKey("task.posted" as any, "a", "b", { task_id: "t-2" });
    expect(withTask).toBe("task.posted:a:b:t-2");

    const withChannel = deriveIdempotencyKey("channel.message_posted" as any, "a", "b", { channel_name: "ops" });
    expect(withChannel).toBe("channel.message_posted:a:b:ops");

    const fallbackTs = deriveIdempotencyKey("agent.spawned" as any, "a", "b", { timestamp: "2026-01-01T00:00:00Z" });
    expect(fallbackTs).toBe("agent.spawned:a:b:2026-01-01T00:00:00Z");
  });

  it("(9) same message_id → same idempotency_key across fires", async () => {
    process.env.RELAY_ALLOW_PRIVATE_WEBHOOKS = "1";
    const captured: string[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.idempotency_key) captured.push(parsed.idempotency_key);
        } catch {
          /* ignore */
        }
        res.writeHead(200);
        res.end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;
    try {
      registerAgent("a", "r", []);
      registerAgent("b", "r", []);
      seedWebhook(`http://127.0.0.1:${port}/h`);
      fireWebhooks("message.sent" as any, "a", "b", { message_id: "stable-id" });
      fireWebhooks("message.sent" as any, "a", "b", { message_id: "stable-id" });
      await new Promise((r) => setTimeout(r, 500));
      expect(captured.length).toBeGreaterThanOrEqual(2);
      expect(captured[0]).toBe(captured[1]);
      expect(captured[0]).toBe("message.sent:a:b:stable-id");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

// --- End-to-end combined (1 test) ---

describe("v2.1 Phase 4e — combined end-to-end", () => {
  it("(10) successful delivery carries all four new artifacts; persisted log row has no leaks", async () => {
    process.env.RELAY_ALLOW_PRIVATE_WEBHOOKS = "1";
    let capturedHeaders: Record<string, string | string[] | undefined> = {};
    let capturedBody = "";
    const server = http.createServer((req, res) => {
      capturedHeaders = req.headers;
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        capturedBody = body;
        res.writeHead(200);
        res.end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;
    try {
      registerAgent("a", "r", []);
      registerAgent("b", "r", []);
      const id = seedWebhook(`http://127.0.0.1:${port}/h`);
      fireWebhooks("message.sent" as any, "a", "b", { message_id: "m10" });
      await new Promise((r) => setTimeout(r, 400));

      const parsed = JSON.parse(capturedBody);
      // Four new artifacts:
      expect(parsed.delivery_id).toMatch(/^[0-9a-f]{8}-/);
      expect(parsed.idempotency_key).toBe("message.sent:a:b:m10");
      expect(capturedHeaders["x-relay-delivery-id"]).toBe(parsed.delivery_id);
      expect(capturedHeaders["date"]).toBeTruthy();

      // Persisted log should have the pre-log "in-flight" placeholder or a
      // success terminal — either way, no leaky payload content in `error`.
      const rows = getDb().prepare(
        "SELECT error FROM webhook_delivery_log WHERE webhook_id = ?"
      ).all(id) as Array<{ error: string | null }>;
      for (const row of rows) {
        if (row.error) {
          expect(row.error).not.toContain("127.0.0.1");
          expect(row.error).not.toMatch(/\$2[aby]\$/);
        }
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
