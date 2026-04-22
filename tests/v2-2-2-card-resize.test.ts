// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.2.2 B2 — per-card resize handle + snap-to-grid-column.
 *
 * Resize behavior is mouse-drag DOM interaction, not meaningfully
 * testable in node. These tests assert:
 *
 * B2.1  Each agent card ships a resize handle element + reset-size
 *       button.
 * B2.2  Dashboard base styles declare the .card-resize + .card-reset
 *       selectors.
 * B2.3  The client-side LRU cap constant is present in the bundle so
 *       the localStorage map can't grow unboundedly.
 * B2.4  renderAgents applies grid-column/grid-row span inline styles
 *       when cardSizes is populated (indirect: check the script string
 *       contains the `grid-column:span ` template).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import type { Server as HttpServer } from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v222-b2-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_HTTP_SECRET;
delete process.env.RELAY_DASHBOARD_SECRET;

const { startHttpServer } = await import("../src/transport/http.js");
const { closeDb, registerAgent } = await import("../src/db.js");
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

describe("v2.2.2 B2 — per-card resize scaffold", () => {
  it("(B2.1) agent-card template emits resize-handle + reset-size elements", async () => {
    registerAgent("b2-a", "r", []);
    const html = await getHtml("/");
    // renderAgents is client-side; the template literal is in the
    // source. Confirm the relevant attribute hooks exist.
    expect(html).toContain('data-action="resize-handle"');
    expect(html).toContain('data-action="reset-size"');
  });

  it("(B2.2) styles declare .card-resize + .card-reset selectors", async () => {
    const html = await getHtml("/");
    expect(html).toContain(".card-resize");
    expect(html).toContain(".card-reset");
    expect(html).toContain("nwse-resize");
  });

  it("(B2.3) LRU cap constant (50) is present in the script", async () => {
    const html = await getHtml("/");
    expect(html).toContain("CARD_SIZES_CAP = 50");
    expect(html).toContain("bot-relay-card-sizes-v1");
  });

  it("(B2.4) template applies grid-column:span when cardSizes populated", async () => {
    const html = await getHtml("/");
    expect(html).toContain("grid-column:span ");
    expect(html).toContain("grid-row:span ");
  });

  it("(B2.5) pointer handlers wired: pointerdown + pointermove + pointerup", async () => {
    const html = await getHtml("/");
    expect(html).toContain("'pointerdown'");
    expect(html).toContain("'pointermove'");
    expect(html).toContain("'pointerup'");
  });
});
