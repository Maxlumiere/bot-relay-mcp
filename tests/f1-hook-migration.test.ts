// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * F1 hook migration (ADR-0044 point 6; architect ruling 89ee30db, 28 Sep).
 *
 * THE READ PATH IS CHOSEN BY CONFIGURATION, NEVER BY FAILURE:
 *   - LOCAL mode (a local instance DB is configured): the mail read is
 *     `relay pending AGENT --json` (F1) and nothing else. A read that fails is
 *     LOUD ("relay unreadable") and NEVER falls back to HTTP.
 *   - REMOTE mode (no local instance; RELAY_HTTP_HOST configured): the HTTP
 *     get_messages peek, LABELED "via remote relay" in what the agent sees. It
 *     still stamps `seq` (the ADR-0044 residual, a known limit for remote-only
 *     setups until a remote F1 equivalent exists).
 *   - Neither: no read, no request, CANNOT-JUDGE (no judgement was made).
 * A LOCAL read that failed is a concluded fault: DEGRADED, "relay unreadable: <why>"
 * (the verdict contract shared by all three hooks, documented in hooks/_verdict.sh).
 *
 * HARM TEST: in local mode the hook makes ZERO HTTP requests, whether the DB is
 * readable or not. The fixture points RELAY_HTTP_HOST/PORT at a COUNTING STUB that
 * would answer a get_messages peek with a plausible message, so a hook that fell
 * back to HTTP would both be counted and show the stub's sender. The PostToolUse
 * liveness self-heal (a WRITE, which only the daemon may do) is out of the rule's
 * scope; its anchor is pinned to this process so it stays a no-op, and a separate
 * mismatched-anchor case proves the stub IS reachable (non-vacuous) while no
 * request names get_messages.
 *
 * The stub is an in-process server, so every hook run is an ASYNC spawn: a
 * spawnSync would block the event loop, the stub could not answer, and a
 * fallback would fail silently, making the harm test pass vacuously.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import cp from "child_process";
import { fileURLToPath } from "url";
import type { Server as HttpServer } from "http";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HOOKS_DIR = path.resolve(__dirname, "..", "hooks");
const PTU_HOOK = path.join(HOOKS_DIR, "post-tool-use-check.sh");
const STOP_HOOK = path.join(HOOKS_DIR, "stop-check.sh");

const TEST_DIR = path.join(os.tmpdir(), "bot-relay-f1-hooks-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_ALLOW_LEGACY;
delete process.env.RELAY_HTTP_SECRET;
delete process.env.RELAY_INSTANCE_ID;

const { startHttpServer } = await import("../src/transport/http.js");
const { closeDb, getDb, sendMessage: dbSend, registerAgent: dbRegister } = await import("../src/db.js");

let relay: HttpServer;
let relayPort: number;

interface StubRequest {
  method: string;
  url: string;
  body: string;
}
let stub: HttpServer;
let stubPort: number;
const stubRequests: StubRequest[] = [];

const STUB_SENDER = "stub-sender";
/** What the stub answers a tool call with: a plausible page, or a tool error in either shape. */
// is-error / error-json: Codex's measured shapes. The *-page modes ISOLATE each check:
// a body that is otherwise a valid EMPTY page, so only that one check stands between
// a tool error and a "verified empty" mailbox.
let stubMode: "ok" | "is-error" | "error-json" | "is-error-page" | "error-code-page" | "bool-total" | "pos-total-empty" | "neg-total" = "ok";

/** A counting stand-in for a daemon: answers /health and any /mcp call with ONE plausible pending message. */
function startStub(): Promise<void> {
  stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      stubRequests.push({ method: req.method ?? "", url: req.url ?? "", body });
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (stubMode !== "ok") {
        const emptyPage = { messages: [], count: 0, total_pending: 0, since_bound: null };
        const body =
          stubMode === "bool-total"
            ? { messages: [], total_pending: false }
            : stubMode === "pos-total-empty"
              ? { messages: [], total_pending: 5 }
              : stubMode === "neg-total"
                ? { messages: [], total_pending: -1 }
                : stubMode === "is-error-page"
            ? emptyPage
            : stubMode === "error-code-page"
              ? { ...emptyPage, error_code: "AUTH_FAILED" }
              : { error_code: "AUTH_FAILED", error: "stub: token rejected" };
        const text = JSON.stringify(body);
        const flagged = stubMode === "is-error" || stubMode === "is-error-page";
        // (The bounds modes are NOT tool errors: a well-formed result whose page cannot be true.)
        const result = flagged ? { isError: true, content: [{ type: "text", text }] } : { content: [{ type: "text", text }] };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
        return;
      }
      const inner = {
        messages: [
          { id: "stub-1", from_agent: STUB_SENDER, priority: "high", created_at: new Date().toISOString(), content: "x" },
        ],
        count: 1,
        total_pending: 1,
        since_bound: null,
        success: true,
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(inner) }] } }));
    });
  });
  return new Promise((r) => stub.listen(0, "127.0.0.1", () => r()));
}

