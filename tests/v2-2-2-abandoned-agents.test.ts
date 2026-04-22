// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.2.2 B3 — abandoned agent status + purge-agents CLI.
 *
 * B3.1  deriveAgentStatus promotes offline > RELAY_AGENT_ABANDON_DAYS
 *       (default 7) to "abandoned".
 * B3.2  RELAY_AGENT_ABANDON_DAYS env var overrides the threshold.
 * B3.3  Dashboard HTML ships the show-abandoned checkbox + status
 *       dropdown option.
 * B3.4  `relay purge-agents` (dry-run) lists candidates + exits 0
 *       without deleting.
 * B3.5  `relay purge-agents --apply --yes` deletes candidates + writes
 *       audit entries.
 * B3.6  `--abandoned-since=N` honors the custom threshold.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import type { Server as HttpServer } from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v222-b3-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_HTTP_SECRET;
delete process.env.RELAY_DASHBOARD_SECRET;

const { startHttpServer } = await import("../src/transport/http.js");
const { closeDb, getDb, registerAgent, getAgents } = await import("../src/db.js");
const { run: runPurgeAgents } = await import("../src/cli/purge-agents.js");
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

function ageAgent(name: string, days: number): void {
  const stamp = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  getDb().prepare("UPDATE agents SET last_seen = ? WHERE name = ?").run(stamp, name);
}

beforeEach(async () => {
  delete process.env.RELAY_AGENT_ABANDON_DAYS;
  await bootServer();
});
afterEach(() => {
  try { if (server) server.close(); } catch { /* ignore */ }
  _resetDashboardWsForTests();
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  delete process.env.RELAY_AGENT_ABANDON_DAYS;
});

describe("v2.2.2 B3.a — abandoned agent_status", () => {
  it("(B3.1) agent with last_seen > 7 days surfaces as agent_status='abandoned'", () => {
    registerAgent("abandon-me", "r", []);
    ageAgent("abandon-me", 8);
    const found = getAgents().find((a) => a.name === "abandon-me");
    expect(found).toBeDefined();
    expect(found!.agent_status).toBe("abandoned");
  });

  it("(B3.2) RELAY_AGENT_ABANDON_DAYS override respected", () => {
    process.env.RELAY_AGENT_ABANDON_DAYS = "2";
    registerAgent("quick-abandon", "r", []);
    ageAgent("quick-abandon", 3);
    const found = getAgents().find((a) => a.name === "quick-abandon");
    expect(found!.agent_status).toBe("abandoned");
  });

  it("(B3.2b) last_seen under threshold → offline, not abandoned", () => {
    registerAgent("still-alive", "r", []);
    ageAgent("still-alive", 3); // < 7 days
    const found = getAgents().find((a) => a.name === "still-alive");
    expect(found!.agent_status).toBe("offline");
  });
});

describe("v2.2.2 B3.b — dashboard show-abandoned toggle", () => {
  it("(B3.3) dashboard HTML ships checkbox + status option", async () => {
    const html = await getHtml("/");
    expect(html).toContain('id="filter-show-abandoned"');
    expect(html).toContain('<option value="abandoned">abandoned</option>');
    expect(html).toContain('.badge-abandoned');
  });
});

describe("v2.2.2 B3.c — relay purge-agents CLI", () => {
  it("(B3.4) dry-run lists candidates without deleting", async () => {
    registerAgent("p1-old", "r", []);
    registerAgent("p1-new", "r", []);
    ageAgent("p1-old", 10);
    ageAgent("p1-new", 2);
    closeDb();
    // Run the CLI which opens its own DB handle.
    const code = await runPurgeAgents([]);
    expect(code).toBe(0);
    // Reopen to confirm nothing got deleted.
    const { initializeDb, getDb: getDb2 } = await import("../src/db.js");
    await initializeDb();
    const rows = getDb2().prepare("SELECT name FROM agents").all() as { name: string }[];
    const names = rows.map((r) => r.name).sort();
    expect(names).toContain("p1-old");
    expect(names).toContain("p1-new");
  });

  it("(B3.5) --apply --yes deletes old agents + writes audit entries", async () => {
    registerAgent("p2-old", "r", []);
    registerAgent("p2-fresh", "r", []);
    ageAgent("p2-old", 14);
    ageAgent("p2-fresh", 1);
    closeDb();
    const code = await runPurgeAgents(["--apply", "--yes"]);
    expect(code).toBe(0);
    const { initializeDb, getDb: getDb2 } = await import("../src/db.js");
    await initializeDb();
    const rows = getDb2().prepare("SELECT name FROM agents").all() as { name: string }[];
    const names = rows.map((r) => r.name);
    expect(names).not.toContain("p2-old");
    expect(names).toContain("p2-fresh");
    const audit = getDb2()
      .prepare("SELECT agent_name, tool, params_summary FROM audit_log WHERE tool = 'purge-agents.cli' ORDER BY id DESC")
      .all() as { agent_name: string; tool: string; params_summary: string }[];
    expect(audit.length).toBe(1);
    expect(audit[0].agent_name).toBe("p2-old");
    expect(audit[0].params_summary).toMatch(/threshold_days=7/);
    expect(audit[0].params_summary).toMatch(/target=p2-old/);
  });

  it("(B3.6) --abandoned-since=3 overrides the default threshold", async () => {
    registerAgent("p3-five", "r", []);
    registerAgent("p3-two", "r", []);
    ageAgent("p3-five", 5);
    ageAgent("p3-two", 2);
    closeDb();
    const code = await runPurgeAgents(["--abandoned-since=3", "--apply", "--yes"]);
    expect(code).toBe(0);
    const { initializeDb, getDb: getDb2 } = await import("../src/db.js");
    await initializeDb();
    const rows = getDb2().prepare("SELECT name FROM agents").all() as { name: string }[];
    const names = rows.map((r) => r.name);
    expect(names).not.toContain("p3-five");
    expect(names).toContain("p3-two");
  });

  it("(B3.7) --apply with no eligible agents is a no-op", async () => {
    registerAgent("p4-fresh", "r", []);
    closeDb();
    const code = await runPurgeAgents(["--apply", "--yes"]);
    expect(code).toBe(0);
    const { initializeDb, getDb: getDb2 } = await import("../src/db.js");
    await initializeDb();
    const rows = getDb2().prepare("SELECT name FROM agents").all() as { name: string }[];
    expect(rows.map((r) => r.name)).toContain("p4-fresh");
  });
});
