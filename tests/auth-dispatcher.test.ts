// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Dispatcher-level auth tests (v1.7) — exercises the real enforcement path
 * via the HTTP transport. Verifies that:
 *   - tools without token → rejected (auth_error)
 *   - tools with wrong token → rejected
 *   - tools with valid token → allowed
 *   - capability-gated tools (spawn/tasks/webhooks/broadcast) require the cap
 *   - legacy grace env var opens the door
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import type { Server as HttpServer } from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-auth-disp-test-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
// v2.1.3 I8: scrub inherited RELAY_AGENT_* env vars so isolated tests
// do not auth against a parent-shell spawn-agent.sh token.
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
// legacy grace OFF by default for this file — tests exercise the strict v1.7 path
delete process.env.RELAY_ALLOW_LEGACY;

const { startHttpServer } = await import("../src/transport/http.js");
const { closeDb } = await import("../src/db.js");

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

async function register(name: string, caps: string[] = []): Promise<string> {
  const resp = await mcpCall("tools/call", {
    name: "register_agent",
    arguments: { name, role: "r", capabilities: caps },
  });
  const body = JSON.parse(resp.result.content[0].text);
  return body.agent_token;
}

async function callTool(toolName: string, args: any): Promise<{ success: boolean; authError?: boolean; errorMsg?: string; raw: any }> {
  const resp = await mcpCall("tools/call", { name: toolName, arguments: args });
  const body = JSON.parse(resp.result.content[0].text);
  return {
    success: body.success === true,
    authError: body.auth_error === true,
    errorMsg: body.error,
    raw: body,
  };
}

