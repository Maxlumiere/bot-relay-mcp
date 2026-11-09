// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Hook PR 2, as ruled (rebuilt on the AEAD owner door): a STDIO process that owns a wasm DB opens the loopback
 * owner-peek listener (`transport: "stdio"` in its v3 record), which serves ONLY the owner door (AES-256-GCM under the
 * record's key, the instance binding in the AAD; no bearer), so the hooks read its agents' mail through it. Order:
 * lock → DB → listen → record. And (Q8) the wasm liveness self-heal: PostToolUse restamps the agent's anchor through the
 * SAME door (`relay owner liveness`: report_liveness with its normal auth, the agent's own token SEALED in), gated by a
 * per-(instance, agent) cache instead of a native DB read; no token, no call (as the native self-heal).
 * - A listen failure keeps the stdio server running (its 'error' row is in hook-pr1-owner-http.test.ts); the hooks
 *   name "the owner has no hook endpoint" (Q5).
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
/** An MCP client's first frame: a stdio server waits for its client's first byte before it starts (src/index.ts). */
const INITIALIZE = JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "hook-pr2-test", version: "1" } } }) + "\n";
/** Every stdout line is a JSON-RPC frame (stdout is MCP-only). */
/** Every stdout line is a JSON-RPC frame, and there IS at least one (the initialize reply): "" is not a pass. */
const onlyJsonRpc = (out: string) => {
  const lines = out.split("\n").filter(Boolean);
  return lines.length > 0 && lines.every((l) => { try { return (JSON.parse(l) as { jsonrpc?: string }).jsonrpc === "2.0"; } catch { return false; } });
};
/** A STDIO relay process on the case's wasm DB: its client sends `initialize` and keeps stdin open. Resolves once its record names a stdio owner. */
async function startStdioOwner(c: Case): Promise<StdioOwner> {
  const child = spawn(process.execPath, [DIST_INDEX], { env: baseEnv(c, { RELAY_TRANSPORT: "stdio" }), stdio: ["pipe", "pipe", "pipe"] });
  procs.push(child);
  child.stdin!.write(INITIALIZE);
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
/** The stdio owner's exit, or null after `ms` (an MCP client closing stdin must END it: #423 R1 P1). */
function exitWithin(child: ChildProcess, ms: number): Promise<number | null | "timeout"> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve("timeout"), ms);
    child.once("exit", (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
}
/** Stop an owner the way an MCP client does: close stdin, WAIT for it to end; only a stuck one gets a signal. */
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin?.end();
  if ((await exitWithin(child, 10_000)) !== "timeout") return;
  child.kill("SIGTERM");
  if ((await exitWithin(child, 10_000)) === "timeout") child.kill("SIGKILL");
}
interface Rec { v: number; host: string; port: number; pid: number; key: string; transport: string; instance_id: string; db_path: string }
const record = (c: Case) => JSON.parse(fs.readFileSync(c.record, "utf-8")) as Rec;
// THE AEAD DOOR, as ruled (an independent client implementing the spec).
const hkdf = (key: string, dir: "req" | "resp") => Buffer.from(crypto.hkdfSync("sha256", Buffer.from(key, "hex"), Buffer.alloc(0), `relay-owner-door v1 ${dir}`, 32));
const reqAad = (r: Rec, p: string, ts: number, nonce: string) => Buffer.from(`req\n${p}\n${ts}\n${nonce}\n${r.instance_id}\n${r.db_path}`);
const respAad = (r: Rec, p: string, ts: number, nonce: string, status: number) => Buffer.from(`resp\n${p}\n${ts}\n${nonce}\n${r.instance_id}\n${r.db_path}\n${status}`);
function seal(key: Buffer, aad: Buffer, plain: unknown) {
  const iv = crypto.randomBytes(12);
  const ci = crypto.createCipheriv("aes-256-gcm", key, iv);
  ci.setAAD(aad);
  const ct = Buffer.concat([ci.update(JSON.stringify(plain), "utf-8"), ci.final()]);
  return { iv: iv.toString("base64"), ct: ct.toString("base64"), tag: ci.getAuthTag().toString("base64") };
}
function openSealed(key: Buffer, aad: Buffer, env: { iv?: string; ct?: string; tag?: string }): unknown | null {
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(String(env.iv), "base64"));
    d.setAAD(aad);
    d.setAuthTag(Buffer.from(String(env.tag), "base64"));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(String(env.ct), "base64")), d.final()]).toString("utf-8"));
  } catch {
    return null;
  }
}
const PEEK = "/owner/v1/peek";
const LIVENESS = "/owner/v1/liveness";
/** One sealed exchange as a client with the key makes it; `opened` = the reply's plaintext when it authenticates. */
async function door(r: Rec, p: string, args: Record<string, unknown>, agent = AGENT) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString("hex");
  const body = JSON.stringify({ ts, client_nonce: nonce, ...seal(hkdf(r.key, "req"), reqAad(r, p, ts, nonce), { agent_name: agent, args }) });
  const res = await fetch(`http://127.0.0.1:${r.port}${p}`, { method: "POST", headers: { "Content-Type": "text/plain" }, body });
  const text = await res.text();
  let env: { iv?: string; ct?: string; tag?: string } = {};
  try {
    env = JSON.parse(text) as typeof env;
  } catch {
    /* not JSON */
  }
  return { status: res.status, opened: openSealed(hkdf(r.key, "resp"), respAad(r, p, ts, nonce, res.status), env) as Record<string, unknown> | null };
}
/** report_liveness through the door, the agent's token sealed in (as `relay owner liveness` sends it). */
const livenessArgs = (pid: number, start: string, token: string | null) => ({
  rpc: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "report_liveness", arguments: { agent_name: AGENT, agent_pid: pid, agent_pid_start: start } } },
  ...(token ? { agent_token: token } : {}),
});
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
  it("lock → DB → listen → record: a v3 record names a stdio owner on 127.0.0.1 (a kernel port) whose DOOR answers, sealed; a door request writes nothing to stdout", async () => {
    const c = newCase("stdio-record");
    seedWasmDb(c, "pr2 record mail");
    const o = await startStdioOwner(c);
    const rec = record(c);
    expect(rec).toMatchObject({ v: 3, host: "127.0.0.1", pid: o.child.pid, transport: "stdio" });
    expect(rec.port).toBeGreaterThan(0);
    const before = o.stdout();
    const r = await door(rec, PEEK, { with_content: 5 });
    expect(r.status).toBe(200);
    expect(r.opened, "the owner's reply authenticates").not.toBeNull();
    expect(JSON.stringify(r.opened)).toContain("pr2 record mail");
    await new Promise((x) => setTimeout(x, 200));
    expect(o.stdout(), "a door request wrote nothing to the MCP stdout").toBe(before);
    expect(onlyJsonRpc(o.stdout()), `stdout holds only JSON-RPC frames:\n${o.stdout()}`).toBe(true);
    await stop(o.child);
    expect(fs.existsSync(c.record), "the record is never deleted").toBe(true);
  }, 90_000);

  it("the stdio listener serves ONLY the door: /mcp, /health, /owner-id → 403; its liveness door restamps the anchor with the agent's own token (a wrong token: AUTH_FAILED, no restamp)", async () => {
    const c = newCase("stdio-gate");
    const { token } = seedWasmDb(c, "pr2 gate mail");
    const o = await startStdioOwner(c);
    const rec = record(c);
    const base = `http://127.0.0.1:${rec.port}`;
    for (const [m, p] of [["POST", "/mcp"], ["GET", "/mcp"], ["GET", "/health"], ["GET", "/owner-id"]] as const) {
      expect((await fetch(`${base}${p}`, { method: m, body: m === "POST" ? "{}" : undefined })).status, `${m} ${p}`).toBe(403);
    }
    const wrong = await door(rec, LIVENESS, livenessArgs(1111, "t-wrong", "pr2-not-the-agents-token-aaaaaaaa"));
    expect(JSON.stringify(wrong.opened), "a wrong token is the handler's own refusal").toMatch(/AUTH_FAILED/);
    // the anchor BEFORE any successful request: the wrong token wrote nothing
    await stop(o.child);
    expect((await anchorOf(c, AGENT)).agent_pid, "the wrong token did not restamp").not.toBe(1111);
    const o2 = await startStdioOwner(c);
    const live = await door(record(c), LIVENESS, livenessArgs(4242, "t0", token));
    expect(live.status).toBe(200);
    expect(live.opened, "the owner's reply authenticates").not.toBeNull();
    expect(JSON.stringify(live.opened)).not.toMatch(/AUTH_FAILED|isError":true/);
    await stop(o2.child);
    expect((await anchorOf(c, AGENT)).agent_pid, "the right token restamped").toBe(4242);
  }, 90_000);

  it("a SECOND stdio process on the same wasm DB is refused by name, opens no listener, and leaves the first owner's record", async () => {
    const c = newCase("stdio-second");
    seedWasmDb(c, "pr2 second");
    const o = await startStdioOwner(c);
    const before = record(c);
    // Its client speaks (an initialize), so it gets past the stdin guard to the owner lock.
    const second = spawnSync(process.execPath, [DIST_INDEX], { env: baseEnv(c, { RELAY_TRANSPORT: "stdio" }), encoding: "utf-8", input: INITIALIZE, timeout: 30_000 });
    expect(second.status).not.toBe(0);
    expect(second.stderr).toMatch(/another relay process owns this wasm DB/);
    expect(record(c), "the record still names the first owner").toEqual(before);
    await stop(o.child);
  }, 90_000);
});

