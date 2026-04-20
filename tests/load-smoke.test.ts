// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 5b — load smoke. N producers × M messages × K consumers at
 * sustained throughput. Validates no silent loss, no duplicate deliveries,
 * p99 latency under target, cap checks still enforced under concurrency.
 *
 * Defaults: N=5 producers, M=100 msgs each, K=3 consumers (500 total msgs).
 * Override via env for longer soak runs:
 *   RELAY_LOAD_PRODUCERS=10 RELAY_LOAD_MESSAGES=500 RELAY_LOAD_CONSUMERS=5
 *
 * Gated behind --full in pre-publish-check.sh; NOT part of the default
 * vitest run (too slow for dev loops).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import type { Server as HttpServer } from "http";

const N_PRODUCERS = parseInt(process.env.RELAY_LOAD_PRODUCERS || "5", 10);
const M_MESSAGES = parseInt(process.env.RELAY_LOAD_MESSAGES || "100", 10);
const K_CONSUMERS = parseInt(process.env.RELAY_LOAD_CONSUMERS || "3", 10);
const P99_LATENCY_MS = parseInt(process.env.RELAY_LOAD_P99_MS || "500", 10);

const TEST_ROOT = path.join(os.tmpdir(), "bot-relay-load-" + process.pid);
const TEST_DB_PATH = path.join(TEST_ROOT, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
// v2.1.3 I8: scrub inherited RELAY_AGENT_* env vars so isolated tests
// do not auth against a parent-shell spawn-agent.sh token.
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
// Load testing produces a LOT of rate-limit hits if defaults are tight.
// Raise caps for this test file only.
process.env.RELAY_RATE_LIMIT_MESSAGES_PER_HOUR = "100000";
process.env.RELAY_RATE_LIMIT_TASKS_PER_HOUR = "100000";

const { startHttpServer } = await import("../src/transport/http.js");
const { closeDb, getDb } = await import("../src/db.js");

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

async function register(name: string, caps: string[] = []): Promise<string> {
  const r = await rpc("register_agent", { name, role: "r", capabilities: caps });
  return r.agent_token;
}

function p99(latencies: number[]): number {
  const sorted = latencies.slice().sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * 0.99);
  return sorted[Math.min(idx, sorted.length - 1)];
}

beforeAll(async () => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  closeDb();
  server = startHttpServer(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 120));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  try { server?.close(); } catch { /* ignore */ }
  closeDb();
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  delete process.env.RELAY_RATE_LIMIT_MESSAGES_PER_HOUR;
  delete process.env.RELAY_RATE_LIMIT_TASKS_PER_HOUR;
});

describe("v2.1 Phase 5b — load smoke", () => {
  it(`sustains ${N_PRODUCERS} producers × ${M_MESSAGES} msgs × ${K_CONSUMERS} consumers with no loss + p99 < ${P99_LATENCY_MS}ms`, async () => {
    // Register producers + consumers.
    const producers: { name: string; token: string }[] = [];
    for (let i = 0; i < N_PRODUCERS; i++) {
      const name = `prod-${i}-${process.pid}`;
      const tok = await register(name, []);
      producers.push({ name, token: tok });
    }
    const consumers: { name: string; token: string }[] = [];
    for (let i = 0; i < K_CONSUMERS; i++) {
      const name = `cons-${i}-${process.pid}`;
      const tok = await register(name, []);
      consumers.push({ name, token: tok });
    }

    const TOTAL_MSGS = N_PRODUCERS * M_MESSAGES;
    const latencies: number[] = [];

    // Fire all producers concurrently. Each sends M_MESSAGES round-robin
    // across consumers.
    const producerRuns = producers.map(async (p, pi) => {
      for (let i = 0; i < M_MESSAGES; i++) {
        const to = consumers[(pi * M_MESSAGES + i) % K_CONSUMERS].name;
        const start = Date.now();
        const r = await rpc(
          "send_message",
          { from: p.name, to, content: `p${pi}-m${i}`, priority: "normal" },
          p.token
        );
        latencies.push(Date.now() - start);
        if (!r.success) {
          throw new Error(`send_message failed: pi=${pi} i=${i} err=${r.error}`);
        }
      }
    });
    await Promise.all(producerRuns);

    // Assert DB count matches expected — no silent loss.
    const countRow = getDb().prepare("SELECT COUNT(*) AS c FROM messages").get() as { c: number };
    expect(countRow.c).toBe(TOTAL_MSGS);

    // Assert no duplicates — every (from, to, content) triple unique.
    const dups = getDb()
      .prepare(
        "SELECT COUNT(*) AS c FROM (SELECT from_agent, to_agent, content, COUNT(*) AS n FROM messages GROUP BY from_agent, to_agent, content HAVING n > 1)"
      )
      .get() as { c: number };
    expect(dups.c).toBe(0);

    // Latency under target.
    const p99Latency = p99(latencies);
    expect(p99Latency).toBeLessThan(P99_LATENCY_MS);

    // Every consumer received roughly M_MESSAGES/K each.
    for (const c of consumers) {
      const inboxCount = (getDb()
        .prepare("SELECT COUNT(*) AS c FROM messages WHERE to_agent = ?")
        .get(c.name) as { c: number }).c;
      expect(inboxCount).toBeGreaterThan(0);
    }
  }, 120_000);

  it("cap check still enforced under concurrent load — unauthed broadcast refused", async () => {
    // Fire 20 concurrent unauthed broadcasts (cap-gated). ALL must refuse.
    const attempts = Array.from({ length: 20 }, (_, i) =>
      rpc("broadcast", { from: `ghost-${i}`, content: "x" })
    );
    const results = await Promise.all(attempts);
    const refused = results.filter((r) => r.success === false).length;
    expect(refused).toBe(20);
  }, 30_000);

  it("DB integrity intact after load pump (PRAGMA integrity_check = ok)", async () => {
    // Phase 5b safety invariant: after N*M concurrent writes, the SQLite DB
    // must still pass its own integrity check. WAL + CAS discipline should
    // guarantee this regardless of the load pattern.
    const r = getDb().prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    expect(r.integrity_check).toBe("ok");
  }, 10_000);

  // Note on lease-reassignment under load: the heartbeat/requeue path is
  // tested end-to-end in tests/beta-smart-routing.test.ts (stale lease →
  // next piggyback → requeue). Duplicating that test here is redundant
  // and its timing-sensitive nature flakes under load. The load-smoke
  // invariants we assert are the ones the load pattern itself exercises:
  // no loss, no duplicates, latency, cap enforcement, integrity.
});
