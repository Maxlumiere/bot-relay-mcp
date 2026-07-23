// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0005 (v2.22.0) — orphan-GC keystone, proven against the REAL auth paths.
 *
 * victra's pre-ship catch (2026-07-22): the orphan-GC safety rests entirely on
 * "authed ≥1x ⇒ first_authed_at IS NOT NULL ⇒ never reaped." If the marker is
 * NOT stamped on the path orchestrators actually use — the EXPLICIT-CALLER path
 * (send_message.from / get_messages.agent_name, verified via
 * explicitCallerCachePut, NOT resolveAgentByToken) — then a live agent reads
 * first_authed_at IS NULL, the keystone collapses to `session_id IS NULL`
 * alone, and a live-but-session-less agent is reaped as a false orphan.
 *
 * The existing DX suite drove auth via resolveAgentByToken (the IMPLICIT path).
 * This file drives the SHIPPED HTTP server end-to-end through enforceAuth's
 * explicit-caller branch and asserts the marker is stamped there, then proves
 * the GC can never reap such an agent. It audits the REAL stamping behavior,
 * not the assumed one.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import type { Server as HttpServer } from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-2220-gcstamp-" + process.pid);
process.env.RELAY_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
delete process.env.RELAY_ALLOW_LEGACY;

const { startHttpServer } = await import("../src/transport/http.js");
const { closeDb, getDb, getAgentAuthData, gcOrphanRegistrations } = await import("../src/db.js");

let server: HttpServer;
let baseUrl: string;

async function mcpCall(method: string, params: any, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  // ADR-0005 #3: one-shot POSTs return plain JSON; older SSE framing still handled.
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse(dataLine ? dataLine.slice(5).trim() : text);
}

async function register(name: string): Promise<string> {
  const resp = await mcpCall("tools/call", {
    name: "register_agent",
    arguments: { name, role: "worker", capabilities: [] },
  });
  return JSON.parse(resp.result.content[0].text).agent_token as string;
}

/** Force a row into the "orphan-shaped" state the GC scans for. */
function makeSessionlessAndOld(name: string): void {
  const old = new Date(Date.now() - 3600_000).toISOString(); // 1h > 30min TTL
  getDb().prepare("UPDATE agents SET session_id = NULL, created_at = ? WHERE name = ?").run(old, name);
}

