// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0036 S3-lite — the SessionStart hook takes its identity from the BIND
 * RESULT (victra rulings A and B, provisional pending architect).
 *
 * A (architect ruling: RESOLVE FIRST, ACT ONCE): bind runs FIRST and its result
 *    is the only name every later step uses. The hook used to register as the env
 *    name ("default" for an `ai` window) BEFORE bind: two name sources in one run,
 *    and a register before the takeover was adjudicated. Now a claim makes the hook
 *    X with NO register (the rebind was the identity write); a named launch intent
 *    registers; a transient registers nothing; if bind cannot run, only a REAL env
 *    name is used, loudly.
 * B: a window that is nobody (no env name, no spawn manifest, no config default)
 *    no longer registers the shared "default" row (measured live today, pid 94194,
 *    with unnamed `ai` windows piling into it). It gets a transient LABEL in
 *    agent_bindings only, and the hook says plainly that it has no relay identity.
 *    That includes an explicit RELAY_AGENT_NAME=default (architect: never register
 *    default).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { getFreePort } from "./_helpers/port.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.join(os.tmpdir(), `bot-relay-s3lite-hookid-${process.pid}`);
const FAKE_REPO = path.join(ROOT, "bot-relay-mcp");
const HOOK = path.join(FAKE_REPO, "hooks", "check-relay.sh");
const DB = path.join(ROOT, "relay.db");
process.env.RELAY_DB_PATH = DB;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;

const DETECTED = (await import("../src/liveness.js")).detectAgentProcess();
const ANCHOR_PID = DETECTED?.pid ?? process.pid;
const DEAD_PID = 2_147_483_646;
const C = "c1c1c1c1-1111-2222-3333-444444444444";

