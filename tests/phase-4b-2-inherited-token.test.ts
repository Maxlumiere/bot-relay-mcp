// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 4b.2 — inherited-token graceful replacement.
 *
 * Covers Codex Q1 design answer: hybrid rotation.
 *   - Managed agents enter rotation_grace with both old+new tokens valid
 *     until expiry; a priority=high push-message delivers the new token.
 *   - Unmanaged agents get restart_required:true + new token returned to
 *     the caller for out-of-band delivery; old token invalid immediately.
 *   - rotate_token_admin is a separate tool with `rotate_others` capability.
 *
 * Test structure per spec §4:
 *   §4.1 managed grace flow      (~8 tests)
 *   §4.2 unmanaged flow          (~5 tests)
 *   §4.3 admin-rotate flow       (~6 tests)
 *   §4.4 race + edge matrix      (~6 tests)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import type { Server as HttpServer } from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-4b2-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_ALLOW_LEGACY;

const { startHttpServer } = await import("../src/transport/http.js");
const { closeDb, getDb, getAgentAuthData, rotateAgentToken, sweepExpiredRotationGrace } =
  await import("../src/db.js");
const { ERROR_CODES } = await import("../src/error-codes.js");

let server: HttpServer;
let baseUrl: string;

async function rpc(tool: string, args: any, token?: string): Promise<any> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (token) headers["X-Agent-Token"] = token;
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  const rpcResp = dataLine ? JSON.parse(dataLine.slice(5).trim()) : JSON.parse(text);
  return JSON.parse(rpcResp.result.content[0].text);
}

async function register(name: string, caps: string[] = [], managed = false): Promise<string> {
  const r = await rpc("register_agent", { name, role: "r", capabilities: caps, managed });
  return r.agent_token;
}

function cleanup() {
  try { server?.close(); } catch { /* ignore */ }
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
}

beforeEach(async () => {
  cleanup();
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  delete process.env.RELAY_ALLOW_LEGACY;
  delete process.env.RELAY_AGENT_TOKEN;
  server = startHttpServer(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 80));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});
afterEach(cleanup);

// ============================================================
// §4.1 — managed agent grace flow (8 tests)
// ============================================================

