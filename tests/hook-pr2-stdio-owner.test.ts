// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Hook PR 2, as ruled: a STDIO process that owns a wasm DB opens the loopback owner-peek listener (hook PR 1's gated
 * listener, `transport: "stdio"` in the record), so the hooks read its agents' mail over it. Order: lock → DB → listen
 * → record. And (Q8) the wasm liveness self-heal: PostToolUse restamps the agent's anchor through the SAME proved
 * route, gated by a per-(instance, agent) cache instead of a native DB read.
 * - The listener serves GET /owner-id, the get_messages peek, and report_liveness with exactly its keys; anything
 *   else is 403.
 * - A listen failure keeps the stdio server running; the hooks name "the owner has no hook endpoint" (Q5).
 * The TS rows run on every OS; the hook rows run where the bash hooks do (POSIX).
 */
import { describe, it, expect, afterEach, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import http from "http";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";
import { sandboxEnv } from "./_helpers/sandbox-env.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST_INDEX = path.join(REPO, "dist", "index.js");
const DIST_DB = pathToFileURL(path.join(REPO, "dist", "db.js")).href;
const DIST_HTTP = pathToFileURL(path.join(REPO, "dist", "transport", "http.js")).href;
const RELAY = path.join(REPO, "bin", "relay");
const HOOKS = path.join(REPO, "hooks");
const WIN_NO_BASH_HOOKS = process.platform === "win32";
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hookpr2-")));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const AGENT = "pr2-agent";
const SENDER = "pr2-sender";
const procs: ChildProcess[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
});

interface Case {
  home: string;
  dir: string;
  db: string;
  cfg: string;
  record: string;
}
function newCase(tag: string): Case {
  const home = fs.mkdtempSync(path.join(ROOT, `${tag}-`));
  const dir = path.join(home, "inst");
  fs.mkdirSync(dir, { recursive: true });
  const db = path.join(dir, "relay.db");
  return { home, dir, db, cfg: path.join(dir, "config.json"), record: path.join(dir, ".relay.db.relay-owner.json") };
}
const baseEnv = (c: Case, extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const env = sandboxEnv(c.home);
  delete env.RELAY_HOME;
  return { ...env, RELAY_DB_PATH: c.db, RELAY_CONFIG_PATH: c.cfg, RELAY_WAKE_COVERAGE_STATUS_PATH: path.join(c.home, "wc.json"), ...extra };
};
/** A native DB with AGENT and SENDER, one message for AGENT, converted to wasm; the config then declares wasm. */
function seedWasmDb(c: Case, message: string, cfg: Record<string, unknown> = {}): { token: string; senderToken: string } {
  fs.writeFileSync(c.cfg, "{}", { mode: 0o600 });
  const script = path.join(c.home, "seed.mjs");
  fs.writeFileSync(
    script,
    `const db = await import(${JSON.stringify(DIST_DB)});
     const a = db.registerAgent(${JSON.stringify(AGENT)}, "r", []);
     const s = db.registerAgent(${JSON.stringify(SENDER)}, "r", []);
     db.sendMessage(${JSON.stringify(SENDER)}, ${JSON.stringify(AGENT)}, ${JSON.stringify(message)}, "normal");
     db.closeDb();
     process.stdout.write(JSON.stringify({ token: a.plaintext_token, senderToken: s.plaintext_token }));`
  );
  const r = spawnSync(process.execPath, [script], { encoding: "utf-8", env: baseEnv(c) });
  expect(r.status, r.stderr).toBe(0);
  const out = JSON.parse(r.stdout) as { token: string; senderToken: string };
  const conv = spawnSync(process.execPath, [RELAY, "convert-journal", "--to", "wasm"], { encoding: "utf-8", env: baseEnv(c) });
  expect(conv.status, `${conv.stdout}\n${conv.stderr}`).toBe(0);
  fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm", ...cfg }), { mode: 0o600 });
  return out;
}