async function stubDaemon(): Promise<{ port: number; calls: string[]; close: () => Promise<void> }> {
  const port = await getFreePort();
  const calls: string[] = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      try {
        const n = (JSON.parse(body) as { params?: { name?: string; arguments?: { name?: string } } }).params;
        if (n?.name) calls.push(`${n.name}:${n.arguments?.name ?? ""}`);
      } catch {
        /* GET /health */
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "{}" }] }, status: "ok" }));
    });
  });
  await new Promise<void>((r) => srv.listen(port, "127.0.0.1", () => r()));
  return { port, calls, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

function runHook(port: number, source: string, env: Record<string, string | undefined> = {}): Promise<{ stdout: string; stderr: string }> {
  const base: Record<string, string> = {
    HOME: ROOT,
    PATH: process.env.PATH || "/usr/bin:/bin",
    RELAY_DB_PATH: DB,
    RELAY_AGENT_ROLE: "builder",
    RELAY_AGENT_CAPABILITIES: "",
    RELAY_AGENT_TOKEN: "",
    RELAY_HTTP_HOST: "127.0.0.1",
    RELAY_HTTP_PORT: String(port),
    CLAUDE_PID: String(ANCHOR_PID),
  };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return new Promise((resolve) => {
    const child = spawn("bash", [HOOK], { env: base });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", () => resolve({ stdout, stderr }));
    child.stdin.end(
      JSON.stringify({ session_id: C, transcript_path: `${ROOT}/t.jsonl`, cwd: path.join(ROOT, "proj"), hook_event_name: "SessionStart", source }),
    );
  });
}

beforeEach(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(ROOT, "proj"), { recursive: true, mode: 0o700 });
  fs.cpSync(path.join(REPO_ROOT, "hooks"), path.join(FAKE_REPO, "hooks"), { recursive: true });
  fs.symlinkSync(path.join(REPO_ROOT, "bin"), path.join(FAKE_REPO, "bin"), "dir");
  fs.symlinkSync(path.join(REPO_ROOT, "dist"), path.join(FAKE_REPO, "dist"), "dir");
  fs.writeFileSync(
    path.join(ROOT, ".claude.json"),
    JSON.stringify({ mcpServers: { "bot-relay": { type: "stdio", command: "node", args: [path.join(REPO_ROOT, "dist", "index.js")] } } }),
  );
  const { closeDb, getDb } = await import("../src/db.js");
  closeDb();
  process.env.RELAY_DB_PATH = DB;
  getDb();
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db.js");
  closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

async function withStub<T>(fn: (d: { port: number; calls: string[] }) => Promise<T>): Promise<T> {
  const d = await stubDaemon();
  try {
    return await fn(d);
  } finally {
    await d.close();
  }
}

describe("S3-lite ruling B — a window that is nobody does not register as 'default'", () => {
  it("unnamed: NO register_agent, NO 'default' mailbox, and it says it has no relay identity", async () => {
    await withStub(async (d) => {
      const r = await runHook(d.port, "startup", { RELAY_AGENT_NAME: undefined });
      expect(d.calls.filter((c) => c.startsWith("register_agent")), r.stdout + r.stderr).toEqual([]);
      expect(r.stdout).not.toMatch(/Pending messages for default/);
      expect(r.stdout).toMatch(/no relay identity/i);
      expect(r.stdout).toMatch(/tmp:proj:[0-9a-f]{4}/);
    });
  }, 30_000);

  it("CONTROL: a named window still registers under its name", async () => {
    await withStub(async (d) => {
      await runHook(d.port, "startup", { RELAY_AGENT_NAME: "hook-named" });
      expect(d.calls).toContain("register_agent:hook-named");
    });
  }, 30_000);

  it("an EXPLICIT RELAY_AGENT_NAME=default is nobody too: architect ruled 'never register default'", async () => {
    await withStub(async (d) => {
      const r = await runHook(d.port, "startup", { RELAY_AGENT_NAME: "default" });
      expect(d.calls.filter((c) => c.startsWith("register_agent")), r.stdout + r.stderr).toEqual([]);
      expect(r.stdout).toMatch(/no relay identity/i);
    });
  }, 30_000);
});

describe("S3-lite ruling A — after a claim, the hook IS the claimed identity", () => {
  it("unnamed /resume of a dead holder's conversation: 'reclaimed X', X's mail, never 'default', no register", async () => {
    const { getOwnHostId } = await import("../src/liveness.js");
    process.env.RELAY_DB_PATH = DB;
    const { registerAgent, sendMessage, upsertAgentBinding, closeDb, getDb } = await import("../src/db.js");
    registerAgent("hook-x", "builder", []);
    registerAgent("hook-sender", "builder", []);
    sendMessage("hook-sender", "hook-x", "welcome back, hook-x", "normal");
    getDb().prepare("UPDATE agents SET agent_pid = ?, agent_pid_start = ?, host_id = ? WHERE name = ?").run(
      DEAD_PID,
      "Mon Sep 15 10:00:00 2026",
      getOwnHostId(),
      "hook-x",
    );
    upsertAgentBinding(getDb(), {
      hostId: getOwnHostId()!,
      windowPid: DEAD_PID,
      windowPidStart: "Mon Sep 15 10:00:00 2026",
      agentName: "hook-x",
      agentClass: null,
      conversationId: C,
      conversationTitle: null,
      cwd: "/tmp/old",
      boundVia: "launch-intent",
    });
    closeDb();

    await withStub(async (d) => {
      const r = await runHook(d.port, "resume", { RELAY_AGENT_NAME: undefined });
      expect(r.stdout, r.stderr).toMatch(/reclaimed hook-x/);
      expect(r.stdout).toMatch(/Pending messages for hook-x/);
      expect(r.stdout).toContain("welcome back, hook-x");
      expect(r.stdout).not.toMatch(/for default/);
      expect(d.calls.filter((c) => c.startsWith("register_agent"))).toEqual([]);
    });
  }, 30_000);
});

describe("S3-lite ruling A — when bind cannot run, only a REAL launch-intent name is used, loudly", () => {
  async function breakBind(): Promise<void> {
    // A below-range schema: bind refuses (schema not migrated) before recording.
    const { closeDb, getDb } = await import("../src/db.js");
    closeDb();
    process.env.RELAY_DB_PATH = DB;
    getDb().prepare("UPDATE schema_info SET version = 24 WHERE id = 1").run();
    closeDb();
  }

  it("named window + bind refused → registers its launch intent, says so on stdout, verdict DEGRADED naming bind", async () => {
    await breakBind();
    await withStub(async (d) => {
      const r = await runHook(d.port, "startup", { RELAY_AGENT_NAME: "hook-fallback" });
      expect(d.calls).toContain("register_agent:hook-fallback");
      expect(r.stdout).toMatch(/launch intent ALONE/);
      expect(r.stdout).toMatch(/VERDICT=DEGRADED reason="[^"]*bind[^"]*"/);
    });
  }, 30_000);

  it("UNNAMED window + bind refused → registers NOTHING (never falls back to 'default')", async () => {
    await breakBind();
    await withStub(async (d) => {
      const r = await runHook(d.port, "startup", { RELAY_AGENT_NAME: undefined });
      expect(d.calls.filter((c) => c.startsWith("register_agent")), r.stdout + r.stderr).toEqual([]);
      expect(r.stdout).not.toMatch(/Pending messages for default/);
    });
  }, 30_000);
});
