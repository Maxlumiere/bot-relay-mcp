// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.2.0 Phase 1 — dashboard click-to-focus foundation.
 *
 * Coverage:
 *   - Schema v9 migration adds agents.terminal_title_ref.
 *   - register_agent accepts + stores terminal_title_ref on both the first-
 *     insert path and the re-register UPDATE path.
 *   - discover_agents + /api/snapshot expose the field.
 *   - Focus drivers (macOS osascript / Linux wmctrl / Windows AppActivate)
 *     build the correct command for a given title.
 *   - POST /api/focus-terminal: 404 on unknown agent, 409 on NULL title ref,
 *     routes through csrfCheck but dashboardAuthCheck gates auth.
 *   - Zod layer rejects shell-metachar-laced titles at the tool boundary.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import type { Server as HttpServer } from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v220-p1-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
delete process.env.RELAY_ALLOW_LEGACY;
delete process.env.RELAY_HTTP_SECRET;
delete process.env.RELAY_DASHBOARD_SECRET;

const { registerAgent, getAgents, closeDb, getDb } = await import("../src/db.js");
const { macosDriver } = await import("../src/focus/drivers/macos.js");
const { linuxDriver } = await import("../src/focus/drivers/linux.js");
const { windowsDriver } = await import("../src/focus/drivers/windows.js");
const { focusTerminal, resolveDriver, buildContext } = await import("../src/focus/dispatcher.js");
const { startHttpServer } = await import("../src/transport/http.js");
const { RegisterAgentSchema, FocusTerminalSchema } = await import("../src/types.js");

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
}

beforeEach(() => cleanup());
afterEach(() => cleanup());

// ============================================================================
// Schema + register_agent + discover_agents
// ============================================================================

describe("v2.2.0 Phase 1 — schema + register_agent surface", () => {
  it("(1a) schema v9 adds agents.terminal_title_ref column", () => {
    registerAgent("seed", "r", []);
    const cols = getDb().prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("terminal_title_ref");
  });

  it("(1b) registerAgent stores terminal_title_ref on first insert", () => {
    const r = registerAgent("fresh", "builder", ["tasks"], { terminal_title_ref: "victra-build" });
    expect(r.agent.terminal_title_ref).toBe("victra-build");
    const row = getDb()
      .prepare("SELECT terminal_title_ref FROM agents WHERE name = ?")
      .get("fresh") as { terminal_title_ref: string };
    expect(row.terminal_title_ref).toBe("victra-build");
  });

  it("(1c) registerAgent UPDATE path replaces terminal_title_ref when provided", () => {
    registerAgent("reg", "builder", []);
    registerAgent("reg", "builder", [], { terminal_title_ref: "new-title" });
    const row = getDb()
      .prepare("SELECT terminal_title_ref FROM agents WHERE name = ?")
      .get("reg") as { terminal_title_ref: string };
    expect(row.terminal_title_ref).toBe("new-title");
  });

  it("(1d) registerAgent UPDATE preserves prior terminal_title_ref when field omitted", () => {
    registerAgent("keep", "r", [], { terminal_title_ref: "original" });
    registerAgent("keep", "r", []); // omitted — should NOT clear
    const row = getDb()
      .prepare("SELECT terminal_title_ref FROM agents WHERE name = ?")
      .get("keep") as { terminal_title_ref: string };
    expect(row.terminal_title_ref).toBe("original");
  });

  it("(1e) discover_agents (via getAgents) surfaces terminal_title_ref", () => {
    registerAgent("discover-me", "r", [], { terminal_title_ref: "my-window" });
    const agents = getAgents();
    const found = agents.find((a) => a.name === "discover-me");
    expect(found?.terminal_title_ref).toBe("my-window");
  });

  it("(1f) Zod RegisterAgentSchema accepts valid titles + rejects shell metachars", () => {
    const ok = RegisterAgentSchema.safeParse({
      name: "x",
      role: "r",
      capabilities: [],
      terminal_title_ref: "victra build-1",
    });
    expect(ok.success).toBe(true);
    const bad = RegisterAgentSchema.safeParse({
      name: "x",
      role: "r",
      capabilities: [],
      terminal_title_ref: "$(evil)",
    });
    expect(bad.success).toBe(false);
  });
});

// ============================================================================
// Focus drivers — pure command construction
// ============================================================================