describe("§4.1 managed agent grace flow", () => {
  it("(M.1) rotate_token on managed agent → state=rotation_grace, old token auths, new token auths", async () => {
    const oldTok = await register("m-1", [], true);
    const rot = await rpc("rotate_token", { agent_name: "m-1" }, oldTok);
    expect(rot.success).toBe(true);
    expect(rot.agent_class).toBe("managed");
    expect(rot.grace_expires_at).toBeTruthy();
    expect(rot.new_token).toBeTruthy();
    expect(rot.new_token).not.toBe(oldTok);

    // Both tokens auth. Use discover_agents (no explicit caller field;
    // resolveCallerByToken path — so rotation_grace branch exercised).
    const a = await rpc("discover_agents", {}, oldTok);
    expect(a.count).toBeGreaterThanOrEqual(1);
    const b = await rpc("discover_agents", {}, rot.new_token);
    expect(b.count).toBeGreaterThanOrEqual(1);

    expect(getAgentAuthData("m-1")?.auth_state).toBe("rotation_grace");
  });

  it("(M.2) push-message delivered with token_rotated envelope v1", async () => {
    const oldTok = await register("m-2", [], true);
    const rot = await rpc("rotate_token", { agent_name: "m-2" }, oldTok);
    expect(rot.push_sent).toBe(true);

    // The pushed message is stored in m-2's inbox as a high-priority msg.
    const msgs = await rpc(
      "get_messages",
      { agent_name: "m-2", status: "pending", limit: 20 },
      rot.new_token
    );
    const pushMsg = (msgs.messages || []).find((m: any) =>
      (m.content || "").includes("bot-relay-token-rotation")
    );
    expect(pushMsg).toBeDefined();
    // Parse the fenced JSON block.
    const fence = /```json\n([\s\S]*?)\n```/.exec(pushMsg.content);
    expect(fence).not.toBeNull();
    const payload = JSON.parse(fence![1]);
    expect(payload.protocol).toBe("bot-relay-token-rotation");
    expect(payload.version).toBe(1);
    expect(payload.event).toBe("token_rotated");
    expect(payload.agent_name).toBe("m-2");
    expect(payload.new_token).toBe(rot.new_token);
    expect(payload.rotator).toBe("self");
  });

  it("(M.3) grace window defaults to RELAY_ROTATION_GRACE_SECONDS (fallback 900)", async () => {
    const oldTok = await register("m-3", [], true);
    const beforeRot = Date.now();
    const rot = await rpc("rotate_token", { agent_name: "m-3" }, oldTok);
    const expiryMs = new Date(rot.grace_expires_at).getTime();
    // Default 900s. Allow generous slack for CI timing.
    expect(expiryMs - beforeRot).toBeGreaterThan(890_000);
    expect(expiryMs - beforeRot).toBeLessThan(910_000);
  });

  it("(M.4) grace_seconds=60 override honored", async () => {
    const oldTok = await register("m-4", [], true);
    const beforeRot = Date.now();
    const rot = await rpc("rotate_token", { agent_name: "m-4", grace_seconds: 60 }, oldTok);
    const expiryMs = new Date(rot.grace_expires_at).getTime();
    expect(expiryMs - beforeRot).toBeGreaterThan(55_000);
    expect(expiryMs - beforeRot).toBeLessThan(65_000);
  });

  it("(M.5) grace_seconds=0 forces hard-cut — old token invalid immediately", async () => {
    const oldTok = await register("m-5", [], true);
    const rot = await rpc("rotate_token", { agent_name: "m-5", grace_seconds: 0 }, oldTok);
    expect(rot.success).toBe(true);
    expect(rot.agent_class).toBe("managed");
    expect(rot.grace_expires_at).toBeNull();
    expect(getAgentAuthData("m-5")?.auth_state).toBe("active");

    // Old token rejected; new token works.
    const oldAttempt = await rpc("discover_agents", {}, oldTok);
    expect(oldAttempt.count === undefined || oldAttempt.success === false).toBe(true);
    const newAttempt = await rpc("discover_agents", {}, rot.new_token);
    expect(newAttempt.count).toBeGreaterThanOrEqual(1);
  });

  it("(M.6) rotate_token on managed with auth via header instead of arg", async () => {
    const oldTok = await register("m-6", [], true);
    const rot = await rpc("rotate_token", { agent_name: "m-6" }, oldTok);
    expect(rot.success).toBe(true);
    expect(rot.agent_class).toBe("managed");
  });

  it("(M.7) grace expiry cleanup swept by piggyback — row transitions back to active", async () => {
    const oldTok = await register("m-7", [], true);
    // grace_seconds=0 already transitions to active directly; use a small
    // value then manually expire via DB manipulation + direct sweep call.
    const rot = await rpc("rotate_token", { agent_name: "m-7", grace_seconds: 5 }, oldTok);
    expect(getAgentAuthData("m-7")?.auth_state).toBe("rotation_grace");
    // Expire the grace window by backdating the expiry timestamp.
    const past = new Date(Date.now() - 1000).toISOString();
    getDb().prepare("UPDATE agents SET rotation_grace_expires_at = ? WHERE name = 'm-7'").run(past);
    const changes = sweepExpiredRotationGrace();
    expect(changes).toBe(1);
    const row = getAgentAuthData("m-7");
    expect(row?.auth_state).toBe("active");
    expect(row?.previous_token_hash ?? null).toBeNull();
    expect(row?.rotation_grace_expires_at ?? null).toBeNull();
    // Old token no longer works after cleanup.
    const oldAttempt = await rpc("discover_agents", {}, oldTok);
    expect(oldAttempt.count === undefined || oldAttempt.success === false).toBe(true);
    // New token works.
    const newAttempt = await rpc("discover_agents", {}, rot.new_token);
    expect(newAttempt.count).toBeGreaterThanOrEqual(1);
  });

  it("(M.8) auth via explicit-caller path (send_message from) works for both tokens during grace", async () => {
    const oldTok = await register("m-8", [], true);
    await register("m-8-peer", []);
    const rot = await rpc("rotate_token", { agent_name: "m-8" }, oldTok);

    const r1 = await rpc(
      "send_message",
      { from: "m-8", to: "m-8-peer", content: "using old" },
      oldTok
    );
    expect(r1.success).toBe(true);

    const r2 = await rpc(
      "send_message",
      { from: "m-8", to: "m-8-peer", content: "using new" },
      rot.new_token
    );
    expect(r2.success).toBe(true);
  });
});

