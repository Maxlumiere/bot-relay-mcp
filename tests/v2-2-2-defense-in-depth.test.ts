// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.2.2 A1 — /api/send-message defense-in-depth (optional from_agent_token).
 *
 * Three regression cases:
 *   A1.1  present-and-valid token → 200 + audit `from_authenticated: true`
 *   A1.2  absent (v2.2.1 default) → 200 + audit `from_authenticated: false`
 *   A1.3  present-and-invalid     → 403 AUTH_FAILED + audit success=0
 *
 * Also covers the `X-From-Agent-Token` header as an alternate carrier, so
 * the audit marker must appear regardless of body-vs-header placement.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import type { Server as HttpServer } from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v222-a1-" + process.pid);
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

function postJson(
  p: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {}
): Promise<{ status: number; json: any }> {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, path: p, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(data)), ...extraHeaders },
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (raw += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null }));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function latestSendAudit(): { success: number; params_summary: string; error: string | null } | undefined {
  return getDb()
    .prepare(
      "SELECT success, params_summary, error FROM audit_log " +
      "WHERE tool = 'send_message' AND source = 'dashboard' " +
      "ORDER BY id DESC LIMIT 1"
    )
    .get() as { success: number; params_summary: string; error: string | null } | undefined;
}

beforeEach(async () => { await bootServer(); });
afterEach(() => {
  try { if (server) server.close(); } catch { /* ignore */ }
  _resetDashboardWsForTests();
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

describe("v2.2.2 A1 — /api/send-message optional from_agent_token", () => {
  it("(A1.1) present-and-valid token → 200 + audit records from_authenticated=true", async () => {
    const { plaintext_token } = registerAgent("a1-from", "r", []);
    registerAgent("a1-to", "r", []);
    expect(plaintext_token).toBeTruthy();
    const res = await postJson("/api/send-message", {
      from: "a1-from",
      to: "a1-to",
      content: "verified send",
      from_agent_token: plaintext_token,
    });
    expect(res.status).toBe(200);
    expect(res.json?.success).toBe(true);
    const row = latestSendAudit();
    expect(row).toBeDefined();
    expect(row!.success).toBe(1);
    expect(row!.params_summary).toMatch(/from_authenticated=true/);
  });

  it("(A1.1b) header X-From-Agent-Token also yields from_authenticated=true", async () => {
    const { plaintext_token } = registerAgent("a1h-from", "r", []);
    registerAgent("a1h-to", "r", []);
    const res = await postJson(
      "/api/send-message",
      { from: "a1h-from", to: "a1h-to", content: "header path" },
      { "X-From-Agent-Token": String(plaintext_token) },
    );
    expect(res.status).toBe(200);
    const row = latestSendAudit();
    expect(row!.success).toBe(1);
    expect(row!.params_summary).toMatch(/from_authenticated=true/);
  });

  it("(A1.2) absent token → 200 + audit records from_authenticated=false (v2.2.1 default)", async () => {
    registerAgent("a2-from", "r", []);
    registerAgent("a2-to", "r", []);
    const res = await postJson("/api/send-message", {
      from: "a2-from",
      to: "a2-to",
      content: "no token supplied",
    });
    expect(res.status).toBe(200);
    expect(res.json?.success).toBe(true);
    const row = latestSendAudit();
    expect(row!.success).toBe(1);
    expect(row!.params_summary).toMatch(/from_authenticated=false/);
  });

  it("(A1.3) present-and-invalid token → 403 AUTH_FAILED + audit success=0", async () => {
    registerAgent("a3-from", "r", []);
    registerAgent("a3-to", "r", []);
    const res = await postJson("/api/send-message", {
      from: "a3-from",
      to: "a3-to",
      content: "bad token",
      from_agent_token: "not-the-real-token-at-all-bogus",
    });
    expect(res.status).toBe(403);
    expect(res.json?.success).toBe(false);
    expect(res.json?.error_code).toBe("AUTH_FAILED");
    const row = latestSendAudit();
    expect(row).toBeDefined();
    expect(row!.success).toBe(0);
    expect(row!.error).toMatch(/from_agent_token verification failed/i);
  });
});
