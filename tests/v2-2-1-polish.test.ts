// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.2.1 Part B polish regressions.
 *
 *   P1 — 4 themes + `set_dashboard_theme` MCP tool + dashboard_prefs table
 *   P2 — 3 inline endpoints (/api/send-message, /api/kill-agent, /api/set-status)
 *   P3 — CSS extraction (asserted indirectly: dashboard HTML still contains :root)
 *   P4 — WS test helper extraction (asserted indirectly: helper file exists)
 *   P5 — SECURITY.md CSRF loopback-dev callout (asserted by file content match)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import type { Server as HttpServer } from "http";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v221-polish-" + process.pid);
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
  closeDb,
  getDb,
  registerAgent,
  getDashboardPrefs,
  setDashboardPrefs,
  getAgentAuthData,
} = await import("../src/db.js");
const { handleSetDashboardTheme } = await import("../src/tools/dashboard.js");
const { SetDashboardThemeSchema } = await import("../src/types.js");

let server: HttpServer;
let port: number;

async function bootServer(): Promise<void> {
  if (server) { try { server.close(); } catch { /* ignore */ } }
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  server = startHttpServer(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 60));
  const addr = server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
}

function parseResult(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

function postJson(p: string, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: p,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(data)),
          ...extraHeaders,
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null }));
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function getText(p: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: p }, (res) => {
        let b = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
      })
      .on("error", reject);
  });
}

