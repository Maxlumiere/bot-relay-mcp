// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.2.2 B1 — rich custom-theme dialog + server persistence.
 *
 * Full DOM interaction is exercised manually (the dialog is a native
 * <dialog> with color pickers — no point mocking it in node). These
 * tests cover the server-side POST /api/dashboard-theme endpoint that
 * the Save button calls, plus the static HTML shape so the dialog
 * scaffolding is present on the page.
 *
 * B1.1  Dashboard HTML ships the <dialog> scaffold + 14 color pickers.
 * B1.2  POST { mode: 'catppuccin' } persists via setDashboardPrefs.
 * B1.3  POST { mode: 'custom', custom_json } persists + broadcasts
 *       a dashboard.theme_changed event to open WS clients.
 * B1.4  POST { mode: 'custom' } WITHOUT custom_json → 400.
 * B1.5  POST { mode: 'custom', custom_json: <missing tokens> } → 400.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import type { Server as HttpServer } from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v222-b1-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_HTTP_SECRET;
delete process.env.RELAY_DASHBOARD_SECRET;
delete process.env.RELAY_DASHBOARD_OPERATOR;

const { startHttpServer } = await import("../src/transport/http.js");
const { closeDb, getDb, getDashboardPrefs } = await import("../src/db.js");
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

function postJson(p: string, body: Record<string, unknown>): Promise<{ status: number; json: any }> {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, path: p, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(data)) },
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

function getHtml(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: p },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve(raw));
      },
    );
    req.on("error", reject);
  });
}

beforeEach(async () => { await bootServer(); });
afterEach(() => {
  try { if (server) server.close(); } catch { /* ignore */ }
  _resetDashboardWsForTests();
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

const FULL_THEME = {
  bg: "#101010",
  panel: "#1a1a1a",
  "panel-2": "#202020",
  border: "#303030",
  text: "#eaeaea",
  muted: "#8a8a8a",
  accent: "#5b8cff",
  online: "#3ecf8e",
  stale: "#ffb454",
  offline: "#606060",
  critical: "#ff5c5c",
  high: "#ff914d",
  normal: "#5b8cff",
  low: "#999999",
};

describe("v2.2.2 B1 — custom-theme dialog + /api/dashboard-theme", () => {
  it("(B1.1) dashboard HTML ships the <dialog> scaffold + 14 color pickers", async () => {
    const html = await getHtml("/");
    expect(html).toContain('<dialog id="custom-theme-dialog"');
    expect(html).toContain('id="custom-theme-save"');
    expect(html).toContain('id="custom-theme-cancel"');
    expect(html).toContain('id="custom-theme-json"');
    for (const t of Object.keys(FULL_THEME)) {
      expect(html).toContain('data-token="' + t + '"');
    }
  });

  it("(B1.2) POST { mode: 'catppuccin' } persists via setDashboardPrefs", async () => {
    const res = await postJson("/api/dashboard-theme", { mode: "catppuccin" });
    expect(res.status).toBe(200);
    expect(res.json?.success).toBe(true);
    expect(res.json?.theme).toBe("catppuccin");
    const persisted = getDashboardPrefs();
    expect(persisted.theme).toBe("catppuccin");
  });

  it("(B1.3) POST { mode: 'custom', custom_json } persists + broadcasts WS event", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/dashboard/ws`);
    const messages: any[] = [];
    ws.on("message", (d: Buffer) => {
      try { messages.push(JSON.parse(d.toString("utf8"))); } catch { /* ignore */ }
    });
    await new Promise<void>((r, j) => {
      ws.once("open", () => r());
      ws.once("error", j);
      setTimeout(() => j(new Error("ws open timeout")), 1500);
    });
    // Let the eager hello frame land before we post.
    await new Promise((r) => setTimeout(r, 80));
    const res = await postJson("/api/dashboard-theme", { mode: "custom", custom_json: FULL_THEME });
    expect(res.status).toBe(200);
    expect(res.json?.success).toBe(true);
    const persisted = getDashboardPrefs();
    expect(persisted.theme).toBe("custom");
    expect(persisted.custom_json).toBeTruthy();
    expect(JSON.parse(persisted.custom_json!)).toMatchObject({ bg: "#101010" });
    // Wait for broadcast to flush.
    await new Promise((r) => setTimeout(r, 120));
    ws.close();
    const broadcast = messages.find((m) => m.event === "dashboard.theme_changed");
    expect(broadcast).toBeDefined();
    expect(broadcast.entity_id).toBe("custom");
  });

  it("(B1.4) POST { mode: 'custom' } without custom_json → 400", async () => {
    const res = await postJson("/api/dashboard-theme", { mode: "custom" });
    expect(res.status).toBe(400);
    expect(res.json?.success).toBe(false);
  });

  it("(B1.5) POST { mode: 'custom', custom_json: partial } → 400", async () => {
    const partial = { ...FULL_THEME } as Record<string, string>;
    delete partial.bg;
    const res = await postJson("/api/dashboard-theme", { mode: "custom", custom_json: partial });
    expect(res.status).toBe(400);
  });

  it("(B1.6) audit log records via_dashboard on successful set", async () => {
    await postJson("/api/dashboard-theme", { mode: "dark" });
    const row = getDb()
      .prepare(
        "SELECT success, params_summary FROM audit_log " +
        "WHERE tool = 'set_dashboard_theme' AND source = 'dashboard' " +
        "ORDER BY id DESC LIMIT 1",
      )
      .get() as { success: number; params_summary: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.success).toBe(1);
    expect(row!.params_summary).toMatch(/mode=dark/);
  });
});
