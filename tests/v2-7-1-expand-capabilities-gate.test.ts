// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.7.1 [CRITICAL] regression — `expand_capabilities` MUST require admin
 * capability at the dispatcher.
 *
 * Bug class (pre-v2.7.1): src/auth.ts:97 TOOL_CAPABILITY map omitted
 * `expand_capabilities` entirely. The dispatcher at src/server.ts:1091
 * falls back to "no capability required" for unmapped tools, so any
 * authenticated agent — even one with the default `{user}` cap set —
 * could call expand_capabilities on themselves to add `admin`,
 * `manage_others`, `rotate_others`. From there: `revoke_token` /
 * `rotate_token_admin` on any peer. ~3 calls to fully compromise a
 * relay.
 *
 * Origin: review-Victra deep-review synthesis msg `2b903f9b`
 * (synthesizes codex + Hermes deep-repo audits), Maxime locked
 * "fix all in one bundled dispatch" 2026-05-13.
 *
 * This test exercises the dispatcher path via HTTP RPC (same pattern
 * as tests/v2-1-error-codes.test.ts) — calling handleExpandCapabilities
 * directly would BYPASS the dispatcher's cap gate and miss the bug.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import type { Server as HttpServer } from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v271-expandcap-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
delete process.env.RELAY_ALLOW_LEGACY;
delete process.env.RELAY_HTTP_SECRET;

const { startHttpServer } = await import("../src/transport/http.js");
const { closeDb } = await import("../src/db.js");
const { ERROR_CODES } = await import("../src/error-codes.js");

let server: HttpServer;
let baseUrl: string;

async function rpc(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  const parsed = dataLine ? JSON.parse(dataLine.slice(5).trim()) : JSON.parse(text);
  return JSON.parse(parsed.result.content[0].text);
}

async function register(name: string, caps: string[] = []): Promise<string> {
  const r = await rpc("register_agent", { name, role: "r", capabilities: caps });
  return r.agent_token as string;
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

describe("v2.7.1 [CRITICAL] — expand_capabilities cap gate", () => {
  it("agent with default `[]` caps calling expand_capabilities on itself is REJECTED with CAP_DENIED", async () => {
    const tok = await register("priv-esc-attempt", []);
    // Self-escalation attempt: add `admin` to your own row.
    const r = await rpc("expand_capabilities", {
      agent_name: "priv-esc-attempt",
      new_capabilities: ["admin"],
      agent_token: tok,
    });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe(ERROR_CODES.CAP_DENIED);
  });

  it("agent with default `[]` caps cannot escalate by chaining (the exploit path Hermes flagged)", async () => {
    const attackerTok = await register("attacker", []);
    await register("victim", []);
    // Step 1: try to add admin → BLOCKED
    const step1 = await rpc("expand_capabilities", {
      agent_name: "attacker",
      new_capabilities: ["admin"],
      agent_token: attackerTok,
    });
    expect(step1.success).toBe(false);
    expect(step1.error_code).toBe(ERROR_CODES.CAP_DENIED);

    // Step 2 (defense-in-depth): even if step 1 had silently succeeded,
    // revoke_token requires admin cap too. Confirm the gate fires.
    const step2 = await rpc("revoke_token", {
      target_agent_name: "victim",
      agent_token: attackerTok,
    });
    expect(step2.success).toBe(false);
    expect(step2.error_code).toBe(ERROR_CODES.CAP_DENIED);
  });

  it("agent with `admin` cap CAN call expand_capabilities on self (positive control — fix doesn't break legit admins)", async () => {
    // expand_capabilities is self-managed by design (handler docstring at
    // src/tools/identity.ts:822 — "caller proved they own the row"). The
    // dispatcher routes the explicit `agent_name` arg through the
    // explicit-caller auth branch, which ties agent_name == caller. So
    // the positive control must be a self-expansion. An admin adding
    // additional caps to its own row is the legitimate use case.
    const adminTok = await register("legit-admin", ["admin"]);
    const r = await rpc("expand_capabilities", {
      agent_name: "legit-admin",
      // Handler enforces additive-only: new_capabilities MUST be a superset
      // of current. Pass the full target set (existing "admin" + new
      // "webhooks") rather than just the addition.
      new_capabilities: ["admin", "webhooks"],
      agent_token: adminTok,
    });
    expect(r.success).toBe(true);
    expect(r.capabilities).toEqual(expect.arrayContaining(["admin", "webhooks"]));
  });
});

describe("v2.7.1 [WALK-ANALOGOUS] — TOOL_CAPABILITY coverage of mutating identity/auth tools", () => {
  // Spec-pinning test: list of every src/server.ts tool that MUTATES auth
  // or identity state. Each is either gated in TOOL_CAPABILITY or has a
  // documented reason for being open (self-mutation only, etc.). New
  // mutating tools added in future releases MUST be reviewed against
  // this list — codex's discipline note on "verify don't assume".
  //
  // This test is a structural pin, not a behavioral test — it imports
  // TOOL_CAPABILITY and asserts the security-relevant keys are present.
  it("every identified privilege-mutation tool is gated in TOOL_CAPABILITY", async () => {
    const { TOOL_CAPABILITY } = await import("../src/auth.js");
    // Tools that mutate cross-agent auth/identity state and MUST be gated.
    const mustBeGated = ["revoke_token", "rotate_token_admin", "expand_capabilities", "spawn_agent"];
    for (const tool of mustBeGated) {
      expect(
        TOOL_CAPABILITY[tool],
        `${tool} is missing from TOOL_CAPABILITY in src/auth.ts — any auth'd agent can call it without a capability check.`,
      ).toBeDefined();
    }
  });
});
