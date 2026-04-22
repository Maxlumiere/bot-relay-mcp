// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.2.2 A2 — per-human operator identity via cookie.
 *
 * Covers the cookie > env > default precedence and the
 * GET/POST /api/operator-identity endpoints.
 *
 * A2.1  POST sets relay_operator_identity cookie, subsequent action
 *       records `operator=<cookie value>` in the audit log.
 * A2.2  Cookie beats RELAY_DASHBOARD_OPERATOR env var.
 * A2.3  POST { identity: '' } clears the cookie → audit falls back
 *       to env (if set) then default sentinel.
 * A2.4  GET surfaces the current identity + source.
 * A2.5  Invalid identity (bad chars, >64 chars) → 400.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import type { Server as HttpServer } from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v222-a2-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
delete process.env.RELAY_HTTP_SECRET;
delete process.env.RELAY_DASHBOARD_SECRET;
delete process.env.RELAY_DASHBOARD_OPERATOR;

const { startHttpServer } = await import("../src/transport/http.js");
const { closeDb, getDb, registerAgent } = await import("../src/db.js");
const { _resetDashboardWsForTests } = await import("../src/transport/websocket.js");

let server: HttpServer;
let port: number;

async function bootServer(): Promise<void> {
  if (server) { try { server.close(); } catch { /* ignore */ } }
  _resetDashboardWsForTests();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  server = startHttpServer(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 60));
  const addr = server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
}

function request(
  method: string,
  p: string,
  body: Record<string, unknown> | null,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; json: any; setCookie: string[] }> {
  const data = body === null ? "" : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = { ...extraHeaders };
    if (data) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(data);
    }
    const req = http.request(
      { host: "127.0.0.1", port, path: p, method, headers },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          const setCookie = res.headers["set-cookie"] || [];
          resolve({
            status: res.statusCode ?? 0,
            json: raw ? JSON.parse(raw) : null,
            setCookie: Array.isArray(setCookie) ? setCookie : [setCookie],
          });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function extractCookie(setCookie: string[], name: string): string | null {
  for (const line of setCookie) {
    const m = line.match(new RegExp("^" + name + "=([^;]*)"));
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

function latestAudit(tool: string): { params_summary: string; success: number } | undefined {
  return getDb()
    .prepare(
      "SELECT params_summary, success FROM audit_log " +
      "WHERE tool = ? AND source = 'dashboard' " +
      "ORDER BY id DESC LIMIT 1",
    )
    .get(tool) as { params_summary: string; success: number } | undefined;
}

beforeEach(async () => {
  delete process.env.RELAY_DASHBOARD_OPERATOR;
  await bootServer();
});
afterEach(() => {
  try { if (server) server.close(); } catch { /* ignore */ }
  _resetDashboardWsForTests();
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  delete process.env.RELAY_DASHBOARD_OPERATOR;
});

describe("v2.2.2 A2 — operator identity cookie", () => {
  it("(A2.1) POST sets cookie + following action audits operator=<cookie>", async () => {
    const setRes = await request("POST", "/api/operator-identity", { identity: "alice" });
    expect(setRes.status).toBe(200);
    expect(setRes.json?.identity).toBe("alice");
    const cookie = extractCookie(setRes.setCookie, "relay_operator_identity");
    expect(cookie).toBe("alice");
    const attrs = setRes.setCookie.find((c) => c.startsWith("relay_operator_identity=")) || "";
    expect(attrs).toMatch(/Max-Age=\d+/);
    expect(attrs).toMatch(/SameSite=Lax/);

    // Exercise a send-message with the cookie attached.
    registerAgent("a2-1-from", "r", []);
    registerAgent("a2-1-to", "r", []);
    await request(
      "POST",
      "/api/send-message",
      { from: "a2-1-from", to: "a2-1-to", content: "cookie test" },
      { Cookie: "relay_operator_identity=alice" },
    );
    const audit = latestAudit("send_message");
    expect(audit).toBeDefined();
    expect(audit!.params_summary).toMatch(/operator=alice/);
  });

  it("(A2.2) cookie beats RELAY_DASHBOARD_OPERATOR env", async () => {
    process.env.RELAY_DASHBOARD_OPERATOR = "envperson";
    // Reboot so the env is picked up by any cached config (defensive;
    // dashboardOperatorIdentity reads process.env live so this is belt-and-braces).
    await bootServer();
    registerAgent("a2-2-from", "r", []);
    registerAgent("a2-2-to", "r", []);
    await request(
      "POST",
      "/api/send-message",
      { from: "a2-2-from", to: "a2-2-to", content: "env vs cookie" },
      { Cookie: "relay_operator_identity=bob" },
    );
    const audit = latestAudit("send_message");
    expect(audit!.params_summary).toMatch(/operator=bob/);
    expect(audit!.params_summary).not.toMatch(/operator=envperson/);
  });

  it("(A2.3) env var wins when no cookie is present", async () => {
    process.env.RELAY_DASHBOARD_OPERATOR = "envperson";
    await bootServer();
    registerAgent("a2-3-from", "r", []);
    registerAgent("a2-3-to", "r", []);
    await request(
      "POST",
      "/api/send-message",
      { from: "a2-3-from", to: "a2-3-to", content: "env only" },
      {},
    );
    const audit = latestAudit("send_message");
    expect(audit!.params_summary).toMatch(/operator=envperson/);
  });

  it("(A2.4) default sentinel when no cookie + no env", async () => {
    registerAgent("a2-4-from", "r", []);
    registerAgent("a2-4-to", "r", []);
    await request(
      "POST",
      "/api/send-message",
      { from: "a2-4-from", to: "a2-4-to", content: "default" },
      {},
    );
    const audit = latestAudit("send_message");
    expect(audit!.params_summary).toMatch(/operator=dashboard-user/);
  });

  it("(A2.5) POST with empty identity clears cookie (Max-Age=0)", async () => {
    const res = await request("POST", "/api/operator-identity", { identity: "" });
    expect(res.status).toBe(200);
    expect(res.json?.cleared).toBe(true);
    const clearLine = res.setCookie.find((c) => c.startsWith("relay_operator_identity="));
    expect(clearLine).toBeDefined();
    expect(clearLine!).toMatch(/Max-Age=0/);
  });

  it("(A2.6) GET surfaces identity + source", async () => {
    process.env.RELAY_DASHBOARD_OPERATOR = "envdefault";
    await bootServer();
    const r1 = await request("GET", "/api/operator-identity", null, {});
    expect(r1.status).toBe(200);
    expect(r1.json.identity).toBe("envdefault");
    expect(r1.json.source).toBe("env");
    expect(r1.json.env_set).toBe(true);

    const r2 = await request(
      "GET",
      "/api/operator-identity",
      null,
      { Cookie: "relay_operator_identity=carol" },
    );
    expect(r2.json.identity).toBe("carol");
    expect(r2.json.source).toBe("cookie");
  });

  it("(A2.7) invalid identity (bad chars / too long) → 400", async () => {
    const bad1 = await request("POST", "/api/operator-identity", { identity: "nope;DROP TABLE" });
    expect(bad1.status).toBe(400);
    const bad2 = await request("POST", "/api/operator-identity", { identity: "x".repeat(65) });
    expect(bad2.status).toBe(400);
    const good = await request("POST", "/api/operator-identity", { identity: "max.user@lumiere" });
    expect(good.status).toBe(200);
  });
});
