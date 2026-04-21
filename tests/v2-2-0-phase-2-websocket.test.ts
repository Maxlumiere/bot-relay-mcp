// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.2.0 Phase 2 — dashboard WebSocket push layer.
 *
 * Coverage:
 *   - upgrade handshake for /dashboard/ws on loopback with no secret
 *   - upgrade rejection for non-loopback with no secret (401)
 *   - upgrade handshake with valid dashboard secret via ?auth query
 *   - upgrade rejection with wrong secret (401)
 *   - broadcast round-trip: fire an event, receive on connected client
 *   - rate-limit coalesce: two events with same (type, entity_id) inside 500ms
 *     → only first broadcast reaches the client
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { WebSocket } from "ws";
import type { Server as HttpServer } from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v220-p2-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
delete process.env.RELAY_ALLOW_LEGACY;
delete process.env.RELAY_HTTP_SECRET;
delete process.env.RELAY_DASHBOARD_SECRET;

const { startHttpServer } = await import("../src/transport/http.js");
const {
  broadcastDashboardEvent,
  _resetDashboardWsForTests,
  _dashboardWsStateForTests,
} = await import("../src/transport/websocket.js");
const { closeDb } = await import("../src/db.js");

let server: HttpServer;
let port: number;

async function bootServer(env: Record<string, string | undefined> = {}): Promise<void> {
  if (server) {
    try {
      server.close();
    } catch {
      /* ignore */
    }
  }
  _resetDashboardWsForTests();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  server = startHttpServer(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 80));
  const addr = server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
}

beforeEach(async () => {
  delete process.env.RELAY_HTTP_SECRET;
  delete process.env.RELAY_DASHBOARD_SECRET;
});

afterEach(() => {
  _resetDashboardWsForTests();
  try {
    if (server) server.close();
  } catch {
    /* ignore */
  }
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  delete process.env.RELAY_HTTP_SECRET;
  delete process.env.RELAY_DASHBOARD_SECRET;
});

/**
 * Connect and start buffering messages immediately so the test doesn't race
 * the hello frame. Returns a tuple {ws, nextMessage()} where nextMessage
 * pulls from the internal queue (and waits if empty).
 */
async function connectWs(
  urlPath: string,
  subprotocols?: string[]
): Promise<{ ws: WebSocket; nextMessage: (timeoutMs?: number) => Promise<string> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${urlPath}`, subprotocols);
  const queue: string[] = [];
  let pendingResolve: ((v: string) => void) | null = null;
  ws.on("message", (data: Buffer) => {
    const s = data.toString("utf8");
    if (pendingResolve) {
      pendingResolve(s);
      pendingResolve = null;
    } else {
      queue.push(s);
    }
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("ws connect timeout"));
    }, 2000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    ws.once("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      reject(new Error(`ws rejected: HTTP ${res.statusCode}`));
    });
  });
  return {
    ws,
    nextMessage: (timeoutMs = 1500) =>
      new Promise((resolve, reject) => {
        if (queue.length > 0) {
          resolve(queue.shift()!);
          return;
        }
        const timer = setTimeout(() => reject(new Error("ws message timeout")), timeoutMs);
        pendingResolve = (s) => {
          clearTimeout(timer);
          resolve(s);
        };
      }),
  };
}

describe("v2.2.0 Phase 2 — WebSocket handshake", () => {
  it("(W1) loopback + no secret: /dashboard/ws upgrade accepted", async () => {
    await bootServer();
    const { ws, nextMessage } = await connectWs("/dashboard/ws");
    const hello = JSON.parse(await nextMessage());
    expect(hello.event).toBe("dashboard.hello");
    expect(typeof hello.ts).toBe("string");
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(_dashboardWsStateForTests().clients).toBe(0);
  });

  it("(W2) secret configured + correct ?auth: upgrade accepted", async () => {
    await bootServer({ RELAY_DASHBOARD_SECRET: "ws-ok-secret" });
    const { ws, nextMessage } = await connectWs("/dashboard/ws?auth=ws-ok-secret");
    const hello = JSON.parse(await nextMessage());
    expect(hello.event).toBe("dashboard.hello");
    ws.close();
  });

  it("(W3) secret configured + wrong ?auth: upgrade rejected 401", async () => {
    await bootServer({ RELAY_DASHBOARD_SECRET: "right-secret" });
    await expect(connectWs("/dashboard/ws?auth=wrong-secret")).rejects.toThrow(/HTTP 401/);
  });

  it("(W4) secret configured + valid cookie: upgrade accepted", async () => {
    await bootServer({ RELAY_DASHBOARD_SECRET: "cookie-ws-secret" });
    // ws package accepts Cookie header via options.headers on construction.
    // We reach into the helper by constructing manually — the cookie path
    // is the one browsers actually use so it's worth the extra setup.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/dashboard/ws`, {
      headers: { Cookie: "relay_dashboard_auth=cookie-ws-secret" },
    });
    const queue: string[] = [];
    ws.on("message", (d: Buffer) => queue.push(d.toString("utf8")));
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
      ws.once("unexpected-response", (_r, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      setTimeout(() => reject(new Error("timeout")), 2000);
    });
    // Wait briefly for hello to arrive
    for (let i = 0; i < 20 && queue.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(queue.length).toBeGreaterThan(0);
    const hello = JSON.parse(queue[0]);
    expect(hello.event).toBe("dashboard.hello");
    ws.close();
  });

  it("(W5) secret configured + bearer.<secret> subprotocol: upgrade accepted", async () => {
    await bootServer({ RELAY_DASHBOARD_SECRET: "subproto-ws" });
    const { ws, nextMessage } = await connectWs("/dashboard/ws", ["bearer.subproto-ws"]);
    const hello = JSON.parse(await nextMessage());
    expect(hello.event).toBe("dashboard.hello");
    ws.close();
  });
});