beforeAll(async () => {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  server = startHttpServer(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 120));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(() => {
  try { server?.close(); } catch { /* ignore */ }
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

describe("ADR-0005 — the orphan-GC keystone holds on the REAL explicit-caller path", () => {
  it("send_message (explicit-caller auth) STAMPS first_authed_at — the orchestrator path victra uses", async () => {
    const token = await register("gc-orch");
    await register("gc-rcpt");
    // Fresh registration is an orphan: never authenticated.
    expect(getAgentAuthData("gc-orch")!.first_authed_at).toBeNull();

    // Authenticate via the EXPLICIT-CALLER path (from + from_agent_token → enforceAuth
    // explicit branch → authenticateAgent → explicitCallerCachePut → markAgentAuthenticated).
    const send = await mcpCall("tools/call", {
      name: "send_message",
      arguments: { from: "gc-orch", to: "gc-rcpt", content: "keystone probe", agent_token: token },
    });
    expect(JSON.parse(send.result.content[0].text).success).toBe(true);

    // The marker MUST now be set — this is the whole safety argument.
    expect(getAgentAuthData("gc-orch")!.first_authed_at).not.toBeNull();
  });

  it("get_messages (explicit-caller auth) ALSO stamps first_authed_at", async () => {
    const token = await register("gc-reader");
    expect(getAgentAuthData("gc-reader")!.first_authed_at).toBeNull();
    const read = await mcpCall("tools/call", {
      name: "get_messages",
      arguments: { agent_name: "gc-reader", agent_token: token },
    });
    expect(read.result).toBeTruthy();
    expect(getAgentAuthData("gc-reader")!.first_authed_at).not.toBeNull();
  });

  it("a fully-authed agent is NEVER reaped by the orphan-GC — even session-less + old", async () => {
    // gc-orch authenticated above → first_authed_at set. Now push it into the
    // exact shape the GC scans for (session lost + older than the TTL).
    makeSessionlessAndOld("gc-orch");
    const removed = gcOrphanRegistrations(getDb());
    // It must survive: the keystone (first_authed_at NOT NULL) excludes it.
    expect(getAgentAuthData("gc-orch")).not.toBeNull();
    // Sanity: the GC didn't just no-op globally — it can still reap a TRUE orphan.
    expect(typeof removed).toBe("number");
  });

  it("CONTRAST: a never-authed orphan (session-less + old) IS reaped", async () => {
    await register("gc-true-orphan"); // registered, never authenticated
    expect(getAgentAuthData("gc-true-orphan")!.first_authed_at).toBeNull();
    makeSessionlessAndOld("gc-true-orphan");
    const removed = gcOrphanRegistrations(getDb());
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(getAgentAuthData("gc-true-orphan")).toBeNull();
  });

  it("BLOCKER a (codex #115): a force re-register that RE-AUTHENTICATES stamps first_authed_at → GC can't reap it", async () => {
    // THE critical repro. The active-row re-register re-auth exit authenticated
    // successfully but returned WITHOUT stamping (register never routes through
    // the dispatcher's cache-put) → GC reaped a live re-authed agent (got 1).
    const token = await register("reauth-a");
    expect(getAgentAuthData("reauth-a")!.first_authed_at).toBeNull();
    // FORCE re-register with the ISSUED token — codex's exact repro: a genuinely
    // successful authenticated path (enforceAuth #1) that re-registers the row.
    const reReg = await mcpCall("tools/call", {
      name: "register_agent",
      arguments: { name: "reauth-a", role: "worker", capabilities: [], agent_token: token, force: true },
    });
    expect(JSON.parse(reReg.result.content[0].text).success).toBe(true);
    // The re-auth MUST have stamped first_authed_at (this is the fix).
    expect(getAgentAuthData("reauth-a")!.first_authed_at).not.toBeNull();
    // codex's exact shape: null session + age past TTL → the agent must SURVIVE
    // the GC (without the stamp above, this row is deleted — the negative control).
    makeSessionlessAndOld("reauth-a");
    gcOrphanRegistrations(getDb());
    expect(getAgentAuthData("reauth-a")).not.toBeNull();
  });

  it("health_check with a valid token stamps first_authed_at (inventory path #4)", async () => {
    const token = await register("hc-agent");
    expect(getAgentAuthData("hc-agent")!.first_authed_at).toBeNull();
    await mcpCall("tools/call", { name: "health_check", arguments: { agent_token: token } });
    expect(getAgentAuthData("hc-agent")!.first_authed_at).not.toBeNull();
  });

  it("dashboard /api/send-message with a verified from_agent_token stamps (inventory path #5 — the `relay send` path)", async () => {
    // victra's live production case: an orchestrator that authenticates ONLY via
    // `relay send` (→ /api/send-message, path #5) had first_authed_at EMPTY on the
    // 2.20.0 daemon — so once 2.22.0 ships it would GC ITSELF the moment its
    // session nulled. This asserts the fix: an agent whose ONLY auth is #5 ends
    // up with a non-null first_authed_at.
    const token = await register("dash-from");
    await register("dash-to");
    expect(getAgentAuthData("dash-from")!.first_authed_at).toBeNull();
    const res = await fetch(`${baseUrl}/api/send-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: "dash-from", to: "dash-to", content: "hi", from_agent_token: token }),
    });
    expect(res.ok).toBe(true);
    expect(getAgentAuthData("dash-from")!.first_authed_at).not.toBeNull();
  });
});
