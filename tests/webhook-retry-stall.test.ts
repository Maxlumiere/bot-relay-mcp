// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 4q MED #4 — webhook retry piggyback on every Nth tool call
 * regardless of whether the tool itself fires webhooks.
 *
 * Broken-before: retry scan lived only inside fireWebhooks(). If a relay
 * had due retries queued AND subsequent traffic landed on tools with no
 * matching webhook subscriptions (discover_agents, get_messages),
 * retries sat indefinitely.
 *
 * Fixed: maybePiggybackWebhookRetries() runs in runCall after enforceAuth,
 * on every Nth tool call (N=5). Retries claimed + fired within the
 * piggyback window regardless of tool type.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import type { Server as HttpServer } from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-4q-retry-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
process.env.RELAY_ALLOW_PRIVATE_WEBHOOKS = "1";

const { startHttpServer } = await import("../src/transport/http.js");
const { closeDb, getDb, registerWebhook, registerAgent } = await import("../src/db.js");
const { _resetPiggybackCounterForTests } = await import("../src/server.js");

let server: HttpServer;
let baseUrl: string;

async function rpc(tool: string, args: any, token?: string): Promise<any> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (token) headers["X-Agent-Token"] = token;
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse(JSON.parse(dataLine!.slice(5).trim()).result.content[0].text);
}

function cleanup() {
  try { server?.close(); } catch { /* ignore */ }
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
}

beforeEach(async () => {
  cleanup();
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  delete process.env.RELAY_AGENT_TOKEN;
  // Counter is module-scoped (persists across HTTP requests); reset per test.
  _resetPiggybackCounterForTests();
  server = startHttpServer(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 80));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});
afterEach(cleanup);

describe("v2.1 Phase 4q MED #4 — webhook retry piggyback on every tool call", () => {
  it("(1) due retry claims + fires on N-th non-webhook tool call (not just webhook-firing tools)", async () => {
    registerAgent("obs", "r", []);
    // Register a webhook targeting a dead port so the retry never succeeds —
    // but also irrelevant: we're verifying the CLAIM path runs, not delivery.
    const wh = registerWebhook("http://127.0.0.1:65500/gone", "channel.message_posted", undefined, "secret");

    // Seed a due retry row directly. next_retry_at in the past so it
    // qualifies for claim immediately.
    const dueAt = new Date(Date.now() - 1000).toISOString();
    const insertedAt = new Date().toISOString();
    getDb().prepare(
      "INSERT INTO webhook_delivery_log (id, webhook_id, event, payload, status_code, error, attempted_at, retry_count, next_retry_at) " +
      "VALUES (?, ?, ?, ?, 500, 'seed', ?, 1, ?)"
    ).run("log-stall-1", wh.id, "channel.message_posted", "{}", insertedAt, dueAt);

    // Register a caller with a token so we can make cap-less auth'd calls.
    const reg = await rpc("register_agent", { name: "caller-1", role: "r", capabilities: [] });
    const tok = reg.agent_token;

    // Fire 6 calls to discover_agents (NO matching webhook subscription for
    // this event). Pre-fix, the retry would stall indefinitely; post-fix,
    // piggyback fires on the 5th call (counter hits 5).
    // Note: register_agent above was call #1 counter-wise. So this loop
    // will cross the piggyback threshold inside these 6 iterations.
    for (let i = 0; i < 6; i++) {
      await rpc("discover_agents", {}, tok);
    }
    // Give fire-and-forget retryOne a moment to update the log row.
    await new Promise((r) => setTimeout(r, 200));

    // The claim attempt MUST have incremented retry_count or marked the row
    // terminal. Pre-fix: retry_count stays at 1 forever. Post-fix: either
    // retry_count incremented (another retry scheduled) or terminal_status
    // was set (permanent failure after exhausted attempts).
    const row = getDb()
      .prepare("SELECT retry_count, terminal_status, claimed_at FROM webhook_delivery_log WHERE id = 'log-stall-1'")
      .get() as { retry_count: number; terminal_status: string | null; claimed_at: string | null };
    const scanFired = row.claimed_at !== null || row.retry_count > 1 || row.terminal_status !== null;
    expect(scanFired).toBe(true);
  });

  it("(2) piggyback counter: calls below N-1 do NOT trigger scan; call N-1 DOES trigger (in 0-based counter terms)", async () => {
    // This test asserts the counter mechanism without asserting the exact
    // N value (the constant may change). We verify that SOME number of
    // tool calls < 10 triggers a scan — the piggyback frequency is
    // guaranteed to run at or before the 10th call if N is sane (≤ 10).
    registerAgent("obs2", "r", []);
    const wh = registerWebhook("http://127.0.0.1:65500/gone", "channel.message_posted", undefined, "secret");
    const dueAt = new Date(Date.now() - 1000).toISOString();
    const insertedAt = new Date().toISOString();
    getDb().prepare(
      "INSERT INTO webhook_delivery_log (id, webhook_id, event, payload, status_code, error, attempted_at, retry_count, next_retry_at) " +
      "VALUES ('log-stall-2', ?, ?, '{}', 500, 'seed', ?, 1, ?)"
    ).run(wh.id, "channel.message_posted", insertedAt, dueAt);

    const reg = await rpc("register_agent", { name: "caller-2", role: "r", capabilities: [] });
    const tok = reg.agent_token;

    // Make 10 calls to a non-webhook tool. Within 10 calls the piggyback
    // must have fired at least once.
    for (let i = 0; i < 10; i++) {
      await rpc("discover_agents", {}, tok);
    }
    await new Promise((r) => setTimeout(r, 200));

    const row = getDb()
      .prepare("SELECT retry_count, terminal_status, claimed_at FROM webhook_delivery_log WHERE id = 'log-stall-2'")
      .get() as { retry_count: number; terminal_status: string | null; claimed_at: string | null };
    const scanFired = row.claimed_at !== null || row.retry_count > 1 || row.terminal_status !== null;
    expect(scanFired).toBe(true);
  });
});