describe("v2.2.0 Phase 2 — broadcast round-trip + rate limit", () => {
  it("(B1) broadcastDashboardEvent delivers METADATA-ONLY JSON (Codex H4 contract)", async () => {
    await bootServer();
    const { ws, nextMessage } = await connectWs("/dashboard/ws");
    await nextMessage(); // drain hello

    broadcastDashboardEvent({
      event: "message.sent",
      entity_id: "msg-1",
      ts: new Date().toISOString(),
      kind: "message.sent",
    });

    const payload = JSON.parse(await nextMessage());
    expect(payload.event).toBe("message.sent");
    expect(payload.entity_id).toBe("msg-1");
    expect(typeof payload.ts).toBe("string");
    expect(payload.kind).toBe("message.sent");
    // v2.2.0 Codex audit H4: broadcasts MUST NOT carry raw body content
    // or a free-form `data` blob. Pushes are refetch signals; clients
    // call /api/snapshot for canonical state. Guard against future
    // regressions that silently re-add payload content to the broadcast.
    expect(payload.data).toBeUndefined();
    expect(payload.content).toBeUndefined();
    ws.close();
  });

  it("(B2) rate-limit coalesces rapid bursts on same (event, entity_id)", async () => {
    await bootServer();
    const { ws, nextMessage } = await connectWs("/dashboard/ws");
    await nextMessage(); // drain hello

    const received: string[] = [];
    const listener = (data: Buffer) => received.push(data.toString("utf8"));
    ws.on("message", listener);

    const ts = new Date().toISOString();
    broadcastDashboardEvent({ event: "message.sent", entity_id: "rate-1", ts });
    broadcastDashboardEvent({ event: "message.sent", entity_id: "rate-1", ts });
    broadcastDashboardEvent({ event: "message.sent", entity_id: "rate-1", ts });

    await new Promise((r) => setTimeout(r, 120));
    ws.off("message", listener);
    expect(received.length).toBe(1);
    ws.close();
  });

  it("(B3) different entity_ids on same event do NOT coalesce", async () => {
    await bootServer();
    const { ws, nextMessage } = await connectWs("/dashboard/ws");
    await nextMessage(); // drain hello

    const received: string[] = [];
    const listener = (data: Buffer) => received.push(data.toString("utf8"));
    ws.on("message", listener);

    const ts = new Date().toISOString();
    broadcastDashboardEvent({ event: "message.sent", entity_id: "e-a", ts });
    broadcastDashboardEvent({ event: "message.sent", entity_id: "e-b", ts });
    broadcastDashboardEvent({ event: "message.sent", entity_id: "e-c", ts });

    await new Promise((r) => setTimeout(r, 120));
    ws.off("message", listener);
    expect(received.length).toBe(3);
    ws.close();
  });

  it("(B4) broadcast with no connected clients is a no-op (never throws)", () => {
    _resetDashboardWsForTests();
    expect(() =>
      broadcastDashboardEvent({
        event: "task.transitioned",
        entity_id: "task-1",
        ts: new Date().toISOString(),
      })
    ).not.toThrow();
  });
});