/** PATH stubs: sqlite3 records every call; curl logs its argv (the URL), then runs the real curl. */
const STUBS = path.join(ROOT, "stubs");
fs.mkdirSync(STUBS, { recursive: true });
const SQLITE_LOG = path.join(ROOT, "sqlite3.log");
const CURL_LOG = path.join(ROOT, "curl.log");
const ARGV_LOG = path.join(ROOT, "argv.log");
fs.writeFileSync(path.join(STUBS, "sqlite3"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${SQLITE_LOG}"\nexit 1\n`, { mode: 0o755 });
/** ps: FAKE_PS_NO_LSTART makes ONLY the start-time lookup fail (a transient failure); everything else is the real ps. */
const REAL_PS = spawnSync("sh", ["-c", "command -v ps"], { encoding: "utf-8" }).stdout.trim();
fs.writeFileSync(path.join(STUBS, "ps"), `#!/bin/sh\nif [ -n "$FAKE_PS_NO_LSTART" ]; then case "$*" in *lstart*) exit 1 ;; esac; fi\nexec "${REAL_PS}" "$@"\n`, { mode: 0o755 });
const REAL_CURL = spawnSync("sh", ["-c", "command -v curl"], { encoding: "utf-8" }).stdout.trim();
fs.writeFileSync(path.join(STUBS, "curl"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${CURL_LOG}"\nexec "${REAL_CURL}" "$@"\n`, { mode: 0o755 });
/** node: `node <relay> where --fields` prints FAKE_WHERE_FILE when set; anything else runs node. */
fs.writeFileSync(
  path.join(STUBS, "node"),
  `#!/bin/sh\nprintf 'node %s\\n' "$*" >> "${ARGV_LOG}"\ncase "$2 $3" in "where --fields") if [ -n "$FAKE_WHERE_FILE" ]; then cat "$FAKE_WHERE_FILE"; exit 0; fi ;; esac\nexec "${process.execPath}" "$@"\n`,
  { mode: 0o755 }
);
async function runHook(c: Case, hook: string, extra: Record<string, string>, input = "") {
  fs.rmSync(SQLITE_LOG, { force: true });
  fs.rmSync(CURL_LOG, { force: true });
  fs.rmSync(ARGV_LOG, { force: true });
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
  const argv = lines(ARGV_LOG);
  return { status, out: `${stdout}\n${stderr}`, sqliteCalls: lines(SQLITE_LOG), livenessCalls: argv.filter((l) => / owner liveness /.test(l)).length, peekCalls: argv.filter((l) => / owner peek /.test(l)).length };
}
const PTU = JSON.stringify({ session_id: "s-pr2", hook_event_name: "PostToolUse" });
const inputFor = (hook: string) => (hook === "check-relay.sh" ? "" : JSON.stringify({ session_id: "s-pr2", hook_event_name: hook === "stop-check.sh" ? "Stop" : "PostToolUse" }));
const cacheFiles = (c: Case) => {
  const d = path.join(c.home, ".bot-relay", "hook-state");
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.startsWith("liveness-owner-")).map((f) => path.join(d, f)) : [];
};

describe.skipIf(WIN_NO_BASH_HOOKS)("hook PR 2: the hooks read a stdio owner's mail, and self-heal liveness through the door (POSIX)", () => {
  it.each(["check-relay.sh", "stop-check.sh", "post-tool-use-check.sh"])("%s: a STDIO wasm owner → the agent's pending mail over its loopback listener, never sqlite3", async (hook) => {
    const c = newCase(`stdio-${hook.split(".")[0]}`);
    const { token } = seedWasmDb(c, `pr2 stdio mail for ${hook}`);
    const o = await startStdioOwner(c);
    const r = await runHook(c, hook, { RELAY_AGENT_TOKEN: token }, inputFor(hook));
    expect(r.sqliteCalls).toEqual([]);
    expect(r.out, `${r.out}\n${o.stderr()}`).toMatch(new RegExp(`pr2 stdio mail for ${hook.replace(".", "\\.")}|${SENDER}`));
    expect(onlyJsonRpc(o.stdout()), `the stdio owner's stdout holds only JSON-RPC frames:\n${o.stdout()}`).toBe(true);
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

  it("Q8: a CHANGED pid → PostToolUse restamps the anchor through the door (ONE `relay owner liveness`), gated on the DB's stored anchor (no second copy kept); the steady state makes ZERO liveness calls", async () => {
    const c = newCase("live-restamp");
    const { token } = seedWasmDb(c, "pr2 live mail");
    const o = await startStdioOwner(c);
    const first = await runHook(c, "post-tool-use-check.sh", { RELAY_AGENT_TOKEN: token }, PTU);
    expect(first.peekCalls, `precondition: the mail was read through the door\n${first.out}`).toBeGreaterThanOrEqual(1);
    expect(first.livenessCalls, `ONE liveness call\n${first.out}`).toBe(1);
    expect(cacheFiles(c), "no second copy of the anchor (#423 R1 P2-3: the gate is the DB's truth)").toEqual([]);
    const steady = await runHook(c, "post-tool-use-check.sh", { RELAY_AGENT_TOKEN: token }, PTU);
    expect(steady.peekCalls, "precondition: the steady run read the mail").toBeGreaterThanOrEqual(1);
    expect(steady.livenessCalls, `the steady state: zero liveness calls\n${steady.out}`).toBe(0);
    await stop(o.child);
    expect((await anchorOf(c, AGENT)).agent_pid, "the anchor is the hook's agent pid (this test process)").toBe(process.pid);
  }, 150_000);

  it("Q8: a STALE stored start (the same pid, another start, set through the door) → one call, and the anchor is the agent's real one again", async () => {
    const c = newCase("live-stale");
    const { token } = seedWasmDb(c, "pr2 stale mail");
    const o = await startStdioOwner(c);
    const first = await runHook(c, "post-tool-use-check.sh", { RELAY_AGENT_TOKEN: token }, PTU);
    expect(first.livenessCalls, `precondition: the first run restamped\n${first.out}`).toBe(1);
    const stale = await door(record(c), LIVENESS, livenessArgs(process.pid, "a stale start", token));
    expect(JSON.stringify(stale.opened), "precondition: the stale start landed").not.toMatch(/AUTH_FAILED|isError":true/);
    const r = await runHook(c, "post-tool-use-check.sh", { RELAY_AGENT_TOKEN: token }, PTU);
    expect(r.livenessCalls, r.out).toBe(1);
    await stop(o.child);
    const a = await anchorOf(c, AGENT);
    expect(a.agent_pid).toBe(process.pid);
    expect(a.agent_pid_start, "the real start again").not.toBe("a stale start");
  }, 150_000);

  it("Q8: NO agent token → no liveness call at all (parity with the native self-heal); the mail is still read", async () => {
    const c = newCase("live-notoken");
    seedWasmDb(c, "pr2 notoken mail");
    const o = await startStdioOwner(c);
    const r = await runHook(c, "post-tool-use-check.sh", { RELAY_AGENT_TOKEN: "" }, PTU);
    expect(r.peekCalls, `precondition: the mail was read through the door\n${r.out}`).toBeGreaterThanOrEqual(1);
    expect(r.livenessCalls, `no token: zero liveness calls\n${r.out}`).toBe(0);
    expect(cacheFiles(c)).toEqual([]);
    await stop(o.child);
  }, 150_000);

  it("Q8: a FORGED liveness reply (a relay that forwards the peek to the owner but answers liveness itself) → refused: no cache, no token sent", async () => {
    const c = newCase("live-forged");
    const { token } = seedWasmDb(c, "pr2 forged mail");
    const o = await startStdioOwner(c);
    const real = record(c);
    const seen: string[] = [];
    const mitm = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d: Buffer) => (body += d));
      req.on("end", () => {
        seen.push(`${req.url}\n${JSON.stringify(req.headers)}\n${body}`);
        if (req.url === LIVENESS) {
          // a reply WITHOUT the key: a plausible envelope that cannot authenticate
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end(JSON.stringify({ iv: crypto.randomBytes(12).toString("base64"), ct: Buffer.from(JSON.stringify({ ok: true, agent: AGENT })).toString("base64"), tag: crypto.randomBytes(16).toString("base64") }));
          return;
        }
        const up = http.request({ host: "127.0.0.1", port: real.port, path: req.url, method: req.method, headers: req.headers }, (ur) => {
          let ub = "";
          ur.on("data", (x: Buffer) => (ub += x));
          ur.on("end", () => {
            res.writeHead(ur.statusCode ?? 500, { "Content-Type": "text/plain" });
            res.end(ub);
          });
        });
        up.end(body);
      });
    });
    await new Promise<void>((r) => mitm.listen(0, "127.0.0.1", () => r()));
    try {
      fs.writeFileSync(c.record, JSON.stringify({ ...real, port: (mitm.address() as { port: number }).port }), { mode: 0o600 });
      const r = await runHook(c, "post-tool-use-check.sh", { RELAY_AGENT_TOKEN: token }, PTU);
      expect(r.livenessCalls, `precondition: the liveness call ran\n${r.out}`).toBe(1);
      expect(seen.some((s) => s.startsWith(LIVENESS)), "precondition: the relay saw the liveness request").toBe(true);
      expect(cacheFiles(c), "a forged reply is never cached as a success").toEqual([]);
      expect(seen.join("\n"), "the agent's token never crosses the door in clear (it is sealed)").not.toContain(token);
    } finally {
      await new Promise<void>((r) => mitm.close(() => r()));
      await stop(o.child);
    }
  }, 150_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// #423 Codex R1 (each RED from the review's own inputs).
describe("#423 R1 P1: a stdio owner ENDS when its client closes stdin (every OS)", () => {
  it("stdin EOF alone (no signal) → the stdio owner exits, its lock is released, and a successor becomes the owner", async () => {
    const c = newCase("stdio-eof");
    seedWasmDb(c, "pr2 eof mail");
    const o = await startStdioOwner(c);
    o.child.stdin!.end(); // the MCP client goes away: no SIGTERM, no SIGINT
    const code = await exitWithin(o.child, 15_000);
    expect(code, `the owner ended on EOF alone (it kept running: the listener held the process)\n${o.stderr()}`).not.toBe("timeout");
    const next = await startStdioOwner(c);
    expect(record(c).pid, "the successor took ownership (the lock was released)").toBe(next.child.pid);
    await stop(next.child);
  }, 90_000);
});

describe("#423 R1 P2-3: the sealed peek carries the REQUESTING agent's stored anchor (every OS)", () => {
  it("peek as A → A's stored anchor (pid, start), and nothing of B's; the peek stays a PURE read (the anchors are unchanged)", async () => {
    const c = newCase("peek-anchor");
    const { token, senderToken } = seedWasmDb(c, "pr2 anchor mail");
    const o = await startStdioOwner(c);
    const rec = record(c);
    const setA = await door(rec, LIVENESS, livenessArgs(424_242, "t-A", token));
    expect(JSON.stringify(setA.opened), "precondition: A's anchor set").not.toMatch(/AUTH_FAILED|isError":true/);
    const setB = await door(rec, LIVENESS, {
      rpc: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "report_liveness", arguments: { agent_name: SENDER, agent_pid: 535_353, agent_pid_start: "t-B" } } },
      agent_token: senderToken,
    }, SENDER);
    expect(JSON.stringify(setB.opened), "precondition: B's anchor set").not.toMatch(/AUTH_FAILED|isError":true/);
    const peek = await door(rec, PEEK, { with_content: 0 });
    expect(peek.status).toBe(200);
    expect((peek.opened as { anchor?: unknown } | null)?.anchor, "the requesting agent's stored anchor").toEqual({ agent_pid: 424_242, agent_pid_start: "t-A" });
    expect(JSON.stringify(peek.opened), "nothing of another agent's").not.toMatch(/535353|t-B/);
    await stop(o.child);
    expect(await anchorOf(c, AGENT), "a pure read: A's anchor is unchanged").toEqual({ agent_pid: 424_242, agent_pid_start: "t-A" });
    expect(await anchorOf(c, SENDER), "and B's").toEqual({ agent_pid: 535_353, agent_pid_start: "t-B" });
  }, 90_000);
});

describe("#423 R1 P3-4: a listener that did not BIND publishes no record (every OS)", () => {
  it("the daemon's port is already taken → no owner record (it would name another process's port), and the bind failure is named", async () => {
    const c = newCase("bind-denied");
    // a NATIVE DB: every daemon owner writes a record once it listens
    fs.writeFileSync(c.cfg, "{}", { mode: 0o600 });
    const seed = spawnSync(process.execPath, ["--input-type=module", "-e", `const db = await import(${JSON.stringify(DIST_DB)}); db.registerAgent(${JSON.stringify(AGENT)}, "r", []); db.closeDb();`], { encoding: "utf-8", env: baseEnv(c) });
    expect(seed.status, seed.stderr).toBe(0);
    const squatter = http.createServer((_q, r) => r.end("not a relay"));
    await new Promise<void>((r) => squatter.listen(0, "127.0.0.1", () => r()));
    const port = (squatter.address() as { port: number }).port;
    try {
      const d = spawn(process.execPath, [DIST_INDEX], { env: baseEnv(c, { RELAY_TRANSPORT: "http", RELAY_HTTP_HOST: "127.0.0.1", RELAY_HTTP_PORT: String(port) }), stdio: ["ignore", "pipe", "pipe"] });
      procs.push(d);
      let err = "";
      d.stderr!.on("data", (x: Buffer) => (err += x));
      await exitWithin(d, 8_000);
      if (d.exitCode === null) d.kill("SIGKILL");
      expect(fs.existsSync(c.record), `no record for a listener that never bound\n${err}`).toBe(false);
      expect(err, "the bind failure is named").toMatch(/EADDRINUSE|could not listen|address already in use/i);
    } finally {
      await new Promise<void>((r) => squatter.close(() => r()));
    }
  }, 60_000);
});

describe.skipIf(WIN_NO_BASH_HOOKS)("#423 R1: the wasm self-heal keeps the PID-reuse guard and the DB's truth (POSIX)", () => {
  it("P2-2: a TRANSIENT start-time lookup failure (same pid) → no report, and the stored start is kept (never downgraded to NULL)", async () => {
    const c = newCase("live-nostart");
    const { token } = seedWasmDb(c, "pr2 nostart mail");
    const o = await startStdioOwner(c);
    const first = await runHook(c, "post-tool-use-check.sh", { RELAY_AGENT_TOKEN: token }, PTU);
    expect(first.livenessCalls, `precondition: the first run restamped\n${first.out}`).toBe(1);
    const failing = await runHook(c, "post-tool-use-check.sh", { RELAY_AGENT_TOKEN: token, FAKE_PS_NO_LSTART: "1" }, PTU);
    expect(failing.peekCalls, "precondition: the mail was read").toBeGreaterThanOrEqual(1);
    expect(failing.livenessCalls, `an unreadable start for the SAME pid reports nothing\n${failing.out}`).toBe(0);
    await stop(o.child);
    const a = await anchorOf(c, AGENT);
    expect(a.agent_pid).toBe(process.pid);
    expect(a.agent_pid_start, "the known start is kept").not.toBeNull();
  }, 150_000);

  it("P2-3: ANOTHER writer moves the stored anchor (B) after this agent's report (A) → the next run makes ONE call and the anchor is A again (no stale hit)", async () => {
    const c = newCase("live-interleave");
    const { token } = seedWasmDb(c, "pr2 interleave mail");
    const o = await startStdioOwner(c);
    const a = await runHook(c, "post-tool-use-check.sh", { RELAY_AGENT_TOKEN: token }, PTU);
    expect(a.livenessCalls, `precondition: A reported\n${a.out}`).toBe(1);
    const b = await door(record(c), LIVENESS, livenessArgs(999_999, "t-B", token));
    expect(JSON.stringify(b.opened), "precondition: B's report landed").not.toMatch(/AUTH_FAILED|isError":true/);
    const again = await runHook(c, "post-tool-use-check.sh", { RELAY_AGENT_TOKEN: token }, PTU);
    expect(again.livenessCalls, `the DB holds B, not A: ONE call\n${again.out}`).toBe(1);
    await stop(o.child);
    expect((await anchorOf(c, AGENT)).agent_pid, "the anchor is A's again").toBe(process.pid);
  }, 150_000);

  it("a WRONG agent token at the hook → the liveness call is refused: nothing recorded, the anchor untouched, and the next run with the right token still reports", async () => {
    const c = newCase("live-wrongtok");
    const { token } = seedWasmDb(c, "pr2 wrongtok mail");
    const o = await startStdioOwner(c);
    const bad = await runHook(c, "post-tool-use-check.sh", { RELAY_AGENT_TOKEN: "pr2-not-the-agents-token-bbbbbbbb" }, PTU);
    expect(cacheFiles(c), `a refused report is never recorded as a success\n${bad.out}`).toEqual([]);
    const good = await runHook(c, "post-tool-use-check.sh", { RELAY_AGENT_TOKEN: token }, PTU);
    expect(good.livenessCalls, `the right token still reports\n${good.out}`).toBe(1);
    await stop(o.child);
    expect((await anchorOf(c, AGENT)).agent_pid).toBe(process.pid);
  }, 150_000);
});
