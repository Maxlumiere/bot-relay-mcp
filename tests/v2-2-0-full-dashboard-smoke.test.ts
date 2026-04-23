// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.2.0 Phase 6 — dashboard end-to-end smoke for the `--full` pre-publish
 * gate. Boots one HTTP server, drives every dashboard surface back-to-back
 * in a single browser-shaped flow:
 *
 *   GET /health            → 200 (monitor-class)
 *   GET /dashboard         → 200 + reactive-app landmarks
 *   GET /api/snapshot      → 200 + preview fields
 *   POST /api/focus-terminal with null terminal_title_ref → 409 (graceful)
 *   WS /dashboard/ws hello → event=dashboard.hello
 *   TOCTOU smoke via deliverPinnedPost → pin honored, vhost Host header
 *
 * Default vitest run already covers each of these in phase-scoped files;
 * this is the --full gate's single-server integration pass that proves
 * nothing regresses when all surfaces are exercised together.
 *
 * Listed under tests/** so vitest.full.config.ts picks it up automatically;
 * the default config also picks it up — keeping it in the default run is
 * free cycles (under 1s) and catches integration regressions early.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import { WebSocket } from "ws";
import type { Server as HttpServer } from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v220-full-smoke-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
delete process.env.RELAY_HTTP_SECRET;
delete process.env.RELAY_DASHBOARD_SECRET;

const { startHttpServer } = await import("../src/transport/http.js");
const { registerAgent, closeDb } = await import("../src/db.js");
const { _resetDashboardWsForTests } = await import("../src/transport/websocket.js");
const { deliverPinnedPost } = await import("../src/webhook-delivery.js");

let server: HttpServer;
let port: number;

beforeAll(async () => {
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  server = startHttpServer(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 80));
  const addr = server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
});

afterAll(() => {
  _resetDashboardWsForTests();
  try { server.close(); } catch { /* ignore */ }
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

function get(p: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: p }, (res) => {
        let b = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
      })
      .on("error", reject);
  });
}

function post(p: string, body: Record<string, unknown>): Promise<{ status: number; body: string }> {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: p,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(data)) },
      },
      (res) => {
        let b = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

describe("v2.2.0 Phase 6 — dashboard end-to-end smoke (--full)", () => {
  it("hits every dashboard surface back-to-back on one server", async () => {
    // 1. Health.
    const health = await get("/health");
    expect(health.status).toBe(200);
    const healthJson = JSON.parse(health.body);
    expect(healthJson.status).toBe("ok");
    expect(healthJson.version).toBe("2.4.0");
    expect(healthJson.protocol_version).toBe("2.4.0");

    // 2. Dashboard HTML.
    const dash = await get("/dashboard");
    expect(dash.status).toBe(200);
    expect(dash.body).toContain('id="agents-grid"');
    expect(dash.body).toContain('/dashboard/ws');
    expect(dash.body).toContain('/api/focus-terminal');

    // 3. Snapshot with preview fields.
    registerAgent("smoke-a", "r", []);
    registerAgent("smoke-b", "r", [], { terminal_title_ref: "smoke-window" });
    const snap = await get("/api/snapshot");
    expect(snap.status).toBe(200);
    const snapJson = JSON.parse(snap.body);
    expect(Array.isArray(snapJson.agents)).toBe(true);
    const b = snapJson.agents.find((a: any) => a.name === "smoke-b");
    expect(b.terminal_title_ref).toBe("smoke-window");

    // 4. Focus endpoint: 409 on null ref, 404 on unknown.
    const ghost = await post("/api/focus-terminal", { agent_name: "nonexistent" });
    expect(ghost.status).toBe(404);
    const nullRef = await post("/api/focus-terminal", { agent_name: "smoke-a" });
    expect(nullRef.status).toBe(409);

    // 5. WebSocket hello.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/dashboard/ws`);
    const queue: string[] = [];
    ws.on("message", (d: Buffer) => queue.push(d.toString("utf8")));
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
      setTimeout(() => reject(new Error("ws timeout")), 1500);
    });
    for (let i = 0; i < 20 && queue.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(queue.length).toBeGreaterThan(0);
    const hello = JSON.parse(queue[0]);
    expect(hello.event).toBe("dashboard.hello");
    ws.close();

    // 6. TOCTOU smoke: pinned-IP delivery to a local receiver.
    const receiver = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", () => r()));
    const addr = receiver.address();
    const recvPort = typeof addr === "object" && addr ? addr.port : 0;
    const delivered = await deliverPinnedPost({
      url: `http://example.invalid:${recvPort}/hook`,
      pinnedIp: "127.0.0.1",
      headers: {},
      body: "{}",
      timeoutMs: 1500,
    });
    expect(delivered.statusCode).toBe(200);
    receiver.close();
  }, 10_000);
});
