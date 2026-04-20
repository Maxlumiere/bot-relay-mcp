// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 4d — dashboard auth + DNS-rebinding + info-disclosure.
 *
 * Verifies the middleware chain installed on GET /, /dashboard, /api/snapshot:
 *   - Host-header allowlist (DNS rebinding defense) runs first.
 *   - Dashboard auth gate (RELAY_DASHBOARD_SECRET or fallback http_secret).
 *   - Info-disclosure: snapshot JSON does NOT contain token_hash or webhook
 *     secret strings.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import http from "http";
import path from "path";
import os from "os";
import type { Server as HttpServer } from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-dashboard-harden-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
// v2.1.3 I8: scrub inherited RELAY_AGENT_* env vars so isolated tests
// do not auth against a parent-shell spawn-agent.sh token.
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
delete process.env.RELAY_ALLOW_LEGACY;
delete process.env.RELAY_HTTP_SECRET;
delete process.env.RELAY_DASHBOARD_SECRET;
delete process.env.RELAY_DASHBOARD_HOSTS;

const { startHttpServer } = await import("../src/transport/http.js");
const { registerAgent, closeDb, getDb } = await import("../src/db.js");

let server: HttpServer;
let port: number;

beforeEach(async () => {
  delete process.env.RELAY_HTTP_SECRET;
  delete process.env.RELAY_DASHBOARD_SECRET;
  delete process.env.RELAY_DASHBOARD_HOSTS;
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  server = startHttpServer(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 100));
  const addr = server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
});

afterEach(() => {
  try {
    server.close();
  } catch {
    /* ignore */
  }
  delete process.env.RELAY_HTTP_SECRET;
  delete process.env.RELAY_DASHBOARD_SECRET;
  delete process.env.RELAY_DASHBOARD_HOSTS;
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

function getWithHeaders(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return fetch(url, { headers }).then(async (res) => ({
    status: res.status,
    body: await res.text(),
  }));
}

/**
 * Low-level HTTP GET that actually sends a user-supplied `Host` header.
 * Node's `fetch` sanitizes Host to match the URL origin; we need to forge
 * it for the DNS-rebinding defense test.
 */
function rawGet(p: string, hostHeader: string, extraHeaders: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: p,
        method: "GET",
        headers: { Host: hostHeader, ...extraHeaders },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

describe("v2.1 Phase 4d — dashboard hardening", () => {
  it("(1) loopback bind, no secret → /api/snapshot allowed (dev-friendly)", async () => {
    const r = await getWithHeaders(`http://127.0.0.1:${port}/api/snapshot`);
    expect(r.status).toBe(200);
    const data = JSON.parse(r.body);
    expect(data.agents).toBeDefined();
  });

  it("(2) request with Host: evil.com → 421 Misdirected Request (DNS rebinding defense)", async () => {
    const r = await rawGet("/api/snapshot", "evil.com");
    expect(r.status).toBe(421);
    const data = JSON.parse(r.body);
    expect(data.error).toMatch(/Misdirected/i);
    expect(data.hint).toMatch(/RELAY_DASHBOARD_HOSTS/);
  });

  it("(3) RELAY_DASHBOARD_SECRET set + correct Bearer → 200", async () => {
    server.close();
    process.env.RELAY_DASHBOARD_SECRET = "dash-s3cret";
    server = startHttpServer(0, "127.0.0.1");
    await new Promise((r) => setTimeout(r, 100));
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
    const r = await getWithHeaders(`http://127.0.0.1:${port}/api/snapshot`, {
      Authorization: "Bearer dash-s3cret",
    });
    expect(r.status).toBe(200);
    JSON.parse(r.body); // valid JSON
  });

  it("(4) RELAY_DASHBOARD_SECRET set + WRONG Bearer → 401", async () => {
    server.close();
    process.env.RELAY_DASHBOARD_SECRET = "right-secret";
    server = startHttpServer(0, "127.0.0.1");
    await new Promise((r) => setTimeout(r, 100));
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
    const r = await getWithHeaders(`http://127.0.0.1:${port}/api/snapshot`, {
      Authorization: "Bearer wrong-secret",
    });
    expect(r.status).toBe(401);
    const data = JSON.parse(r.body);
    expect(data.error).toMatch(/secret/i);
  });

  it("(5) RELAY_DASHBOARD_SECRET set + ?auth=<secret> query → 200", async () => {
    server.close();
    process.env.RELAY_DASHBOARD_SECRET = "query-ok";
    server = startHttpServer(0, "127.0.0.1");
    await new Promise((r) => setTimeout(r, 100));
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
    const r = await getWithHeaders(`http://127.0.0.1:${port}/api/snapshot?auth=query-ok`);
    expect(r.status).toBe(200);
  });

  it("(6) falls back to RELAY_HTTP_SECRET when RELAY_DASHBOARD_SECRET unset", async () => {
    server.close();
    process.env.RELAY_HTTP_SECRET = "http-fallback";
    server = startHttpServer(0, "127.0.0.1");
    await new Promise((r) => setTimeout(r, 100));
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
    const ok = await getWithHeaders(`http://127.0.0.1:${port}/api/snapshot`, {
      Authorization: "Bearer http-fallback",
    });
    expect(ok.status).toBe(200);
    const bad = await getWithHeaders(`http://127.0.0.1:${port}/api/snapshot`, {
      Authorization: "Bearer not-it",
    });
    expect(bad.status).toBe(401);
  });

  it("(7) cookie `relay_dashboard_auth=<secret>` also authorizes", async () => {
    server.close();
    process.env.RELAY_DASHBOARD_SECRET = "cookie-secret";
    server = startHttpServer(0, "127.0.0.1");
    await new Promise((r) => setTimeout(r, 100));
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
    const r = await getWithHeaders(`http://127.0.0.1:${port}/api/snapshot`, {
      Cookie: "relay_dashboard_auth=cookie-secret",
    });
    expect(r.status).toBe(200);
  });

  it("(8) snapshot payload does NOT leak token hashes or webhook secret strings", async () => {
    // Seed an agent + a webhook with a secret so there's something to leak
    // accidentally.
    registerAgent("leak-probe", "r", []);
    getDb()
      .prepare(
        "INSERT INTO webhook_subscriptions (id, url, event, filter, secret, created_at) VALUES (?, ?, ?, NULL, ?, ?)"
      )
      .run("wh-secret", "http://example.com/h", "*", "super-secret-hmac-key", new Date().toISOString());

    const r = await getWithHeaders(`http://127.0.0.1:${port}/api/snapshot`);
    expect(r.status).toBe(200);
    // Must not include the HMAC secret or a bcrypt prefix anywhere.
    expect(r.body).not.toContain("super-secret-hmac-key");
    expect(r.body).not.toMatch(/\$2[aby]\$/);
    // Sanity: the agent and webhook ARE present by ID so we know we actually
    // hit the payload, not an empty dict.
    expect(r.body).toContain("leak-probe");
    expect(r.body).toContain("wh-secret");
  });
});
