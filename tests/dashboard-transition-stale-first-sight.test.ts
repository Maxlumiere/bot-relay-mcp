// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * R2: the macOS CI red (RT1 on main ba5b97a, RT2 at 04adea0, #328's rt-progress), through the REAL HTTP register.
 *
 * registerAgent stamps last_seen BEFORE its two sync bcrypt hashes (the token, the registration-recovery handle) and
 * INSERTs the row after them; no tick can run in between (the hashes block the event loop). So the broadcaster first
 * sees a new agent already aged by the hash time. On a slow runner that age lands between ~500 and 1000 ms: `active`
 * is sent, and the first `waiting` tick comes less than 500 ms later, inside the dashboard rate limiter's window.
 * Before the fix that `waiting` was dropped AND recorded as sent, so it was never re-sent: the subscriber never saw it.
 *
 * Here hashToken is the real one, then held until ~750 ms after the first hash of the registration began: the slow
 * runner, reproduced on any machine. The stamp itself is NOT moved (ruled: last_seen = when the request arrived; the
 * defect is the broadcaster's dedup). The test asserts the OUTCOME: the subscriber receives `waiting`.
 *
 * BOUNDARY: if the real hashes alone exceed ~1 s, the first sight is already `waiting` (sent directly, never limited)
 * and this test exercises that path instead; it must still pass. The first-sight age is printed in any failure.
 * The deterministic form of the same sequence is R1 in tests/dashboard-status-transition-never-dropped.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server as HttpServer } from "node:http";

const slow = vi.hoisted(() => ({ on: false, firstHashAt: null as number | null, holdUntilMs: 750 }));
vi.mock("../src/auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth.js")>();
  return {
    ...actual,
    hashToken: (token: string): string => {
      const h = actual.hashToken(token);
      if (slow.on) {
        if (slow.firstHashAt === null) slow.firstHashAt = Date.now();
        else {
          const until = slow.firstHashAt + slow.holdUntilMs;
          while (Date.now() < until) {
            /* the slow runner: a sync hash blocks the event loop, exactly like this */
          }
          slow.firstHashAt = null;
        }
      }
      return h;
    },
  };
});

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-stale-first-sight-" + process.pid);
process.env.RELAY_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_HTTP_SECRET;
delete process.env.RELAY_DASHBOARD_SECRET;
// The CI configuration that reached the defect: a 100 ms tick (< the 500 ms limiter window), a 1 s active window.
process.env.RELAY_DECAY_TICK_MS = "100";
process.env.RELAY_STATE_ACTIVE_WINDOW_SEC = "1";
delete process.env.RELAY_DECAY_TICK_DISABLED;

const { startHttpServer } = await import("../src/transport/http.js");
const { _resetDashboardWsForTests } = await import("../src/transport/websocket.js");
const { closeDb, getDb } = await import("../src/db.js");
import { connectWs } from "./_helpers/ws.js";
import { mintHeaders } from "./_helpers/mint.js";

let server: HttpServer;
let port: number;

beforeEach(async () => {
  _resetDashboardWsForTests();
  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  server = startHttpServer(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 80));
  port = (server.address() as { port: number }).port;
});
afterEach(async () => {
  slow.on = false;
  slow.firstHashAt = null;
  _resetDashboardWsForTests();
  await new Promise<void>((r) => server.close(() => r()));
  closeDb();
  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

async function register(name: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...mintHeaders() },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "register_agent", arguments: { name, role: "user", capabilities: ["build"] } } }),
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  const inner = JSON.parse(dataLine ? dataLine.slice(5).trim() : text) as { result?: { content?: Array<{ text?: string }> } };
  const json = JSON.parse(inner.result?.content?.[0]?.text ?? "null") as { success?: boolean } | null;
  if (json?.success !== true) throw new Error(`register_agent ${name} did not succeed: ${text}`);
}

/** Subscribe, register `name` (with or without the slow hash), and wait up to 5 s for its `waiting` frame. */
async function registerAndWatch(name: string, slowHash: boolean): Promise<void> {
  const h = await connectWs(port, "/dashboard/ws");
  expect((JSON.parse(await h.nextMessage()) as { event: string }).event, "the hello: this subscriber is registered").toBe("dashboard.hello");
  slow.on = slowHash;
  await register(name);
  slow.on = false;
  const lastSeen = (getDb().prepare("SELECT last_seen FROM agents WHERE name = ?").get(name) as { last_seen: string }).last_seen;

  const frames: Array<{ event: string; entity_id: string; ts: string; kind?: string }> = [];
  const deadline = Date.now() + 5000;
  let sawWaiting = false;
  while (!sawWaiting && Date.now() < deadline) {
    let raw: string;
    try {
      raw = await h.nextMessage(Math.max(50, deadline - Date.now()));
    } catch {
      break;
    }
    const f = JSON.parse(raw) as (typeof frames)[number];
    frames.push(f);
    sawWaiting = f.event === "agent.status_changed" && f.entity_id === name && f.kind === "waiting";
  }
  h.ws.close();
  const firstStatus = frames.find((f) => f.event === "agent.status_changed");
  const firstSightAgeMs = firstStatus ? Date.parse(firstStatus.ts) - Date.parse(lastSeen) : null;
  expect(
    sawWaiting,
    `no waiting frame within 5 s. last_seen ${lastSeen}; first status frame ${JSON.stringify(firstStatus)} (first-sight age ${firstSightAgeMs} ms); frames ${JSON.stringify(frames)}`,
  ).toBe(true);
}

describe("R2: a new agent first seen 500-1000 ms old still reaches `waiting` on the dashboard", () => {
  it("HARM: the real HTTP register with a slow hash: the subscriber receives agent.status_changed:waiting", async () => {
    await registerAndWatch("rt-stale-first-sight", true);
  }, 15_000);

  it("TWIN: the same register at this machine's own hash speed: the subscriber receives waiting", async () => {
    await registerAndWatch("rt-fresh-first-sight", false);
  }, 15_000);
});
