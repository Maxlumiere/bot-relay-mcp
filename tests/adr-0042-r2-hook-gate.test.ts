// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0042 R2, the HOOK half: the SessionStart hook's register gate keys on the
 * row's stored ANCHOR, not on last_seen. The old gate (session set AND last_seen
 * < 120s) read a live but QUIET window as STALE, because observation does not bump
 * last_seen, so a second process carrying the name re-registered over the live
 * window. That was the door in the victra case (MEASURED 24 Sep).
 *
 * Now: if the stored anchor is ALIVE and is not this window's, the hook does not
 * attempt the register, says so on stdout, and the verdict names it. The server
 * refuses the same register anyway (tests/adr-0042-r2-no-silent-takeover), so this
 * half is about saying the true thing before trying. The control is a DEAD holder:
 * a relaunch registers as before.
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
const ROOT = path.join(os.tmpdir(), `bot-relay-r2-hook-${process.pid}`);
const FAKE_REPO = path.join(ROOT, "bot-relay-mcp");
const HOOK = path.join(FAKE_REPO, "hooks", "check-relay.sh");
const DB = path.join(ROOT, "relay.db");
process.env.RELAY_DB_PATH = DB;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;

const NAME = "r2-hook-agent";
const DEAD_PID = 2_147_483_646;

async function stubDaemon(): Promise<{ port: number; calls: string[]; close: () => Promise<void> }> {
  const port = await getFreePort();
  const calls: string[] = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      try {
        const n = (JSON.parse(body) as { params?: { name?: string } }).params?.name;
        if (n) calls.push(n);
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

function runHook(port: number, token: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", [HOOK], {
      env: {
        HOME: ROOT,
        PATH: process.env.PATH || "/usr/bin:/bin",
        RELAY_DB_PATH: DB,
        RELAY_AGENT_NAME: NAME,
        RELAY_AGENT_ROLE: "builder",
        RELAY_AGENT_CAPABILITIES: "",
        RELAY_AGENT_TOKEN: token,
        RELAY_HTTP_HOST: "127.0.0.1",
        RELAY_HTTP_PORT: String(port),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", () => resolve({ stdout, stderr }));
    child.stdin.end(JSON.stringify({ session_id: "d0d0d0d0-1111-2222-3333-444444444444", cwd: ROOT, hook_event_name: "SessionStart", source: "startup" }));
  });
}

beforeEach(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
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

/** The row: registered, QUIET (aged last_seen), anchored to `pid`. Returns its token. */
async function quietHeldBy(pid: number, start: string): Promise<string> {
  process.env.RELAY_DB_PATH = DB;
  const db = await import("../src/db.js");
  const { getOwnHostId } = await import("../src/liveness.js");
  const r = db.registerAgent(NAME, "builder", []);
  db.getDb()
    .prepare("UPDATE agents SET agent_pid = ?, agent_pid_start = ?, host_id = ?, last_seen = ? WHERE name = ?")
    .run(pid, start, getOwnHostId(), "2000-01-01T00:00:00.000Z", NAME);
  db.closeDb();
  return r.plaintext_token!;
}

describe("ADR-0042 R2 — the hook's register gate keys on the stored ANCHOR, not last_seen", () => {
  it("a QUIET row held by a LIVE window: this window does not register, says so, and the verdict names it", async () => {
    const { processStartedAt } = await import("../src/liveness.js");
    const holder = process.ppid; // alive, on this host, and not this hook's window
    const token = await quietHeldBy(holder, processStartedAt(holder) ?? "");
    const d = await stubDaemon();
    try {
      const r = await runHook(d.port, token);
      expect(d.calls, r.stdout + r.stderr).not.toContain("register_agent");
      expect(r.stdout).toMatch(/held by a LIVE window/);
      expect(r.stdout).toMatch(/VERDICT=REGISTER_FAILED reason="[^"]*live window[^"]*"/i);
    } finally {
      await d.close();
    }
  }, 30_000);

  it("CONTROL: the same quiet row held by a DEAD window → the relaunch registers", async () => {
    const token = await quietHeldBy(DEAD_PID, "Mon Sep 15 10:00:00 2026");
    const d = await stubDaemon();
    try {
      const r = await runHook(d.port, token);
      expect(d.calls, r.stdout + r.stderr).toContain("register_agent");
    } finally {
      await d.close();
    }
  }, 30_000);
});
