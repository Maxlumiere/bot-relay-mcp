// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0037 — only the model moves mail to read.
 *
 * hooks/post-tool-use-check.sh used to DRAIN the mailbox (HTTP get_messages
 * status=pending, or a sqlite UPDATE status='read') and inject the bodies as
 * additionalContext. A hook cannot prove delivery: additionalContext has no
 * acknowledgement, can be truncated, and — measured — PostToolUse also fires for
 * SUBAGENT tool calls (stdin then carries agent_id / agent_type), so the injection
 * can land in a subagent's context while the mail is already marked read. The
 * recipient's own drain then returns nothing: silent loss.
 *
 * Contract pinned here:
 *   - harm attempt: pending mail + the hook runs → the message is STILL pending
 *     after the hook exits (HTTP path and sqlite path);
 *   - innocent twin: the model's own get_messages is what delivers and marks it;
 *   - a subagent tool call runs no mail path at all;
 *   - the notice is data (count, senders, a bounded first line), never bodies.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import cp from "child_process";
import { fileURLToPath } from "url";
import type { Server as HttpServer } from "http";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HOOK_SCRIPT = path.resolve(__dirname, "..", "hooks", "post-tool-use-check.sh");

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-adr0037-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
// A throwaway HOME for every hook run, so no hook-state file lands in a real ~/.bot-relay.
const HOOK_HOME = path.join(TEST_DB_DIR, "home");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
delete process.env.RELAY_ALLOW_LEGACY;
delete process.env.RELAY_HTTP_SECRET;

const { startHttpServer } = await import("../src/transport/http.js");
const { closeDb, getDb } = await import("../src/db.js");

let server: HttpServer;
let port: number;
let baseUrl: string;

async function mcpCall(payload: unknown): Promise<any> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse(dataLine ? dataLine.slice(5).trim() : text);
}

async function tool(name: string, args: Record<string, unknown>): Promise<any> {
  const resp = await mcpCall({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return JSON.parse(resp.result.content[0].text);
}

async function register(name: string): Promise<string> {
  return (await tool("register_agent", { name, role: "r", capabilities: [] })).agent_token as string;
}

async function send(from: string, to: string, content: string, fromToken: string): Promise<void> {
  await tool("send_message", { from, to, content, priority: "normal", agent_token: fromToken });
}

function messageRow(to: string, content: string): { status: string; read_by_session: string | null; read_at: string | null } {
  return getDb()
    .prepare("SELECT status, read_by_session, read_at FROM messages WHERE to_agent = ? AND content = ?")
    .get(to, content) as { status: string; read_by_session: string | null; read_at: string | null };
}

function expectStillPending(to: string, content: string): void {
  const row = messageRow(to, content);
  expect(row, "message row exists").toBeTruthy();
  expect(row.read_at, "read_at must stay NULL — no hook may stamp a read").toBeNull();
  expect(row.read_by_session, "read_by_session must stay NULL — the hook is not the reader").toBeNull();
  expect(row.status).toBe("pending");
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

// Main-agent PostToolUse payload (no agent_id / agent_type), as measured on Claude Code 2.1.272.
const MAIN_AGENT_STDIN = JSON.stringify({
  session_id: "11111111-1111-1111-1111-111111111111",
  hook_event_name: "PostToolUse",
  tool_name: "Read",
  tool_input: {},
  tool_response: {},
  tool_use_id: "toolu_main",
  cwd: "/tmp",
});
// Subagent PostToolUse payload: the same shape plus agent_id + agent_type.
const SUBAGENT_STDIN = JSON.stringify({
  session_id: "11111111-1111-1111-1111-111111111111",
  hook_event_name: "PostToolUse",
  tool_name: "Read",
  tool_input: {},
  tool_response: {},
  tool_use_id: "toolu_sub",
  cwd: "/tmp",
  agent_id: "aa5fcd608eedaadb7",
  agent_type: "general-purpose",
});

function runHook(env: Record<string, string | undefined>, stdin: string = MAIN_AGENT_STDIN): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const finalEnv: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: HOOK_HOME,
      RELAY_HOOK_NOTICE_REMIND_SECS: "0",
    };
    for (const [k, v] of Object.entries(env)) {
      if (v !== undefined) finalEnv[k] = v;
    }
    const child = cp.spawn("bash", [HOOK_SCRIPT], { env: finalEnv });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
    child.on("error", reject);
    child.stdin.end(stdin);
  });
}

function httpEnv(name: string, token: string): Record<string, string> {
  return {
    RELAY_AGENT_NAME: name,
    RELAY_AGENT_TOKEN: token,
    RELAY_HTTP_HOST: "127.0.0.1",
    RELAY_HTTP_PORT: String(port),
    RELAY_DB_PATH: TEST_DB_PATH,
  };
}

