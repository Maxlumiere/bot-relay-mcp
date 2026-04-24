// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.4.1 — dashboard inbox visibility.
 *
 * Coverage:
 *   - getInboxSummary() returns a row for every registered agent, including
 *     agents with zero mail (pending=0, unread=0, last_message_at=null).
 *   - pending_count + unread_count reflect status='pending' / seq IS NULL.
 *   - Drain (getMessages) flips pending_count to 0 but last_message_at is
 *     retained — a drained inbox still shows history.
 *   - snapshotApi enriches agents[] with the three new fields without
 *     breaking the existing AgentWithStatus shape.
 *   - Dashboard HTML contains the inbox-badge markup + the new "inbox"
 *     sort option so the frontend wiring lands.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import type { Server as HttpServer } from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v241-inbox-" + process.pid);
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
  registerAgent,
  sendMessage,
  getMessages,
  getInboxSummary,
  closeDb,
} = await import("../src/db.js");
const { _resetDashboardWsForTests } = await import("../src/transport/websocket.js");

let server: HttpServer;
let port: number;

async function bootServer(): Promise<void> {
  if (server) {
    try { server.close(); } catch { /* ignore */ }
  }
  _resetDashboardWsForTests();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  server = startHttpServer(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 60));
  const addr = server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
}

function getJson(p: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: p }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, json: body ? JSON.parse(body) : null });
        });
      })
      .on("error", reject);
  });
}

function getText(p: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: p }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

beforeEach(async () => {
  await bootServer();
});

afterEach(() => {
  _resetDashboardWsForTests();
  try { if (server) server.close(); } catch { /* ignore */ }
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

describe("v2.4.1 — getInboxSummary()", () => {
  it("(I1) empty relay: returns [] (no agents registered yet)", () => {
    const rows = getInboxSummary();
    expect(rows).toEqual([]);
  });

  it("(I2) agents with zero mail still appear in the result (LEFT JOIN)", () => {
    registerAgent("victra", "orchestrator", []);
    registerAgent("outreach-tech", "builder", []);
    const rows = getInboxSummary();
    const names = rows.map((r) => r.agent_name).sort();
    expect(names).toEqual(["outreach-tech", "victra"]);
    for (const r of rows) {
      expect(r.pending_count).toBe(0);
      expect(r.unread_count).toBe(0);
      expect(r.last_message_at).toBeNull();
    }
  });

  it("(I3) pending_count + unread_count reflect mail piling up", () => {
    registerAgent("victra", "orchestrator", []);
    registerAgent("sender", "r", []);
    sendMessage("sender", "victra", "m1", "normal");
    sendMessage("sender", "victra", "m2", "high");
    sendMessage("sender", "victra", "m3", "normal");
    const rows = getInboxSummary();
    const v = rows.find((r) => r.agent_name === "victra")!;
    expect(v.pending_count).toBe(3);
    expect(v.unread_count).toBe(3);
    expect(v.last_message_at).not.toBeNull();
    const s = rows.find((r) => r.agent_name === "sender")!;
    expect(s.pending_count).toBe(0);
    expect(s.unread_count).toBe(0);
    expect(s.last_message_at).toBeNull();
  });

  it("(I4) drain flips pending_count to 0 but last_message_at survives history", () => {
    registerAgent("victra", "orchestrator", []);
    registerAgent("sender", "r", []);
    sendMessage("sender", "victra", "m1", "normal");
    sendMessage("sender", "victra", "m2", "normal");
    getMessages("victra", "pending", 100);
    const rows = getInboxSummary();
    const v = rows.find((r) => r.agent_name === "victra")!;
    expect(v.pending_count).toBe(0);
    expect(v.unread_count).toBe(0);
    expect(v.last_message_at).not.toBeNull();
  });
});

describe("v2.4.1 — /api/snapshot enrichment", () => {
  it("(S1) each agent row carries pending_count / unread_count / last_message_at", async () => {
    registerAgent("victra", "orchestrator", []);
    registerAgent("sender", "r", []);
    sendMessage("sender", "victra", "ping", "high");
    const r = await getJson("/api/snapshot");
    expect(r.status).toBe(200);
    const v = r.json.agents.find((a: any) => a.name === "victra");
    expect(v).toBeTruthy();
    expect(v.pending_count).toBe(1);
    expect(v.unread_count).toBe(1);
    expect(typeof v.last_message_at).toBe("string");
    const s = r.json.agents.find((a: any) => a.name === "sender");
    expect(s.pending_count).toBe(0);
    expect(s.unread_count).toBe(0);
    expect(s.last_message_at).toBeNull();
  });

  it("(S2) snapshot shape stable: existing agent fields survive enrichment", async () => {
    registerAgent("victra", "orchestrator", ["triage"]);
    const r = await getJson("/api/snapshot");
    expect(r.status).toBe(200);
    const v = r.json.agents.find((a: any) => a.name === "victra");
    expect(v.name).toBe("victra");
    expect(v.role).toBe("orchestrator");
    expect(v.capabilities).toEqual(["triage"]);
    expect(v.agent_status).toBeDefined();
    expect(v.has_token).toBeDefined();
    // v2.4.1 additive fields present.
    expect(v.pending_count).toBe(0);
    expect(v.unread_count).toBe(0);
    expect(v.last_message_at).toBeNull();
  });
});

describe("v2.4.1 — dashboard HTML", () => {
  it("(H1) inbox badge markup + 'inbox' sort option ship with the HTML", async () => {
    const r = await getText("/dashboard");
    expect(r.status).toBe(200);
    // Sort dropdown gained the 'inbox' option.
    expect(r.body).toMatch(/<option value="inbox">inbox<\/option>/);
    // Rendering logic references the inbox-badge class + per-card title.
    expect(r.body).toContain("inbox-badge");
    expect(r.body).toContain("inbox-badge-warn");
    expect(r.body).toContain("inbox-badge-zero");
  });
});