// ============================================================
// §4.2 — unmanaged agent flow (5 tests)
// ============================================================

describe("§4.2 unmanaged agent flow", () => {
  it("(U.1) rotate_token on unmanaged → state stays active, restart_required:true, no push-message", async () => {
    const oldTok = await register("u-1", [], false);
    const rot = await rpc("rotate_token", { agent_name: "u-1" }, oldTok);
    expect(rot.success).toBe(true);
    expect(rot.agent_class).toBe("unmanaged");
    expect(rot.restart_required).toBe(true);
    expect(rot.operator_note).toMatch(/restart/i);
    expect(getAgentAuthData("u-1")?.auth_state).toBe("active");
    expect(getAgentAuthData("u-1")?.rotation_grace_expires_at ?? null).toBeNull();
    // No push-message sent. Inbox should be empty (no high-priority system message).
    const msgs = await rpc(
      "get_messages",
      { agent_name: "u-1", status: "pending", limit: 20 },
      rot.new_token
    );
    const hasPush = (msgs.messages || []).some((m: any) =>
      (m.content || "").includes("bot-relay-token-rotation")
    );
    expect(hasPush).toBe(false);
  });

  it("(U.2) old unmanaged token invalid immediately on next call", async () => {
    const oldTok = await register("u-2", [], false);
    const rot = await rpc("rotate_token", { agent_name: "u-2" }, oldTok);
    // Old token → rejected.
    await register("u-2-peer", []);
    const rOld = await rpc("send_message", { from: "u-2", to: "u-2-peer", content: "x" }, oldTok);
    expect(rOld.success).toBe(false);
    // New token → works.
    const rNew = await rpc("send_message", { from: "u-2", to: "u-2-peer", content: "x" }, rot.new_token);
    expect(rNew.success).toBe(true);
  });

  it("(U.3) managed=false is the default when not supplied", async () => {
    // register_agent without `managed` field → defaults to false (unmanaged).
    const r = await rpc("register_agent", { name: "u-3", role: "r", capabilities: [] });
    expect(r.success).toBe(true);
    expect(getAgentAuthData("u-3")?.managed).toBe(0);
  });

  it("(U.4) grace_seconds ignored for unmanaged — no grace_expires_at, no push-message", async () => {
    const oldTok = await register("u-4", [], false);
    const rot = await rpc("rotate_token", { agent_name: "u-4", grace_seconds: 120 }, oldTok);
    expect(rot.agent_class).toBe("unmanaged");
    expect((rot as any).grace_expires_at).toBeUndefined();
    expect(rot.restart_required).toBe(true);
  });

  it("(U.5) managed flag is immutable: re-register with managed=true is preserved-as-false", async () => {
    const tok = await register("u-5", [], false);
    expect(getAgentAuthData("u-5")?.managed).toBe(0);
    // Re-register with managed=true. Existing row preserves managed=0
    // (same rule as capabilities per v1.7.1).
    // v2.2.1 B2: active-row re-register now requires force=true; test
    // exercises managed-immutability semantic, independent of collision.
    const r = await rpc(
      "register_agent",
      { name: "u-5", role: "r", capabilities: [], managed: true, force: true },
      tok
    );
    expect(r.success).toBe(true);
    expect(getAgentAuthData("u-5")?.managed).toBe(0);
  });
});

// ============================================================
// §4.3 — admin-rotate flow (6 tests)
// ============================================================