function contextOf(r: RunResult): string {
  expect(r.stdout, "expected a hook notice on stdout").not.toBe("");
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string;
}

beforeAll(async () => {
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(HOOK_HOME, { recursive: true });
  server = startHttpServer(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 100));
  const addr = server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

describe("ADR-0037 — harm attempt: the hook never moves mail to read", () => {
  it("HTTP path: pending mail is STILL pending after the hook exits", async () => {
    const s = await register("a37-sender-1");
    const t = await register("a37-recv-1");
    await send("a37-sender-1", "a37-recv-1", "harm attempt over http", s);

    const r = await runHook(httpEnv("a37-recv-1", t));
    expect(r.code).toBe(0);
    expectStillPending("a37-recv-1", "harm attempt over http");
  });

  it("sqlite fallback (no token): pending mail is STILL pending after the hook exits", async () => {
    const s = await register("a37-sender-2");
    await register("a37-recv-2");
    await send("a37-sender-2", "a37-recv-2", "harm attempt over sqlite", s);

    const r = await runHook({ RELAY_AGENT_NAME: "a37-recv-2", RELAY_DB_PATH: TEST_DB_PATH });
    expect(r.code).toBe(0);
    expectStillPending("a37-recv-2", "harm attempt over sqlite");
  });
});

describe("ADR-0037 — innocent twin: the model's own get_messages delivers and marks", () => {
  it("after the hook has run, the recipient's get_messages still returns the message and THAT call marks it read", async () => {
    const s = await register("a37-sender-3");
    const t = await register("a37-recv-3");
    await send("a37-sender-3", "a37-recv-3", "delivered only by the model", s);

    await runHook(httpEnv("a37-recv-3", t));

    const drained = await tool("get_messages", { agent_name: "a37-recv-3", status: "pending", agent_token: t });
    const contents = (drained.messages as Array<{ content: string }>).map((m) => m.content);
    expect(contents).toContain("delivered only by the model");
    expect(messageRow("a37-recv-3", "delivered only by the model").read_at).not.toBeNull();
  });
});

describe("ADR-0037 — subagent tool calls run no mail path", () => {
  it("stdin with agent_id/agent_type → no output and the mail stays pending (HTTP path)", async () => {
    const s = await register("a37-sender-4");
    const t = await register("a37-recv-4");
    await send("a37-sender-4", "a37-recv-4", "not for a subagent", s);

    const r = await runHook(httpEnv("a37-recv-4", t), SUBAGENT_STDIN);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expectStillPending("a37-recv-4", "not for a subagent");
  });

  it("stdin with agent_id/agent_type → no output and the mail stays pending (sqlite path)", async () => {
    const s = await register("a37-sender-5");
    await register("a37-recv-5");
    await send("a37-sender-5", "a37-recv-5", "not for a subagent either", s);

    const r = await runHook({ RELAY_AGENT_NAME: "a37-recv-5", RELAY_DB_PATH: TEST_DB_PATH }, SUBAGENT_STDIN);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expectStillPending("a37-recv-5", "not for a subagent either");
  });
});

describe("ADR-0037 — the notice is data, never message bodies", () => {
  it("names the count and sender, carries at most a bounded first line, and never a later line", async () => {
    const s = await register("a37-sender-6");
    const t = await register("a37-recv-6");
    const longFirst = "FIRSTLINE " + "x".repeat(300);
    await send("a37-sender-6", "a37-recv-6", `${longFirst}\nSECOND-LINE-MUST-NOT-APPEAR`, s);

    const ctx = contextOf(await runHook(httpEnv("a37-recv-6", t)));
    expect(ctx).toMatch(/^relay: 1 unread for a37-recv-6/);
    expect(ctx).toContain("a37-sender-6");
    expect(ctx).toContain("FIRSTLINE");
    expect(ctx).not.toContain("SECOND-LINE-MUST-NOT-APPEAR");
    expect(ctx).not.toContain("x".repeat(150));
  });

  it("sqlite fallback notice follows the same rules", async () => {
    const s = await register("a37-sender-7");
    await register("a37-recv-7");
    await send("a37-sender-7", "a37-recv-7", "sqlite first line\nSQLITE-SECOND-LINE-MUST-NOT-APPEAR", s);

    const ctx = contextOf(await runHook({ RELAY_AGENT_NAME: "a37-recv-7", RELAY_DB_PATH: TEST_DB_PATH }));
    expect(ctx).toMatch(/^relay: 1 unread for a37-recv-7/);
    expect(ctx).toContain("a37-sender-7");
    expect(ctx).not.toContain("SQLITE-SECOND-LINE-MUST-NOT-APPEAR");
  });
});
