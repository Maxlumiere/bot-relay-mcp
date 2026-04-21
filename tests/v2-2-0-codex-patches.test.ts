// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.2.0 Codex audit regression coverage.
 *
 *   H1  — /api/focus-terminal reachable when RELAY_HTTP_SECRET is set
 *         (bypass list includes the focus endpoint)
 *   H2  — dashboard frontend forwards relay_csrf cookie as X-Relay-CSRF
 *         header on state-changing /api/* POSTs
 *   H3  — WebSocket upgrade rejects bad Host header (421) + bad Origin
 *         (403) via the shared boundary-checks module
 *   H4  — broadcast shape is metadata-only — no raw payloads on the wire
 *   M1  — redirect follow: safe 301 → followed to final response; unsafe
 *         301 → terminated; >MAX_REDIRECTS → error
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import { WebSocket } from "ws";
import type { Server as HttpServer } from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v220-codex-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
delete process.env.RELAY_ALLOW_LEGACY;
delete process.env.RELAY_HTTP_SECRET;
delete process.env.RELAY_DASHBOARD_SECRET;
process.env.RELAY_ALLOW_PRIVATE_WEBHOOKS = "1";

const { startHttpServer } = await import("../src/transport/http.js");
const { registerAgent, closeDb } = await import("../src/db.js");
const {
  broadcastDashboardEvent,
  _resetDashboardWsForTests,
} = await import("../src/transport/websocket.js");
const { deliverPinnedPost } = await import("../src/webhook-delivery.js");

let server: HttpServer;
let port: number;

async function bootServer(env: Record<string, string | undefined> = {}): Promise<void> {
  if (server) {
    try { server.close(); } catch { /* ignore */ }
  }
  _resetDashboardWsForTests();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  server = startHttpServer(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 60));
  const addr = server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
}

beforeEach(async () => {
  delete process.env.RELAY_HTTP_SECRET;
  delete process.env.RELAY_DASHBOARD_SECRET;
  delete process.env.RELAY_HTTP_ALLOWED_HOSTS;
  delete process.env.RELAY_DASHBOARD_HOSTS;
});

afterEach(() => {
  _resetDashboardWsForTests();
  try { if (server) server.close(); } catch { /* ignore */ }
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  delete process.env.RELAY_HTTP_SECRET;
  delete process.env.RELAY_DASHBOARD_SECRET;
  delete process.env.RELAY_HTTP_ALLOWED_HOSTS;
  delete process.env.RELAY_DASHBOARD_HOSTS;
});

