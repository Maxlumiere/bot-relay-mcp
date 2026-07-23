// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0005 lifecycle refinement — the establishment-invariant checklist (codex #115).
 *
 * THE MODEL (for async architect review — ADR-0005's domain): a row is ESTABLISHED
 * the moment the system committed a USABLE CREDENTIAL to a party it LAUNCHED, or
 * that PROVED ownership. A bare register stays PROVISIONAL until first auth — its
 * token was returned but nobody has shown they hold it. The orphan-GC reaps
 * `established_at IS NULL` + session-less + old, so establishment must be recorded
 * at each such event.
 *
 * The seven establishment paths (identity becomes real):
 *   proved-ownership (token auth) — #1 register active-row re-register (force),
 *   #2 token-only resolver, #3 explicit-caller (send_message/get_messages),
 *   #4 health_check, #5 dashboard /api/send-message (also `relay send`);
 *   credential-committed — #6 recovery completion (proved authorization via the
 *   recovery_token), #7 spawn_agent provisioning (the system wrote the child's
 *   token to the vault + launched the driver — a stronger commitment than a bare
 *   register; silence is startup, not abandonment — else we reap children we
 *   ourselves just spawned).
 *
 * HONEST CEILING — this guard is a MANUALLY ENUMERATED checklist, NOT
 * by-construction: it proves every LISTED path stamps, but it does NOT
 * auto-discover an UNLISTED path. A new establishment path is silently absent
 * until someone adds its case here (the recovery + spawn misses are why this
 * caveat is load-bearing). The negative control (break a stamp → the listed
 * checks fail) proves the listed assertions work — it CANNOT prove coverage of
 * paths nobody enumerated. `established_at` is set at N call sites with no single
 * write-chokepoint; this checklist is call-site discipline with a check attached,
 * strictly better than an implicit proxy but not a storage-layer guarantee.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import type { Server as HttpServer } from "http";

// #7 spawn: the platform driver is macOS-only on CI, so mock the dispatcher to
// report a clean launch — the establishment stamp under test lives in spawn.ts's
// provisioning success path (after vault-write + driver-launch), not the driver.
vi.mock("../src/spawn/dispatcher.js", () => ({
  spawnAgent: () => ({ ok: true, platform: "test", driverName: "mock" }),
}));

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-2220-establish-" + process.pid);
process.env.RELAY_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_ORPHAN_TTL_MINUTES;

const { startHttpServer } = await import("../src/transport/http.js");
const { closeDb, getDb, getAgentAuthData, purgeOldRecords, resolveAgentByToken } = await import("../src/db.js");
const { hashToken } = await import("../src/auth.js");
const { handleSpawnAgent } = await import("../src/tools/spawn.js");

let server: HttpServer;
let baseUrl: string;

async function mcpCall(name: string, args: any): Promise<any> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  const dl = text.split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse(dl ? dl.slice(5).trim() : text);
}
async function register(name: string): Promise<string> {
  const r = await mcpCall("register_agent", { name, role: "worker", capabilities: [] });
  return JSON.parse(r.result.content[0].text).agent_token as string;
}
const established = (n: string) => getAgentAuthData(n)?.established_at ?? null;
const firstAuthed = (n: string) => getAgentAuthData(n)?.first_authed_at ?? null;

