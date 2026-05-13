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
 * (synthesizes codex + Hermes deep-repo audits), the maintainer locked
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

describe("v2.7.1 R1 [CONTRACT] — TOOL_CAPABILITY map agrees with tool-description admin marker", () => {
  // v2.7.1 R0 had a hand-maintained fixed-list spec-pin that read:
  //   const mustBeGated = ["revoke_token", "rotate_token_admin",
  //                        "expand_capabilities", "spawn_agent"];
  // Codex R1 audit caught the gap: set_dashboard_theme documents
  // itself at src/server.ts:633 as "Auth: dashboard-secret-equivalent
  // capability (treated as an admin operation)" but the fixed list
  // didn't include it. The audit's exact note: "Your walk-analogous
  // fixed list would NOT have failed if another admin tool stayed
  // unmapped. set_dashboard_theme is that current counterexample."
  //
  // R1 replaces the fixed list with a CONTRACT pin: scan every tool
  // description in src/server.ts for admin-equivalent phrasing AND
  // assert the matching TOOL_CAPABILITY entry exists with cap='admin'.
  // The contract is "documentation and TOOL_CAPABILITY MUST agree" —
  // drift detection is the goal, not a hand-curated list.
  //
  // Markers scanned:
  //   - "treated as an admin operation" (set_dashboard_theme's literal phrase)
  //   - "dashboard-secret-equivalent" (alternate phrasing)
  //   - "Requires `admin` capability" (explicit cite)
  // Future tools landing with any of these markers automatically join
  // the contract; future audits flagging additional markers can
  // extend the regex below.
  it("every tool whose description declares admin-equivalent semantics is gated cap='admin' in TOOL_CAPABILITY", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const { fileURLToPath } = await import("url");
    const { TOOL_CAPABILITY } = await import("../src/auth.js");
    const here = path.dirname(fileURLToPath(import.meta.url));
    const serverTs = path.resolve(here, "..", "src", "server.ts");
    const body = fs.readFileSync(serverTs, "utf-8");

    // Split into tool entries by the `name: "<tool>"` marker. Each
    // entry runs from one name: to the next (or to the array's
    // closing bracket).
    const toolRegex = /\bname:\s*"([a-z_][a-z0-9_]*)"/g;
    const toolStarts: Array<{ name: string; start: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = toolRegex.exec(body)) !== null) {
      toolStarts.push({ name: m[1], start: m.index });
    }

    const adminMarkerRegex = /(treated as an admin operation|dashboard-secret-equivalent|Requires `admin` capability)/i;
    const violations: string[] = [];
    for (let i = 0; i < toolStarts.length; i++) {
      const entry = toolStarts[i];
      const end = i + 1 < toolStarts.length ? toolStarts[i + 1].start : body.length;
      const chunk = body.slice(entry.start, end);
      if (!adminMarkerRegex.test(chunk)) continue;
      // Skip the top-level server name; only tool entries inside the
      // tools array carry capability semantics.
      if (entry.name === "bot-relay") continue;
      // Skip the `unregister_agent` entry — its docstring mentions
      // "admin removals" with the `manage_others` cap as a HANDLER-
      // side branch (self-removal is unauthenticated). The contract
      // here is for tools whose admin-marker maps to a dispatcher-
      // level TOOL_CAPABILITY gate.
      if (entry.name === "unregister_agent") continue;

      const actual = TOOL_CAPABILITY[entry.name];
      if (actual !== "admin") {
        violations.push(
          `tool "${entry.name}" docs declare admin semantics but TOOL_CAPABILITY[${entry.name}] === ${JSON.stringify(actual)} (expected "admin")`,
        );
      }
    }

    expect(
      violations.length,
      `${violations.length} tool(s) drift between description and TOOL_CAPABILITY:\n  ${violations.join("\n  ")}`,
    ).toBe(0);
  });

  // Hand-curated must-be-gated list, kept as defense-in-depth against
  // a tool that lacks the description marker but still mutates
  // cross-agent auth/identity state. v2.7.1 R0 shipped this list
  // as the spec-pin; R1 retains it as a secondary check (the contract
  // test above is the primary).
  it("every identified privilege-mutation tool is gated in TOOL_CAPABILITY (defense-in-depth list)", async () => {
    const { TOOL_CAPABILITY } = await import("../src/auth.js");
    const mustBeGated = [
      "revoke_token",
      "rotate_token_admin",
      "expand_capabilities",
      "spawn_agent",
      "set_dashboard_theme", // R1: added after codex audit caught the gap
    ];
    for (const tool of mustBeGated) {
      expect(
        TOOL_CAPABILITY[tool],
        `${tool} is missing from TOOL_CAPABILITY in src/auth.ts — any auth'd agent can call it without a capability check.`,
      ).toBeDefined();
    }
  });
});

describe("v2.7.1 R1 [P2] — set_dashboard_theme cap gate (runtime behavior)", () => {
  // The fix for codex R1 P2 ALSO needs runtime regression tests
  // mirroring the expand_capabilities cap-gate shape: a default-cap
  // caller is REJECTED with CAP_DENIED; an admin-cap caller succeeds.
  // Without these, the contract test above pins the static map but
  // a future refactor of the dispatcher's TOOL_CAPABILITY consumer
  // could break the runtime gate without failing.
  it("agent with default `[]` caps calling set_dashboard_theme is REJECTED with CAP_DENIED", async () => {
    const tok = await register("dash-default-cap", []);
    const r = await rpc("set_dashboard_theme", {
      mode: "dark",
      agent_token: tok,
    });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe(ERROR_CODES.CAP_DENIED);
  });

  it("agent with `admin` cap CAN call set_dashboard_theme (positive control)", async () => {
    const tok = await register("dash-admin", ["admin"]);
    const r = await rpc("set_dashboard_theme", {
      mode: "light",
      agent_token: tok,
    });
    expect(r.success).toBe(true);
    expect(r.theme).toBe("light");
  });
});
