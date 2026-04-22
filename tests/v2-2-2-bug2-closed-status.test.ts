// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.2.2 BUG2 — closed agent_status.
 *
 * SIGINT/SIGTERM from a stdio terminal used to set agent_status to
 * `offline`, indistinguishable from a network drop or transient
 * disconnect. v2.2.2 adds `closed` — an intentional-retirement state
 * written by `closeAgentSession` (the helper now wired into
 * performAutoUnregister). Dashboards can render retired-by-intent
 * terminals differently from offline-but-may-return.
 *
 * BUG2.1  closeAgentSession sets status='closed' + clears session_id.
 * BUG2.2  performAutoUnregister routes through closeAgentSession and
 *         writes a `stdio.auto_close` audit entry.
 * BUG2.3  Dashboard HTML ships the `closed` filter option +
 *         `.badge-closed` style.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import type { Server as HttpServer } from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v222-bug2-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_HTTP_SECRET;

const { startHttpServer } = await import("../src/transport/http.js");
const { closeDb, getDb, registerAgent, closeAgentSession, getAgents } = await import("../src/db.js");
const { performAutoUnregister } = await import("../src/transport/stdio.js");
const { _resetDashboardWsForTests } = await import("../src/transport/websocket.js");

let server: HttpServer | null = null;
let port = 0;

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

function getHtml(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: p }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (raw += c));
      res.on("end", () => resolve(raw));
    });
    req.on("error", reject);
  });
}

beforeEach(() => {
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
});
afterEach(() => {
  try { if (server) server.close(); } catch { /* ignore */ }
  server = null;
  _resetDashboardWsForTests();
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

describe("v2.2.2 BUG2 — closed agent_status", () => {
  it("(BUG2.1) closeAgentSession sets status='closed' + clears session_id", () => {
    registerAgent("close-me", "r", []);
    const row = getDb()
      .prepare("SELECT session_id FROM agents WHERE name = ?")
      .get("close-me") as { session_id: string };
    expect(row.session_id).toBeTruthy();
    const r = closeAgentSession("close-me", row.session_id);
    expect(r.changed).toBe(true);
    const after = getDb()
      .prepare("SELECT session_id, agent_status FROM agents WHERE name = ?")
      .get("close-me") as { session_id: string | null; agent_status: string };
    expect(after.session_id).toBeNull();
    expect(after.agent_status).toBe("closed");
    const derived = getAgents().find((a) => a.name === "close-me");
    expect(derived?.agent_status).toBe("closed");
  });

  it("(BUG2.2) performAutoUnregister routes through closeAgentSession + writes stdio.auto_close audit", () => {
    registerAgent("sigint-target", "r", []);
    const row = getDb()
      .prepare("SELECT session_id FROM agents WHERE name = ?")
      .get("sigint-target") as { session_id: string };
    performAutoUnregister("sigint-target", row.session_id, "SIGINT");
    const after = getDb()
      .prepare("SELECT agent_status FROM agents WHERE name = ?")
      .get("sigint-target") as { agent_status: string };
    expect(after.agent_status).toBe("closed");
    const audit = getDb()
      .prepare(
        "SELECT agent_name, tool, params_summary FROM audit_log " +
        "WHERE tool = 'stdio.auto_close' ORDER BY id DESC LIMIT 1"
      )
      .get() as { agent_name: string; tool: string; params_summary: string } | undefined;
    expect(audit).toBeDefined();
    expect(audit!.agent_name).toBe("sigint-target");
    expect(audit!.params_summary).toMatch(/signal=SIGINT/);
  });

  it("(BUG2.3) dashboard ships 'closed' filter option + .badge-closed style", async () => {
    await bootServer();
    const html = await getHtml("/");
    expect(html).toContain('<option value="closed">closed</option>');
    expect(html).toContain(".badge-closed");
  });
});