beforeEach(async () => {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  server = startHttpServer(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 100));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterEach(() => {
  try { server?.close(); } catch { /* ignore */ }
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

describe("ADR-0005 — every identity-establishment path stamps established_at", () => {
  it("#2 token-only resolver (resolveAgentByToken) establishes", async () => {
    const token = await register("est-tokenonly");
    expect(established("est-tokenonly")).toBeNull();
    expect(resolveAgentByToken(token)).not.toBeNull();
    expect(established("est-tokenonly")).not.toBeNull();
  });

  it("#3 explicit-caller (send_message) establishes", async () => {
    const token = await register("est-send");
    await register("est-rcpt");
    expect(established("est-send")).toBeNull();
    await mcpCall("send_message", { from: "est-send", to: "est-rcpt", content: "hi", agent_token: token });
    expect(established("est-send")).not.toBeNull();
  });

  it("#4 health_check establishes", async () => {
    const token = await register("est-health");
    expect(established("est-health")).toBeNull();
    await mcpCall("health_check", { agent_token: token });
    expect(established("est-health")).not.toBeNull();
  });

  it("#5 dashboard /api/send-message (also `relay send`) establishes", async () => {
    const token = await register("est-dash");
    await register("est-dash-to");
    expect(established("est-dash")).toBeNull();
    const res = await fetch(`${baseUrl}/api/send-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: "est-dash", to: "est-dash-to", content: "hi", from_agent_token: token }),
    });
    expect(res.ok).toBe(true);
    expect(established("est-dash")).not.toBeNull();
  });

  it("#1 force re-register (token auth) establishes AND stamps first_authed_at", async () => {
    const token = await register("est-force");
    expect(established("est-force")).toBeNull();
    const r = await mcpCall("register_agent", { name: "est-force", role: "worker", capabilities: [], agent_token: token, force: true });
    expect(JSON.parse(r.result.content[0].text).success).toBe(true);
    expect(established("est-force")).not.toBeNull();
    expect(firstAuthed("est-force")).not.toBeNull(); // token auth → both
  });

  it("#6 recovery completion establishes — WITHOUT first_authed_at (recovery is not a token auth)", async () => {
    await register("est-rec");
    // issueRecovery: transition to recovery_pending with a known recovery_token.
    const RECOVERY = "recovery-secret-token-abc123456789";
    getDb().prepare("UPDATE agents SET auth_state = 'recovery_pending', recovery_token_hash = ? WHERE name = ?").run(hashToken(RECOVERY), "est-rec");
    expect(established("est-rec")).toBeNull();
    // Complete recovery via register_agent with the recovery_token.
    const r = await mcpCall("register_agent", { name: "est-rec", role: "worker", capabilities: [], recovery_token: RECOVERY });
    expect(JSON.parse(r.result.content[0].text).success).toBe(true);
    // Recovery is an ESTABLISHMENT event → established_at set; but NOT a token auth
    // → first_authed_at stays NULL (the two markers stay honest).
    expect(established("est-rec")).not.toBeNull();
    expect(firstAuthed("est-rec")).toBeNull();
  });

  it("#7 spawn_agent provisioning establishes the child (delivered vault credential + launched driver)", async () => {
    const res = await handleSpawnAgent({ name: "est-spawn", role: "worker", capabilities: [] } as any);
    expect(JSON.parse(res.content[0].text).success).toBe(true);
    // The child is a PROVISIONED live identity even before its first MCP call —
    // established, NOT a bare provisional register. (Not a token auth, so
    // first_authed_at stays NULL until the child authenticates.)
    expect(established("est-spawn")).not.toBeNull();
    expect(firstAuthed("est-spawn")).toBeNull();
  });
});

describe("ADR-0005 — codex #115 recovery blocker: exact 6-step repro (must collect 0)", () => {
  it("recovered row survives the GC after its session ends (was reaped: expected 0, got 1)", async () => {
    // 1. never-token-authed row
    await register("rec-repro");
    expect(established("rec-repro")).toBeNull();
    // 2. issueRecovery → recovery_pending  +  3. age created_at past the orphan TTL
    const RECOVERY = "recovery-secret-token-xyz987654321";
    const old = new Date(Date.now() - 3600_000).toISOString();
    getDb()
      .prepare("UPDATE agents SET auth_state = 'recovery_pending', recovery_token_hash = ?, created_at = ? WHERE name = ?")
      .run(hashToken(RECOVERY), old, "rec-repro");
    // 4. complete register_agent with the VALID recovery_token (active, fresh token,
    //    live session, first_authed_at NULL by design — but now established_at SET).
    const r = await mcpCall("register_agent", { name: "rec-repro", role: "worker", capabilities: [], recovery_token: RECOVERY });
    expect(JSON.parse(r.result.content[0].text).success).toBe(true);
    expect(established("rec-repro")).not.toBeNull();
    // 5. recovered terminal ends normally → session_id NULL
    getDb().prepare("UPDATE agents SET session_id = NULL WHERE name = ?").run("rec-repro");
    // 6. purge tick → the recovered row is a legitimate identity → NOT reaped
    //    (was: reaped by the retired GC; the tick now deletes no agent row at all)
    purgeOldRecords(getDb());
    expect(getAgentAuthData("rec-repro")).not.toBeNull();
  });

  it("spawn (path #7): a slow-starting child survives the GC (was reaped: expected 0, got 1)", async () => {
    // spawn provisions the child (register + vault-write + driver launch) then
    // marks the pre-reg session OFFLINE → a sessionless row with a delivered,
    // usable credential. Before the fix established_at was NULL, so a child that
    // hadn't yet made its first MCP call (slow startup) + aged past the TTL got
    // GC'd — deleting an agent we just spawned.
    const res = await handleSpawnAgent({ name: "spawn-repro", role: "worker", capabilities: [] } as any);
    expect(JSON.parse(res.content[0].text).success).toBe(true);
    getDb().prepare("UPDATE agents SET session_id = NULL, created_at = ? WHERE name = ?").run(new Date(Date.now() - 3600_000).toISOString(), "spawn-repro");
    purgeOldRecords(getDb());
    expect(getAgentAuthData("spawn-repro")).not.toBeNull(); // established at provisioning; and the tick reaps nothing anyway
  });
});
