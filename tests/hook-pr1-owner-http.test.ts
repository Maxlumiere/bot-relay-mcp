// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Hook PR 1: the hooks read mail over HTTP from a wasm DB's DAEMON OWNER (as ruled: the owner endpoint record, a
 * challenge-response before any credential, `relay where --fields` line 8 = "URL KEY", the existing remote mail read).
 * - The owner writes realpath(parent)/.<basename>.relay-owner.json (0600, after it is listening; never deleted):
 *   {v, host:"127.0.0.1", port, pid, pid_start, key, transport}. The key is NEVER served.
 * - GET /owner-id?c=<challenge> answers HMAC-SHA256(key, challenge ‖ port).
 * - `where` line 7 is `http` only for a wasm DB with a VALID record (the lock held, the pid alive with the same start);
 *   line 8 is "http://127.0.0.1:<port> <key>", empty otherwise; exactly 8 lines.
 * - The hook sends a fresh challenge, verifies the answer with the key (node, key on STDIN), and only then sends the
 *   agent's token, for a get_messages peek. Any failure is a named skip, never a sqlite3 read, never a token sent.
 * The TS rows run on every OS; the hook rows run where the bash hooks do (POSIX).
 */
import { describe, it, expect, afterEach, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import crypto from "crypto";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";
import { getFreePort } from "./_helpers/port.js";
import { sandboxEnv } from "./_helpers/sandbox-env.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST_INDEX = path.join(REPO, "dist", "index.js");
const DIST_DB = pathToFileURL(path.join(REPO, "dist", "db.js")).href;
const RELAY = path.join(REPO, "bin", "relay");
const HOOKS = path.join(REPO, "hooks");
/** The bash hooks do not run on native Windows (src/cli/generate-hooks.ts; WSL runs them as Linux). */
const WIN_NO_BASH_HOOKS = process.platform === "win32";
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hookpr1-")));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const AGENT = "pr1-agent";
const KEY_RE = /^[0-9a-f]{32}$/;
const procs: ChildProcess[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  for (const p of procs.splice(0)) if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
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
/** A native DB with AGENT registered and one message for it; then converted to the wasm owner's kind. Returns AGENT's token. */
function seedWasmDb(c: Case, message = "hello over http"): string {
  fs.writeFileSync(c.cfg, "{}", { mode: 0o600 });
  const r = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const db = await import(${JSON.stringify(DIST_DB)});
       const a = db.registerAgent(${JSON.stringify(AGENT)}, "r", []);
       db.registerAgent("pr1-sender", "r", []);
       db.sendMessage("pr1-sender", ${JSON.stringify(AGENT)}, ${JSON.stringify(message)}, "normal");
       db.closeDb();
       process.stdout.write(a.plaintext_token);`,
    ],
    { encoding: "utf-8", env: baseEnv(c) }
  );
  expect(r.status, r.stderr).toBe(0);
  const token = r.stdout.trim();
  const conv = spawnSync(process.execPath, [RELAY, "convert-journal", "--to", "wasm"], { encoding: "utf-8", env: baseEnv(c) });
  expect(conv.status, `${conv.stdout}\n${conv.stderr}`).toBe(0);
  return token;
}
function seedNativeDb(c: Case): string {
  fs.writeFileSync(c.cfg, "{}", { mode: 0o600 });
  const r = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `const db = await import(${JSON.stringify(DIST_DB)}); const a = db.registerAgent(${JSON.stringify(AGENT)}, "r", []); db.closeDb(); process.stdout.write(a.plaintext_token);`],
    { encoding: "utf-8", env: baseEnv(c) }
  );
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
}
/** The wasm owner daemon (HTTP, 127.0.0.1). Resolves once /health answers. */
async function startOwnerDaemon(c: Case, host = "127.0.0.1", extraEnv: Record<string, string> = {}): Promise<{ child: ChildProcess; port: number; stderr: () => string }> {
  const port = await getFreePort();
  const reach = host === "0.0.0.0" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
  const child = spawn(process.execPath, [DIST_INDEX], {
    env: baseEnv(c, { RELAY_TRANSPORT: "http", RELAY_HTTP_HOST: host, RELAY_HTTP_PORT: String(port), ...extraEnv }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  procs.push(child);
  let err = "";
  child.stderr!.on("data", (d: Buffer) => (err += d));
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    if (child.exitCode !== null) break;
    const ok = await fetch(`http://${reach}:${port}/health`).then((r) => r.ok, () => false);
    if (ok && fs.existsSync(c.record)) return { child, port, stderr: () => err };
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the owner daemon did not come up with its record (exit ${child.exitCode}):\n${err}`);
}
async function stopDaemon(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
const whereFields = (c: Case, extra: Record<string, string> = {}) => {
  const r = spawnSync(process.execPath, [RELAY, "where", "--fields"], { encoding: "utf-8", env: baseEnv(c, extra) });
  return { status: r.status, lines: r.stdout.split("\n").slice(0, -1), raw: r.stdout, stderr: r.stderr };
};
const mac = (key: string, challenge: string, port: number) => crypto.createHmac("sha256", Buffer.from(key, "hex")).update(`${challenge}${port}`).digest("hex");

describe("hook PR 1: the owner endpoint record and the challenge-response (every OS)", () => {
  it("a wasm DAEMON owner writes its record after listening: 0600, {v, host 127.0.0.1, port, pid, pid_start, key, transport}; /owner-id answers HMAC(key, challenge‖port) and never serves the key", async () => {
    const c = newCase("record");
    seedWasmDb(c);
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    const rec = JSON.parse(fs.readFileSync(c.record, "utf-8")) as Record<string, unknown>;
    expect(rec).toMatchObject({ v: 1, host: "127.0.0.1", port: d.port, pid: d.child.pid, transport: "http" });
    expect(String(rec.key)).toMatch(KEY_RE);
    // The start token comes from ps, which Windows lacks (there it is null, and `where` never says http: the bash hooks
    // do not run there either).
    if (process.platform !== "win32") expect(typeof rec.pid_start === "string" && rec.pid_start.length > 0, "the owner's start token is recorded").toBe(true);
    if (process.platform !== "win32") expect(fs.statSync(c.record).mode & 0o777).toBe(0o600);
    const challenge = crypto.randomBytes(16).toString("hex");
    const res = await fetch(`http://127.0.0.1:${d.port}/owner-id?c=${challenge}`);
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(body)).toEqual({ mac: mac(String(rec.key), challenge, d.port) });
    expect(body, "the key is never served").not.toContain(String(rec.key));
    expect((await fetch(`http://127.0.0.1:${d.port}/owner-id`)).status, "no challenge: refused").toBe(400);
    expect((await fetch(`http://127.0.0.1:${d.port}/health`).then((r) => r.text())), "/health does not carry the key").not.toContain(String(rec.key));
    await stopDaemon(d.child);
    expect(fs.existsSync(c.record), "the record is never deleted, even on a clean exit").toBe(true);
  }, 90_000);

  it.skipIf(process.platform === "win32")("`relay where --fields`: a wasm DB with a VALID record → exactly 8 lines, line 7 `http`, line 8 `http://127.0.0.1:<port> <key>` (skipped on Windows: no ps start token there, and no bash hooks)", async () => {
    const c = newCase("where-http");
    seedWasmDb(c);
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    const key = String((JSON.parse(fs.readFileSync(c.record, "utf-8")) as { key: string }).key);
    const w = whereFields(c);
    expect(w.lines.length, w.raw).toBe(8);
    expect(w.lines[6]).toBe("http");
    expect(w.lines[7]).toBe(`http://127.0.0.1:${d.port} ${key}`);
  }, 90_000);

  it("the LOCK FREE (the owner exited, its record left behind) → not `http`, line 8 empty", async () => {
    const c = newCase("where-free");
    seedWasmDb(c);
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    await stopDaemon(d.child);
    expect(fs.existsSync(c.record), "precondition: the record is left behind").toBe(true);
    const w = whereFields(c);
    expect(w.lines.length, w.raw).toBe(8);
    expect(w.lines[6]).not.toBe("http");
    expect(w.lines[7]).toBe("");
  }, 90_000);

  it("the PID REUSED (the record names a live pid whose start token differs) → not `http`, line 8 empty", async () => {
    const c = newCase("where-pid");
    seedWasmDb(c);
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    const rec = JSON.parse(fs.readFileSync(c.record, "utf-8")) as Record<string, unknown>;
    fs.writeFileSync(c.record, JSON.stringify({ ...rec, pid: process.pid, pid_start: "a-start-token-that-is-not-this-process's" }), { mode: 0o600 });
    const w = whereFields(c);
    expect(w.lines.length, w.raw).toBe(8);
    expect(w.lines[6]).not.toBe("http");
    expect(w.lines[7]).toBe("");
    await stopDaemon(d.child);
  }, 90_000);

  it("twin: a NATIVE instance → 8 lines, line 7 `sqlite3`, line 8 empty (unchanged reads)", () => {
    const c = newCase("where-native");
    seedNativeDb(c);
    const w = whereFields(c);
    expect(w.lines.length, w.raw).toBe(8);
    expect(w.lines[6]).toBe("sqlite3");
    expect(w.lines[7]).toBe("");
  }, 60_000);

  it("the closed verdict set is pinned TS ↔ bash: `http` is a verdict, and only `sqlite3` and `http` enable a read", async () => {
    const { HOOK_DB_VERDICTS } = (await import("../src/hook-db-verdict.js")) as { HOOK_DB_VERDICTS: readonly string[] };
    expect(HOOK_DB_VERDICTS).toContain("http");
    const src = fs.readFileSync(path.join(HOOKS, "_vault-helpers.sh"), "utf-8");
    expect(src, "the hooks know the http verdict").toMatch(/\bhttp\)/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The hook rows: bash, POSIX. A SPY listener stands in for an owner (or an impostor) and records every byte it receives.

interface Spy {
  port: number;
  requests: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }>;
  bytes: () => string;
}
async function startSpy(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void): Promise<Spy> {
  const requests: Spy["requests"] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => (body += d));
    req.on("end", () => {
      requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      handler(req, res, body);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { port, requests, bytes: () => requests.map((q) => `${q.method} ${q.url}\n${JSON.stringify(q.headers)}\n${q.body}`).join("\n") };
}
/** A PATH stub for `node`: `node <relay> where --fields` prints FAKE_WHERE_FILE's content; anything else runs node. */
const STUBS = path.join(ROOT, "stubs");
fs.mkdirSync(STUBS, { recursive: true });
const ARGV_LOG = path.join(ROOT, "argv.log");
const RM_CAPTURE = path.join(ROOT, "rm-capture.log");
fs.writeFileSync(
  path.join(STUBS, "node"),
  `#!/bin/sh\nprintf 'node %s\\n' "$*" >> "${ARGV_LOG}"\nif [ -n "$FAKE_NODE_HANG" ]; then case "$*" in *"$FAKE_NODE_HANG"*) exec sleep 30 ;; esac; fi\ncase "$2 $3" in "where --fields") if [ -n "$FAKE_WHERE_FILE" ]; then cat "$FAKE_WHERE_FILE"; exit 0; fi ;; esac\nexec "${process.execPath}" "$@"\n`,
  { mode: 0o755 }
);
const REAL_CURL = spawnSync("sh", ["-c", "command -v curl"], { encoding: "utf-8" }).stdout.trim();
const REAL_RM = spawnSync("sh", ["-c", "command -v rm"], { encoding: "utf-8" }).stdout.trim();
/** curl: its argv logged, then the real curl (its stdin, the -K - config, passes through untouched). */
fs.writeFileSync(path.join(STUBS, "curl"), `#!/bin/sh\nprintf 'curl %s\\n' "$*" >> "${ARGV_LOG}"\nexec "${REAL_CURL}" "$@"\n`, { mode: 0o755 });
/** rm: every file the hook deletes (its temp files, the where capture) is COPIED into the capture log first. */
fs.writeFileSync(
  path.join(STUBS, "rm"),
  `#!/bin/sh\nfor a in "$@"; do case "$a" in -*) ;; *) [ -f "$a" ] && { printf '== %s\\n' "$a"; cat "$a"; printf '\\n'; } >> "${RM_CAPTURE}" ;; esac; done\nexec "${REAL_RM}" "$@"\n`,
  { mode: 0o755 }
);
const SQLITE_LOG = path.join(ROOT, "sqlite3.log");
fs.writeFileSync(path.join(STUBS, "sqlite3"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${SQLITE_LOG}"\nexit 1\n`, { mode: 0o755 });

/**
 * The hook, run ASYNCHRONOUSLY: a spy listener lives in THIS process, so a spawnSync would starve it (the event loop
 * blocked: the hook's request never served, a vacuous "zero bytes received"). Measured on 5771f88: 0 requests.
 */
async function runHook(c: Case, hook: string, extra: Record<string, string>, input = "") {
  fs.rmSync(SQLITE_LOG, { force: true });
  const env = baseEnv(c, { PATH: `${STUBS}:${process.env.PATH ?? ""}`, RELAY_AGENT_NAME: AGENT, RELAY_TEST_CLOCK: "0", ...extra });
  const child = spawn("bash", [path.join(HOOKS, hook)], { env, stdio: ["pipe", "pipe", "pipe"] });
  procs.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (d: Buffer) => (stdout += d));
  child.stderr!.on("data", (d: Buffer) => (stderr += d));
  child.stdin!.end(input);
  const t0 = Date.now();
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
  const sqliteCalls = fs.existsSync(SQLITE_LOG) ? fs.readFileSync(SQLITE_LOG, "utf-8").split("\n").filter(Boolean) : [];
  return { status, out: `${stdout}\n${stderr}`, stdout, sqliteCalls, ms: Date.now() - t0 };
}
/** A fake `where --fields` answer: an instance on c.db, verdict `line7`, and `line8` (or no 8th line at all). */
function fakeWhere(c: Case, line7: string, line8: string | null): string {
  const f = path.join(c.home, `where-${crypto.randomBytes(4).toString("hex")}.txt`);
  const lines = ["explicit-db", c.db, "true", "", "", path.join(c.dir, "agents"), line7, ...(line8 === null ? [] : [line8])];
  fs.writeFileSync(f, lines.join("\n") + "\n");
  return f;
}
const TOKEN = "pr1-secret-token-aaaaaaaaaaaaaaaa";
const KEY = crypto.randomBytes(16).toString("hex");

describe.skipIf(WIN_NO_BASH_HOOKS)("hook PR 1: the hooks read mail over HTTP from a daemon owner (POSIX)", () => {
  it.each(["check-relay.sh", "stop-check.sh", "post-tool-use-check.sh"])(
    "%s: a wasm DB owned by a DAEMON → the agent's pending mail is read over HTTP, never with sqlite3",
    async (hook) => {
      const c = newCase(`deliver-${hook.split(".")[0]}`);
      const token = seedWasmDb(c, `pr1 mail for ${hook}`);
      fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
      const d = await startOwnerDaemon(c);
      const input = hook === "check-relay.sh" ? "" : JSON.stringify({ session_id: "s-pr1", hook_event_name: hook === "stop-check.sh" ? "Stop" : "PostToolUse" });
      const r = await runHook(c, hook, { RELAY_AGENT_TOKEN: token }, input);
      expect(r.sqliteCalls, "never a sqlite3 read on a wasm DB").toEqual([]);
      expect(r.out, `the mail arrives over HTTP\n${r.out}\n${d.stderr()}`).toMatch(new RegExp(`pr1 mail for ${hook.replace(".", "\\.")}|pr1-sender`));
      await stopDaemon(d.child);
    },
    120_000
  );

  const SECRET = `pr1-http-secret-${crypto.randomBytes(16).toString("hex")}`;
  it.each(["check-relay.sh", "stop-check.sh", "post-tool-use-check.sh"])(
    "%s: the owner daemon has an http_secret → the mail is still read (the secret goes curl-config-on-stdin only), and NO secret byte is in any argv, any file the hook wrote, or its output",
    async (hook) => {
      const c = newCase(`secret-${hook.split(".")[0]}`);
      const token = seedWasmDb(c, `pr1 secret mail for ${hook}`);
      fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm", http_secret: SECRET }), { mode: 0o600 });
      const d = await startOwnerDaemon(c);
      fs.rmSync(ARGV_LOG, { force: true });
      fs.rmSync(RM_CAPTURE, { force: true });
      const input = hook === "check-relay.sh" ? "" : JSON.stringify({ session_id: "s-pr1", hook_event_name: hook === "stop-check.sh" ? "Stop" : "PostToolUse" });
      const r = await runHook(c, hook, { RELAY_AGENT_TOKEN: token }, input);
      expect(r.out, `the mail arrives through the secret-protected owner\n${r.out}\n${d.stderr()}`).toMatch(new RegExp(`pr1 secret mail for ${hook.replace(".", "\\.")}|pr1-sender`));
      const argv = fs.existsSync(ARGV_LOG) ? fs.readFileSync(ARGV_LOG, "utf-8") : "";
      expect(argv.length, "precondition: the stubs logged the hook's curl/node runs").toBeGreaterThan(0);
      expect(argv, "the secret is in no process argv").not.toContain(SECRET);
      const captured = fs.existsSync(RM_CAPTURE) ? fs.readFileSync(RM_CAPTURE, "utf-8") : "";
      expect(captured, "no file the hook wrote (its temp files, the where capture) held the secret").not.toContain(SECRET);
      const tmp = path.join(c.home, ".tmp");
      const leftovers = fs.existsSync(tmp) ? fs.readdirSync(tmp).map((f) => { try { return fs.readFileSync(path.join(tmp, f), "utf-8"); } catch { return ""; } }).join("\n") : "";
      expect(leftovers, "nothing left in the hook's temp dir holds the secret").not.toContain(SECRET);
      expect(r.out, "the secret is in no hook output").not.toContain(SECRET);
      await stopDaemon(d.child);
    },
    120_000
  );

  it("an http_secret curl config CANNOT carry (a quote) is declined BY NAME: the hook says it can't be sent safely, and never prints the secret", async () => {
    const c = newCase("secret-unsafe");
    const token = seedWasmDb(c, "pr1 unsafe-secret mail");
    const unsafe = `pr1-"quoted"-secret-${crypto.randomBytes(16).toString("hex")}`;
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm", http_secret: unsafe }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    const r = await runHook(c, "check-relay.sh", { RELAY_AGENT_TOKEN: token });
    expect(r.out).toMatch(/http_secret can't be sent safely: it contains a character curl config can't carry/);
    expect(r.out, "the secret is in no hook output").not.toContain(unsafe);
    expect(r.sqliteCalls).toEqual([]);
    await stopDaemon(d.child);
  }, 120_000);

  it.each([
    ["the http_secret read", "curl-auth-config", /the http_secret could not be read in time/],
    ["the proof check", "timingSafeEqual", /did not prove the record's key/],
  ])("a HUNG %s (its node never returns) is bounded in time: the hook ends inside its budget and names it", async (_what, hang, named) => {
    const c = newCase(`hang-${hang}`);
    const token = seedWasmDb(c, "pr1 hang mail");
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm", http_secret: SECRET }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    fs.rmSync(ARGV_LOG, { force: true });
    const r = await runHook(c, "check-relay.sh", { RELAY_AGENT_TOKEN: token, FAKE_NODE_HANG: hang });
    const argv = fs.existsSync(ARGV_LOG) ? fs.readFileSync(ARGV_LOG, "utf-8") : "";
    expect(argv, "precondition: the hung step ran (the stub saw it)").toContain(hang);
    expect(r.status, "the hook exited by itself (not killed by the 60s runner)").not.toBeNull();
    expect(r.ms, `the stub sleeps 30s: the hook must end inside its 10s budget\n${r.out}`).toBeLessThan(10_000);
    expect(r.out).toMatch(named);
    expect(r.out).not.toContain(SECRET);
    await stopDaemon(d.child);
  }, 120_000);

  it("a WRONG http_secret (the hook resolves a different one) is a NAMED failure: no mail, never a sqlite3 read", async () => {
    const c = newCase("secret-wrong");
    const token = seedWasmDb(c, "pr1 must not arrive");
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm", http_secret: SECRET }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    const r = await runHook(c, "check-relay.sh", { RELAY_AGENT_TOKEN: token, RELAY_HTTP_SECRET: `wrong-${SECRET}` });
    expect(r.out).not.toMatch(/pr1 must not arrive/);
    expect(r.out).toMatch(/remote relay read failed|could not be read|unauthorized/i);
    expect(r.sqliteCalls).toEqual([]);
    expect(r.out, "the secret is in no hook output").not.toContain(SECRET);
    await stopDaemon(d.child);
  }, 120_000);

  it("an IMPOSTOR on the record's port (a wrong MAC) receives ZERO token bytes, and the hook names the skip", async () => {
    const c = newCase("impostor");
    seedNativeDb(c);
    const spy = await startSpy((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ mac: "00".repeat(32) }));
    });
    const r = await runHook(c, "check-relay.sh", { RELAY_AGENT_TOKEN: TOKEN, FAKE_WHERE_FILE: fakeWhere(c, "http", `http://127.0.0.1:${spy.port} ${KEY}`) });
    expect(spy.bytes(), "the token never reached the impostor").not.toContain(TOKEN);
    expect(spy.requests.every((q) => q.url.startsWith("/owner-id?c=")), `only the challenge was sent: ${spy.bytes()}`).toBe(true);
    expect(spy.requests.length, "the challenge was sent (the handshake ran)").toBeGreaterThanOrEqual(1);
    expect(r.out).toMatch(/owner (endpoint|record) .*(not proved|did not prove|failed the challenge)/i);
    expect(r.sqliteCalls).toEqual([]);
  }, 60_000);

  it("a REPLAYED MAC (correct for an OLD challenge) is refused: zero token bytes", async () => {
    const c = newCase("replay");
    seedNativeDb(c);
    let port = 0;
    const old = "0123456789abcdef0123456789abcdef";
    const spy = await startSpy((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ mac: mac(KEY, old, port) })); // what a cached answer to an earlier challenge would be
    });
    port = spy.port;
    const r = await runHook(c, "check-relay.sh", { RELAY_AGENT_TOKEN: TOKEN, FAKE_WHERE_FILE: fakeWhere(c, "http", `http://127.0.0.1:${spy.port} ${KEY}`) });
    expect(spy.requests.length, "the handshake ran").toBeGreaterThanOrEqual(1);
    expect(spy.requests[0]!.url, "a fresh challenge, not the old one").not.toContain(old);
    expect(spy.bytes()).not.toContain(TOKEN);
    expect(r.out).toMatch(/owner (endpoint|record) .*(not proved|did not prove|failed the challenge)/i);
  }, 60_000);

  it("a 3xx from /owner-id is NOT followed: the redirect target receives nothing, zero token bytes", async () => {
    const c = newCase("redirect");
    seedNativeDb(c);
    const target = await startSpy((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    const spy = await startSpy((req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${target.port}${req.url}` });
      res.end();
    });
    const r = await runHook(c, "check-relay.sh", { RELAY_AGENT_TOKEN: TOKEN, FAKE_WHERE_FILE: fakeWhere(c, "http", `http://127.0.0.1:${spy.port} ${KEY}`) });
    expect(spy.requests.length, "the handshake ran").toBeGreaterThanOrEqual(1);
    expect(target.requests, "the redirect was never followed").toEqual([]);
    expect(spy.bytes() + target.bytes()).not.toContain(TOKEN);
    expect(r.out).toMatch(/owner (endpoint|record) .*(not proved|did not prove|failed the challenge)/i);
  }, 60_000);

  it.each([
    ["a non-loopback host", (p: number) => `http://192.0.2.1:${p} ${KEY}`],
    ["localhost (not the exact 127.0.0.1)", (p: number) => `http://localhost:${p} ${KEY}`],
    ["a short key", (p: number) => `http://127.0.0.1:${p} abcd`],
    ["a path after the port", (p: number) => `http://127.0.0.1:${p}/x ${KEY}`],
    ["no key", (p: number) => `http://127.0.0.1:${p}`],
  ])("a MALFORMED line 8 (%s) → a named skip with NO network call", async (_label, line8) => {
    const c = newCase("malformed");
    seedNativeDb(c);
    const spy = await startSpy((req, res) => res.end("{}"));
    const r = await runHook(c, "check-relay.sh", { RELAY_AGENT_TOKEN: TOKEN, FAKE_WHERE_FILE: fakeWhere(c, "http", line8(spy.port)) });
    expect(spy.requests, "no request at all").toEqual([]);
    expect(r.out).toMatch(/owner (endpoint|record) .*(malformed|invalid|not a loopback)/i);
    expect(r.sqliteCalls).toEqual([]);
  }, 60_000);

  it("a 7-line answer (an older relay CLI than these hooks) → a named version-skew skip: no sqlite3, no network", async () => {
    const c = newCase("seven");
    seedNativeDb(c);
    const spy = await startSpy((req, res) => res.end("{}"));
    const r = await runHook(c, "check-relay.sh", { RELAY_AGENT_TOKEN: TOKEN, FAKE_WHERE_FILE: fakeWhere(c, "http", null) });
    expect(spy.requests).toEqual([]);
    expect(r.sqliteCalls).toEqual([]);
    expect(r.out).toMatch(/7-line answer[\s\S]*(version skew|update the relay)/i);
  }, 60_000);
});

describe("hook PR 1: the record is never deleted by relay code (a scan row)", () => {
  it("no src code removes the owner endpoint record: no unlink/rm whose argument IS the record path (resolved through its declaration)", async () => {
    const { srcProgram } = await import("./_helpers/ts-binding.js");
    const ts = (await import("typescript-legacy")).default;
    const program = srcProgram();
    const checker = program.getTypeChecker();
    const hits: string[] = [];
    // The functions that DERIVE the record path: those naming it, then (a fixpoint) every function that calls one.
    const derivers = new Set<string>(["ownerEndpointPath"]);
    const bodies: Array<[string, string]> = [];
    for (const sf of program.getSourceFiles()) {
      if (!path.relative(REPO, sf.fileName).split(path.sep).join("/").startsWith("src/") || sf.isDeclarationFile) continue;
      const collect = (n: import("typescript-legacy").Node): void => {
        if (ts.isFunctionDeclaration(n) && n.name) bodies.push([n.name.text, n.getText(sf)]);
        else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) bodies.push([n.name.text, n.initializer.getText(sf)]);
        ts.forEachChild(n, collect);
      };
      collect(sf);
    }
    for (let grew = true; grew; ) {
      grew = false;
      for (const [name, body] of bodies) {
        if (derivers.has(name)) continue;
        if (/relay-owner\.json/.test(body) || [...derivers].some((d) => new RegExp(`\\b${d}\\(`).test(body))) {
          derivers.add(name);
          grew = true;
        }
      }
    }
    const namesRecord = (t: string) => /relay-owner\.json/.test(t) || [...derivers].some((d) => new RegExp(`\\b${d}\\(`).test(t));
    for (const sf of program.getSourceFiles()) {
      const rel = path.relative(REPO, sf.fileName).split(path.sep).join("/");
      if (!rel.startsWith("src/") || sf.isDeclarationFile) continue;
      const visit = (n: import("typescript-legacy").Node): void => {
        if (ts.isCallExpression(n) && /\b(unlinkSync|rmSync|unlink|rm|rmdirSync)$/.test(n.expression.getText(sf)) && n.arguments[0]) {
          const arg = n.arguments[0];
          let text = arg.getText(sf);
          if (ts.isIdentifier(arg)) {
            const decl = checker.getSymbolAtLocation(arg)?.declarations?.[0];
            if (decl && ts.isVariableDeclaration(decl) && decl.initializer) text += ` = ${decl.initializer.getText()}`;
          }
          if (namesRecord(text)) hits.push(`${rel}: ${n.getText(sf)} (${text})`);
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect(fs.existsSync(path.join(REPO, "src", "owner-endpoint.ts")), "the record has its own module").toBe(true);
    expect(hits, "no remove of the record path").toEqual([]);
  }, 120_000);
});

/**
 * Hook PR 1, as ruled (Q9): the record ALWAYS points at a listener the hooks reach as 127.0.0.1. A daemon whose main
 * listener 127.0.0.1 cannot reach (bound to ::1, or to one LAN address) ALSO opens a loopback-only "owner peek"
 * listener, and the record points there. That listener serves ONLY GET /owner-id and the hooks' get_messages peek.
 */
const LAN_V4 = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal)?.address ?? null;
const V6_LOOPBACK = await new Promise<boolean>((resolve) => {
  const srv = http.createServer();
  srv.once("error", () => resolve(false));
  srv.listen(0, "::1", () => srv.close(() => resolve(true)));
});
const UNREACHABLE_BINDS: Array<[string, string | null, Record<string, string>]> = [
  ["::1 (IPv6 loopback only)", V6_LOOPBACK ? "::1" : null, {}],
  ["one LAN IPv4 address (with an http_secret, as a non-loopback bind requires)", LAN_V4, {}],
];
const PEEK_SECRET = `pr1-peek-secret-${crypto.randomBytes(16).toString("hex")}`;
async function mcpCall(base: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text.split("\n").find((l) => l.startsWith("data: "));
  let json: any = null;
  try { json = JSON.parse(data ? data.slice(6) : text); } catch { /* not JSON */ }
  return { status: res.status, text, json };
}
const peekArgs = (token: string) => ({ agent_name: AGENT, status: "pending", limit: 10, peek: true, since: "all", agent_token: token });
const call = (name: string, args: Record<string, unknown>) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

describe("hook PR 1 (Q9): a main listener 127.0.0.1 cannot reach → a loopback owner-peek listener, and the record points there", () => {
  it.each(UNREACHABLE_BINDS)("a daemon bound to %s: the record names a 127.0.0.1 listener on ANOTHER port that proves the key", async (_what, host, env) => {
    if (host === null) return void console.warn(`[hook-pr1] skipped by name: no such address on this runner (${_what})`);
    const c = newCase(`peek-${host.replace(/[^0-9a-z]/gi, "")}`);
    seedWasmDb(c);
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm", http_secret: PEEK_SECRET }), { mode: 0o600 });
    const d = await startOwnerDaemon(c, host, env);
    const rec = JSON.parse(fs.readFileSync(c.record, "utf-8")) as { host: string; port: number; key: string };
    expect(rec.host).toBe("127.0.0.1");
    expect(rec.port, "the record points at the peek listener, not the main one").not.toBe(d.port);
    const challenge = crypto.randomBytes(16).toString("hex");
    const res = await fetch(`http://127.0.0.1:${rec.port}/owner-id?c=${challenge}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mac: mac(rec.key, challenge, rec.port) });
    if (host === LAN_V4) {
      const off = await fetch(`http://${LAN_V4}:${rec.port}/owner-id?c=${challenge}`).then((r) => r.status, () => "refused");
      expect(off, "the peek listener is bound to 127.0.0.1 only").toBe("refused");
    }
    await stopDaemon(d.child);
  }, 90_000);

  it.skipIf(process.platform === "win32").each(UNREACHABLE_BINDS)("a daemon bound to %s: SessionStart reads the agent's mail through the peek listener (the secret included), never sqlite3", async (_what, host, env) => {
    if (host === null) return void console.warn(`[hook-pr1] skipped by name: no such address on this runner (${_what})`);
    const c = newCase(`peek-hook-${host.replace(/[^0-9a-z]/gi, "")}`);
    const token = seedWasmDb(c, "pr1 mail via the peek listener");
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm", http_secret: PEEK_SECRET }), { mode: 0o600 });
    const d = await startOwnerDaemon(c, host, env);
    const r = await runHook(c, "check-relay.sh", { RELAY_AGENT_TOKEN: token });
    expect(r.out, `${r.out}\n${d.stderr()}`).toMatch(/pr1 mail via the peek listener|pr1-sender/);
    expect(r.sqliteCalls).toEqual([]);
    expect(r.out).not.toContain(PEEK_SECRET);
    await stopDaemon(d.child);
  }, 120_000);

  it.skipIf(process.platform === "win32").each(["stop-check.sh", "post-tool-use-check.sh"])("%s through the peek listener (a daemon 127.0.0.1 cannot reach): the mail is read; no /health probe on the proved owner route (the listener refuses /health)", async (hook) => {
    const host = V6_LOOPBACK ? "::1" : LAN_V4;
    if (host === null) return void console.warn("[hook-pr1] skipped by name: no address 127.0.0.1 cannot reach on this runner");
    const c = newCase(`peek-${hook.split(".")[0]}`);
    const token = seedWasmDb(c, `pr1 peek mail for ${hook}`);
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm", http_secret: PEEK_SECRET }), { mode: 0o600 });
    const d = await startOwnerDaemon(c, host, host === LAN_V4 ? { RELAY_HTTP_ALLOWED_HOSTS: LAN_V4 } : {});
    fs.rmSync(ARGV_LOG, { force: true });
    const input = JSON.stringify({ session_id: "s-pr1", hook_event_name: hook === "stop-check.sh" ? "Stop" : "PostToolUse" });
    const r = await runHook(c, hook, { RELAY_AGENT_TOKEN: token }, input);
    expect(r.out, `${r.out}\n${d.stderr()}`).toMatch(new RegExp(`pr1 peek mail for ${hook.replace(".", "\\.")}|pr1-sender`));
    expect(r.sqliteCalls).toEqual([]);
    const argv = fs.existsSync(ARGV_LOG) ? fs.readFileSync(ARGV_LOG, "utf-8") : "";
    expect(argv, "no /health probe on the owner route").not.toMatch(/\/health/);
    await stopDaemon(d.child);
  }, 120_000);

  it("the peek listener serves ONLY /owner-id and the get_messages peek: every other route, every other tool, any other argument key, a batch, a session, a WS upgrade → refused", async () => {
    const host = V6_LOOPBACK ? "::1" : LAN_V4;
    if (host === null) return void console.warn("[hook-pr1] skipped by name: no address 127.0.0.1 cannot reach on this runner");
    const c = newCase("peek-gate");
    const token = seedWasmDb(c, "pr1 gate mail");
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm", http_secret: PEEK_SECRET }), { mode: 0o600 });
    // A LAN main listener's own Host check must accept the LAN address (the registry is read through it below).
    const d = await startOwnerDaemon(c, host, host === LAN_V4 ? { RELAY_HTTP_ALLOWED_HOSTS: LAN_V4 } : {});
    const rec = JSON.parse(fs.readFileSync(c.record, "utf-8")) as { port: number };
    const peek = `http://127.0.0.1:${rec.port}`;
    const auth = { "X-Relay-Secret": PEEK_SECRET, "X-Agent-Token": token };
    // The allowed peek works (the gate is not a wall).
    const ok = await mcpCall(peek, call("get_messages", peekArgs(token)), auth);
    expect(ok.status, ok.text).toBe(200);
    expect(ok.text).toContain("pr1 gate mail");
    // Every route startHttpServer registers (read from its source), on the peek listener → 403, but the two.
    const src = fs.readFileSync(path.join(REPO, "src", "transport", "http.ts"), "utf-8");
    const routes = [...src.matchAll(/app\.(get|post|put|delete|patch|all)\(\s*"([^"]+)"/g)].map((m) => [m[1]!.toUpperCase(), m[2]!] as const);
    expect(routes.length, "precondition: the route scan found the routes").toBeGreaterThan(15);
    for (const [method, route] of routes) {
      if ((method === "GET" && route === "/owner-id") || (method === "POST" && route === "/mcp")) continue;
      const res = await fetch(`${peek}${route.replace(/:[a-z_]+/gi, "x")}`, { method: method === "ALL" ? "GET" : method, headers: auth, body: method === "GET" ? undefined : "{}" });
      expect(res.status, `${method} ${route}`).toBe(403);
    }
    // Every tool but get_messages (the live registry, from the MAIN listener) → 403.
    const reach = host.includes(":") ? `[${host}]` : host;
    const list = await mcpCall(`http://${reach}:${d.port}`, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, auth);
    const names: string[] = (list.json?.result?.tools ?? []).map((t: { name: string }) => t.name);
    expect(names.length, `precondition: the registry was read (${list.status} ${list.text.slice(0, 200)})`).toBeGreaterThan(20);
    for (const name of names.filter((n) => n !== "get_messages")) {
      const res = await mcpCall(peek, call(name, { agent_name: AGENT, agent_token: token }), auth);
      expect(res.status, `tools/call ${name}`).toBe(403);
    }
    const refused: Array<[string, unknown, Record<string, string>?]> = [
      ["tools/list", { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }],
      ["initialize", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "1" } } }],
      ["ack: true (resolves mail through a read-only door)", call("get_messages", { ...peekArgs(token), ack: true })],
      ["peek: false", call("get_messages", { ...peekArgs(token), peek: false })],
      ["peek absent", call("get_messages", (({ peek: _p, ...rest }) => rest)(peekArgs(token)))],
      ["status other than pending", call("get_messages", { ...peekArgs(token), status: "all" })],
      ["a batch", [call("get_messages", peekArgs(token))]],
      ["an mcp-session-id", call("get_messages", peekArgs(token)), { "mcp-session-id": "x" }],
    ];
    for (const [what, body, extra] of refused) {
      const res = await mcpCall(peek, body, { ...auth, ...(extra ?? {}) });
      expect(res.status, what).toBe(403);
    }
    expect((await fetch(`${peek}/mcp`, { headers: auth })).status, "GET /mcp").toBe(403);
    expect((await fetch(`${peek}/health`)).status, "GET /health").toBe(403);
    // A WebSocket upgrade bypasses Express: it must be refused at the socket.
    const upgraded = await new Promise<string>((resolve) => {
      const req = http.request({ host: "127.0.0.1", port: rec.port, path: "/dashboard/ws", headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64") } });
      req.on("upgrade", () => resolve("upgraded"));
      req.on("response", (r) => resolve(`status ${r.statusCode}`));
      req.on("error", () => resolve("refused"));
      req.end();
    });
    expect(upgraded, "a WS upgrade is never accepted").not.toBe("upgraded");
    // A wrong agent token on the allowed peek: no mail (the auth path is the daemon's own).
    const wrong = await mcpCall(peek, call("get_messages", peekArgs("wrong-token-aaaaaaaaaaaaaaaa")), { ...auth, "X-Agent-Token": "wrong-token-aaaaaaaaaaaaaaaa" });
    expect(wrong.text).not.toContain("pr1 gate mail");
    await stopDaemon(d.child);
  }, 180_000);

  it("twin: a daemon bound to 127.0.0.1 records its MAIN port (no second listener)", async () => {
    const c = newCase("peek-twin");
    seedWasmDb(c);
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    expect((JSON.parse(fs.readFileSync(c.record, "utf-8")) as { port: number }).port).toBe(d.port);
    await stopDaemon(d.child);
  }, 90_000);

  it("a daemon whose Host allowlist does NOT accept 127.0.0.1 (RELAY_HTTP_ALLOWED_HOSTS set to a name) → the peek listener, whose Host check is loopback-only", async () => {
    const c = newCase("peek-hostlist");
    seedWasmDb(c);
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    const d = await startOwnerDaemon(c, "127.0.0.1", { RELAY_HTTP_ALLOWED_HOSTS: "relay.example.internal" });
    const rec = JSON.parse(fs.readFileSync(c.record, "utf-8")) as { port: number; key: string };
    expect(rec.port).not.toBe(d.port);
    const challenge = crypto.randomBytes(16).toString("hex");
    const res = await fetch(`http://127.0.0.1:${rec.port}/owner-id?c=${challenge}`);
    expect(res.status).toBe(200);
    // And the MAIN listener's /owner-id is now Host-checked (it sat before the check).
    expect((await fetch(`http://127.0.0.1:${d.port}/owner-id?c=${challenge}`)).status, "main /owner-id is Host-checked").toBe(421);
    await stopDaemon(d.child);
  }, 90_000);

  it("the peek listener's bind host is a CONSTANT 127.0.0.1: startHttpServer in owner-peek mode refuses any other host", async () => {
    // A LITERAL specifier (the parser-pin gate refuses a computed one); the assert throws before any setup.
    const mod = (await import("../src/transport/http.js")) as { startHttpServer: (p: number, h: string, o?: { ownerPeek?: boolean }) => unknown };
    for (const h of ["0.0.0.0", "::", "::1", "localhost", LAN_V4 ?? "10.0.0.1"]) {
      expect(() => mod.startHttpServer(0, h, { ownerPeek: true }), h).toThrow(/127\.0\.0\.1/);
    }
  });
});