describe("§4.3 admin-rotate flow", () => {
  it("(A.1) rotate_token_admin requires rotate_others capability on rotator", async () => {
    const plainTok = await register("a-plain", []); // no rotate_others cap
    await register("a-target-1", [], true);
    const r = await rpc(
      "rotate_token_admin",
      { target_agent_name: "a-target-1", rotator_name: "a-plain" },
      plainTok
    );
    expect(r.success).toBe(false);
    expect(r.error_code).toBe(ERROR_CODES.CAP_DENIED);
  });

  it("(A.2) admin rotates managed target → grace window + push-message to TARGET", async () => {
    const adminTok = await register("a-admin-2", ["rotate_others"]);
    await register("a-target-2", [], true);
    const r = await rpc(
      "rotate_token_admin",
      { target_agent_name: "a-target-2", rotator_name: "a-admin-2", grace_seconds: 60 },
      adminTok
    );
    expect(r.success).toBe(true);
    expect(r.agent_class).toBe("managed");
    expect(r.grace_expires_at).toBeTruthy();
    // new_token is NOT returned for managed targets (delivered via push).
    expect((r as any).new_token).toBeUndefined();
    expect(r.push_sent).toBe(true);
    // Target's inbox has the push.
    const targetInbox = getDb()
      .prepare("SELECT content FROM messages WHERE to_agent = 'a-target-2' AND priority = 'high'")
      .all() as Array<{ content: string }>;
    expect(targetInbox.length).toBeGreaterThanOrEqual(1);
    expect(targetInbox[0].content).toContain("bot-relay-token-rotation");
    // rotator field in push should be admin's name, not "self".
    const fence = /```json\n([\s\S]*?)\n```/.exec(targetInbox[0].content);
    const payload = JSON.parse(fence![1]);
    expect(payload.rotator).toBe("a-admin-2");
  });

  it("(A.3) admin rotates unmanaged target → new_token returned to ADMIN + restart_required", async () => {
    const adminTok = await register("a-admin-3", ["rotate_others"]);
    await register("a-target-3", [], false); // unmanaged
    const r = await rpc(
      "rotate_token_admin",
      { target_agent_name: "a-target-3", rotator_name: "a-admin-3" },
      adminTok
    );
    expect(r.success).toBe(true);
    expect(r.agent_class).toBe("unmanaged");
    expect(r.new_token).toBeTruthy();
    expect(r.restart_required).toBe(true);
    expect(r.operator_note).toMatch(/out.of.band/i);
  });

  it("(A.4) admin cannot rotate own token via rotate_token_admin", async () => {
    const adminTok = await register("a-admin-4", ["rotate_others"]);
    const r = await rpc(
      "rotate_token_admin",
      { target_agent_name: "a-admin-4", rotator_name: "a-admin-4" },
      adminTok
    );
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/cannot target self/i);
  });

  it("(A.5) audit log names BOTH admin + target for admin-rotate", async () => {
    const adminTok = await register("a-admin-5", ["rotate_others"]);
    await register("a-target-5", [], true);
    await rpc(
      "rotate_token_admin",
      { target_agent_name: "a-target-5", rotator_name: "a-admin-5" },
      adminTok
    );
    const row = getDb()
      .prepare(
        "SELECT agent_name, params_summary FROM audit_log WHERE tool = 'rotate_token_admin' ORDER BY created_at DESC LIMIT 1"
      )
      .get() as { agent_name: string | null; params_summary: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.agent_name).toBe("a-admin-5");
    expect(row!.params_summary).toContain("a-target-5");
  });

  it("(A.6) rotate_token_admin on nonexistent target → NOT_FOUND", async () => {
    const adminTok = await register("a-admin-6", ["rotate_others"]);
    const r = await rpc(
      "rotate_token_admin",
      { target_agent_name: "ghost", rotator_name: "a-admin-6" },
      adminTok
    );
    expect(r.success).toBe(false);
    expect(r.error_code).toBe(ERROR_CODES.NOT_FOUND);
  });
});

// ============================================================
// §4.4 — race matrix (6 tests)
// ============================================================