beforeEach(async () => {
  await bootServer();
});
afterEach(() => {
  try { if (server) server.close(); } catch { /* ignore */ }
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

// ============================================================================
// P1 — themes + set_dashboard_theme
// ============================================================================

describe("v2.2.1 P1 — dashboard themes + set_dashboard_theme tool", () => {
  it("(P1.1) dashboard_prefs seeded with catppuccin on first migration", () => {
    const prefs = getDashboardPrefs();
    expect(prefs.theme).toBe("catppuccin");
    expect(prefs.custom_json).toBeNull();
    expect(prefs.updated_at).toBeTruthy();
  });

  it("(P1.2) handleSetDashboardTheme writes new default + round-trips via getDashboardPrefs", () => {
    const r = handleSetDashboardTheme({ mode: "dark" } as any);
    const body = parseResult(r);
    expect(body.success).toBe(true);
    expect(body.theme).toBe("dark");
    expect(getDashboardPrefs().theme).toBe("dark");
  });

  it("(P1.3) Zod: mode='custom' WITHOUT custom_json → rejected", () => {
    const r = SetDashboardThemeSchema.safeParse({ mode: "custom" });
    expect(r.success).toBe(false);
  });

  it("(P1.4) Zod: mode='custom' WITH all 14 tokens → accepted", () => {
    const tokens = {
      bg: "#000", panel: "#111", "panel-2": "#222", border: "#333",
      text: "#eee", muted: "#aaa", accent: "#08f",
      online: "#0f0", stale: "#fa0", offline: "#666",
      critical: "#f00", high: "#f80", normal: "#08f", low: "#ccc",
    };
    const r = SetDashboardThemeSchema.safeParse({ mode: "custom", custom_json: tokens });
    expect(r.success).toBe(true);
  });

  it("(P1.5) Zod: custom_json missing a token → rejected", () => {
    const partialTokens = { bg: "#000", panel: "#111" }; // missing 12 others
    const r = SetDashboardThemeSchema.safeParse({ mode: "custom", custom_json: partialTokens });
    expect(r.success).toBe(false);
  });

  it("(P1.6) /api/snapshot surfaces dashboard_prefs so clients can read server default", async () => {
    setDashboardPrefs("light", null);
    const r = await getText("/api/snapshot");
    expect(r.status).toBe(200);
    const json = JSON.parse(r.body);
    expect(json.dashboard_prefs).toBeDefined();
    expect(json.dashboard_prefs.theme).toBe("light");
  });

  it("(P1.7) dashboard HTML references 4 theme options in the dropdown", async () => {
    const r = await getText("/dashboard");
    expect(r.body).toMatch(/id="theme-toggle"/);
    expect(r.body).toMatch(/option value="catppuccin"/);
    expect(r.body).toMatch(/option value="dark"/);
    expect(r.body).toMatch(/option value="light"/);
    expect(r.body).toMatch(/option value="custom"/);
  });
});

// ============================================================================
// P2 — 3 inline endpoints
// ============================================================================

describe("v2.2.1 P2 — /api/send-message", () => {
  it("(P2.S1) happy path: registered sender + recipient → 200 + message stored", async () => {
    registerAgent("p2-from", "r", []);
    registerAgent("p2-to", "r", []);
    const r = await postJson("/api/send-message", {
      from: "p2-from",
      to: "p2-to",
      content: "from the dashboard",
    });
    expect(r.status).toBe(200);
    expect(r.json.success).toBe(true);
    expect(r.json.message_id).toBeTruthy();
    const count = (getDb().prepare("SELECT COUNT(*) AS c FROM messages").get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it("(P2.S2) invalid body (no `to`) → 400", async () => {
    const r = await postJson("/api/send-message", { from: "x", content: "hi" });
    expect(r.status).toBe(400);
  });

  it("(P2.S3) unknown sender → 400 with SENDER_NOT_REGISTERED", async () => {
    registerAgent("p2-to2", "r", []);
    const r = await postJson("/api/send-message", {
      from: "ghost-sender",
      to: "p2-to2",
      content: "spoofed",
    });
    expect(r.status).toBe(400);
    expect(r.json.error_code).toBe("SENDER_NOT_REGISTERED");
  });
});

describe("v2.2.1 P2 — /api/kill-agent", () => {
  it("(P2.K1) missing X-Relay-Confirm header → 428 with confirmation-required hint", async () => {
    registerAgent("doomed", "r", []);
    const r = await postJson("/api/kill-agent", { name: "doomed" });
    expect(r.status).toBe(428);
    expect(r.json.error).toMatch(/confirmation/i);
  });

  it("(P2.K2) with X-Relay-Confirm=yes + valid target → 200 + row removed", async () => {
    registerAgent("doomed-2", "r", []);
    const r = await postJson("/api/kill-agent", { name: "doomed-2" }, { "X-Relay-Confirm": "yes" });
    expect(r.status).toBe(200);
    expect(r.json.success).toBe(true);
    expect(r.json.removed).toBe(true);
    expect(getAgentAuthData("doomed-2")).toBeNull();
  });

  it("(P2.K3) non-registered target → 200 with removed:false (idempotent)", async () => {
    const r = await postJson("/api/kill-agent", { name: "ghost" }, { "X-Relay-Confirm": "yes" });
    expect(r.status).toBe(200);
    expect(r.json.success).toBe(true);
    expect(r.json.removed).toBe(false);
  });

  it("(P2.K4) invalid body → 400", async () => {
    const r = await postJson("/api/kill-agent", {}, { "X-Relay-Confirm": "yes" });
    expect(r.status).toBe(400);
  });
});

describe("v2.2.1 P2 — /api/set-status", () => {
  it("(P2.ST1) happy path: registered agent + valid status → 200 + row updated", async () => {
    registerAgent("statuschanger", "r", []);
    const r = await postJson("/api/set-status", {
      agent_name: "statuschanger",
      agent_status: "blocked",
    });
    expect(r.status).toBe(200);
    expect(r.json.success).toBe(true);
    const row = getAgentAuthData("statuschanger");
    expect(row?.agent_status).toBe("blocked");
  });

  it("(P2.ST2) unknown agent → 404", async () => {
    const r = await postJson("/api/set-status", {
      agent_name: "ghost",
      agent_status: "working",
    });
    expect(r.status).toBe(404);
  });

  it("(P2.ST3) invalid status enum → 400", async () => {
    registerAgent("statuschanger-2", "r", []);
    const r = await postJson("/api/set-status", {
      agent_name: "statuschanger-2",
      agent_status: "DEFINITELY_NOT_A_STATUS",
    });
    expect(r.status).toBe(400);
  });
});

// ============================================================================
// P3, P4, P5 — artifact checks
// ============================================================================

describe("v2.2.1 P3/P4/P5 — extraction + docs artifacts", () => {
  it("(P3.1) src/dashboard-styles.ts exports DASHBOARD_BASE_STYLES + DASHBOARD_THEMES", async () => {
    const mod = await import("../src/dashboard-styles.js");
    expect(mod.DASHBOARD_BASE_STYLES).toMatch(/:root \{/);
    expect(mod.DASHBOARD_THEMES).toMatch(/\[data-theme="dark"\]/);
    expect(mod.DASHBOARD_THEMES).toMatch(/\[data-theme="light"\]/);
  });

  it("(P3.2) rendered dashboard HTML contains interpolated :root CSS block", async () => {
    const r = await getText("/dashboard");
    expect(r.body).toMatch(/:root \{[\s\S]+--bg:/);
    expect(r.body).toMatch(/data-theme="dark"/);
    expect(r.body).toMatch(/data-theme="light"/);
  });

  it("(P4.1) tests/_helpers/ws.ts exists with connectWs export", () => {
    const helperPath = path.join(REPO_ROOT, "tests", "_helpers", "ws.ts");
    expect(fs.existsSync(helperPath)).toBe(true);
    const body = fs.readFileSync(helperPath, "utf-8");
    expect(body).toMatch(/export async function connectWs/);
    expect(body).toMatch(/WsTestHandle/);
  });

  it("(P5.1) SECURITY.md contains the v2.2.1 CSRF loopback-dev callout", () => {
    const body = fs.readFileSync(path.join(REPO_ROOT, "SECURITY.md"), "utf-8");
    expect(body).toMatch(/CSRF is skipped on loopback-dev permissive mode/);
    expect(body).toMatch(/RELAY_DASHBOARD_SECRET/);
  });

  it("(P5.2) docs/hook-payload-format.md cross-linked from docs/hooks.md", () => {
    const hooks = fs.readFileSync(path.join(REPO_ROOT, "docs", "hooks.md"), "utf-8");
    expect(hooks).toMatch(/hook-payload-format\.md/);
  });
});