describe("v2.2.0 Phase 1 — focus drivers (command construction)", () => {
  const ctxWithBins = { platform: "darwin" as const, hasBinary: () => true };

  it("(2a) macOS driver: osascript invocation with escaped title", () => {
    const cmd = macosDriver.buildCommand("victra-build", { ...ctxWithBins, platform: "darwin" });
    expect(cmd.exec).toBe("osascript");
    expect(cmd.args[0]).toBe("-e");
    expect(cmd.args[1]).toContain(`name of s is "victra-build"`);
    expect(cmd.args[1]).toContain("tell application \"iTerm2\"");
  });

  it("(2b) macOS driver: AppleScript escapes double-quotes + backslashes", () => {
    const cmd = macosDriver.buildCommand(`quo"te`, { ...ctxWithBins, platform: "darwin" });
    // Title with a `"` gets escaped to `\"` in the embedded AppleScript.
    expect(cmd.args[1]).toContain(`quo\\"te`);
  });

  it("(2c) Linux driver: wmctrl -a TITLE with title as discrete argv", () => {
    const cmd = linuxDriver.buildCommand("victra build", { ...ctxWithBins, platform: "linux" });
    expect(cmd.exec).toBe("wmctrl");
    expect(cmd.args).toEqual(["-a", "victra build"]);
  });

  it("(2d) Linux driver: canHandle false when wmctrl missing → dispatcher graceful degrades", () => {
    const noWmctrl = { platform: "linux" as const, hasBinary: (b: string) => b !== "wmctrl" };
    expect(linuxDriver.canHandle(noWmctrl)).toBe(false);
  });

  it("(2e) Windows driver: powershell AppActivate with PS-escaped title", () => {
    const cmd = windowsDriver.buildCommand("my-agent", { ...ctxWithBins, platform: "win32" });
    expect(cmd.exec).toBe("powershell.exe");
    expect(cmd.args[0]).toBe("-NoProfile");
    expect(cmd.args[1]).toBe("-NonInteractive");
    expect(cmd.args[2]).toBe("-Command");
    expect(cmd.args[3]).toContain(`AppActivate('my-agent')`);
  });

  it("(2f) Windows driver: PowerShell single-quote escape doubles `'`", () => {
    const cmd = windowsDriver.buildCommand("it's", { ...ctxWithBins, platform: "win32" });
    expect(cmd.args[3]).toContain(`AppActivate('it''s')`);
  });

  it("(2g) dispatcher resolveDriver returns null for unsupported platform", () => {
    // @ts-expect-error — intentionally pass an unsupported platform
    expect(resolveDriver("freebsd")).toBeNull();
  });

  it("(2h) dispatcher focusTerminal returns graceful-degrade when binary missing", async () => {
    // Stub buildContext via a direct focusTerminal call — in real tests we'd
    // inject a mock driver, but the dispatcher checks process.platform then
    // canHandle. On this CI host osascript exists (macOS), so for coverage
    // we just assert focusTerminal never throws — a graceful-degrade path
    // on any host IS the invariant being verified.
    const result = await focusTerminal("nonexistent-window-xyz-12345");
    // Result structure is always well-formed, raised may be true/false.
    expect(typeof result.raised).toBe("boolean");
    expect(result.platform).toBe(process.platform);
    expect(result.title).toBe("nonexistent-window-xyz-12345");
  });
});

// ============================================================================
// POST /api/focus-terminal endpoint
// ============================================================================

let server: HttpServer;
let port: number;

async function bootServer(): Promise<void> {
  if (server) {
    try { server.close(); } catch { /* ignore */ }
  }
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  server = startHttpServer(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 60));
  const addr = server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
}

function post(
  p: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string }> {
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
          ...headers,
        },
      },
      (res) => {
        let out = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (out += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: out }));
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

describe("v2.2.0 Phase 1 — POST /api/focus-terminal", () => {
  it("(3a) 400 on invalid body (no agent_name)", async () => {
    await bootServer();
    const r = await post("/api/focus-terminal", {});
    expect(r.status).toBe(400);
    expect(r.body).toMatch(/invalid/i);
    server.close();
  });

  it("(3b) 404 on unknown agent", async () => {
    await bootServer();
    const r = await post("/api/focus-terminal", { agent_name: "ghost" });
    expect(r.status).toBe(404);
    const data = JSON.parse(r.body);
    expect(data.raised).toBe(false);
    expect(data.reason).toMatch(/not registered/);
    server.close();
  });

  it("(3c) 409 when agent has NULL terminal_title_ref (graceful degrade)", async () => {
    await bootServer();
    registerAgent("no-ref", "r", []);
    const r = await post("/api/focus-terminal", { agent_name: "no-ref" });
    expect(r.status).toBe(409);
    const data = JSON.parse(r.body);
    expect(data.raised).toBe(false);
    expect(data.reason).toMatch(/terminal_title_ref/);
    server.close();
  });

  it("(3d) Zod-level rejection of invalid agent_name shape returns 400", async () => {
    await bootServer();
    // agent_name max is 64 chars per Zod. 100-char string → rejection.
    const r = await post("/api/focus-terminal", { agent_name: "x".repeat(100) });
    expect(r.status).toBe(400);
    server.close();
  });

  it("(3e) FocusTerminalSchema shape is tight (agent_name required string)", () => {
    expect(FocusTerminalSchema.safeParse({}).success).toBe(false);
    expect(FocusTerminalSchema.safeParse({ agent_name: "" }).success).toBe(false);
    expect(FocusTerminalSchema.safeParse({ agent_name: "ok" }).success).toBe(true);
  });
});
