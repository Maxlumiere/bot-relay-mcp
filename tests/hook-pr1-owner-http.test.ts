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
async function startOwnerDaemon(c: Case): Promise<{ child: ChildProcess; port: number; stderr: () => string }> {
  const port = await getFreePort();
  const child = spawn(process.execPath, [DIST_INDEX], {
    env: baseEnv(c, { RELAY_TRANSPORT: "http", RELAY_HTTP_HOST: "127.0.0.1", RELAY_HTTP_PORT: String(port) }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  procs.push(child);
  let err = "";
  child.stderr!.on("data", (d: Buffer) => (err += d));
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    if (child.exitCode !== null) break;
    const ok = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false);
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
    expect(typeof rec.pid_start === "string" && rec.pid_start.length > 0, "the owner's start token is recorded").toBe(true);
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

  it("`relay where --fields`: a wasm DB with a VALID record → exactly 8 lines, line 7 `http`, line 8 `http://127.0.0.1:<port> <key>`", async () => {
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
fs.writeFileSync(
  path.join(STUBS, "node"),
  `#!/bin/sh\ncase "$2 $3" in "where --fields") if [ -n "$FAKE_WHERE_FILE" ]; then cat "$FAKE_WHERE_FILE"; exit 0; fi ;; esac\nexec "${process.execPath}" "$@"\n`,
  { mode: 0o755 }
);
const SQLITE_LOG = path.join(ROOT, "sqlite3.log");
fs.writeFileSync(path.join(STUBS, "sqlite3"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${SQLITE_LOG}"\nexit 1\n`, { mode: 0o755 });

function runHook(c: Case, hook: string, extra: Record<string, string>, input = "") {
  fs.rmSync(SQLITE_LOG, { force: true });
  const env = baseEnv(c, { PATH: `${STUBS}:${process.env.PATH ?? ""}`, RELAY_AGENT_NAME: AGENT, RELAY_TEST_CLOCK: "0", ...extra });
  const r = spawnSync("bash", [path.join(HOOKS, hook)], { encoding: "utf-8", timeout: 60_000, input, env });
  const sqliteCalls = fs.existsSync(SQLITE_LOG) ? fs.readFileSync(SQLITE_LOG, "utf-8").split("\n").filter(Boolean) : [];
  return { status: r.status, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}`, stdout: r.stdout ?? "", sqliteCalls };
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
      const r = runHook(c, hook, { RELAY_AGENT_TOKEN: token }, input);
      expect(r.sqliteCalls, "never a sqlite3 read on a wasm DB").toEqual([]);
      expect(r.out, `the mail arrives over HTTP\n${r.out}\n${d.stderr()}`).toMatch(new RegExp(`pr1 mail for ${hook.replace(".", "\\.")}|pr1-sender`));
      await stopDaemon(d.child);
    },
    120_000
  );

  it("an IMPOSTOR on the record's port (a wrong MAC) receives ZERO token bytes, and the hook names the skip", async () => {
    const c = newCase("impostor");
    seedNativeDb(c);
    const spy = await startSpy((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ mac: "00".repeat(32) }));
    });
    const r = runHook(c, "check-relay.sh", { RELAY_AGENT_TOKEN: TOKEN, FAKE_WHERE_FILE: fakeWhere(c, "http", `http://127.0.0.1:${spy.port} ${KEY}`) });
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
    const r = runHook(c, "check-relay.sh", { RELAY_AGENT_TOKEN: TOKEN, FAKE_WHERE_FILE: fakeWhere(c, "http", `http://127.0.0.1:${spy.port} ${KEY}`) });
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
    const r = runHook(c, "check-relay.sh", { RELAY_AGENT_TOKEN: TOKEN, FAKE_WHERE_FILE: fakeWhere(c, "http", `http://127.0.0.1:${spy.port} ${KEY}`) });
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
    const r = runHook(c, "check-relay.sh", { RELAY_AGENT_TOKEN: TOKEN, FAKE_WHERE_FILE: fakeWhere(c, "http", line8(spy.port)) });
    expect(spy.requests, "no request at all").toEqual([]);
    expect(r.out).toMatch(/owner (endpoint|record) .*(malformed|invalid|not a loopback)/i);
    expect(r.sqliteCalls).toEqual([]);
  }, 60_000);

  it("a 7-line answer (an older relay CLI than these hooks) → a named version-skew skip: no sqlite3, no network", async () => {
    const c = newCase("seven");
    seedNativeDb(c);
    const spy = await startSpy((req, res) => res.end("{}"));
    const r = runHook(c, "check-relay.sh", { RELAY_AGENT_TOKEN: TOKEN, FAKE_WHERE_FILE: fakeWhere(c, "http", null) });
    expect(spy.requests).toEqual([]);
    expect(r.sqliteCalls).toEqual([]);
    expect(r.out).toMatch(/7-line answer[\s\S]*(version skew|update the relay)/i);
  }, 60_000);
});

describe("hook PR 1: the record is never deleted by relay code (a scan row)", () => {
  it("no src module removes the owner endpoint record (no unlink/rm of a .relay-owner.json path)", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".ts")) {
          const text = fs.readFileSync(full, "utf-8");
          if (/relay-owner\.json/.test(text) && /\b(unlinkSync|rmSync|unlink|rm)\s*\(/.test(text)) hits.push(path.relative(REPO, full));
        }
      }
    };
    walk(path.join(REPO, "src"));
    const recordModule = path.join(REPO, "src", "owner-endpoint.ts");
    expect(fs.existsSync(recordModule), "the record has its own module").toBe(true);
    expect(hits, "a module that names the record never removes a file").toEqual([]);
  });
});
