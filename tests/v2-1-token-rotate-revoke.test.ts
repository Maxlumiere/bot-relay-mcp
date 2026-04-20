// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 4b.1 — rotate_token + revoke_token MCP tools.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import type { Server as HttpServer } from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-token-rotate-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
// v2.1.3 I8: scrub inherited RELAY_AGENT_* env vars so isolated tests
// do not auth against a parent-shell spawn-agent.sh token.
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
delete process.env.RELAY_ALLOW_LEGACY;

const { startHttpServer } = await import("../src/transport/http.js");
const { closeDb, getDb, rotateAgentToken, getAgentAuthData } = await import("../src/db.js");
const { ERROR_CODES } = await import("../src/error-codes.js");

let server: HttpServer;
let baseUrl: string;

async function rpc(tool: string, args: any): Promise<any> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  const rpcResp = dataLine ? JSON.parse(dataLine.slice(5).trim()) : JSON.parse(text);
  return JSON.parse(rpcResp.result.content[0].text);
}

async function register(name: string, caps: string[] = []): Promise<string> {
  const r = await rpc("register_agent", { name, role: "r", capabilities: caps });
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
  server = startHttpServer(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 80));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});
afterEach(cleanup);

describe("v2.1 Phase 4b.1 — rotate_token + revoke_token", () => {
  it("(1) rotate_token with correct current token issues fresh token; old token no longer works", async () => {
    const oldTok = await register("rot-a", []);
    const rotate = await rpc("rotate_token", { agent_name: "rot-a", agent_token: oldTok });
    expect(rotate.success).toBe(true);
    expect(rotate.new_token).toBeTruthy();
    expect(rotate.new_token).not.toBe(oldTok);

    // Old token on a subsequent call → AUTH_FAILED.
    const sendWithOld = await rpc("send_message", {
      from: "rot-a",
      to: "rot-a",
      content: "x",
      agent_token: oldTok,
    });
    expect(sendWithOld.success).toBe(false);
    expect(sendWithOld.error_code).toBe(ERROR_CODES.AUTH_FAILED);

    // New token works.
    await register("rot-self-recipient", []);
    const sendWithNew = await rpc("send_message", {
      from: "rot-a",
      to: "rot-self-recipient",
      content: "x",
      agent_token: rotate.new_token,
    });
    expect(sendWithNew.success).toBe(true);
  });

  it("(2) rotate_token with wrong token → AUTH_FAILED, token unchanged", async () => {
    const goodTok = await register("rot-b", []);
    const r = await rpc("rotate_token", { agent_name: "rot-b", agent_token: "wrong-token-xxx" });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe(ERROR_CODES.AUTH_FAILED);
    // Original token still works.
    await register("rot-b-peer", []);
    const check = await rpc("send_message", {
      from: "rot-b",
      to: "rot-b-peer",
      content: "still works",
      agent_token: goodTok,
    });
    expect(check.success).toBe(true);
  });

  it("(3) rotate concurrent race: second attempt fails with CONCURRENT_UPDATE", async () => {
    await register("rot-c", []);
    // Read the CURRENT hash from the DB directly so we can call the helper
    // twice against the same expected hash — exercises the CAS miss.
    const existing = getAgentAuthData("rot-c")!;
    const oldHash = existing.token_hash!;
    // First rotate succeeds.
    const first = rotateAgentToken("rot-c", oldHash);
    expect(first.newPlaintextToken).toBeTruthy();
    // Second rotate with the stale expected-hash → CAS miss → throw.
    expect(() => rotateAgentToken("rot-c", oldHash)).toThrow(/token_hash changed|concurrent/i);
  });

  it("(4) revoke_token from admin transitions target to recovery_pending; v2.1 Phase 4b.1 v2 preserves token_hash post-revoke", async () => {
    const adminTok = await register("rot-admin", ["admin"]);
    const targetTok = await register("rot-victim", []);
    const preHash = getAgentAuthData("rot-victim")?.token_hash;
    expect(preHash).toBeTruthy();

    const r = await rpc("revoke_token", {
      target_agent_name: "rot-victim",
      revoker_name: "rot-admin",
      agent_token: adminTok,
    });
    expect(r.success).toBe(true);
    expect(r.revoked).toBe("rot-victim");
    // v2.1 Phase 4b.1 v2: token_hash is PRESERVED post-revoke (forensic
    // integrity + CAS contract). State flips instead. Issue_recovery defaults
    // to true, so state → recovery_pending + a recovery_token is minted.
    const post = getAgentAuthData("rot-victim");
    expect(post?.token_hash).toBe(preHash);
    expect(post?.auth_state).toBe("recovery_pending");
    expect(r.recovery_token).toBeTruthy();

    // Victim's old token no longer works (state rejects, even though hash
    // still matches — resolveCallerByToken skips non-active rows).
    await register("rot-bystander", []);
    const sendWithOld = await rpc("send_message", {
      from: "rot-victim",
      to: "rot-bystander",
      content: "x",
      agent_token: targetTok,
    });
    expect(sendWithOld.success).toBe(false);
  });

  it("(5) revoke_token from non-admin agent → CAP_DENIED, target untouched", async () => {
    const plainTok = await register("rot-plain", []); // no admin cap
    await register("rot-would-victim", []);
    const preHash = getAgentAuthData("rot-would-victim")?.token_hash;
    expect(preHash).toBeTruthy();

    const r = await rpc("revoke_token", {
      target_agent_name: "rot-would-victim",
      revoker_name: "rot-plain",
      agent_token: plainTok,
    });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe(ERROR_CODES.CAP_DENIED);
    expect(getAgentAuthData("rot-would-victim")?.token_hash).toBe(preHash);
  });

  it("(6) revoke_token of non-existent target → NOT_FOUND", async () => {
    const adminTok = await register("rot-admin-6", ["admin"]);
    const r = await rpc("revoke_token", {
      target_agent_name: "ghost-agent",
      revoker_name: "rot-admin-6",
      agent_token: adminTok,
    });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe(ERROR_CODES.NOT_FOUND);
  });

  it("(7) v2.1 Phase 4b.1 v2: revoked target re-bootstraps via register_agent WITH recovery_token (not silent migration anymore)", async () => {
    const adminTok = await register("rot-admin-7", ["admin"]);
    await register("rot-victim-7", ["broadcast"]); // carry a cap for post-rebootstrap verification

    const revoke = await rpc("revoke_token", {
      target_agent_name: "rot-victim-7",
      revoker_name: "rot-admin-7",
      agent_token: adminTok,
    });
    expect(revoke.recovery_token).toBeTruthy();
    // token_hash preserved, state flipped — the v2.1 Phase 4b.1 v2 contract
    // closes HIGH D (post-revoke unauthenticated name-race).
    expect(getAgentAuthData("rot-victim-7")?.auth_state).toBe("recovery_pending");

    // Plain register_agent (no recovery_token) → rejected by dispatcher.
    const naive = await rpc("register_agent", {
      name: "rot-victim-7",
      role: "r",
      capabilities: ["broadcast"],
    });
    expect(naive.success).toBe(false);

    // Register with the recovery_token → transitions to active, mints a
    // fresh token, clears recovery_token_hash.
    const reboot = await rpc("register_agent", {
      name: "rot-victim-7",
      role: "r",
      capabilities: ["broadcast"],
      recovery_token: revoke.recovery_token,
    });
    expect(reboot.success).toBe(true);
    expect(reboot.agent_token).toBeTruthy();
    expect(reboot.recovery_completed).toBe(true);

    // Fresh token works against a cap-gated tool (broadcast was preserved
    // per v1.7.1 capability-immutability).
    const b = await rpc("broadcast", {
      from: "rot-victim-7",
      content: "back online",
      agent_token: reboot.agent_token,
    });
    expect(b.success).toBe(true);
  });

  it("(8) audit log records rotate + revoke with revoker on the revoke entry", async () => {
    const adminTok = await register("rot-admin-8", ["admin"]);
    const targetTok = await register("rot-target-8", []);
    // rotate
    await rpc("rotate_token", { agent_name: "rot-target-8", agent_token: targetTok });
    // revoke
    await rpc("revoke_token", {
      target_agent_name: "rot-target-8",
      revoker_name: "rot-admin-8",
      agent_token: adminTok,
    });

    const rotateRows = getDb()
      .prepare("SELECT * FROM audit_log WHERE tool = 'rotate_token' ORDER BY created_at DESC")
      .all() as Array<{ agent_name: string | null; tool: string }>;
    // Filter to the HANDLER-level audit entry (distinguished by params_summary
    // starting with "target="). The dispatcher also writes its own audit row
    // per call (agent_name=null because agentFromArgs doesn't recognize
    // revoke_token's field names) — we don't want to match that one.
    const revokeRows = getDb()
      .prepare("SELECT * FROM audit_log WHERE tool = 'revoke_token' AND params_summary LIKE 'target=%' ORDER BY created_at DESC")
      .all() as Array<{ agent_name: string | null; tool: string; params_summary: string | null }>;

    expect(rotateRows.length).toBeGreaterThanOrEqual(1);
    expect(revokeRows.length).toBeGreaterThanOrEqual(1);
    // Revoker is the logged agent on the handler-level revoke entry.
    const handlerRevoke = revokeRows[0];
    expect(handlerRevoke.agent_name).toBe("rot-admin-8");
    expect(handlerRevoke.params_summary).toContain("rot-target-8");
  });
});
