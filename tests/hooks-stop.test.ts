// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Integration tests for hooks/stop-check.sh (v2.1 Phase 2a).
 *
 * Mirrors hooks-post-tool-use.test.ts — spins up a real HTTP relay on a random
 * port, registers a real agent with a token, sends messages, then invokes the
 * stop hook script as a subprocess with controlled env vars and inspects
 * stdout / stderr / timing.
 *
 * Covers:
 *   1. HTTP happy path — pending mail → valid Claude Code hook JSON with
 *      hookEventName "Stop".
 *   2. Empty mailbox → truly empty stdout, exit 0.
 *   3. Idempotency — re-running the hook returns empty (messages marked read).
 *   4. Unreachable relay + unreachable DB → silent fail within budget.
 *   5. Missing token → falls back to sqlite direct, still surfaces mail
 *      with hookEventName "Stop".
 *   6. No re-register — hook does not change the agent's capabilities or role.
 *   7. Missing RELAY_AGENT_NAME → silent exit 0.
 *   8. Invalid token shape → treated as missing token, sqlite fallback runs.
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
const HOOK_SCRIPT = path.resolve(__dirname, "..", "hooks", "stop-check.sh");

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-stop-hook-test-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_ALLOW_LEGACY;
delete process.env.RELAY_HTTP_SECRET;

const { startHttpServer } = await import("../src/transport/http.js");
const { closeDb } = await import("../src/db.js");

let server: HttpServer;
let port: number;
let baseUrl: string;

async function mcpCall(payload: any, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  if (!dataLine) return JSON.parse(text);
  return JSON.parse(dataLine.slice(5).trim());
}

async function registerWithToken(name: string, caps: string[] = []): Promise<string> {
  const resp = await mcpCall({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "register_agent", arguments: { name, role: "r", capabilities: caps } },
  });
  const body = JSON.parse(resp.result.content[0].text);
  return body.agent_token as string;
}

async function sendMessage(from: string, to: string, content: string, fromToken: string): Promise<void> {
  await mcpCall({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "send_message",
      arguments: { from, to, content, priority: "normal", agent_token: fromToken },
    },
  });
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

function runHook(env: Record<string, string | undefined>): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const finalEnv: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
    };
    for (const [k, v] of Object.entries(env)) {
      if (v !== undefined) finalEnv[k] = v;
    }
    const child = cp.spawn("bash", [HOOK_SCRIPT], { env: finalEnv });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("exit", (code) => resolve({ code, stdout, stderr, durationMs: Date.now() - start }));
    child.on("error", reject);
  });
}