function rawRequest(opts: {
  method: string;
  path: string;
  hostHeader?: string;
  extraHeaders?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: opts.path,
        method: opts.method,
        headers: {
          Host: opts.hostHeader ?? `127.0.0.1:${port}`,
          ...(opts.body
            ? {
                "Content-Type": "application/json",
                "Content-Length": String(Buffer.byteLength(opts.body)),
              }
            : {}),
          ...(opts.extraHeaders || {}),
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      }
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ============================================================================
// H1 — /api/focus-terminal reachable with RELAY_HTTP_SECRET set
// ============================================================================

describe("Codex H1 — /api/focus-terminal bypasses HTTP-secret gate", () => {
  it("(H1.1) POST /api/focus-terminal works when RELAY_HTTP_SECRET is set (via dashboardAuthCheck)", async () => {
    await bootServer({ RELAY_HTTP_SECRET: "http-only-secret" });
    // Register an agent with terminal_title_ref so we can test the
    // successful focus lookup branch. The driver will fail to actually
    // raise (no live iTerm2 with that title) — we just care that the
    // request was ROUTED to dashboardAuthCheck + dispatcher, not rejected
    // by authMiddleware on the HTTP-secret gate.
    registerAgent("focus-target", "r", [], { terminal_title_ref: "some-window" });
    const r = await rawRequest({
      method: "POST",
      path: "/api/focus-terminal",
      body: JSON.stringify({ agent_name: "focus-target" }),
    });
    // Loopback-no-dashboard-secret → dashboardAuthCheck passes;
    // dispatcher runs; focus fails at OS level → 409 (raised=false).
    // Pre-patch behavior was 401 from authMiddleware. We assert the
    // response is NOT 401 — the dashboardAuthCheck + dispatcher path ran.
    expect(r.status).not.toBe(401);
  });
});

// ============================================================================
// H2 — dashboard frontend forwards CSRF header
// ============================================================================

describe("Codex H2 — dashboard frontend forwards relay_csrf", () => {
  it("(H2.1) GET /dashboard HTML contains the csrfHeader() helper + X-Relay-CSRF wiring", async () => {
    await bootServer();
    const r = await rawRequest({ method: "GET", path: "/dashboard" });
    expect(r.status).toBe(200);
    expect(r.body).toContain("relay_csrf");
    expect(r.body).toContain("X-Relay-CSRF");
    expect(r.body).toContain("csrfHeader");
  });
});

// ============================================================================
// H3 — WebSocket upgrade boundary checks
// ============================================================================

describe("Codex H3 — /dashboard/ws upgrade respects Host + Origin allowlists", () => {
  it("(H3.1) bad Host header → 421 on upgrade (DNS rebinding defense)", async () => {
    await bootServer();
    // Use raw http.request to forge Host header on the WS upgrade.
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/dashboard/ws",
          method: "GET",
          headers: {
            Host: "evil.example.com",
            Upgrade: "websocket",
            Connection: "Upgrade",
            "Sec-WebSocket-Version": "13",
            "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
          },
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        }
      );
      req.on("upgrade", (res) => resolve({ status: res.statusCode ?? 0, body: "" }));
      req.on("error", reject);
      req.end();
    });
    expect(result.status).toBe(421);
    expect(result.body).toMatch(/Misdirected/);
  });

  it("(H3.2) bad Origin header → 403 on upgrade", async () => {
    await bootServer();
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/dashboard/ws",
          method: "GET",
          headers: {
            Host: `127.0.0.1:${port}`,
            Origin: "http://evil.example.com",
            Upgrade: "websocket",
            Connection: "Upgrade",
            "Sec-WebSocket-Version": "13",
            "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
          },
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        }
      );
      req.on("upgrade", (res) => resolve({ status: res.statusCode ?? 0, body: "" }));
      req.on("error", reject);
      req.end();
    });
    expect(result.status).toBe(403);
    expect(result.body).toMatch(/Origin not allowed/);
  });

  it("(H3.3) good Host + no Origin → upgrade accepted (non-browser caller)", async () => {
    await bootServer();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/dashboard/ws`);
    const open = await new Promise<boolean>((resolve) => {
      ws.once("open", () => resolve(true));
      ws.once("error", () => resolve(false));
      ws.once("unexpected-response", () => resolve(false));
      setTimeout(() => resolve(false), 1500);
    });
    expect(open).toBe(true);
    ws.close();
  });
});

// ============================================================================
// H4 — broadcast shape is metadata-only
// ============================================================================

describe("Codex H4 — broadcast payloads are metadata-only", () => {
  it("(H4.1) broadcastDashboardEvent rejects extra payload fields at the type level + doesn't leak body content", async () => {
    await bootServer();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/dashboard/ws`);
    const queue: string[] = [];
    ws.on("message", (d: Buffer) => queue.push(d.toString("utf8")));
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
      setTimeout(() => reject(new Error("timeout")), 1500);
    });
    // Drain hello.
    for (let i = 0; i < 20 && queue.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    queue.length = 0;
    broadcastDashboardEvent({
      event: "message.sent",
      entity_id: "test-id",
      ts: new Date().toISOString(),
      kind: "message.sent",
    });
    for (let i = 0; i < 20 && queue.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(queue.length).toBe(1);
    const payload = JSON.parse(queue[0]);
    expect(payload.event).toBe("message.sent");
    expect(payload.entity_id).toBe("test-id");
    expect(payload.kind).toBe("message.sent");
    // No data / content / extra payload fields
    expect(payload.data).toBeUndefined();
    expect(payload.content).toBeUndefined();
    expect(payload.from_agent).toBeUndefined();
    expect(payload.to_agent).toBeUndefined();
    ws.close();
  });
});

