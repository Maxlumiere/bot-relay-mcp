// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.20.1 — verified-token cache on the EXPLICIT-CALLER auth path.
 *
 * The critical new invariant is the IMPERSONATION gate: a valid token for agent
 * X must NEVER authenticate a claim `from: Y`, even when the cache is warm. Plus
 * the revoke-trap on the explicit path, and the shared-helper refactor causing
 * no regression on the token-only path (that suite is v2-20-0; here we assert
 * the explicit path directly).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import type { Server as HttpServer } from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-2201-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_ALLOW_LEGACY;
delete process.env.RELAY_ENCRYPTION_KEYRING;
delete process.env.RELAY_ENCRYPTION_KEY;

const { startHttpServer } = await import("../src/transport/http.js");
const {
  closeDb,
  registerAgent,
  revokeAgentToken,
  expandAgentCapabilities,
  getAgentAuthData,
  getAuthGeneration,
  bumpAuthGeneration,
  explicitCallerCacheGet,
  explicitCallerCachePut,
  getDb,
} = await import("../src/db.js");
const { ERROR_CODES } = await import("../src/error-codes.js");
const { computeTokenLookup, _resetTokenLookupCacheForTests } = await import("../src/token-lookup.js");
const { authCacheClear } = await import("../src/auth-cache.js");

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
  authCacheClear();
  _resetTokenLookupCacheForTests();
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
afterEach(() => cleanup());

// ─────────────────────────────────────────────────────────────────────────────
describe("v2.20.1 — explicit-caller path over HTTP (enforceAuth)", () => {
  it("happy path: repeated authenticated send_message succeeds (warm cache)", async () => {
    const xTok = await register("x-send", []);
    await register("x-recv", []);
    for (let i = 0; i < 3; i++) {
      const r = await rpc("send_message", { from: "x-send", to: "x-recv", content: "hi", agent_token: xTok });
      expect(r.success).toBe(true);
    }
  });

  it("IMPERSONATION: agent X's valid token with from=Y is DENIED — even after a warm cache", async () => {
    const xTok = await register("imp-x", []);
    await register("imp-y", []); // Y exists (registered) — so the failure is auth, not "not registered"
    await register("imp-recv", []);
    // Warm the cache: X authenticates successfully with its own token.
    expect((await rpc("send_message", { from: "imp-x", to: "imp-recv", content: "1", agent_token: xTok })).success).toBe(true);
    // Now claim from=Y using X's (cached) token → the name-match gate must DENY.
    const spoof = await rpc("send_message", { from: "imp-y", to: "imp-recv", content: "2", agent_token: xTok });
    expect(spoof.success).toBe(false);
    expect(spoof.error_code).toBe(ERROR_CODES.AUTH_FAILED);
  });

  it("REVOKE-TRAP (explicit path): a revoked token is denied on the next send — even warm", async () => {
    const xTok = await register("rev-x", []);
    await register("rev-recv", []);
    expect((await rpc("send_message", { from: "rev-x", to: "rev-recv", content: "1", agent_token: xTok })).success).toBe(true); // caches
    revokeAgentToken("rev-x"); // bumps the generation; token_hash retained (still bcrypt-matchable)
    const after = await rpc("send_message", { from: "rev-x", to: "rev-recv", content: "2", agent_token: xTok });
    expect(after.success).toBe(false);
    expect(after.error_code).toBe(ERROR_CODES.AUTH_FAILED);
  });

  it("wrong token for a real caller is denied (no false cache hit)", async () => {
    await register("wt-x", []);
    await register("wt-recv", []);
    const r = await rpc("send_message", { from: "wt-x", to: "wt-recv", content: "x", agent_token: "not-the-real-token" });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe(ERROR_CODES.AUTH_FAILED);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("v2.20.1 — explicit-caller cache functions (unit)", () => {
  it("put → get returns the verdict; the impersonation gate rejects a wrong claimant", () => {
    const { plaintext_token } = registerAgent("u-alice", "r", ["tasks"]);
    const row = getAgentAuthData("u-alice")!;
    explicitCallerCachePut(plaintext_token!, row, ["tasks"]);
    // Correct claimant → hit.
    expect(explicitCallerCacheGet(plaintext_token!, "u-alice")).toEqual({ name: "u-alice", capabilities: ["tasks"] });
    // IMPERSONATION: same valid token, different claimed name → MISS.
    expect(explicitCallerCacheGet(plaintext_token!, "u-mallory")).toBeNull();
  });

  it("generation bump invalidates the cached verdict", () => {
    const { plaintext_token } = registerAgent("u-bob", "r", []);
    explicitCallerCachePut(plaintext_token!, getAgentAuthData("u-bob")!, []);
    expect(explicitCallerCacheGet(plaintext_token!, "u-bob")).not.toBeNull();
    bumpAuthGeneration();
    expect(explicitCallerCacheGet(plaintext_token!, "u-bob")).toBeNull();
  });

  it("Q1 self-heal: an explicit-path put on a NULL-digest row populates token_lookup", () => {
    const { plaintext_token } = registerAgent("u-carol", "r", []);
    // Simulate a legacy NULL-digest row.
    getDb().prepare("UPDATE agents SET token_lookup = NULL WHERE name = ?").run("u-carol");
    authCacheClear();
    expect(getAgentAuthData("u-carol")!.token_lookup).toBeNull();
    explicitCallerCachePut(plaintext_token!, getAgentAuthData("u-carol")!, []);
    // Digest is now healed (deterministic migration on first explicit-path call).
    expect(getAgentAuthData("u-carol")!.token_lookup).toBe(computeTokenLookup(plaintext_token!));
  });

  it("caps change is reflected (gen bump → re-verify picks up new caps)", () => {
    const { plaintext_token } = registerAgent("u-dave", "r", ["tasks"]);
    explicitCallerCachePut(plaintext_token!, getAgentAuthData("u-dave")!, ["tasks"]);
    expect(explicitCallerCacheGet(plaintext_token!, "u-dave")!.capabilities).toEqual(["tasks"]);
    expandAgentCapabilities("u-dave", ["tasks", "admin"]); // bumps gen
    expect(explicitCallerCacheGet(plaintext_token!, "u-dave")).toBeNull(); // stale entry gone → caller re-verifies
  });
});