beforeAll(async () => {
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
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

describe("Stop hook — HTTP path (preferred)", () => {
  it("(1) happy path: pending mail → hook JSON with hookEventName 'Stop'", async () => {
    const senderTok = await registerWithToken("stop-sender-1", []);
    const recvTok = await registerWithToken("stop-recv-1", []);
    await sendMessage("stop-sender-1", "stop-recv-1", "after text-only turn", senderTok);

    const r = await runHook({
      RELAY_AGENT_NAME: "stop-recv-1",
      RELAY_AGENT_TOKEN: recvTok,
      RELAY_HTTP_HOST: "127.0.0.1",
      RELAY_HTTP_PORT: String(port),
      RELAY_DB_PATH: TEST_DB_PATH,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toBe("");
    const parsed = JSON.parse(r.stdout);
    expect(parsed.continue).toBe(true);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("Stop");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("[RELAY]");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("stop-sender-1");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("after text-only turn");
  });

  it("(2) empty mailbox → truly empty stdout, exit 0", async () => {
    const tok = await registerWithToken("stop-empty", []);
    const r = await runHook({
      RELAY_AGENT_NAME: "stop-empty",
      RELAY_AGENT_TOKEN: tok,
      RELAY_HTTP_HOST: "127.0.0.1",
      RELAY_HTTP_PORT: String(port),
      RELAY_DB_PATH: TEST_DB_PATH,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("(3) idempotent: second run after the first returns empty (messages marked read)", async () => {
    const senderTok = await registerWithToken("stop-sender-2", []);
    const recvTok = await registerWithToken("stop-recv-2", []);
    await sendMessage("stop-sender-2", "stop-recv-2", "one and done", senderTok);

    const env = {
      RELAY_AGENT_NAME: "stop-recv-2",
      RELAY_AGENT_TOKEN: recvTok,
      RELAY_HTTP_HOST: "127.0.0.1",
      RELAY_HTTP_PORT: String(port),
      RELAY_DB_PATH: TEST_DB_PATH,
    };
    const r1 = await runHook(env);
    expect(r1.stdout).not.toBe("");
    expect(r1.stdout).toContain("one and done");

    const r2 = await runHook(env);
    expect(r2.code).toBe(0);
    expect(r2.stdout).toBe("");
  });
});

describe("Stop hook — graceful degradation", () => {
  it("(4) unreachable relay AND unreachable DB → silent exit within ~3s, empty stdout", async () => {
    const r = await runHook({
      RELAY_AGENT_NAME: "stop-gone",
      RELAY_AGENT_TOKEN: "AAAAAAAAAAAAAAAAAAAAAAAA",
      RELAY_HTTP_HOST: "127.0.0.1",
      RELAY_HTTP_PORT: "1",
      RELAY_DB_PATH: "/tmp/bot-relay-stop-hook-test-does-not-exist-" + process.pid + "/relay.db",
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.durationMs).toBeLessThan(3500);
  });

  it("(5) missing token → falls back to sqlite direct, still emits hookEventName 'Stop'", async () => {
    const senderTok = await registerWithToken("stop-sender-3", []);
    await registerWithToken("stop-recv-3", []);
    await sendMessage("stop-sender-3", "stop-recv-3", "sqlite delivery", senderTok);

    const r = await runHook({
      RELAY_AGENT_NAME: "stop-recv-3",
      // RELAY_AGENT_TOKEN intentionally unset
      RELAY_DB_PATH: TEST_DB_PATH,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toBe("");
    const parsed = JSON.parse(r.stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("Stop");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("sqlite delivery");
  });

  it("(7) missing RELAY_AGENT_NAME → silent exit 0, empty stdout", async () => {
    const r = await runHook({
      RELAY_DB_PATH: TEST_DB_PATH,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("(8) invalid token shape (contains whitespace) → falls back to sqlite, empty mailbox = empty stdout", async () => {
    await registerWithToken("stop-badtok", []);
    const r = await runHook({
      RELAY_AGENT_NAME: "stop-badtok",
      RELAY_AGENT_TOKEN: "invalid token with spaces",
      RELAY_HTTP_HOST: "127.0.0.1",
      RELAY_HTTP_PORT: String(port),
      RELAY_DB_PATH: TEST_DB_PATH,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });
});

describe("Stop hook — behavioral invariants", () => {
  it("(6) does NOT re-register: capabilities and role unchanged after firing", async () => {
    const senderTok = await registerWithToken("stop-sender-4", []);
    const recvTok = await registerWithToken("stop-recv-4", ["messaging", "observer"]);
    await sendMessage("stop-sender-4", "stop-recv-4", "peek-at-turn-end", senderTok);

    const before = await mcpCall({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "discover_agents", arguments: { agent_token: recvTok } },
    });
    const beforeList = JSON.parse(before.result.content[0].text).agents as Array<{ name: string; role: string; capabilities: string[] }>;
    const beforeSelf = beforeList.find((a) => a.name === "stop-recv-4")!;
    expect(beforeSelf).toBeTruthy();

    const r = await runHook({
      RELAY_AGENT_NAME: "stop-recv-4",
      RELAY_AGENT_TOKEN: recvTok,
      RELAY_HTTP_HOST: "127.0.0.1",
      RELAY_HTTP_PORT: String(port),
      RELAY_DB_PATH: TEST_DB_PATH,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("peek-at-turn-end");

    const after = await mcpCall({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "discover_agents", arguments: { agent_token: recvTok } },
    });
    const afterList = JSON.parse(after.result.content[0].text).agents as Array<{ name: string; role: string; capabilities: string[] }>;
    const afterSelf = afterList.find((a) => a.name === "stop-recv-4")!;

    expect(afterSelf.role).toBe(beforeSelf.role);
    expect(afterSelf.capabilities).toEqual(beforeSelf.capabilities);
  });
});
