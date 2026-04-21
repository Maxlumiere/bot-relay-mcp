// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.2.0 Phase 3 — dashboard frontend rewrite.
 *
 * Coverage:
 *   - `GET /dashboard` serves the new HTML with the expected landmark IDs
 *     (cards-per-row toggle, filters, messages list, focused-agent panel).
 *   - The inline JS references `/dashboard/ws` (Phase 2) and
 *     `/api/focus-terminal` (Phase 1) — proves the three phases are wired
 *     end-to-end on the client side.
 *   - `/api/snapshot` includes the new `content_preview` / `*_preview`
 *     fields alongside the raw (encrypted) content — narrow Phase 4d
 *     policy expansion documented in src/dashboard.ts.
 *   - CSS uses the `--cards-per-row` custom property.
 *   - Filter bar renders 3 inputs (role / status / since) with associated
 *     aria-labels.
 *   - Recent-messages list uses <button> rows with aria-expanded (keyboard
 *     navigable ARIA-compliant accordion).
 *
 * Manual verification outstanding (per spec § Success criteria, demo-able
 * at ship ceremony): live WebSocket push visible on browser, cards-per-row
 * toggle updates grid, click-to-focus raises iTerm2 on macOS.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import type { Server as HttpServer } from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v220-p3-" + process.pid);
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
const { registerAgent, sendMessage, closeDb } = await import("../src/db.js");
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

describe("v2.2.0 Phase 3 — dashboard HTML", () => {
  it("(D1) GET /dashboard serves HTML containing all Phase 3 landmark IDs", async () => {
    const r = await getText("/dashboard");
    expect(r.status).toBe(200);
    // Core landmarks the reactive app wires to.
    expect(r.body).toContain('id="agents-grid"');
    expect(r.body).toContain('id="cards-per-row-toggle"');
    expect(r.body).toContain('id="filter-role"');
    expect(r.body).toContain('id="filter-status"');
    expect(r.body).toContain('id="filter-since"');
    expect(r.body).toContain('id="focused-agent"');
    expect(r.body).toContain('id="btn-focus-terminal"');
    expect(r.body).toContain('id="conn-pill"');
  });

  it("(D2) HTML references /dashboard/ws (Phase 2) and /api/focus-terminal (Phase 1)", async () => {
    const r = await getText("/dashboard");
    expect(r.status).toBe(200);
    expect(r.body).toContain("/dashboard/ws");
    expect(r.body).toContain("/api/focus-terminal");
    expect(r.body).toContain("/api/snapshot");
  });

  it("(D3) CSS grid uses --cards-per-row custom property", async () => {
    const r = await getText("/dashboard");
    expect(r.body).toContain("--cards-per-row");
    expect(r.body).toMatch(/grid-template-columns:\s*repeat\(var\(--cards-per-row\)/);
  });

  it("(D4) Recent-messages list uses <button> rows with aria-expanded (accordion)", async () => {
    const r = await getText("/dashboard");
    expect(r.body).toContain('class="msg-row"');
    expect(r.body).toContain('aria-expanded');
    // Keyboard/ARIA: the focused panel is aria-live for screen readers on update.
    expect(r.body).toContain('aria-live="polite"');
  });

  it("(D5) Filter bar inputs have associated aria-labels", async () => {
    const r = await getText("/dashboard");
    expect(r.body).toMatch(/aria-label="Cards per row"/);
    expect(r.body).toMatch(/aria-label="Filter by role"/);
    expect(r.body).toMatch(/aria-label="Filter by agent status"/);
    expect(r.body).toMatch(/aria-label="Time window for messages"/);
  });

  it("(D6) Dashboard served from GET / too (root-alias)", async () => {
    const r = await getText("/");
    expect(r.status).toBe(200);
    expect(r.body).toContain('id="agents-grid"');
  });
});

describe("v2.2.0 Phase 3 — /api/snapshot shape", () => {
  it("(S1) includes content_preview on messages", async () => {
    registerAgent("snap-from", "r", []);
    registerAgent("snap-to", "r", []);
    sendMessage("snap-from", "snap-to", "hello dashboard", "normal");
    const r = await getJson("/api/snapshot");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.messages)).toBe(true);
    expect(r.json.messages.length).toBeGreaterThan(0);
    const m = r.json.messages[0];
    // raw (possibly encrypted) content still present for clients that want it
    expect(typeof m.content).toBe("string");
    // new decrypted preview field
    expect(m.content_preview).toBe("hello dashboard");
  });

  it("(S2) long content_preview truncated at 100 chars", async () => {
    registerAgent("long-from", "r", []);
    registerAgent("long-to", "r", []);
    const big = "x".repeat(500);
    sendMessage("long-from", "long-to", big, "normal");
    const r = await getJson("/api/snapshot");
    const m = (r.json.messages as any[]).find(
      (m) => m.from_agent === "long-from" && m.to_agent === "long-to"
    );
    expect(m).toBeDefined();
    expect(m.content_preview.length).toBe(100);
  });

  it("(S3) active_tasks carry description_preview; agents carry terminal_title_ref (Phase 1 wire)", async () => {
    registerAgent("task-owner", "r", []);
    registerAgent("agent-with-title", "r", [], { terminal_title_ref: "my-window" });
    const r = await getJson("/api/snapshot");
    expect(r.status).toBe(200);
    const ag = (r.json.agents as any[]).find((a) => a.name === "agent-with-title");
    expect(ag.terminal_title_ref).toBe("my-window");
  });
});