// ============================================================================
// M1 — redirect follow with re-validation
// ============================================================================

describe("Codex M1 — webhook redirect follow with SSRF re-validation", () => {
  it("(M1.1) safe redirect is followed to final 2xx", async () => {
    // Start two receivers: A responds 301 → B, B responds 200.
    const recvB = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((r) => recvB.listen(0, "127.0.0.1", () => r()));
    const portB = (recvB.address() as { port: number }).port;
    const recvA = http.createServer((_req, res) => {
      res.statusCode = 301;
      res.setHeader("Location", `http://127.0.0.1:${portB}/final`);
      res.end();
    });
    await new Promise<void>((r) => recvA.listen(0, "127.0.0.1", () => r()));
    const portA = (recvA.address() as { port: number }).port;

    const result = await deliverPinnedPost({
      url: `http://127.0.0.1:${portA}/hop1`,
      pinnedIp: "127.0.0.1",
      headers: {},
      body: JSON.stringify({ hello: "world" }),
      timeoutMs: 2000,
    });
    expect(result.statusCode).toBe(200);
    expect(result.bodyText).toContain('"ok":true');
    recvA.close();
    recvB.close();
  });

  it("(M1.2) unsafe redirect target (private IP when allow-private off) is refused + surfaced as error", async () => {
    // Turn OFF allow-private so private IP redirects get rejected.
    const prev = process.env.RELAY_ALLOW_PRIVATE_WEBHOOKS;
    delete process.env.RELAY_ALLOW_PRIVATE_WEBHOOKS;
    try {
      const recvA = http.createServer((_req, res) => {
        res.statusCode = 301;
        // Redirect to cloud-metadata IP — MUST be refused.
        res.setHeader("Location", "http://169.254.169.254/latest/meta-data/");
        res.end();
      });
      await new Promise<void>((r) => recvA.listen(0, "127.0.0.1", () => r()));
      const portA = (recvA.address() as { port: number }).port;

      const result = await deliverPinnedPost({
        url: `http://127.0.0.1:${portA}/`,
        pinnedIp: "127.0.0.1",
        headers: {},
        body: "{}",
        timeoutMs: 2000,
      });
      expect(result.statusCode).toBeNull();
      expect(result.error).toMatch(/redirect refused/);
      expect(result.error).toMatch(/169\.254\.169\.254|link-local|metadata/i);
      recvA.close();
    } finally {
      if (prev !== undefined) process.env.RELAY_ALLOW_PRIVATE_WEBHOOKS = prev;
      else delete process.env.RELAY_ALLOW_PRIVATE_WEBHOOKS;
    }
  });

  it("(M1.3) redirect loop is bounded (too many hops → error)", async () => {
    // One server redirects to itself — the loop hits MAX_REDIRECTS.
    let recv: http.Server;
    const loopServer = http.createServer((req, res) => {
      res.statusCode = 302;
      res.setHeader("Location", `http://127.0.0.1:${(recv.address() as { port: number }).port}${req.url}`);
      res.end();
    });
    recv = loopServer;
    await new Promise<void>((r) => loopServer.listen(0, "127.0.0.1", () => r()));
    const port = (loopServer.address() as { port: number }).port;

    const result = await deliverPinnedPost({
      url: `http://127.0.0.1:${port}/`,
      pinnedIp: "127.0.0.1",
      headers: {},
      body: "{}",
      timeoutMs: 3000,
    });
    expect(result.statusCode).toBeNull();
    expect(result.error).toMatch(/too many redirects/);
    loopServer.close();
  }, 8000);
});