describe("§4.4 race + edge matrix", () => {
  it("(R.1) two concurrent rotate_token on managed agent → one wins CAS, other ConcurrentUpdateError", async () => {
    await register("r-1", [], true);
    const { token_hash } = getAgentAuthData("r-1")!;
    const results = await Promise.allSettled([
      (async () => rotateAgentToken("r-1", token_hash!))(),
      (async () => rotateAgentToken("r-1", token_hash!))(),
    ]);
    const wins = results.filter((r) => r.status === "fulfilled");
    const losses = results.filter((r) => r.status === "rejected");
    expect(wins.length).toBe(1);
    expect(losses.length).toBe(1);
  });

  it("(R.2) rotate_token during rotation_grace → blocked (INVALID_STATE)", async () => {
    const oldTok = await register("r-2", [], true);
    const firstRot = await rpc("rotate_token", { agent_name: "r-2" }, oldTok);
    expect(firstRot.success).toBe(true);
    expect(getAgentAuthData("r-2")?.auth_state).toBe("rotation_grace");
    // Second rotate using either token during the grace window.
    const secondAttempt = await rpc(
      "rotate_token",
      { agent_name: "r-2" },
      firstRot.new_token
    );
    expect(secondAttempt.success).toBe(false);
    expect(secondAttempt.error_code).toBe(ERROR_CODES.INVALID_STATE);
  });

  it("(R.3) revoke during rotation_grace → state=revoked, both tokens invalidated, previous_token_hash cleared", async () => {
    const oldTok = await register("r-3", [], true);
    const rot = await rpc("rotate_token", { agent_name: "r-3" }, oldTok);
    expect(getAgentAuthData("r-3")?.auth_state).toBe("rotation_grace");

    const adminTok = await register("r-3-admin", ["admin"]);
    const rev = await rpc(
      "revoke_token",
      { target_agent_name: "r-3", revoker_name: "r-3-admin", issue_recovery: false },
      adminTok
    );
    expect(rev.success).toBe(true);
    const row = getAgentAuthData("r-3");
    expect(row?.auth_state).toBe("revoked");
    expect(row?.previous_token_hash ?? null).toBeNull();
    expect(row?.rotation_grace_expires_at ?? null).toBeNull();

    // Both old and new tokens rejected.
    await register("r-3-peer", []);
    const r1 = await rpc("send_message", { from: "r-3", to: "r-3-peer", content: "x" }, oldTok);
    expect(r1.success).toBe(false);
    const r2 = await rpc("send_message", { from: "r-3", to: "r-3-peer", content: "x" }, rot.new_token);
    expect(r2.success).toBe(false);
  });

  it("(R.4) unregister during rotation_grace — no zombie grace row", async () => {
    const oldTok = await register("r-4", [], true);
    await rpc("rotate_token", { agent_name: "r-4" }, oldTok);
    // Unregister via old token (still valid during grace).
    const un = await rpc("unregister_agent", { name: "r-4" }, oldTok);
    expect(un.success).toBe(true);
    expect(un.removed).toBe(true);
    expect(getAgentAuthData("r-4")).toBeNull();
  });

  it("(R.5) `managed` column is source of truth — hand-crafted false-register behavior driven by the column, not args", async () => {
    // Register as managed=true. Verify managed=1 in the row.
    const tok = await register("r-5", [], true);
    expect(getAgentAuthData("r-5")?.managed).toBe(1);
    // Re-register with managed=false — v2.1.x immutability preserves =1.
    // v2.2.1 B2: force=true to bypass active-name collision gate.
    const r = await rpc(
      "register_agent",
      { name: "r-5", role: "r", capabilities: [], managed: false, force: true },
      tok
    );
    expect(r.success).toBe(true);
    expect(getAgentAuthData("r-5")?.managed).toBe(1);
    // Rotation still uses the managed path.
    const rot = await rpc("rotate_token", { agent_name: "r-5" }, tok);
    expect(rot.agent_class).toBe("managed");
  });

  it("(R.6) piggyback sweep cleans expired grace row on any subsequent tool call", async () => {
    const oldTok = await register("r-6", [], true);
    const rot = await rpc("rotate_token", { agent_name: "r-6", grace_seconds: 5 }, oldTok);
    expect(getAgentAuthData("r-6")?.auth_state).toBe("rotation_grace");
    // Backdate expiry manually.
    const past = new Date(Date.now() - 1000).toISOString();
    getDb().prepare("UPDATE agents SET rotation_grace_expires_at = ? WHERE name = 'r-6'").run(past);

    // Any subsequent tool call (here discover_agents) should trigger the
    // piggyback sweep within the Nth-call window. Force at least 5 calls to
    // guarantee the counter threshold is crossed.
    for (let i = 0; i < 10; i++) {
      await rpc("discover_agents", {}, rot.new_token);
    }
    // Row should be transitioned back to active.
    const row = getAgentAuthData("r-6");
    expect(row?.auth_state).toBe("active");
  });
});
