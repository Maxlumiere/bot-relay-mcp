// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Integration tests for hooks/stop-check.sh (v2.23 read-only wake rewrite).
 *
 * Spins up a real HTTP relay on a random port, registers a real agent with a
 * token, sends messages, then invokes the stop hook script as a subprocess
 * with controlled env vars + stdin payload and inspects stdout / stderr /
 * timing / DB state.
 *
 * THE CONTRACT UNDER TEST (and why it inverted from the original):
 * `additionalContext` on a Stop hook does not wake the agent — it queues for
 * a next turn that may never come. The original hook marked mail READ while
 * emitting it, which is a silent data-loss path (dropped-as-read on session
 * death, invisible to Sentinel). The rewrite emits decision:"block" (the only
 * Stop output that forces immediate continuation) and NEVER writes: content
 * delivery rides the agent's own authenticated get_messages call.
 *
 * Every delivery test therefore asserts the double invariant:
 *   1. the wake fired (or was suppressed by exactly the guard under test), AND
 *   2. the mail is STILL PENDING in the DB — the hook consumed nothing.
 * Plus a CONTROL that runs a legacy-shaped destructive hook against the same
 * fixture and watches it consume mail without a wake — proving the defect the
 * rewrite removes is real and these assertions can fail.
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
// Isolated HOME so the damper's ~/.bot-relay/hook-state files never touch the
// operator's real home, and so no real vault can leak a token into a test.
const TEST_HOME = path.join(TEST_DB_DIR, "home");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
// v2.1.3 I8: scrub inherited RELAY_AGENT_* env vars so isolated tests
// do not auth against a parent-shell spawn-agent.sh token.
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
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

async function sendMessage(from: string, to: string, content: string, fromToken: string, priority: "normal" | "high" = "normal"): Promise<void> {
  await mcpCall({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "send_message",
      arguments: { from, to, content, priority, agent_token: fromToken },
    },
  });
}

/** Direct read-only DB probe: how many PENDING messages does the agent have? */
function pendingCount(agent: string): number {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Better = require("better-sqlite3");
  const db = new Better(TEST_DB_PATH, { readonly: true });
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE to_agent = ? AND status = 'pending'")
      .get(agent) as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

function runHook(
  env: Record<string, string | undefined>,
  opts: { stdinPayload?: string; script?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const finalEnv: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: TEST_HOME,
      // Default the damper OFF so each test opts in explicitly; a hidden
      // 120s damper would make unrelated tests order-dependent.
      RELAY_STOP_WAKE_DAMPER_SECS: "0",
    };
    for (const [k, v] of Object.entries(env)) {
      if (v !== undefined) finalEnv[k] = v;
    }
    const child = cp.spawn("bash", [opts.script ?? HOOK_SCRIPT], { env: finalEnv });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("exit", (code) => resolve({ code, stdout, stderr, durationMs: Date.now() - start }));
    child.on("error", reject);
    // Mirror the harness: write the hook payload (if any) and CLOSE stdin.
    // An open stdin would make the hook's bounded `read -t` wait out its
    // timeout on every invocation.
    if (opts.stdinPayload !== undefined) child.stdin.write(opts.stdinPayload);
    child.stdin.end();
  });
}