beforeAll(async () => {
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
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

describe("token enforcement on tools with explicit caller", () => {
  it("register_agent works without a token (bootstrap)", async () => {
    const tok = await register("boot-agent", []);
    expect(tok).toBeTruthy();
  });

  it("send_message WITHOUT token is rejected", async () => {
    await register("no-tok-sender", []);
    await register("no-tok-recipient", []);
    const r = await callTool("send_message", {
      from: "no-tok-sender",
      to: "no-tok-recipient",
      content: "hi",
      priority: "normal",
    });
    expect(r.authError).toBe(true);
    expect(r.errorMsg).toMatch(/agent_token|requires|Invalid/);
  });

  it("send_message with WRONG token is rejected", async () => {
    await register("wrong-tok-sender", []);
    await register("wrong-tok-recipient", []);
    const r = await callTool("send_message", {
      from: "wrong-tok-sender",
      to: "wrong-tok-recipient",
      content: "hi",
      priority: "normal",
      agent_token: "not-a-real-token",
    });
    expect(r.authError).toBe(true);
  });

  it("send_message with CORRECT token is allowed", async () => {
    const senderTok = await register("good-tok-sender", []);
    await register("good-tok-recipient", []);
    const r = await callTool("send_message", {
      from: "good-tok-sender",
      to: "good-tok-recipient",
      content: "hi",
      priority: "normal",
      agent_token: senderTok,
    });
    expect(r.success).toBe(true);
  });

  it("claiming to be another agent fails (token mismatch)", async () => {
    const aliceTok = await register("claim-alice", []);
    await register("claim-bob", []);
    // Alice's token, but claiming to be bob
    const r = await callTool("send_message", {
      from: "claim-bob",
      to: "claim-alice",
      content: "impersonating",
      priority: "normal",
      agent_token: aliceTok,
    });
    expect(r.authError).toBe(true);
  });
});

describe("capability scoping", () => {
  it("spawn_agent requires the 'spawn' capability — rejected without it", async () => {
    const tok = await register("no-spawn-cap", ["tasks"]);
    const r = await callTool("spawn_agent", {
      name: "child-a",
      role: "builder",
      capabilities: [],
      agent_token: tok,
    });
    expect(r.authError).toBe(true);
    expect(r.errorMsg).toContain("spawn");
  });

  it("post_task requires 'tasks' capability — rejected without it", async () => {
    const tok = await register("no-tasks-cap", ["messaging"]);
    await register("task-target", []);
    const r = await callTool("post_task", {
      from: "no-tasks-cap",
      to: "task-target",
      title: "x",
      description: "y",
      priority: "normal",
      agent_token: tok,
    });
    expect(r.authError).toBe(true);
    expect(r.errorMsg).toContain("tasks");
  });

  it("broadcast requires 'broadcast' capability — rejected without it", async () => {
    const tok = await register("no-bcast-cap", []);
    const r = await callTool("broadcast", {
      from: "no-bcast-cap",
      content: "hi all",
      agent_token: tok,
    });
    expect(r.authError).toBe(true);
  });

  it("register_webhook requires 'webhooks' capability — rejected without it", async () => {
    const tok = await register("no-webhook-cap", []);
    const r = await callTool("register_webhook", {
      url: "http://example.com/hook",
      event: "message.sent",
      agent_token: tok,
    });
    expect(r.authError).toBe(true);
  });

  it("post_task allowed with 'tasks' capability", async () => {
    const tok = await register("yes-tasks-cap", ["tasks"]);
    await register("yes-tasks-target", []);
    const r = await callTool("post_task", {
      from: "yes-tasks-cap",
      to: "yes-tasks-target",
      title: "real task",
      description: "do it",
      priority: "normal",
      agent_token: tok,
    });
    expect(r.success).toBe(true);
  });

  it("send_message is always allowed (no capability required)", async () => {
    const tok = await register("msg-sender", []); // no caps
    await register("msg-recipient", []);
    const r = await callTool("send_message", {
      from: "msg-sender",
      to: "msg-recipient",
      content: "hello",
      priority: "normal",
      agent_token: tok,
    });
    expect(r.success).toBe(true);
  });

  it("get_messages is always allowed (no capability required)", async () => {
    const tok = await register("reader", []);
    const r = await callTool("get_messages", {
      agent_name: "reader",
      status: "pending",
      limit: 10,
      agent_token: tok,
    });
    expect(r.raw).toHaveProperty("messages");
  });
});

describe("X-Agent-Token HTTP header as auth fallback", () => {
  it("token from X-Agent-Token header is accepted when arg.agent_token is missing", async () => {
    const tok = await register("header-auth-sender", []);
    await register("header-auth-recipient", []);

    const resp = await mcpCall(
      "tools/call",
      {
        name: "send_message",
        arguments: {
          from: "header-auth-sender",
          to: "header-auth-recipient",
          content: "via header",
          priority: "normal",
          // no agent_token field
        },
      },
      { "X-Agent-Token": tok }
    );
    const body = JSON.parse(resp.result.content[0].text);
    expect(body.success).toBe(true);
  });
});

// v1.7.1 — register_agent re-registration auth + capability immutability.
// These tests close the capability-escalation CVE where an unauthenticated
// caller could rewrite an existing agent's capabilities via the upsert path.
describe("register_agent re-registration auth (v1.7.1)", () => {
  it("(i) new-register succeeds without auth — bootstrap path", async () => {
    const resp = await mcpCall("tools/call", {
      name: "register_agent",
      arguments: { name: "rr-new-agent", role: "r", capabilities: ["x"] },
    });
    const body = JSON.parse(resp.result.content[0].text);
    expect(body.success).toBe(true);
    expect(body.agent_token).toBeTruthy();
  });

  it("(ii) re-register with NO token rejected (auth_error)", async () => {
    await register("rr-need-auth", ["build"]);
    const resp = await mcpCall("tools/call", {
      name: "register_agent",
      arguments: { name: "rr-need-auth", role: "r2", capabilities: ["build"] },
    });
    const body = JSON.parse(resp.result.content[0].text);
    expect(body.auth_error).toBe(true);
  });

  it("(iii) re-register with WRONG token rejected", async () => {
    await register("rr-wrong-tok", ["build"]);
    const resp = await mcpCall("tools/call", {
      name: "register_agent",
      arguments: {
        name: "rr-wrong-tok",
        role: "r2",
        capabilities: ["build"],
        agent_token: "definitely-not-a-real-token",
      },
    });
    const body = JSON.parse(resp.result.content[0].text);
    expect(body.auth_error).toBe(true);
  });

  it("(iv) re-register with CORRECT token allowed BUT caps unchanged", async () => {
    const tok = await register("rr-caps-locked", ["build"]);
    const resp = await mcpCall("tools/call", {
      name: "register_agent",
      arguments: {
        name: "rr-caps-locked",
        role: "deployer",
        capabilities: ["spawn", "tasks"], // attempt to grant herself spawn
        agent_token: tok,
      },
    });
    const body = JSON.parse(resp.result.content[0].text);
    expect(body.success).toBe(true);
    // Role DID update
    expect(body.agent.role).toBe("deployer");
    // Caps DID NOT update — the returned agent reflects the preserved caps
    expect(body.agent.capabilities).toEqual(["build"]);
    // A note should explain why the requested caps were ignored
    expect(body.capabilities_note).toMatch(/immutable|unregister/i);
  });

  it("(v) ADVERSARIAL: unauthenticated caller cannot escalate an existing agent's caps", async () => {
    // Victim: registers with minimal caps
    await register("rr-victim", ["messaging"]);
    // An auditor agent with a valid token, used to query discover_agents afterwards
    const auditorTok = await register("rr-auditor", []);
    // Attacker: tries to add 'spawn' via unauthenticated re-register
    const attackResp = await mcpCall("tools/call", {
      name: "register_agent",
      arguments: { name: "rr-victim", role: "r", capabilities: ["spawn", "tasks", "webhooks", "broadcast"] },
    });
    const attackBody = JSON.parse(attackResp.result.content[0].text);
    expect(attackBody.auth_error).toBe(true);
    // Verify in the DB: victim's caps still minimal
    const discover = await mcpCall("tools/call", {
      name: "discover_agents",
      arguments: { agent_token: auditorTok },
    });
    const list = JSON.parse(discover.result.content[0].text).agents as Array<{ name: string; capabilities: string[] }>;
    const victim = list.find((a) => a.name === "rr-victim");
    expect(victim).toBeTruthy();
    expect(victim!.capabilities).toEqual(["messaging"]);
  });

  it("(vi) unregister + fresh register with different caps works", async () => {
    const tok = await register("rr-life-cycle", ["build"]);
    // Unregister self (requires matching token)
    const unregResp = await mcpCall("tools/call", {
      name: "unregister_agent",
      arguments: { name: "rr-life-cycle", agent_token: tok },
    });
    const unregBody = JSON.parse(unregResp.result.content[0].text);
    expect(unregBody.success).toBe(true);
    expect(unregBody.removed).toBe(true);
    // Fresh register — different caps succeed, since the name no longer exists
    const freshResp = await mcpCall("tools/call", {
      name: "register_agent",
      arguments: { name: "rr-life-cycle", role: "r", capabilities: ["spawn", "tasks"] },
    });
    const freshBody = JSON.parse(freshResp.result.content[0].text);
    expect(freshBody.success).toBe(true);
    expect(freshBody.agent.capabilities).toEqual(["spawn", "tasks"]);
    expect(freshBody.agent_token).toBeTruthy();
  });
});
