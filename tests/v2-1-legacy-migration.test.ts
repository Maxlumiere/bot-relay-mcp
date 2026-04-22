// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 2b — legacy-row register_agent migration bypass.
 *
 * Pre-v1.7 agents have `token_hash IS NULL`. The documented migration path is
 * to call `register_agent` and receive a fresh token. v1.7.1 inadvertently
 * broke that path: `enforceAuth` rejects any re-register against an existing
 * row without a valid token, and legacy rows had no token to match, so the
 * dispatcher rejected before the migration code in `registerAgent` could fire.
 *
 * v2.1 Phase 2b narrows a bypass for exactly this case: when
 * `existing.token_hash IS NULL`, skip the auth check for register_agent only
 * and let the data-layer migration issue a fresh token. Every other gate
 * (capability, token, RELAY_ALLOW_LEGACY for non-register tool calls) is
 * unchanged.
 *
 * Coverage:
 *   1. null-hash row + NO token → success, fresh token issued, row has hash after.
 *   2. null-hash row + GARBAGE token → success, fresh token issued (token ignored).
 *   3. hashed row + NO token → auth_error (non-migration re-register still needs token).
 *   4. hashed row + WRONG token → auth_error (no regression on the v1.7.1 CVE fix).
 *   5. post-migration: the issued token works for a capability-scoped call.
 *   6. null-hash row migrated, then re-register again WITH the issued token → success
 *      (path is now the normal hashed re-register).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import type { Server as HttpServer } from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-legacy-migration-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
// v2.1.3 I8: scrub inherited RELAY_AGENT_* env vars so isolated tests
// do not auth against a parent-shell spawn-agent.sh token.
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
// Legacy grace OFF — we're testing the NARROW bypass, not the broad grace env.
delete process.env.RELAY_ALLOW_LEGACY;
delete process.env.RELAY_HTTP_SECRET;

const { startHttpServer } = await import("../src/transport/http.js");
const { getDb, getAgentAuthData, closeDb } = await import("../src/db.js");

let server: HttpServer;
let baseUrl: string;

async function mcpCall(method: string, params: any, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  if (!dataLine) return JSON.parse(text);
  return JSON.parse(dataLine.slice(5).trim());
}

async function callTool(toolName: string, args: any): Promise<{
  success: boolean;
  authError?: boolean;
  errorMsg?: string;
  raw: any;
}> {
  const resp = await mcpCall("tools/call", { name: toolName, arguments: args });
  const body = JSON.parse(resp.result.content[0].text);
  return {
    success: body.success === true,
    authError: body.auth_error === true,
    errorMsg: body.error,
    raw: body,
  };
}

/**
 * Insert a legacy (pre-v1.7) agent row directly into the DB, bypassing
 * `registerAgent` so `token_hash` stays NULL. Mirrors the state a user
 * would have upgrading from a v1.6.x relay.db.
 */
function seedLegacyAgent(name: string, caps: string[] = [], role = "legacy-role"): void {
  const now = new Date().toISOString();
  getDb().prepare(
    // v2.1 Phase 4b.1 v2: legacy rows now need auth_state='legacy_bootstrap'
    // explicitly. The ALTER default is 'active' — without setting this, a
    // simulated legacy row with null token_hash gets treated as a data
    // integrity error by the new state-aware dispatcher instead of the
    // legacy-migration path this test was written to exercise.
    `INSERT INTO agents (name, role, capabilities, last_seen, created_at, token_hash, agent_status, session_id, auth_state)
     VALUES (?, ?, ?, ?, ?, NULL, 'online', NULL, 'legacy_bootstrap')`
  ).run(name, role, JSON.stringify(caps), now, now);
  // Populate the normalized agent_capabilities index so capability checks work
  // post-migration (matches the path registerAgent takes on a fresh register).
  const insertCap = getDb().prepare(
    "INSERT OR IGNORE INTO agent_capabilities (agent_name, capability) VALUES (?, ?)"
  );
  for (const cap of caps) {
    if (cap) insertCap.run(name, cap);
  }
}