interface StdioOwner {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
}
/** A STDIO relay process on the case's wasm DB (its stdin held open, as an MCP client would). Resolves once its record names a stdio owner. */
async function startStdioOwner(c: Case): Promise<StdioOwner> {
  const child = spawn(process.execPath, [DIST_INDEX], { env: baseEnv(c, { RELAY_TRANSPORT: "stdio" }), stdio: ["pipe", "pipe", "pipe"] });
  procs.push(child);
  let out = "";
  let err = "";
  child.stdout!.on("data", (d: Buffer) => (out += d));
  child.stderr!.on("data", (d: Buffer) => (err += d));
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    if (child.exitCode !== null) break;
    try {
      const rec = JSON.parse(fs.readFileSync(c.record, "utf-8")) as { pid: number; transport: string };
      if (rec.pid === child.pid && rec.transport === "stdio") return { child, stdout: () => out, stderr: () => err };
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the stdio owner did not write its record (exit ${child.exitCode}):\n${err}`);
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  child.stdin?.end(); // an MCP client closing: the stdio server ends
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
const record = (c: Case) => JSON.parse(fs.readFileSync(c.record, "utf-8")) as { v: number; host: string; port: number; pid: number; key: string; transport: string };
const mac = (key: string, challenge: string, port: number) => crypto.createHmac("sha256", Buffer.from(key, "hex")).update(`${challenge}${port}`).digest("hex");
async function mcpCall(base: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text };
}
const call = (name: string, args: Record<string, unknown>) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
const peekArgs = (token: string) => ({ agent_name: AGENT, status: "pending", limit: 10, peek: true, since: "all", agent_token: token });
/** The agents row, from a COPY of the DB read with sql.js (never an open of the live file; the owner is stopped first). */
async function anchorOf(c: Case, name: string): Promise<{ agent_pid: number | null; agent_pid_start: string | null }> {
  const copy = path.join(c.home, `copy-${crypto.randomBytes(4).toString("hex")}.db`);
  fs.copyFileSync(c.db, copy);
  const initSqlJs = (await import("sql.js")).default;
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(copy));
  const r = db.exec("SELECT agent_pid, agent_pid_start FROM agents WHERE name = ?", [name]);
  db.close();
  const row = r[0]?.values[0] ?? [null, null];
  return { agent_pid: row[0] === null ? null : Number(row[0]), agent_pid_start: row[1] === null ? null : String(row[1]) };
}

describe("hook PR 2: a stdio wasm owner opens the loopback owner-peek listener (every OS)", () => {
  it("lock → DB → listen → record: the record names a stdio owner on 127.0.0.1 (a kernel port) that proves its key; stdout stays MCP-only", async () => {
    const c = newCase("stdio-record");
    seedWasmDb(c, "pr2 record mail");
    const o = await startStdioOwner(c);
    const rec = record(c);
    expect(rec).toMatchObject({ v: 1, host: "127.0.0.1", pid: o.child.pid, transport: "stdio" });
    expect(rec.port).toBeGreaterThan(0);
    const challenge = crypto.randomBytes(16).toString("hex");
    const res = await fetch(`http://127.0.0.1:${rec.port}/owner-id?c=${challenge}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mac: mac(rec.key, challenge, rec.port) });
    expect(o.stdout(), "the listener wrote nothing to the MCP stdout").toBe("");
    await stop(o.child);
    expect(fs.existsSync(c.record), "the record is never deleted").toBe(true);
  }, 90_000);

  it("the stdio listener's gate: the peek and report_liveness (exactly their keys) pass; any other tool, key or type → 403; another agent's token restamps nothing", async () => {
    const c = newCase("stdio-gate");
    const { token, senderToken } = seedWasmDb(c, "pr2 gate mail");
    const o = await startStdioOwner(c);
    const base = `http://127.0.0.1:${record(c).port}`;
    const auth = { "X-Agent-Token": token };
    const peek = await mcpCall(base, call("get_messages", peekArgs(token)), auth);
    expect(peek.status, peek.text).toBe(200);
    expect(peek.text).toContain("pr2 gate mail");
    const live = await mcpCall(base, call("report_liveness", { agent_name: AGENT, agent_pid: 4242, agent_pid_start: "t0", agent_token: token }), auth);
    expect(live.status, live.text).toBe(200);
    expect(live.text).not.toMatch(/"isError":\s*true/);
    for (const [what, body] of [
      ["send_message", call("send_message", { from: AGENT, to: SENDER, content: "x", agent_token: token })],
      ["report_liveness with an extra key", call("report_liveness", { agent_name: AGENT, agent_pid: 4242, agent_token: token, x: 1 })],
      ["report_liveness with a string pid", call("report_liveness", { agent_name: AGENT, agent_pid: "4242", agent_token: token })],
      ["report_liveness without a pid", call("report_liveness", { agent_name: AGENT, agent_token: token })],
      ["get_messages with ack", call("get_messages", { ...peekArgs(token), ack: true })],
    ] as const) {
      const r = await mcpCall(base, body, auth);
      expect(r.status, what).toBe(403);
    }
    // Another agent's token on AGENT's liveness: refused by the tool's own auth (the anchor is not restamped).
    const forged = await mcpCall(base, call("report_liveness", { agent_name: AGENT, agent_pid: 9999, agent_token: senderToken }), { "X-Agent-Token": senderToken });
    expect(forged.text, forged.text).toMatch(/"isError":\s*true|unauthori|token/i);
    await stop(o.child);
    expect((await anchorOf(c, AGENT)).agent_pid, "the own-token restamp stood; the forged one did not").toBe(4242);
  }, 90_000);

  it("a SECOND stdio process on the same wasm DB is refused by name, opens no listener, and leaves the first owner's record", async () => {
    const c = newCase("stdio-second");
    seedWasmDb(c, "pr2 second");
    const o = await startStdioOwner(c);
    const before = record(c);
    const second = spawnSync(process.execPath, [DIST_INDEX], { env: baseEnv(c, { RELAY_TRANSPORT: "stdio" }), encoding: "utf-8", input: "", timeout: 30_000 });
    expect(second.status).not.toBe(0);
    expect(second.stderr).toMatch(/another relay process owns this wasm DB/);
    expect(record(c), "the record still names the first owner").toEqual(before);
    await stop(o.child);
  }, 90_000);

  it("the owner-peek listener SURVIVES its own listen failure (an async 'error' event): logged, no record, the process lives", () => {
    const c = newCase("peek-error");
    fs.writeFileSync(c.cfg, "{}", { mode: 0o600 });
    const script = path.join(c.home, "peek-error.mjs");
    fs.writeFileSync(
      script,
      `const { startHttpServer } = await import(${JSON.stringify(DIST_HTTP)});
       const s = startHttpServer(0, "127.0.0.1", { ownerPeek: true, ownerTransport: "stdio" });
       s.once("listening", () => {
         s.emit("error", Object.assign(new Error("probe EADDRNOTAVAIL"), { code: "EADDRNOTAVAIL" }));
         setTimeout(() => { process.stdout.write("alive"); s.close(() => process.exit(0)); }, 200);
       });`
    );
    const r = spawnSync(process.execPath, [script], { encoding: "utf-8", env: baseEnv(c), timeout: 30_000 });
    expect(r.stdout, r.stderr).toBe("alive");
    expect(r.stderr).toMatch(/the owner-peek listener failed \(probe EADDRNOTAVAIL\)/);
  }, 60_000);
});