beforeAll(async () => {
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  fs.mkdirSync(TEST_HOME, { recursive: true });
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

describe("Stop hook — read-only wake, HTTP path (preferred)", () => {
  it("(1) pending mail → decision:'block' wake, and the mail is STILL PENDING", async () => {
    const senderTok = await registerWithToken("stop-sender-1", []);
    const recvTok = await registerWithToken("stop-recv-1", []);
    await sendMessage("stop-sender-1", "stop-recv-1", "after text-only turn", senderTok);
    expect(pendingCount("stop-recv-1")).toBe(1);

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
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("[RELAY]");
    expect(parsed.reason).toContain("stop-sender-1");
    expect(parsed.reason).toContain('get_messages(agent_name="stop-recv-1"');
    // The wake must NOT carry the body — content delivery belongs to the
    // agent's own authenticated get_messages call.
    expect(parsed.reason).not.toContain("after text-only turn");
    // THE INVARIANT: waking consumed nothing.
    expect(pendingCount("stop-recv-1")).toBe(1);
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

  it("(3) NOT consume-on-fire: with the damper off, a second run wakes AGAIN for the same mail", async () => {
    // The original hook's "idempotency" was consumption: run two returned
    // empty BECAUSE run one marked the mail read without delivering it.
    // The rewrite inverts that: same mail, same wake, until the AGENT drains
    // it — that is what read-must-mean-received looks like from the hook.
    const senderTok = await registerWithToken("stop-sender-2", []);
    const recvTok = await registerWithToken("stop-recv-2", []);
    await sendMessage("stop-sender-2", "stop-recv-2", "one and NOT done", senderTok);

    const env = {
      RELAY_AGENT_NAME: "stop-recv-2",
      RELAY_AGENT_TOKEN: recvTok,
      RELAY_HTTP_HOST: "127.0.0.1",
      RELAY_HTTP_PORT: String(port),
      RELAY_DB_PATH: TEST_DB_PATH,
    };
    const r1 = await runHook(env);
    expect(JSON.parse(r1.stdout).decision).toBe("block");
    const r2 = await runHook(env);
    expect(JSON.parse(r2.stdout).decision).toBe("block");
    expect(pendingCount("stop-recv-2")).toBe(1);
  });
});

describe("Stop hook — loop guards (suppression must never consume)", () => {
  it("(4) stop_hook_active:true on stdin → no wake, mail still pending", async () => {
    const senderTok = await registerWithToken("stop-sender-5", []);
    const recvTok = await registerWithToken("stop-recv-5", []);
    await sendMessage("stop-sender-5", "stop-recv-5", "arrived during forced continuation", senderTok);

    const r = await runHook(
      {
        RELAY_AGENT_NAME: "stop-recv-5",
        RELAY_AGENT_TOKEN: recvTok,
        RELAY_HTTP_HOST: "127.0.0.1",
        RELAY_HTTP_PORT: String(port),
        RELAY_DB_PATH: TEST_DB_PATH,
      },
      { stdinPayload: JSON.stringify({ session_id: "s1", stop_hook_active: true }) },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(pendingCount("stop-recv-5")).toBe(1);
  });

  it("(5) damper: second run inside the window is suppressed; mail still pending; window expiry re-arms", async () => {
    const senderTok = await registerWithToken("stop-sender-6", []);
    const recvTok = await registerWithToken("stop-recv-6", []);
    await sendMessage("stop-sender-6", "stop-recv-6", "damped", senderTok);

    const env = {
      RELAY_AGENT_NAME: "stop-recv-6",
      RELAY_AGENT_TOKEN: recvTok,
      RELAY_HTTP_HOST: "127.0.0.1",
      RELAY_HTTP_PORT: String(port),
      RELAY_DB_PATH: TEST_DB_PATH,
      RELAY_STOP_WAKE_DAMPER_SECS: "3600",
    };
    const r1 = await runHook(env);
    expect(JSON.parse(r1.stdout).decision).toBe("block");
    const r2 = await runHook(env);
    expect(r2.stdout).toBe("");
    expect(pendingCount("stop-recv-6")).toBe(1);

    // Expire the window by backdating the state file — the wake re-arms.
    const stateFile = path.join(TEST_HOME, ".bot-relay", "hook-state", "stop-wake-stop-recv-6");
    expect(fs.existsSync(stateFile)).toBe(true);
    const past = new Date(Date.now() - 4000 * 1000);
    fs.utimesSync(stateFile, past, past);
    const r3 = await runHook(env);
    expect(JSON.parse(r3.stdout).decision).toBe("block");
    expect(pendingCount("stop-recv-6")).toBe(1);
  });
});

describe("Stop hook — graceful degradation", () => {
  it("(6) unreachable relay AND unreachable DB → silent exit within ~3s, empty stdout", async () => {
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

  it("(7) missing token → sqlite peek fallback still wakes, and consumes nothing", async () => {
    const senderTok = await registerWithToken("stop-sender-3", []);
    await registerWithToken("stop-recv-3", []);
    await sendMessage("stop-sender-3", "stop-recv-3", "sqlite wake", senderTok, "high");

    const r = await runHook({
      RELAY_AGENT_NAME: "stop-recv-3",
      // RELAY_AGENT_TOKEN intentionally unset
      RELAY_DB_PATH: TEST_DB_PATH,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toBe("");
    const parsed = JSON.parse(r.stdout);
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("high priority");
    expect(pendingCount("stop-recv-3")).toBe(1);
  });

  it("(8) missing RELAY_AGENT_NAME → silent exit 0, empty stdout", async () => {
    const r = await runHook({
      RELAY_DB_PATH: TEST_DB_PATH,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("(9) invalid token shape (contains whitespace) → falls back to sqlite, empty mailbox = empty stdout", async () => {
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
  it("(10) does NOT re-register: capabilities and role unchanged after firing", async () => {
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
    expect(JSON.parse(r.stdout).decision).toBe("block");

    const after = await mcpCall({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "discover_agents", arguments: { agent_token: recvTok } },
    });
    const afterList = JSON.parse(after.result.content[0].text).agents as Array<{ name: string; role: string; capabilities: string[] }>;
    const afterSelf = afterList.find((a) => a.name === "stop-recv-4")!;

    expect(afterSelf.role).toBe(beforeSelf.role);
    expect(afterSelf.capabilities).toEqual(beforeSelf.capabilities);
  });

  it("(11) STRUCTURAL: the script contains no UPDATE statement — the write path is gone, not disabled", () => {
    const src = fs.readFileSync(HOOK_SCRIPT, "utf8");
    expect(src).not.toMatch(/UPDATE\s+messages/i);
    // And the sqlite CLI is opened read-only, so even a future stray
    // statement could not silently mutate.
    expect(src).toContain("sqlite3 -readonly");
  });
});

describe("CONTROL — the legacy destructive shape really does lose mail (proves the invariant assertions can fail)", () => {
  it("(12) legacy-shaped hook consumes pending mail while emitting a non-waking additionalContext", async () => {
    const senderTok = await registerWithToken("stop-sender-7", []);
    await registerWithToken("stop-recv-7", []);
    await sendMessage("stop-sender-7", "stop-recv-7", "will be dropped-as-read", senderTok);
    expect(pendingCount("stop-recv-7")).toBe(1);

    // A minimal reproduction of the pre-rewrite sqlite path: SELECT, mark
    // read, emit continue:true + additionalContext (which does not wake).
    const legacy = path.join(TEST_DB_DIR, "legacy-stop-check.sh");
    fs.writeFileSync(
      legacy,
      `#!/bin/bash
ROWS=$(sqlite3 "$RELAY_DB_PATH" "SELECT id FROM messages WHERE to_agent = '$RELAY_AGENT_NAME' AND status = 'pending';")
[ -z "$ROWS" ] && exit 0
for id in $ROWS; do
  sqlite3 "$RELAY_DB_PATH" "UPDATE messages SET status = 'read' WHERE id = '$id' AND status = 'pending';"
done
printf '{"continue": true, "hookSpecificOutput": {"hookEventName": "Stop", "additionalContext": "[RELAY] mail was here"}}'
exit 0
`,
      { mode: 0o755 },
    );

    const r = await runHook(
      {
        RELAY_AGENT_NAME: "stop-recv-7",
        RELAY_DB_PATH: TEST_DB_PATH,
      },
      { script: legacy },
    );
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    // No decision:"block" → per the verified Stop contract, nothing wakes...
    expect(parsed.decision).toBeUndefined();
    // ...and yet the mail is gone from every floor path's view. This is the
    // silent data-loss window the rewrite removes; if the real hook ever
    // regresses to consuming, tests (1)/(3)/(4)/(5)/(7) fail on exactly the
    // assertion this control proves is falsifiable.
    expect(pendingCount("stop-recv-7")).toBe(0);
  });
});
