// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.2.2 B4 + B5 — agent sort dropdown + message search bar.
 *
 * Both are client-side filter/sort operations on data already in the
 * page. These tests assert the HTML scaffolding + client code shape.
 *
 * B4.1  dashboard ships filter-sort dropdown with status/role/last-seen/name.
 * B5.1  dashboard ships filter-messages-search input + 200ms debounce.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import type { Server as HttpServer } from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v222-b4b5-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_HTTP_SECRET;
delete process.env.RELAY_DASHBOARD_SECRET;

const { startHttpServer } = await import("../src/transport/http.js");
const { closeDb } = await import("../src/db.js");
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

beforeEach(async () => { await bootServer(); });
afterEach(() => {
  try { if (server) server.close(); } catch { /* ignore */ }
  _resetDashboardWsForTests();
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

describe("v2.2.2 B4 — agent sort dropdown", () => {
  it("(B4.1) ships sort dropdown with 4 options", async () => {
    const html = await getHtml("/");
    expect(html).toContain('id="filter-sort"');
    expect(html).toContain('<option value="status" selected>status</option>');
    expect(html).toContain('<option value="role">role</option>');
    expect(html).toContain('<option value="last-seen">last seen</option>');
    expect(html).toContain('<option value="name">name</option>');
    // Sort order constants for the 'status' comparator must be baked in.
    expect(html).toContain("STATUS_ORDER");
  });
});

describe("v2.2.2 B5 — message search bar", () => {
  it("(B5.1) ships search input + 200ms debounce", async () => {
    const html = await getHtml("/");
    expect(html).toContain('id="filter-messages-search"');
    expect(html).toContain("messagesSearchTimer");
    // Debounce interval is 200ms per brief.
    expect(html).toContain(", 200);");
  });
});
