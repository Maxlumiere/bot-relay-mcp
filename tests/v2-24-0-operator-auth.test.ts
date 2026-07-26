// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * PR B / ADR-0006 — operator-power endpoints are authed regardless of network
 * position ("location is not a principal"), and the http_secret → operator
 * escalation is removed.
 *
 * ADR-0015 harm + innocent twin, through the REAL shipped route:
 *   - HARM: a tokenless loopback caller attempting operator power is REFUSED
 *     (401) AND the side effect does not happen (set-status leaves the status;
 *     kill-agent leaves the row).
 *   - ESCALATION HARM (the removed fallback): presenting the AGENT transport
 *     credential (http_secret) to an operator endpoint is REFUSED. Before this
 *     PR the `|| config.http_secret` fallback made that succeed.
 *   - INNOCENT TWIN: an authenticated operator (dashboard secret + Bearer + CSRF)
 *     performs the same actions successfully — the gate refuses the harm without
 *     breaking the operator path.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import type { Server as HttpServer } from "http";
import { OPERATOR_SECRET, operatorGet, operatorPost, rawRequest } from "./_helpers/operator-auth.js";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v240-opauth-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_HTTP_SECRET;
delete process.env.RELAY_DASHBOARD_SECRET;

const { startHttpServer } = await import("../src/transport/http.js");
const { closeDb, getDb, registerAgent } = await import("../src/db.js");
const { _resetDashboardWsForTests } = await import("../src/transport/websocket.js");

let server: HttpServer;
let port: number;

async function boot(): Promise<void> {
  if (server) { try { server.close(); } catch { /* ignore */ } }
  _resetDashboardWsForTests();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  server = startHttpServer(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 60)); // wait for the 'listening' event so address() is set
  const addr = server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
}

function agentStatus(name: string): string | undefined {
  const row = getDb().prepare("SELECT agent_status FROM agents WHERE name = ?").get(name) as
    | { agent_status: string }
    | undefined;
  return row?.agent_status;
}
function agentExists(name: string): boolean {
  return !!getDb().prepare("SELECT 1 FROM agents WHERE name = ?").get(name);
}

afterEach(() => {
  try { if (server) server.close(); } catch { /* ignore */ }
  _resetDashboardWsForTests();
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  delete process.env.RELAY_HTTP_SECRET;
  delete process.env.RELAY_DASHBOARD_SECRET;
});

// Every operator-power endpoint (method, path, minimal body). The HARM assertion
// is method-agnostic: operatorAuthCheck refuses BEFORE the handler's own body /
// confirmation checks, so an empty/minimal body still 401s.
const OPERATOR_ENDPOINTS: Array<{ method: "GET" | "POST"; path: string; body: Record<string, unknown> | null }> = [
  { method: "POST", path: "/api/kill-agent", body: { name: "victim" } },
  { method: "POST", path: "/api/wake-agent", body: { agent_name: "victim" } },
  { method: "POST", path: "/api/focus-terminal", body: { agent_name: "victim" } },
  { method: "POST", path: "/api/send-message", body: { from: "victim", to: "other", content: "x" } },
  { method: "POST", path: "/api/set-status", body: { agent_name: "victim", agent_status: "offline" } },
  { method: "GET", path: "/api/operator-identity", body: null },
  { method: "POST", path: "/api/operator-identity", body: { identity: "mallory" } },
  { method: "GET", path: "/api/keyring", body: null },
  { method: "POST", path: "/api/dashboard-theme", body: { mode: "catppuccin" } },
];

describe("ADR-0006 — HARM: tokenless loopback caller is refused operator power (401), no side effect", () => {
  beforeEach(async () => {
    delete process.env.RELAY_HTTP_SECRET;
    delete process.env.RELAY_DASHBOARD_SECRET; // no operator secret configured at all
    await boot();
  });

  for (const ep of OPERATOR_ENDPOINTS) {
    it(`(${ep.method} ${ep.path}) unauthenticated loopback → 401`, async () => {
      const r = await rawRequest(port, ep.method, ep.path, ep.body);
      expect(r.status, `${ep.method} ${ep.path} should refuse an unauthenticated loopback caller`).toBe(401);
      expect(JSON.stringify(r.json)).toContain("Operator authentication required");
    });
  }

  it("(side effect) an unauthenticated set-status does NOT change the status", async () => {
    registerAgent("victim", "worker", []);
    const before = agentStatus("victim");
    const r = await rawRequest(port, "POST", "/api/set-status", { agent_name: "victim", agent_status: "offline" });
    expect(r.status).toBe(401);
    expect(agentStatus("victim")).toBe(before); // refused = unchanged, not just a 401 shell
  });

  it("(recovery, no secret) the 401 says no secret is configured + run relay init — NOT a false 'existing secret'", async () => {
    // No secret is configured in this block → operatorAuthCheck's 401 is reached.
    // It must NOT claim a secret exists (P2b: a signpost whose premise is false is
    // worse than none); it must tell the operator to generate one.
    const r = await rawRequest(port, "GET", "/api/keyring", null);
    expect(r.status).toBe(401);
    expect(r.json.hint).toMatch(/no operator.*secret is configured/i);
    expect(r.json.hint).toContain("relay init");
    expect(r.json.hint).not.toContain("stored under"); // no false "existing secret" claim
  });

  it("(side effect) an unauthenticated kill-agent does NOT remove the row", async () => {
    registerAgent("victim", "worker", []);
    expect(agentExists("victim")).toBe(true);
    const r = await rawRequest(port, "POST", "/api/kill-agent", { name: "victim" }, { "X-Relay-Confirm": "yes" });
    expect(r.status).toBe(401);
    expect(agentExists("victim")).toBe(true); // the corpse-making harm did not happen
  });
});