function takeStubRequests(): StubRequest[] {
  return stubRequests.splice(0, stubRequests.length);
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runHook(script: string, env: Record<string, string | undefined>, stdin: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const finalEnv: Record<string, string> = { PATH: process.env.PATH ?? "" };
    for (const [k, v] of Object.entries(env)) if (v !== undefined) finalEnv[k] = v;
    const child = cp.spawn("bash", [script], { env: finalEnv });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
    child.on("error", reject);
    child.stdin.end(stdin);
  });
}

const PTU_STDIN = JSON.stringify({
  session_id: "f1f1f1f1-0000-0000-0000-000000000001",
  hook_event_name: "PostToolUse",
  tool_name: "Read",
  tool_input: {},
  tool_response: {},
});
const STOP_STDIN = JSON.stringify({ session_id: "f1f1f1f1-0000-0000-0000-000000000002", stop_hook_active: false });

/** A fresh HOME with NO relay instance in it (no ~/.bot-relay/relay.db, no active-instance marker). */
function freshHome(tag: string): string {
  const h = path.join(TEST_DIR, "home-" + tag);
  fs.mkdirSync(h, { recursive: true });
  return h;
}

/**
 * The (pid, start) the hook's liveness self-heal will compute for itself: the
 * helper walks up from ITS parent, which is this test process for both this probe
 * and the hook run. Pinning the stored anchor to it makes the self-heal a no-op.
 */
function hookAnchor(): { pid: number; start: string } {
  const out = cp.execFileSync(
    "bash",
    ["-c", `. "${path.join(HOOKS_DIR, "_vault-helpers.sh")}"; p=$(relay_agent_pid); printf '%s\\x1f%s' "$p" "$(relay_pid_start "$p")"`],
    { encoding: "utf-8" },
  );
  const [pid, start] = out.split("\x1f");
  return { pid: Number(pid), start };
}

function seedAgent(name: string, anchor: "match" | "mismatch" = "match"): string {
  const token = dbRegister(name, "r", []).plaintext_token as string;
  const a = hookAnchor();
  expect(a.pid, "precondition: the helper found an agent process to anchor").toBeGreaterThan(1);
  getDb()
    .prepare("UPDATE agents SET agent_pid = ?, agent_pid_start = ? WHERE name = ?")
    .run(anchor === "match" ? a.pid : 999_999, anchor === "match" ? a.start : "never", name);
  return token;
}

function seqOf(to: string): Array<number | null> {
  return (getDb().prepare("SELECT seq FROM messages WHERE to_agent = ?").all(to) as Array<{ seq: number | null }>).map(
    (r) => r.seq,
  );
}

function localEnv(name: string, token: string, home: string, dbPath = TEST_DB_PATH): Record<string, string> {
  return {
    HOME: home,
    RELAY_AGENT_NAME: name,
    RELAY_AGENT_TOKEN: token,
    RELAY_HTTP_HOST: "127.0.0.1",
    RELAY_HTTP_PORT: String(stubPort),
    RELAY_DB_PATH: dbPath,
    RELAY_HOOK_NOTICE_REMIND_SECS: "0",
    RELAY_STOP_WAKE_DAMPER_SECS: "0",
  };
}