beforeAll(async () => {
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  server = startHttpServer(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 100));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

describe("v2.1 Phase 2b — legacy-row register_agent migration bypass", () => {
  it("(1) null-hash row + NO token → success, fresh token issued, row now has hash", async () => {
    seedLegacyAgent("legacy-a");

    // Sanity: token_hash really is NULL before the call.
    const pre = getAgentAuthData("legacy-a");
    expect(pre?.token_hash).toBeNull();

    const r = await callTool("register_agent", {
      name: "legacy-a",
      role: "r",
      capabilities: [],
      // no agent_token on purpose
    });
    expect(r.success).toBe(true);
    expect(r.raw.agent_token).toMatch(/^[A-Za-z0-9_=.-]+$/);
    expect(r.raw.agent_token.length).toBeGreaterThan(20);

    // After: token_hash is set, migration completed.
    const post = getAgentAuthData("legacy-a");
    expect(post?.token_hash).not.toBeNull();
    expect(post?.token_hash).toMatch(/^\$2[aby]\$/); // bcrypt prefix
  });

  it("(2) null-hash row + GARBAGE token → success, fresh token issued (token is ignored on the migration path)", async () => {
    seedLegacyAgent("legacy-b");

    const r = await callTool("register_agent", {
      name: "legacy-b",
      role: "r",
      capabilities: [],
      agent_token: "this-is-not-a-real-token-and-it-should-not-matter",
    });
    expect(r.success).toBe(true);
    expect(r.authError).not.toBe(true);
    expect(r.raw.agent_token).toBeTruthy();
    expect(r.raw.agent_token).not.toBe("this-is-not-a-real-token-and-it-should-not-matter");
  });

  it("(3) hashed row + NO token → auth_error (non-migration re-register still needs token)", async () => {
    // Bootstrap a normal agent (gets a token-hash).
    const first = await callTool("register_agent", {
      name: "hashed-a",
      role: "r",
      capabilities: [],
    });
    expect(first.success).toBe(true);

    // Re-register without a token — must be rejected.
    const r = await callTool("register_agent", {
      name: "hashed-a",
      role: "r",
      capabilities: [],
    });
    expect(r.success).toBe(false);
    expect(r.authError).toBe(true);
    expect(r.errorMsg).toMatch(/token/i);
  });

  it("(4) hashed row + WRONG token → auth_error (v1.7.1 CVE fix preserved)", async () => {
    const first = await callTool("register_agent", {
      name: "hashed-b",
      role: "r",
      capabilities: [],
    });
    expect(first.success).toBe(true);

    const r = await callTool("register_agent", {
      name: "hashed-b",
      role: "attacker-role", // would-be caps-escalation
      capabilities: ["spawn", "tasks"],
      agent_token: "definitely-not-the-real-token",
    });
    expect(r.success).toBe(false);
    expect(r.authError).toBe(true);
  });

  it("(5) post-migration: the issued token works for a capability-scoped call", async () => {
    // Seed with the capability already present — re-register can't mutate
    // caps (v1.7.1), so the legacy row must carry the cap the moment it
    // was created pre-v1.7 in order for a capability-gated call to work
    // after migration.
    seedLegacyAgent("legacy-c", ["broadcast"]);

    const migrate = await callTool("register_agent", {
      name: "legacy-c",
      role: "r",
      capabilities: ["broadcast"], // informational — actual caps preserved from row
    });
    expect(migrate.success).toBe(true);
    const newToken = migrate.raw.agent_token as string;
    expect(newToken).toBeTruthy();

    // Use the freshly-issued token on a capability-gated tool.
    const r = await callTool("broadcast", {
      from: "legacy-c",
      content: "post-migration test",
      agent_token: newToken,
    });
    expect(r.success).toBe(true);
    expect(r.authError).not.toBe(true);
  });

  it("(6) after migration the next re-register takes the normal hashed-row path with the new token", async () => {
    seedLegacyAgent("legacy-d");

    const first = await callTool("register_agent", {
      name: "legacy-d",
      role: "r",
      capabilities: [],
    });
    expect(first.success).toBe(true);
    const firstToken = first.raw.agent_token as string;

    // Re-register again: now has a hash, so this call hits the v1.7.1 gate.
    // Without the token → rejected.
    const wrongPath = await callTool("register_agent", {
      name: "legacy-d",
      role: "r",
      capabilities: [],
    });
    expect(wrongPath.authError).toBe(true);

    // With the token → accepted (normal hashed-row re-register).
    // v2.2.1 B2: force=true to bypass active-name collision gate.
    const rightPath = await callTool("register_agent", {
      name: "legacy-d",
      role: "r",
      capabilities: [],
      agent_token: firstToken,
      force: true,
    });
    expect(rightPath.success).toBe(true);
  });
});