/** PATH stubs: sqlite3 records every call; curl logs its argv (the URL), then runs the real curl. */
const STUBS = path.join(ROOT, "stubs");
fs.mkdirSync(STUBS, { recursive: true });
const SQLITE_LOG = path.join(ROOT, "sqlite3.log");
const CURL_LOG = path.join(ROOT, "curl.log");
fs.writeFileSync(path.join(STUBS, "sqlite3"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${SQLITE_LOG}"\nexit 1\n`, { mode: 0o755 });
const REAL_CURL = spawnSync("sh", ["-c", "command -v curl"], { encoding: "utf-8" }).stdout.trim();
fs.writeFileSync(path.join(STUBS, "curl"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${CURL_LOG}"\nexec "${REAL_CURL}" "$@"\n`, { mode: 0o755 });
/** node: `node <relay> where --fields` prints FAKE_WHERE_FILE when set; anything else runs node. */
fs.writeFileSync(
  path.join(STUBS, "node"),
  `#!/bin/sh\ncase "$2 $3" in "where --fields") if [ -n "$FAKE_WHERE_FILE" ]; then cat "$FAKE_WHERE_FILE"; exit 0; fi ;; esac\nexec "${process.execPath}" "$@"\n`,
  { mode: 0o755 }
);
async function runHook(c: Case, hook: string, extra: Record<string, string>, input = "") {
  fs.rmSync(SQLITE_LOG, { force: true });
  fs.rmSync(CURL_LOG, { force: true });
  const env = baseEnv(c, { PATH: `${STUBS}:${process.env.PATH ?? ""}`, RELAY_AGENT_NAME: AGENT, RELAY_TEST_CLOCK: "0", ...extra });
  const child = spawn("bash", [path.join(HOOKS, hook)], { env, stdio: ["pipe", "pipe", "pipe"] });
  procs.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (d: Buffer) => (stdout += d));
  child.stderr!.on("data", (d: Buffer) => (stderr += d));
  child.stdin!.end(input);
  const status = await new Promise<number | null>((resolve) => {
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, 60_000);
    child.once("exit", (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
  const lines = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf-8").split("\n").filter(Boolean) : []);
  return { status, out: `${stdout}\n${stderr}`, sqliteCalls: lines(SQLITE_LOG), mcpPosts: lines(CURL_LOG).filter((l) => /\/mcp\b/.test(l)).length };
}
const PTU = JSON.stringify({ session_id: "s-pr2", hook_event_name: "PostToolUse" });
const inputFor = (hook: string) => (hook === "check-relay.sh" ? "" : JSON.stringify({ session_id: "s-pr2", hook_event_name: hook === "stop-check.sh" ? "Stop" : "PostToolUse" }));
const cacheFiles = (c: Case) => {
  const d = path.join(c.home, ".bot-relay", "hook-state");
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.startsWith("liveness-owner-")).map((f) => path.join(d, f)) : [];
};

describe.skipIf(WIN_NO_BASH_HOOKS)("hook PR 2: the hooks read a stdio owner's mail, and self-heal liveness over the proved route (POSIX)", () => {
  it.each(["check-relay.sh", "stop-check.sh", "post-tool-use-check.sh"])("%s: a STDIO wasm owner → the agent's pending mail over its loopback listener, never sqlite3", async (hook) => {
    const c = newCase(`stdio-${hook.split(".")[0]}`);
    const { token } = seedWasmDb(c, `pr2 stdio mail for ${hook}`);
    const o = await startStdioOwner(c);
    const r = await runHook(c, hook, { RELAY_AGENT_TOKEN: token }, inputFor(hook));
    expect(r.sqliteCalls).toEqual([]);
    expect(r.out, `${r.out}\n${o.stderr()}`).toMatch(new RegExp(`pr2 stdio mail for ${hook.replace(".", "\\.")}|${SENDER}`));
    expect(o.stdout(), "the stdio owner's MCP stdout stayed empty").toBe("");
    await stop(o.child);
  }, 120_000);

  it("the owner EXITED (its record left behind) → no `http`, a named skip, never sqlite3", async () => {
    const c = newCase("stdio-exited");
    const { token } = seedWasmDb(c, "pr2 must not arrive");
    const o = await startStdioOwner(c);
    await stop(o.child);
    expect(fs.existsSync(c.record)).toBe(true);
    const r = await runHook(c, "check-relay.sh", { RELAY_AGENT_TOKEN: token });
    expect(r.out).not.toMatch(/pr2 must not arrive/);
    expect(r.out).toMatch(/hook DB read skipped \(skip-(declared-wasm|rlyw)\)/);
    expect(r.out, "the notice says no owner is running (no more 'use the HTTP owner')").toMatch(/no relay process owns it now/);
    expect(r.sqliteCalls).toEqual([]);
  }, 120_000);

  it("Q5: the owner holds the lock but has NO hook endpoint (its record gone) → the verdict skip-no-endpoint, and the notice names it", async () => {
    const c = newCase("stdio-noendpoint");
    const { token } = seedWasmDb(c, "pr2 no endpoint");
    const o = await startStdioOwner(c);
    fs.rmSync(c.record); // the TEST removes it (relay code never does): stands in for a listener that failed to open
    const w = spawnSync(process.execPath, [RELAY, "where", "--fields"], { encoding: "utf-8", env: baseEnv(c) });
    expect(w.stdout.split("\n")[6]).toBe("skip-no-endpoint");
    const r = await runHook(c, "check-relay.sh", { RELAY_AGENT_TOKEN: token });
    expect(r.out).toMatch(/the owner has no hook endpoint/);
    expect(r.sqliteCalls).toEqual([]);
    await stop(o.child);
  }, 120_000);

  it("Q8: a CHANGED pid → PostToolUse restamps the anchor over the proved route (one call), and caches it; the steady state then makes ZERO liveness calls", async () => {
    const c = newCase("live-restamp");
    const { token } = seedWasmDb(c, "pr2 live mail");
    const o = await startStdioOwner(c);
    const first = await runHook(c, "post-tool-use-check.sh", { RELAY_AGENT_TOKEN: token }, PTU);
    expect(first.mcpPosts, `the peek and ONE liveness call\n${first.out}`).toBe(2);
    expect(cacheFiles(c).length, "the restamp was cached").toBe(1);
    expect(fs.statSync(cacheFiles(c)[0]!).mode & 0o777).toBe(0o600);
    const steady = await runHook(c, "post-tool-use-check.sh", { RELAY_AGENT_TOKEN: token }, PTU);
    expect(steady.mcpPosts, `the steady state: the peek only, zero liveness calls\n${steady.out}`).toBe(1);
    await stop(o.child);
    expect((await anchorOf(c, AGENT)).agent_pid, "the anchor is the hook's agent pid (this test process)").toBe(process.pid);
  }, 150_000);

  it("Q8: a STALE cache → one call, the right anchor, the cache corrected", async () => {
    const c = newCase("live-stale");
    const { token } = seedWasmDb(c, "pr2 stale mail");
    const o = await startStdioOwner(c);
    await runHook(c, "post-tool-use-check.sh", { RELAY_AGENT_TOKEN: token }, PTU);
    const [cache] = cacheFiles(c);
    expect(cache, "precondition: a cache exists").toBeDefined();
    fs.writeFileSync(cache!, "999999 stale-start\n", { mode: 0o600 });
    const r = await runHook(c, "post-tool-use-check.sh", { RELAY_AGENT_TOKEN: token }, PTU);
    expect(r.mcpPosts, r.out).toBe(2);
    expect(fs.readFileSync(cache!, "utf-8")).not.toContain("999999");
    await stop(o.child);
    expect((await anchorOf(c, AGENT)).agent_pid).toBe(process.pid);
  }, 150_000);

  it("Q8 (as ruled): a FRESH proof immediately precedes the liveness token: an owner SWAPPED after the peek (its next challenge fails) receives no report_liveness", async () => {
    const c = newCase("live-swap");
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    const KEY = crypto.randomBytes(16).toString("hex");
    const TOKEN = "pr2-swap-token-aaaaaaaaaaaaaaaa";
    let challenges = 0;
    const posts: string[] = [];
    const spy = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d: Buffer) => (body += d));
      req.on("end", () => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname === "/owner-id") {
          challenges++;
          const port = (spy.address() as { port: number }).port;
          const good = challenges === 1; // the real owner answers the peek's proof; then the port is someone else's
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ mac: good ? mac(KEY, url.searchParams.get("c") ?? "", port) : "00".repeat(32) }));
          return;
        }
        if (url.pathname === "/mcp") {
          posts.push(body);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ messages: [], count: 0, has_more: false, total_pending: 0 }) }] } }));
          return;
        }
        res.writeHead(403);
        res.end();
      });
    });
    await new Promise<void>((r) => spy.listen(0, "127.0.0.1", () => r()));
    try {
      const port = (spy.address() as { port: number }).port;
      const where = path.join(c.home, "where.txt");
      fs.writeFileSync(where, ["explicit-db", c.db, "true", "", "", path.join(c.dir, "agents"), "http", `http://127.0.0.1:${port} ${KEY}`].join("\n") + "\n");
      const r = await runHook(c, "post-tool-use-check.sh", { RELAY_AGENT_TOKEN: TOKEN, FAKE_WHERE_FILE: where }, PTU);
      expect(posts.length, `precondition: the peek was served (${r.out})`).toBeGreaterThanOrEqual(1);
      expect(posts[0], "the first post is the peek").toContain("get_messages");
      expect(challenges, "a second, FRESH challenge preceded the liveness send").toBeGreaterThanOrEqual(2);
      expect(posts.some((b) => b.includes("report_liveness")), "no liveness token went to the swapped owner").toBe(false);
      expect(posts.slice(1).some((b) => b.includes(TOKEN)), "no token after the failed proof").toBe(false);
    } finally {
      await new Promise<void>((r) => spy.close(() => r()));
    }
  }, 120_000);
});