function ptuContext(r: RunResult): string {
  expect(r.stdout, "expected a PostToolUse notice on stdout").not.toBe("");
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string;
}

beforeAll(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  relay = startHttpServer(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 100));
  const addr = relay.address();
  relayPort = typeof addr === "object" && addr ? addr.port : 0;
  await startStub();
  const sa = stub.address();
  stubPort = typeof sa === "object" && sa ? sa.port : 0;
});

afterAll(() => {
  relay.close();
  stub.close();
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("F1 hook migration — PostToolUse, LOCAL mode: F1 only, ZERO HTTP requests", () => {
  it("HARM (readable DB): the notice comes from F1, the stub gets zero requests, and seq stays NULL", async () => {
    dbRegister("f1h-sender-1", "r", []);
    const t = seedAgent("f1h-recv-1");
    dbSend("f1h-sender-1", "f1h-recv-1", "local mail", "normal");
    takeStubRequests();

    const r = await runHook(PTU_HOOK, localEnv("f1h-recv-1", t, freshHome("p1")), PTU_STDIN);
    const ctx = ptuContext(r);
    expect(ctx).toMatch(/^relay: 1 unread for f1h-recv-1/);
    expect(ctx).toContain("f1h-sender-1");
    expect(ctx).not.toContain(STUB_SENDER);
    expect(ctx).not.toContain("via remote relay");
    expect(takeStubRequests(), "local mode must make ZERO HTTP requests").toEqual([]);
    // The ADR-0044 residual is GONE on the local path: F1 is a pure SELECT.
    expect(seqOf("f1h-recv-1")).toEqual([null]);
  });

  // An unreadable DB means the stored anchor is UNKNOWN, and an unknown anchor is
  // cannot-judge, never a mismatch: the self-heal must not fire either (ruling 0bab3b46).
  for (const anchor of ["match", "mismatch"] as const) {
    it(`HARM (unreadable DB: not a sqlite file; anchor ${anchor}): LOUD, and still ZERO HTTP requests`, async () => {
      const name = `f1h-recv-2${anchor[0]}`;
      const t = seedAgent(name, anchor);
      const corrupt = path.join(TEST_DIR, `corrupt-${anchor}.db`);
      fs.writeFileSync(corrupt, "this is not a sqlite database, it is a trap\n".repeat(200));
      takeStubRequests();

      const r = await runHook(PTU_HOOK, localEnv(name, t, freshHome("p2" + anchor), corrupt), PTU_STDIN);
      expect(takeStubRequests(), "an unreadable local DB must NEVER lead to an HTTP request").toEqual([]);
      const ctx = ptuContext(r);
      expect(ctx).toMatch(/relay unreadable/);
      expect(ctx).not.toContain(STUB_SENDER);
      expect(r.stderr).toMatch(/VERDICT=DEGRADED reason="relay unreadable: /);
    });
  }

  it("HARM (configured local DB is missing): LOUD, and still ZERO HTTP requests", async () => {
    const t = seedAgent("f1h-recv-3");
    takeStubRequests();

    const r = await runHook(PTU_HOOK, localEnv("f1h-recv-3", t, freshHome("p3"), path.join(TEST_DIR, "absent.db")), PTU_STDIN);
    expect(takeStubRequests(), "a missing configured DB must NEVER switch to HTTP").toEqual([]);
    expect(ptuContext(r)).toMatch(/relay unreadable/);
    expect(r.stderr).toMatch(/VERDICT=DEGRADED reason="relay unreadable: /);
  });

  it("NON-VACUOUS: with a MISMATCHED anchor the stub IS reached, and only by the self-heal write; no request names get_messages", async () => {
    dbRegister("f1h-sender-4", "r", []);
    const t = seedAgent("f1h-recv-4", "mismatch");
    dbSend("f1h-sender-4", "f1h-recv-4", "local mail 4", "normal");
    takeStubRequests();

    const r = await runHook(PTU_HOOK, localEnv("f1h-recv-4", t, freshHome("p4")), PTU_STDIN);
    const reqs = takeStubRequests();
    expect(reqs.length, "precondition: the stub is reachable from the hook").toBeGreaterThan(0);
    for (const q of reqs) {
      const ok = q.url === "/health" || (q.url === "/mcp" && q.body.includes('"report_liveness"'));
      expect(ok, `unexpected request ${q.method} ${q.url} ${q.body.slice(0, 120)}`).toBe(true);
      expect(q.body).not.toContain("get_messages");
    }
    expect(ptuContext(r)).toContain("f1h-sender-4");
  });
});

describe("F1 hook migration — PostToolUse, REMOTE mode twin: the labeled HTTP path", () => {
  it("no local instance + RELAY_HTTP_HOST configured → the notice is labeled 'via remote relay' (and the peek still stamps seq: the known limit)", async () => {
    dbRegister("f1h-sender-5", "r", []);
    const t = seedAgent("f1h-recv-5");
    dbSend("f1h-sender-5", "f1h-recv-5", "remote mail", "normal");

    const r = await runHook(
      PTU_HOOK,
      {
        HOME: freshHome("p5"),
        RELAY_AGENT_NAME: "f1h-recv-5",
        RELAY_AGENT_TOKEN: t,
        RELAY_HTTP_HOST: "127.0.0.1",
        RELAY_HTTP_PORT: String(relayPort),
        RELAY_HOOK_NOTICE_REMIND_SECS: "0",
      },
      PTU_STDIN,
    );
    const ctx = ptuContext(r);
    expect(ctx).toMatch(/via remote relay/);
    expect(ctx).toMatch(/1 unread for f1h-recv-5/);
    expect(ctx).toContain("f1h-sender-5");
    // KNOWN LIMIT for remote-only setups (ADR-0044 residual): the HTTP peek stamps seq.
    expect(seqOf("f1h-recv-5")[0]).not.toBeNull();
  });

  it("NEITHER mode (no local instance, no RELAY_HTTP_HOST): no request, no notice, CANNOT-JUDGE", async () => {
    const t = seedAgent("f1h-recv-6");
    takeStubRequests();
    const r = await runHook(
      PTU_HOOK,
      {
        HOME: freshHome("p6"),
        RELAY_AGENT_NAME: "f1h-recv-6",
        RELAY_AGENT_TOKEN: t,
        // Port only: a host default of 127.0.0.1 would land on the stub and be counted.
        RELAY_HTTP_PORT: String(stubPort),
      },
      PTU_STDIN,
    );
    expect(takeStubRequests()).toEqual([]);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/VERDICT=CANNOT-JUDGE/);
  });
});

describe("F1 hook migration — Stop hook: the same mode rule", () => {
  it("HARM (readable DB): the wake counts the FULL F1 set, the stub gets zero requests, seq stays NULL", async () => {
    dbRegister("f1h-sender-7", "r", []);
    const t = seedAgent("f1h-recv-7");
    for (let i = 0; i < 23; i++) dbSend("f1h-sender-7", "f1h-recv-7", `stop mail ${i}`, "normal");
    takeStubRequests();

    const r = await runHook(STOP_HOOK, localEnv("f1h-recv-7", t, freshHome("s1")), STOP_STDIN);
    expect(takeStubRequests(), "local mode must make ZERO HTTP requests").toEqual([]);
    const out = JSON.parse(r.stdout);
    expect(out.decision).toBe("block");
    // 23, not a 20-row page.
    expect(out.reason).toMatch(/\[RELAY\] 23 pending messages for f1h-recv-7/);
    expect(out.reason).toContain("f1h-sender-7");
    expect(out.reason).not.toContain(STUB_SENDER);
    expect(seqOf("f1h-recv-7").every((s) => s === null)).toBe(true);
  });

  it("HARM (unreadable DB): no block, LOUD on stderr, and ZERO HTTP requests", async () => {
    const t = seedAgent("f1h-recv-8");
    const corrupt = path.join(TEST_DIR, "corrupt-stop.db");
    fs.writeFileSync(corrupt, "not sqlite either\n".repeat(200));
    takeStubRequests();

    const r = await runHook(STOP_HOOK, localEnv("f1h-recv-8", t, freshHome("s2"), corrupt), STOP_STDIN);
    expect(takeStubRequests(), "an unreadable local DB must NEVER switch to HTTP").toEqual([]);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/relay unreadable/);
    expect(r.stderr).toMatch(/VERDICT=DEGRADED reason="relay unreadable: /);
  });

  it("REMOTE twin: the wake is labeled 'via remote relay'", async () => {
    dbRegister("f1h-sender-9", "r", []);
    const t = seedAgent("f1h-recv-9");
    dbSend("f1h-sender-9", "f1h-recv-9", "remote stop mail", "normal");
    const r = await runHook(
      STOP_HOOK,
      {
        HOME: freshHome("s3"),
        RELAY_AGENT_NAME: "f1h-recv-9",
        RELAY_AGENT_TOKEN: t,
        RELAY_HTTP_HOST: "127.0.0.1",
        RELAY_HTTP_PORT: String(relayPort),
        RELAY_STOP_WAKE_DAMPER_SECS: "0",
      },
      STOP_STDIN,
    );
    const out = JSON.parse(r.stdout);
    expect(out.decision).toBe("block");
    expect(out.reason).toMatch(/via remote relay/);
    expect(out.reason).toContain("f1h-sender-9");
  });
});

describe("#286 Codex R1 #4 — a remote TOOL ERROR is never a successful empty read", () => {
  // bool-total / pos-total-empty / neg-total: Codex #286 R2. A boolean is not an integer
  // (Python counts it as one), and an empty page cannot hold a positive or negative total.
  for (const mode of ["is-error", "error-json", "is-error-page", "error-code-page", "bool-total", "pos-total-empty", "neg-total"] as const) {
    for (const [label, hook, stdin] of [["Stop", STOP_HOOK, STOP_STDIN], ["PostToolUse", PTU_HOOK, PTU_STDIN]] as const) {
      it(`${label}: an MCP result [${mode}] is a FAILED read (no HEALTHY), not an empty mailbox`, async () => {
        stubMode = mode;
        try {
          takeStubRequests();
          const r = await runHook(
            hook,
            {
              HOME: freshHome(`r4-${label}-${mode}`),
              RELAY_AGENT_NAME: "f1h-r4",
              RELAY_AGENT_TOKEN: "stubtoken-aaaaaaaaaaaa",
              RELAY_HTTP_HOST: "127.0.0.1",
              RELAY_HTTP_PORT: String(stubPort),
              RELAY_HOOK_NOTICE_REMIND_SECS: "0",
              RELAY_STOP_WAKE_DAMPER_SECS: "0",
            },
            stdin,
          );
          const reqs = takeStubRequests();
          expect(reqs.some((q) => q.body.includes("get_messages")), "precondition: the remote path really asked").toBe(true);
          expect(r.stdout).toBe("");
          expect(r.stderr).not.toMatch(/VERDICT=HEALTHY/);
          expect(r.stderr).toMatch(/VERDICT=CANNOT-JUDGE reason="remote relay read failed/);
        } finally {
          stubMode = "ok";
        }
      });
    }
  }
});

describe("the unresolved name `default` is never an identity: no mail read, no judgement (ADR-0044 point 5)", () => {
  for (const [label, hook, stdin] of [["PostToolUse", PTU_HOOK, PTU_STDIN], ["Stop", STOP_HOOK, STOP_STDIN]] as const) {
    it(`${label}: RELAY_AGENT_NAME=default → no notice, no request, CANNOT-JUDGE (never "relay unreadable")`, async () => {
      takeStubRequests();
      const r = await runHook(hook, { ...localEnv("default", "stubtoken-aaaaaaaaaaaa", freshHome(`dflt-${label}`)) }, stdin);
      expect(r.stdout).toBe("");
      expect(takeStubRequests()).toEqual([]);
      expect(r.stderr).toMatch(/VERDICT=CANNOT-JUDGE reason="agent name unresolved \(default\)/);
    });
  }
});