describe("ADR-0006 — ESCALATION REMOVED: the http_secret (agent transport credential) is NOT operator auth", () => {
  const HTTP_SECRET = "agent-transport-http-secret-abcdefghijklmnop"; // >= 32
  beforeEach(async () => {
    process.env.RELAY_HTTP_SECRET = HTTP_SECRET; // captured into config.http_secret at boot
    delete process.env.RELAY_DASHBOARD_SECRET; // NO dashboard secret — only the transport one exists
    await boot();
  });

  it("presenting http_secret as Bearer to kill-agent → 401 (the removed fallback stays removed)", async () => {
    registerAgent("victim", "worker", []);
    const r = await rawRequest(
      port,
      "POST",
      "/api/kill-agent",
      { name: "victim" },
      { Authorization: `Bearer ${HTTP_SECRET}`, "X-Relay-Confirm": "yes" },
    );
    // Before PR B the `|| config.http_secret` fallback made this a 200 kill.
    expect(r.status).toBe(401);
    expect(agentExists("victim")).toBe(true);
  });

  it("presenting http_secret as Bearer to GET /api/keyring → 401", async () => {
    const r = await rawRequest(port, "GET", "/api/keyring", null, { Authorization: `Bearer ${HTTP_SECRET}` });
    expect(r.status).toBe(401);
  });
});

describe("ADR-0006 — INNOCENT TWIN: an authenticated operator performs the same actions", () => {
  beforeEach(async () => {
    delete process.env.RELAY_HTTP_SECRET;
    process.env.RELAY_DASHBOARD_SECRET = OPERATOR_SECRET; // read live by the resolver
    await boot();
  });

  it("authed set-status succeeds AND changes the status", async () => {
    registerAgent("victim", "worker", []);
    const r = await operatorPost(port, "/api/set-status", { agent_name: "victim", agent_status: "working" });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(agentStatus("victim")).toBe("working");
  });

  it("authed kill-agent succeeds AND removes the row", async () => {
    registerAgent("victim", "worker", []);
    const r = await operatorPost(port, "/api/kill-agent", { name: "victim" }, { extraHeaders: { "X-Relay-Confirm": "yes" } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(agentExists("victim")).toBe(false);
  });

  it("authed GET /api/keyring and /api/operator-identity succeed", async () => {
    const k = await operatorGet(port, "/api/keyring");
    expect(k.status).toBe(200);
    const o = await operatorGet(port, "/api/operator-identity");
    expect(o.status).toBe(200);
  });

  it("(recovery, secret configured) a no-credential request gets the REACHABLE signpost naming where the secret lives", async () => {
    // A secret IS configured here, so dashboardAuthCheck 401s FIRST (before
    // operatorAuthCheck ever runs) — and ITS hint is the reachable recovery path,
    // naming the field + the config file. This is the case the signpost is FOR.
    const r = await rawRequest(port, "GET", "/api/keyring", null);
    expect(r.status).toBe(401);
    expect(r.json.hint).toContain("dashboard_secret");
    expect(r.json.hint).toContain("config.json");
  });

  it("a WRONG bearer is refused at the auth gate even from loopback (secret set, no bypass)", async () => {
    // GET isolates the auth gate (safe method → no CSRF). Wrong secret → 401.
    const r = await operatorGet(port, "/api/keyring", { secret: "wrong-secret" });
    expect(r.status).toBe(401);
  });

  it("a wrong-bearer POST changes nothing (refused before the handler; CSRF or auth)", async () => {
    registerAgent("victim", "worker", []);
    const r = await rawRequest(
      port,
      "POST",
      "/api/set-status",
      { agent_name: "victim", agent_status: "offline" },
      { Authorization: "Bearer wrong-secret" },
    );
    expect([401, 403]).toContain(r.status); // csrfCheck (403) or operatorAuthCheck (401) — either refuses
    expect(agentStatus("victim")).not.toBe("offline"); // the side effect did not happen
  });
});
