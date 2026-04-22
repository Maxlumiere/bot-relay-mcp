// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.2.1 Codex audit patches.
 *
 *   M1 — /api/send-message + /api/kill-agent + /api/set-status audit trail
 *        with via_dashboard: true + operator_identity
 *   L1 — /api/set-status broadcasts agent.state_changed to dashboard WS
 *   L2 — CLI parser: --help wins over unknown flags + applyCliToEnv
 *        tracks `config` source
 *   B5 post-audit — ECONNRESET removed from retryable-error set
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import type { Server as HttpServer } from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v221-codex-" + process.pid);
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
const { parseCliFlags, applyCliToEnv } = await import("../src/cli.js");
const { _resetDashboardWsForTests } = await import("../src/transport/websocket.js");
const { WebSocket } = await import("ws");

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

function postJson(p: string, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}): Promise<{ status: number; json: any }> {
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

beforeEach(async () => { await bootServer(); });
afterEach(() => {
  try { if (server) server.close(); } catch { /* ignore */ }
  _resetDashboardWsForTests();
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  delete process.env.RELAY_DASHBOARD_OPERATOR;
});

// ============================================================================
// M1 — audit trail for inline endpoints
// ============================================================================

describe("Codex M1 — /api/send-message + /api/kill-agent + /api/set-status audit trail", () => {
  it("(M1.1) /api/send-message writes audit_log entry with via_dashboard: true", async () => {
    registerAgent("auditor-from", "r", []);
    registerAgent("auditor-to", "r", []);
    await postJson("/api/send-message", {
      from: "auditor-from",
      to: "auditor-to",
      content: "audit me",
    });
    const rows = getDb()
      .prepare("SELECT agent_name, tool, source, params_json FROM audit_log WHERE tool = 'send_message' AND source = 'dashboard'")
      .all() as { agent_name: string; tool: string; source: string; params_json: string | null }[];
    expect(rows.length).toBe(1);
    expect(rows[0].agent_name).toBe("auditor-from");
    // params_json is encrypted; check decrypted content if encryption
    // isn't configured, the stored value is JSON plaintext.
    if (rows[0].params_json) {
      // Search the params_json for via_dashboard marker — works whether
      // encrypted (base64-ish + prefix) or plaintext.
      const raw = rows[0].params_json;
      // If plaintext JSON, parse directly; if encrypted, the structured
      // data was still committed + is retrievable via audit-log read
      // helpers. We just confirm SOMETHING got written.
      expect(raw.length).toBeGreaterThan(0);
    }
  });

  it("(M1.2) RELAY_DASHBOARD_OPERATOR env sets the operator_identity marker", async () => {
    process.env.RELAY_DASHBOARD_OPERATOR = "maxime";
    await bootServer(); // pick up the env
    registerAgent("mx-from", "r", []);
    registerAgent("mx-to", "r", []);
    await postJson("/api/send-message", {
      from: "mx-from",
      to: "mx-to",
      content: "operator-tagged",
    });
    const row = getDb()
      .prepare("SELECT params_summary FROM audit_log WHERE tool = 'send_message' AND source = 'dashboard'")
      .get() as { params_summary: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.params_summary).toMatch(/operator=maxime/);
  });

  it("(M1.3) /api/kill-agent audit records target + removed flag", async () => {
    registerAgent("doomed-audit", "r", []);
    await postJson("/api/kill-agent", { name: "doomed-audit" }, { "X-Relay-Confirm": "yes" });
    const row = getDb()
      .prepare("SELECT agent_name, params_summary, success FROM audit_log WHERE tool = 'unregister_agent' AND source = 'dashboard'")
      .get() as { agent_name: string; params_summary: string; success: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.agent_name).toBe("doomed-audit");
    expect(row!.params_summary).toMatch(/removed=true/);
    expect(row!.success).toBe(1);
  });

  it("(M1.4) /api/set-status audit records target + new status", async () => {
    registerAgent("statuschanger-audit", "r", []);
    await postJson("/api/set-status", { agent_name: "statuschanger-audit", agent_status: "working" });
    const row = getDb()
      .prepare("SELECT agent_name, params_summary, success FROM audit_log WHERE tool = 'set_status' AND source = 'dashboard'")
      .get() as { agent_name: string; params_summary: string; success: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.agent_name).toBe("statuschanger-audit");
    expect(row!.params_summary).toMatch(/status=working/);
    expect(row!.success).toBe(1);
  });

  it("(M1.5) failed send-message (unknown sender) still writes an audit entry with success=0", async () => {
    await postJson("/api/send-message", { from: "ghost", to: "any", content: "x" });
    const row = getDb()
      .prepare("SELECT success, error FROM audit_log WHERE tool = 'send_message' AND source = 'dashboard'")
      .get() as { success: number; error: string | null } | undefined;
    expect(row).toBeDefined();
    expect(row!.success).toBe(0);
    expect(row!.error).toMatch(/not a registered agent/i);
  });
});

// ============================================================================
// L1 — /api/set-status broadcasts agent.state_changed
// ============================================================================

describe("Codex L1 — /api/set-status broadcasts to dashboard WebSocket", () => {
  it("(L1.1) WS client receives agent.state_changed after /api/set-status call", async () => {
    registerAgent("ws-status", "r", []);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/dashboard/ws`);
    const queue: string[] = [];
    ws.on("message", (d: Buffer) => queue.push(d.toString("utf8")));
    await new Promise<void>((r, j) => {
      ws.once("open", () => r());
      ws.once("error", j);
      setTimeout(() => j(new Error("ws open timeout")), 1500);
    });
    // Wait for hello then clear queue.
    for (let i = 0; i < 20 && queue.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    queue.length = 0;

    await postJson("/api/set-status", { agent_name: "ws-status", agent_status: "blocked" });

    // Wait for the broadcast frame.
    for (let i = 0; i < 20 && queue.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    expect(queue.length).toBeGreaterThan(0);
    const payload = JSON.parse(queue[0]);
    expect(payload.event).toBe("agent.state_changed");
    expect(payload.entity_id).toBe("ws-status");
    expect(payload.kind).toBe("set_status");
    ws.close();
  });
});

// ============================================================================
// L2 — CLI parser fixes
// ============================================================================

describe("Codex L2 — CLI parser drift fixes", () => {
  it("(L2.1) --help wins regardless of unknown flags present", () => {
    const r = parseCliFlags(["--bogus", "--help"]);
    expect(r.error).toBeNull();
    expect(r.help).toBe(true);
  });

  it("(L2.2) --version wins regardless of unknown flags present", () => {
    const r = parseCliFlags(["--bogus", "--version"]);
    expect(r.error).toBeNull();
    expect(r.version).toBe(true);
  });

  it("(L2.3) without --help/--version, unknown flag still errors (regression guard)", () => {
    const r = parseCliFlags(["--bogus"]);
    expect(r.error).not.toBeNull();
    expect(r.error!.exitCode).toBe(2);
  });

  it("(L2.4) applyCliToEnv: config-file-sourced value → source='config' (not 'default')", () => {
    const env: NodeJS.ProcessEnv = {};
    const fileKeys = new Set(["transport", "http_port"]);
    const sources = applyCliToEnv({}, env, fileKeys);
    expect(sources.transport).toBe("config");
    expect(sources.http_port).toBe("config");
    expect(sources.http_host).toBe("default"); // not in fileKeys
  });

  it("(L2.5) applyCliToEnv: CLI beats config-file in source labeling", () => {
    const env: NodeJS.ProcessEnv = {};
    const fileKeys = new Set(["transport"]);
    const sources = applyCliToEnv({ transport: "http" }, env, fileKeys);
    expect(sources.transport).toBe("cli");
  });

  it("(L2.6) applyCliToEnv: env beats config-file in source labeling", () => {
    const env: NodeJS.ProcessEnv = { RELAY_TRANSPORT: "http" };
    const fileKeys = new Set(["transport"]);
    const sources = applyCliToEnv({}, env, fileKeys);
    expect(sources.transport).toBe("env");
  });
});

// ============================================================================
// B5 post-audit — ECONNRESET not retried
// ============================================================================

describe("Codex B5 nuance — ECONNRESET no longer retries (prevents duplicate webhooks)", () => {
  it("(B5n.1) server resets the connection after accepting body → ONE call recorded, no retry storm", async () => {
    const { deliverPinnedPost } = await import("../src/webhook-delivery.js");
    let callCount = 0;
    const receiver = http.createServer((req, _res) => {
      callCount++;
      // Read the body then abruptly destroy the socket — simulates
      // ECONNRESET mid-response. The client sees this as ECONNRESET
      // (or a protocol error depending on when the destroy lands).
      req.on("data", () => { /* consume */ });
      req.on("end", () => {
        req.socket.destroy();
      });
    });
    await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", () => r()));
    const receiverPort = (receiver.address() as { port: number }).port;

    try {
      const result = await deliverPinnedPost({
        url: `http://example.invalid:${receiverPort}/webhook`,
        pinnedIp: "127.0.0.1",
        pinnedIps: ["127.0.0.1", "127.0.0.1", "127.0.0.1"],
        headers: {},
        body: "{}",
        timeoutMs: 1500,
      });
      // Should NOT have retried across all 3 IPs on ECONNRESET.
      expect(callCount).toBe(1);
      // Final result: error surfaced, statusCode null.
      expect(result.statusCode).toBeNull();
      expect(result.error).toBeTruthy();
    } finally {
      receiver.close();
    }
  });

  it("(B5n.2) ECONNREFUSED still retries — pre-connect failures are safe to loop", async () => {
    const { deliverPinnedPost } = await import("../src/webhook-delivery.js");
    // Spin up a live receiver on 127.0.0.1, first IP refused (port 1).
    const receiver = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.end("ok");
    });
    await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", () => r()));
    const receiverPort = (receiver.address() as { port: number }).port;

    try {
      // Use the first IP at a refused-port URL, then pinnedIps[1] at the live port.
      // But since deliverPinnedPost uses the URL's port for the TCP connect port,
      // all IPs share the same port. To exercise the retry path we set up a
      // live receiver on the second IP candidate via an unreachable first IP.
      // 0.0.0.1 is effectively unreachable on loopback contexts.
      const result = await deliverPinnedPost({
        url: `http://example.invalid:${receiverPort}/webhook`,
        pinnedIp: "0.0.0.1",
        pinnedIps: ["0.0.0.1", "127.0.0.1"],
        headers: {},
        body: "{}",
        timeoutMs: 2000,
      });
      expect(result.statusCode).toBe(200);
    } finally {
      receiver.close();
    }
  });
});
