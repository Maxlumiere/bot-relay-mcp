// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Hook PR 1: the hooks read a wasm DB's mail through its OWNER DOOR (as ruled after
 * Codex #418 R1). No bearer credential is ever sent on it.
 * - The owner writes realpath(parent)/.<basename>.relay-owner.json (v2, 0600 / an owner-only ACL set BEFORE the key
 *   bytes, after it is listening, never deleted): {v, host:"127.0.0.1", port, pid, pid_start, key, transport}.
 * - The door: POST /owner/v1/peek and /owner/v1/liveness. The request carries HMAC(key, "req\n" path ts nonce body)
 *   (a 30 s window, a replay cache); the reply carries HMAC(key, "resp\n" nonce status body), verified BEFORE anything
 *   is shown. The peek is a PURE read (`relay pending`'s query); liveness restamps the anchor only.
 * - The record is trusted only when it is a regular, single-linked, euid-owned, private file in a private dir (Windows:
 *   the owner-only ACL predicate).
 * - The client is `relay owner peek|liveness` (node's http, no proxy, no redirect; it opens no DB): it prints
 *   `relay pending --json`'s contract, so the hooks render the owner's mail with their LOCAL code.
 * - `where` line 8 is the URL only: the key never passes through bash, a file, the environment or argv.
 * - On `http`, SessionStart's credential calls go ONLY to a configured endpoint that IS the proven owner.
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
/** The wasm owner daemon (HTTP). Resolves once /health answers and its record exists. */
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
interface OwnerRecord {
  v: number;
  host: string;
  port: number;
  pid: number;
  pid_start: string | null;
  key: string;
  transport: string;
  instance_id: string;
  db_path: string;
}
/** Each key's INSTANCE BINDING (as ruled: the record's instance_id + canonical DB path, inside every MAC). */
const BINDINGS = new Map<string, { instance_id: string; db_path: string }>();
const bindRecord = (rec: OwnerRecord) => {
  BINDINGS.set(rec.key, { instance_id: rec.instance_id ?? "", db_path: rec.db_path ?? "" });
  return rec;
};
const readRecord = (c: Case) => bindRecord(JSON.parse(fs.readFileSync(c.record, "utf-8")) as OwnerRecord);

// ---------------------------------------------------------------------------------------------------------------------
// THE OWNER DOOR, as ruled: a MUTUAL MAC, no bearer credential. "\n" separates fields.
const hmac = (key: string, text: string) => crypto.createHmac("sha256", Buffer.from(key, "hex")).update(text).digest("hex");
const bindingOf = (key: string) => BINDINGS.get(key) ?? { instance_id: "", db_path: "" };
const reqMac = (key: string, p: string, ts: number, nonce: string, body: string) => {
  const b = bindingOf(key);
  return hmac(key, `req\n${b.instance_id}\n${b.db_path}\n${p}\n${ts}\n${nonce}\n${body}`);
};
const respMac = (key: string, nonce: string, status: number, body: string) => {
  const b = bindingOf(key);
  return hmac(key, `resp\n${b.instance_id}\n${b.db_path}\n${nonce}\n${status}\n${body}`);
};
const PEEK = "/owner/v1/peek";
const LIVENESS = "/owner/v1/liveness";
interface DoorOpts {
  ts?: number;
  nonce?: string;
  body?: string;
  mac?: string;
}
/** One door exchange, as a client with the key would make it. macOk: the reply carries the owner's response MAC. */
async function door(port: number, key: string, p: string, args: Record<string, unknown>, o: DoorOpts = {}) {
  const ts = o.ts ?? Math.floor(Date.now() / 1000);
  const nonce = o.nonce ?? crypto.randomBytes(16).toString("hex");
  const body = o.body ?? JSON.stringify({ agent_name: AGENT, args, ts, client_nonce: nonce });
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", "X-Owner-MAC": o.mac ?? reqMac(key, p, ts, nonce, body) },
    body,
  });
  const text = await res.text();
  const got = res.headers.get("x-owner-mac");
  return { status: res.status, text, nonce, macOk: got !== null && got === respMac(key, nonce, res.status, text) };
}
/** The whole DB, from a COPY read with sql.js (never an open of the live file): every table's rows, in order. */
async function dbDump(c: Case): Promise<Record<string, unknown[][]>> {
  const copy = path.join(c.home, `copy-${crypto.randomBytes(4).toString("hex")}.db`);
  fs.copyFileSync(c.db, copy);
  const initSqlJs = (await import("sql.js")).default;
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(copy));
  const out: Record<string, unknown[][]> = {};
  const tables = db.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")[0]?.values.map((r) => String(r[0])) ?? [];
  for (const t of tables) {
    const r = db.exec(`SELECT * FROM "${t}" ORDER BY rowid`)[0];
    out[t] = r ? [r.columns, ...r.values] : [];
  }
  db.close();
  return out;
}

describe("hook PR 1: the owner record and the owner door (every OS)", () => {
  it("a wasm DAEMON owner writes its v2 record after listening (POSIX 0600; Windows owner-only ACL), never deleted; GET /owner-id is retired", async () => {
    const c = newCase("record");
    seedWasmDb(c);
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    const rec = readRecord(c);
    expect(rec).toMatchObject({ v: 2, host: "127.0.0.1", port: d.port, pid: d.child.pid, transport: "http", db_path: fs.realpathSync.native(c.db) });
    expect(typeof rec.instance_id, "the record names its instance (\"\" for an explicit DB path)").toBe("string");
    expect(rec.key).toMatch(KEY_RE);
    if (process.platform === "win32") {
      const { privacyFaults } = (await import("../src/fs-perms.js")) as { privacyFaults: (p: string, m: number) => string[] };
      expect(privacyFaults(c.record, 0o600), "the record's ACL is owner-only").toEqual([]);
    } else {
      expect(typeof rec.pid_start === "string" && rec.pid_start.length > 0, "the owner's start token is recorded").toBe(true);
      expect(fs.statSync(c.record).mode & 0o777).toBe(0o600);
    }
    expect((await fetch(`http://127.0.0.1:${d.port}/owner-id?c=${"a".repeat(32)}`)).status, "the challenge door is retired").toBe(404);
    expect(await fetch(`http://127.0.0.1:${d.port}/health`).then((r) => r.text()), "/health does not carry the key").not.toContain(rec.key);
    await stopDaemon(d.child);
    expect(fs.existsSync(c.record), "the record is never deleted, even on a clean exit").toBe(true);
  }, 90_000);

  it("POST /owner/v1/peek: a MAC'd request gets the agent's pending set with a reply MAC; no bearer credential is asked for or used", async () => {
    const c = newCase("door-peek");
    seedWasmDb(c, "pr1 door mail");
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm", http_secret: `pr1-door-secret-${"x".repeat(32)}` }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    const { key } = readRecord(c);
    const r = await door(d.port, key, PEEK, { with_content: 5 });
    expect(r.status, r.text).toBe(200);
    expect(r.macOk, "the reply is MAC'd with the owner key").toBe(true);
    const body = JSON.parse(r.text) as { ok: boolean; registered: boolean; count: number; messages: Array<{ from_agent?: string; content?: string }> };
    expect(body).toMatchObject({ ok: true, registered: true, count: 1 });
    expect(body.messages[0]?.content).toBe("pr1 door mail");
    expect(r.text, "the key is never served").not.toContain(key);
    await stopDaemon(d.child);
  }, 90_000);

  it("the door REFUSES: a wrong MAC, a stale or future ts, a replayed nonce, a tampered body, another path's MAC, a malformed nonce: none reveals mail", async () => {
    const c = newCase("door-refuse");
    seedWasmDb(c, "pr1 refused mail");
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    const { key } = readRecord(c);
    const now = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomBytes(16).toString("hex");
    const goodBody = JSON.stringify({ agent_name: AGENT, args: { with_content: 5 }, ts: now, client_nonce: nonce });
    const cases: Array<[string, Promise<{ status: number; text: string }>]> = [
      ["a wrong MAC", door(d.port, key, PEEK, { with_content: 5 }, { mac: "00".repeat(32) })],
      ["a stale ts (60s old)", door(d.port, key, PEEK, { with_content: 5 }, { ts: now - 60 })],
      ["a future ts (60s ahead)", door(d.port, key, PEEK, { with_content: 5 }, { ts: now + 60 })],
      ["a tampered body", door(d.port, key, PEEK, {}, { ts: now, nonce: crypto.randomBytes(16).toString("hex"), mac: reqMac(key, PEEK, now, nonce, goodBody) })],
      ["the liveness path's MAC on peek", door(d.port, key, PEEK, { with_content: 5 }, { mac: reqMac(key, LIVENESS, now, nonce, goodBody), ts: now, nonce, body: goodBody })],
      ["a malformed nonce", door(d.port, key, PEEK, { with_content: 5 }, { nonce: "zz" })],
    ];
    for (const [what, p] of cases) {
      const r = await p;
      expect(r.status, `${what}: ${r.text}`).toBeGreaterThanOrEqual(400);
      expect(r.text, what).not.toContain("pr1 refused mail");
    }
    // A replay: the SAME request twice. The first is served; the second is refused (its nonce was seen).
    const rts = Math.floor(Date.now() / 1000);
    const rnonce = crypto.randomBytes(16).toString("hex");
    const rbody = JSON.stringify({ agent_name: AGENT, args: { with_content: 5 }, ts: rts, client_nonce: rnonce });
    const send = () =>
      fetch(`http://127.0.0.1:${d.port}${PEEK}`, { method: "POST", headers: { "Content-Type": "text/plain", "X-Owner-MAC": reqMac(key, PEEK, rts, rnonce, rbody) }, body: rbody });
    const first = await send();
    expect(first.status, await first.clone().text()).toBe(200);
    const again = await send();
    const againText = await again.text();
    expect(again.status, `a replayed nonce: ${againText}`).toBeGreaterThanOrEqual(400);
    expect(againText).not.toContain("pr1 refused mail");
    await stopDaemon(d.child);
  }, 90_000);

  it("the peek is a PURE read: after several peeks the DB is identical (no seq/epoch stamp, no read mark, no cursor move)", async () => {
    const c = newCase("door-pure");
    seedWasmDb(c, "pr1 pure mail");
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    const { key } = readRecord(c);
    await new Promise((r) => setTimeout(r, 1500)); // the owner's startup writes are behind it
    const before = await dbDump(c);
    for (let i = 0; i < 3; i++) expect((await door(d.port, key, PEEK, { with_content: 5 })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 500));
    const after = await dbDump(c);
    for (const t of ["messages", "mailbox", "agent_cursor", "inbox_events"]) expect(after[t], `table ${t} unchanged by the peek`).toEqual(before[t]);
    await stopDaemon(d.child);
  }, 90_000);

  it("POST /owner/v1/liveness restamps ONLY agent_pid / agent_pid_start / host_id; any other argument key is refused", async () => {
    const c = newCase("door-live");
    seedWasmDb(c);
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    const { key } = readRecord(c);
    await new Promise((r) => setTimeout(r, 1500));
    const before = await dbDump(c);
    const extra = await door(d.port, key, LIVENESS, { agent_pid: 4242, agent_pid_start: "t0", status: "busy" });
    expect(extra.status, `an extra key: ${extra.text}`).toBeGreaterThanOrEqual(400);
    const r = await door(d.port, key, LIVENESS, { agent_pid: 4242, agent_pid_start: "t0" });
    expect(r.status, r.text).toBe(200);
    expect(r.macOk).toBe(true);
    await new Promise((r2) => setTimeout(r2, 500));
    const after = await dbDump(c);
    for (const t of Object.keys(before)) {
      if (t === "agents") continue;
      expect(after[t], `table ${t} untouched by the liveness door`).toEqual(before[t]);
    }
    const cols = before.agents![0] as string[];
    const strip = (rows: unknown[][]) => rows.slice(1).map((row) => row.map((v, i) => (["agent_pid", "agent_pid_start", "host_id"].includes(cols[i]!) ? "*" : v)));
    expect(strip(after.agents!), "only agent_pid / agent_pid_start / host_id moved").toEqual(strip(before.agents!));
    const row = after.agents!.slice(1).find((x) => x[cols.indexOf("name")] === AGENT)!;
    expect(row[cols.indexOf("agent_pid")]).toBe(4242);
    expect(row[cols.indexOf("agent_pid_start")]).toBe("t0");
    await stopDaemon(d.child);
  }, 90_000);

  it("`relay where --fields`: a valid record → 8 lines, line 7 `http`, line 8 the URL ONLY (the key is never in where's answer); every OS (the pid is not part of validity, as ruled)", async () => {
    const c = newCase("where-http");
    seedWasmDb(c);
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    const { key } = readRecord(c);
    const w = whereFields(c);
    expect(w.lines.length, w.raw).toBe(8);
    expect(w.lines[6]).toBe("http");
    expect(w.lines[7]).toBe(`http://127.0.0.1:${d.port}`);
    expect(w.raw + w.stderr, "the key is in no part of where's answer").not.toContain(key);
    await stopDaemon(d.child);
  }, 90_000);

  it("the LOCK FREE (the owner exited, its record left behind) → not `http`, and the verdict is decided BY THE LOCK (every OS, Windows included)", async () => {
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
    const { ownerEndpointVerdict } = (await import("../src/owner-endpoint.js")) as { ownerEndpointVerdict: (db: string) => { ok: boolean; reason?: string } };
    expect(ownerEndpointVerdict(c.db)).toMatchObject({ ok: false, reason: "lock-free" });
  }, 90_000);

  it("the pid and its start token are INFORMATIONAL (as ruled): a record naming another pid, or a null start, is still valid while the lock is held; the door's MAC proves liveness", async () => {
    const c = newCase("where-pid");
    seedWasmDb(c);
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    const rec = readRecord(c);
    fs.writeFileSync(c.record, JSON.stringify({ ...rec, pid: process.pid, pid_start: null }), { mode: 0o600 });
    const { ownerEndpointVerdict } = (await import("../src/owner-endpoint.js")) as { ownerEndpointVerdict: (db: string) => { ok: boolean; reason?: string } };
    expect(ownerEndpointVerdict(c.db)).toMatchObject({ ok: true });
    expect(whereFields(c).lines[6]).toBe("http");
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

  it("the closed verdict set is pinned EXACTLY (TS), and the hooks' gate names each", async () => {
    const { HOOK_DB_VERDICTS } = (await import("../src/hook-db-verdict.js")) as { HOOK_DB_VERDICTS: readonly string[] };
    expect([...HOOK_DB_VERDICTS]).toEqual(["sqlite3", "skip-declared-wasm", "skip-rlyw", "skip-unreadable", "skip-owner-locked", "http"]);
    const src = fs.readFileSync(path.join(HOOKS, "_vault-helpers.sh"), "utf-8");
    for (const v of HOOK_DB_VERDICTS) expect(src, `the hooks know ${v}`).toMatch(new RegExp(`\\b${v.replace(/-/g, "\\-")}\\)`));
  });
});

describe("hook PR 1: the door's REPLAY cache, as ruled (expiry by ts, fail-closed when full, swept by a timer)", () => {
  type Verify = (p: string, raw: unknown, mac: unknown, nowMs?: number) => { ok: boolean; status?: number; error?: string };
  async function doorModule() {
    const m = (await import("../src/owner-endpoint.js")) as {
      verifyDoorRequest: Verify;
      writeOwnerEndpoint: (db: string, port: number, t: "http" | "stdio") => string;
      sweepDoorNonces: (nowMs: number) => void;
      doorNonceCount: () => number;
      _resetDoorNoncesForTests: () => void;
      DOOR_NONCE_CAPACITY: number;
    };
    const c = newCase("replay-key");
    fs.writeFileSync(c.db, "");
    const key = bindRecord(JSON.parse(fs.readFileSync(m.writeOwnerEndpoint(c.db, 1, "http"), "utf-8")) as OwnerRecord).key;
    m._resetDoorNoncesForTests();
    return { m, key };
  }
  const signed = (key: string, ts: number, nonce = crypto.randomBytes(16).toString("hex")) => {
    const body = JSON.stringify({ agent_name: AGENT, args: {}, ts, client_nonce: nonce });
    return { body, mac: reqMac(key, PEEK, ts, nonce, body) };
  };

  it("Codex's sequence and every t in the window: a request accepted once is REFUSED at every later instant it would still validate", async () => {
    const { m, key } = await doorModule();
    const T = 2_000_000_000;
    const { body, mac } = signed(key, T);
    expect(m.verifyDoorRequest(PEEK, body, mac, (T - 30) * 1000).ok, "accepted at the window's first instant").toBe(true);
    for (let t = (T - 30) * 1000; t <= (T + 30) * 1000 + 999; t += 250) {
      const r = m.verifyDoorRequest(PEEK, body, mac, t);
      expect(r.ok, `a replay at ${t - T * 1000}ms from ts`).toBe(false);
    }
    // Codex's exact numbers: ts 1030 accepted at 1000.000, replayed at 1060.000.
    m._resetDoorNoncesForTests();
    const c2 = signed(key, 1030);
    expect(m.verifyDoorRequest(PEEK, c2.body, c2.mac, 1_000_000).ok).toBe(true);
    expect(m.verifyDoorRequest(PEEK, c2.body, c2.mac, 1_060_000).ok, "Codex's replay at 1060").toBe(false);
  });

  it("a FULL cache refuses (fail closed), never evicting a live nonce; expired nonces are swept without new traffic (a timer)", async () => {
    const { m, key } = await doorModule();
    const T = 2_000_000_000;
    for (let i = 0; i < m.DOOR_NONCE_CAPACITY; i++) {
      const { body, mac } = signed(key, T);
      expect(m.verifyDoorRequest(PEEK, body, mac, T * 1000).ok).toBe(true);
    }
    const extra = signed(key, T);
    const r = m.verifyDoorRequest(PEEK, extra.body, extra.mac, T * 1000);
    expect(r.ok, "the cache is full: refused").toBe(false);
    expect(r.status).toBe(503);
    expect(m.doorNonceCount()).toBe(m.DOOR_NONCE_CAPACITY);
    m.sweepDoorNonces((T + 40) * 1000);
    expect(m.doorNonceCount(), "every nonce's ts has left the window: swept").toBe(0);
    const src = fs.readFileSync(path.join(REPO, "src", "owner-endpoint.ts"), "utf-8");
    expect(src, "a timer sweeps the cache (independent of traffic), unref'd").toMatch(/setInterval\(\s*\(\)\s*=>\s*sweepDoorNonces\([\s\S]{0,80}\.unref\(\)/);
    m._resetDoorNoncesForTests();
  });
});

describe("hook PR 1: the record TRUST model (cross-user), as ruled", () => {
  type Verdict = { ok: boolean; reason?: string };
  const verdictOf = async (db: string): Promise<Verdict> =>
    ((await import("../src/owner-endpoint.js")) as { ownerEndpointVerdict: (d: string) => Verdict }).ownerEndpointVerdict(db);

  it("the stat predicate: a regular file, nlink 1, owned by the effective uid, no group/other bits; a FOREIGN owner is refused", async () => {
    const { recordStatTrusted } = (await import("../src/owner-endpoint.js")) as { recordStatTrusted: (st: { isFile(): boolean; nlink: number; uid: number; mode: number }, euid: number) => boolean };
    const st = (o: Partial<{ file: boolean; nlink: number; uid: number; mode: number }>) => ({ isFile: () => o.file ?? true, nlink: o.nlink ?? 1, uid: o.uid ?? 501, mode: o.mode ?? 0o100600 });
    expect(recordStatTrusted(st({}), 501), "the control: trusted").toBe(true);
    expect(recordStatTrusted(st({ uid: 502 }), 501), "another user's record").toBe(false);
    expect(recordStatTrusted(st({ mode: 0o100644 }), 501), "0644").toBe(false);
    expect(recordStatTrusted(st({ mode: 0o100620 }), 501), "group-writable").toBe(false);
    expect(recordStatTrusted(st({ nlink: 2 }), 501), "a second hard link").toBe(false);
    expect(recordStatTrusted(st({ file: false }), 501), "not a regular file").toBe(false);
  });

  it.skipIf(process.platform === "win32")("a live owner's record that is a SYMLINK, 0644, hard-linked twice, or in a group/other-writable dir → refused by name; restored → trusted again", async () => {
    const c = newCase("trust");
    seedWasmDb(c);
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    expect(await verdictOf(c.db), "the control: a fresh record is trusted").toMatchObject({ ok: true });
    const original = fs.readFileSync(c.record);
    const elsewhere = path.join(c.home, "planted.json");
    // A symlink to a same-content file.
    fs.writeFileSync(elsewhere, original, { mode: 0o600 });
    fs.rmSync(c.record);
    fs.symlinkSync(elsewhere, c.record);
    expect(await verdictOf(c.db), "a symlinked record").toMatchObject({ ok: false, reason: "untrusted-record" });
    fs.rmSync(c.record);
    fs.writeFileSync(c.record, original, { mode: 0o600 });
    expect(await verdictOf(c.db), "restored").toMatchObject({ ok: true });
    fs.chmodSync(c.record, 0o644);
    expect(await verdictOf(c.db), "0644").toMatchObject({ ok: false, reason: "untrusted-record" });
    fs.chmodSync(c.record, 0o600);
    const link = path.join(c.home, "second-name.json");
    fs.linkSync(c.record, link);
    expect(await verdictOf(c.db), "a second hard link").toMatchObject({ ok: false, reason: "untrusted-record" });
    fs.rmSync(link);
    fs.chmodSync(c.dir, 0o775);
    expect(await verdictOf(c.db), "the DB's dir is group-writable").toMatchObject({ ok: false, reason: "untrusted-dir" });
    fs.chmodSync(c.dir, 0o700);
    expect(await verdictOf(c.db), "restored again").toMatchObject({ ok: true });
    await stopDaemon(d.child);
  }, 90_000);

  it.runIf(process.platform === "win32")("Windows twin: a record whose ACL grants another principal (Everyone: read) is refused", async () => {
    const c = newCase("trust-win");
    seedWasmDb(c);
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    const g = spawnSync("icacls", [c.record, "/grant", "*S-1-1-0:R"], { encoding: "utf-8" });
    expect(g.status, `${g.stdout}${g.stderr}`).toBe(0);
    expect(await verdictOf(c.db)).toMatchObject({ ok: false, reason: "untrusted-record" });
    await stopDaemon(d.child);
  }, 90_000);

  it("the WRITER is bound to its fd (as ruled): the temp name swapped for another file between create and write → the key lands only in the fd's own file, and NO record is published (every OS, a seam)", () => {
    const c = newCase("writer-swap");
    fs.writeFileSync(c.db, "");
    const script = path.join(c.home, "swap.mjs");
    const log = path.join(c.home, "swap.log");
    const decoyCopy = path.join(c.home, "decoy-was.txt");
    fs.writeFileSync(
      script,
      `import fs from "fs";
       const m = await import(${JSON.stringify(pathToFileURL(path.join(REPO, "dist", "owner-endpoint.js")).href)});
       // The swap: the temp name now names a DECOY (a second name keeps a view of it past any cleanup).
       m._setWriterHookForTests((tmp) => { fs.renameSync(tmp, tmp + ".moved"); fs.writeFileSync(tmp, ""); fs.linkSync(tmp, ${JSON.stringify(decoyCopy)}); });
       let threw = false;
       try { m.writeOwnerEndpoint(${JSON.stringify(c.db)}, 1234, "http"); } catch { threw = true; }
       const names = fs.readdirSync(${JSON.stringify(c.dir)});
       fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ threw, names }));`
    );
    const r = spawnSync(process.execPath, [script], { encoding: "utf-8", env: baseEnv(c), timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(fs.readFileSync(log, "utf-8")) as { threw: boolean; names: string[] };
    expect(out.threw, "an identity mismatch refuses the publication").toBe(true);
    expect(fs.existsSync(c.record), "no record is published").toBe(false);
    expect(fs.readFileSync(decoyCopy, "utf-8"), "the swapped-in file never receives the key").not.toMatch(/"key"/);
  }, 60_000);

  it.skipIf(process.platform === "win32")("POSIX: a SYMLINK swapped in for the temp name never receives the key (the write goes through the O_EXCL|O_NOFOLLOW fd)", () => {
    const c = newCase("writer-link");
    fs.writeFileSync(c.db, "");
    const outside = path.join(c.home, "outside.txt");
    fs.writeFileSync(outside, "");
    const script = path.join(c.home, "link.mjs");
    fs.writeFileSync(
      script,
      `import fs from "fs";
       const m = await import(${JSON.stringify(pathToFileURL(path.join(REPO, "dist", "owner-endpoint.js")).href)});
       m._setWriterHookForTests((tmp) => { fs.rmSync(tmp); fs.symlinkSync(${JSON.stringify(outside)}, tmp); });
       try { m.writeOwnerEndpoint(${JSON.stringify(c.db)}, 1234, "http"); } catch {}`
    );
    const r = spawnSync(process.execPath, [script], { encoding: "utf-8", env: baseEnv(c), timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(outside, "utf-8"), "the link's target got no key bytes").toBe("");
    expect(fs.existsSync(c.record) && fs.lstatSync(c.record).isSymbolicLink(), "no symlink was published as the record").toBe(false);
  }, 60_000);

  it("the READER is bound to its fd (as ruled): the record swapped for another file after the checks → refused (every OS, a seam)", async () => {
    const c = newCase("reader-swap");
    seedWasmDb(c);
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    const m = (await import("../src/owner-endpoint.js")) as {
      ownerEndpointVerdict: (db: string) => { ok: boolean; reason?: string };
      _setReaderHookForTests: (fn: ((p: string) => void) | null) => void;
    };
    expect(m.ownerEndpointVerdict(c.db), "the control").toMatchObject({ ok: true });
    m._setReaderHookForTests((p) => {
      const text = fs.readFileSync(p);
      fs.rmSync(p);
      fs.writeFileSync(p, text, { mode: 0o600 });
    });
    try {
      expect(m.ownerEndpointVerdict(c.db)).toMatchObject({ ok: false, reason: "untrusted-record" });
    } finally {
      m._setReaderHookForTests(null);
    }
    await stopDaemon(d.child);
  }, 90_000);

  it.skipIf(process.platform === "win32")("POSIX (as ruled): the guarantee is FILE-level: a group-writable ANCESTOR does not matter; the IMMEDIATE dir is refused when group/other-writable, unless sticky", async () => {
    const c = newCase("dirs");
    seedWasmDb(c);
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    const { ownerEndpointVerdict } = (await import("../src/owner-endpoint.js")) as { ownerEndpointVerdict: (db: string) => { ok: boolean; reason?: string } };
    const home = fs.statSync(c.home).mode & 0o7777;
    const dir = fs.statSync(c.dir).mode & 0o7777;
    try {
      fs.chmodSync(c.home, 0o777);
      expect(ownerEndpointVerdict(c.db), "a world-writable ANCESTOR: still trusted").toMatchObject({ ok: true });
      fs.chmodSync(c.dir, 0o1777);
      expect(ownerEndpointVerdict(c.db), "a sticky world-writable immediate dir: trusted").toMatchObject({ ok: true });
      fs.chmodSync(c.dir, 0o777);
      expect(ownerEndpointVerdict(c.db), "a world-writable immediate dir: refused").toMatchObject({ ok: false, reason: "untrusted-dir" });
    } finally {
      fs.chmodSync(c.dir, dir);
      fs.chmodSync(c.home, home);
    }
    await stopDaemon(d.child);
  }, 90_000);

  it.runIf(process.platform === "win32")("Windows (as ruled, option A): the record's dir with a foreign WRITE-capable ACE (Everyone: write) is refused; the default Temp chain is accepted", async () => {
    const c = newCase("dir-win");
    seedWasmDb(c);
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    const { ownerEndpointVerdict } = (await import("../src/owner-endpoint.js")) as { ownerEndpointVerdict: (db: string) => { ok: boolean; reason?: string } };
    expect(ownerEndpointVerdict(c.db), "the default profile/Temp chain: accepted").toMatchObject({ ok: true });
    const g = spawnSync("icacls", [c.dir, "/grant", "*S-1-1-0:(W)"], { encoding: "utf-8" });
    expect(g.status, `${g.stdout}${g.stderr}`).toBe(0);
    expect(ownerEndpointVerdict(c.db)).toMatchObject({ ok: false, reason: "untrusted-dir" });
    await stopDaemon(d.child);
  }, 90_000);

  it("INSTANCE BINDING (as ruled): instance B's record relocated beside instance A's DB is refused (the record names B's DB; the MACs bind A)", async () => {
    const a = newCase("bind-a");
    const b = newCase("bind-b");
    seedWasmDb(a, "pr1 A mail");
    seedWasmDb(b, "pr1 B mail");
    for (const c of [a, b]) fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    const da = await startOwnerDaemon(a);
    const db = await startOwnerDaemon(b);
    fs.writeFileSync(a.record, fs.readFileSync(b.record), { mode: 0o600 });
    const { ownerEndpointVerdict } = (await import("../src/owner-endpoint.js")) as { ownerEndpointVerdict: (d: string) => { ok: boolean; reason?: string } };
    expect(ownerEndpointVerdict(a.db)).toMatchObject({ ok: false, reason: "bound-elsewhere" });
    const r = spawnSync(process.execPath, [RELAY, "owner", "peek", AGENT, "--json", "--with-content", "5", "--timeout-ms", "5000"], { encoding: "utf-8", env: baseEnv(a) });
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr, "B's mail is never shown as A's").not.toContain("pr1 B mail");
    await stopDaemon(da.child);
    await stopDaemon(db.child);
  }, 120_000);

  it("the record writer sets the owner-only ACL BEFORE any key byte, and an ACL fault publishes NO record (every OS, an injected fault)", () => {
    const c = newCase("acl-order");
    fs.writeFileSync(c.db, "");
    const script = path.join(c.home, "acl.mjs");
    const log = path.join(c.home, "acl.log");
    fs.writeFileSync(
      script,
      `import fs from "fs";
       const m = await import(${JSON.stringify(pathToFileURL(path.join(REPO, "dist", "owner-endpoint.js")).href)});
       const seen = [];
       m._setAclRestrictForTests((p) => { seen.push(fs.statSync(p).size); return ["an injected ACL fault"]; });
       let threw = false;
       try { m.writeOwnerEndpoint(${JSON.stringify(c.db)}, 1234, "http"); } catch { threw = true; }
       const left = fs.readdirSync(${JSON.stringify(c.dir)}).filter((f) => f.includes("relay-owner"));
       m._setAclRestrictForTests((p) => { seen.push(fs.statSync(p).size); return []; });
       m.writeOwnerEndpoint(${JSON.stringify(c.db)}, 1234, "http");
       fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ threw, left, seen }));`
    );
    const r = spawnSync(process.execPath, [script], { encoding: "utf-8", env: baseEnv(c), timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(fs.readFileSync(log, "utf-8")) as { threw: boolean; left: string[]; seen: number[] };
    expect(out.threw, "an ACL fault refuses the write").toBe(true);
    expect(out.left, "no record and no temp file is left").toEqual([]);
    expect(out.seen, "the ACL is set while the file holds ZERO bytes (before the key)").toEqual([0, 0]);
    expect(fs.existsSync(c.record), "with a clean ACL the record is written").toBe(true);
  }, 60_000);
});

describe("hook PR 1: `relay owner peek` (the hooks' client): the door's one exchange, printed as `relay pending --json` prints (every OS)", () => {
  it("its JSON has exactly `relay pending --json`'s keys (plus source: owner), with the content; it opens NO DB (a spy with a positive control)", async () => {
    const twin = newCase("owner-cli-twin");
    seedNativeDb(twin);
    const pend = spawnSync(process.execPath, [RELAY, "pending", AGENT, "--json", "--with-content", "5"], { encoding: "utf-8", env: baseEnv(twin) });
    expect(pend.status, pend.stderr).toBe(0);
    const pendKeys = Object.keys(JSON.parse(pend.stdout) as object).sort();
    const c = newCase("owner-cli");
    seedWasmDb(c, "pr1 cli mail");
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    const spyLog = path.join(c.home, "spy.log");
    const spy = path.join(c.home, "spy.cjs");
    fs.writeFileSync(
      spy,
      `const M = require("module"); const fs = require("fs"); const load = M._load;\n` +
        `M._load = function (req, ...rest) { const m = load.call(this, req, ...rest);\n` +
        `  if (/(^|[\\\\/])better-sqlite3$/.test(req) && typeof m === "function") { return new Proxy(m, { construct(t, a) { fs.appendFileSync(${JSON.stringify(spyLog)}, "better-sqlite3 " + String(a[0]) + "\\n"); return Reflect.construct(t, a); } }); }\n` +
        `  if (/(^|[\\\\/])sql\\.js$/.test(req)) fs.appendFileSync(${JSON.stringify(spyLog)}, "sql.js loaded\\n");\n` +
        `  return m; };\n`
    );
    // The spy's positive control on the SAME CLI: `relay pending` on the native twin opens its DB, and the spy sees it.
    const ctl = spawnSync(process.execPath, ["--require", spy, RELAY, "pending", AGENT, "--json"], { encoding: "utf-8", env: baseEnv(twin) });
    expect(ctl.status, ctl.stderr).toBe(0);
    expect(fs.existsSync(spyLog) ? fs.readFileSync(spyLog, "utf-8") : "", "positive control: the spy sees the CLI open a DB").toMatch(/better-sqlite3|sql\.js/);
    fs.rmSync(spyLog, { force: true });
    const r = spawnSync(process.execPath, ["--require", spy, RELAY, "owner", "peek", AGENT, "--json", "--with-content", "5", "--timeout-ms", "5000"], { encoding: "utf-8", env: baseEnv(c) });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as Record<string, unknown> & { messages: Array<{ content?: string }> };
    expect(Object.keys(out).filter((k) => k !== "source" && k !== "registered").sort()).toEqual(pendKeys);
    expect(out.registered).toBe(true);
    expect(out.source).toBe("owner");
    expect(out.messages[0]?.content).toBe("pr1 cli mail");
    expect(fs.existsSync(spyLog) ? fs.readFileSync(spyLog, "utf-8") : "", "the client opens NO DB").toBe("");
    await stopDaemon(d.child);
  }, 90_000);

  it("an UNREGISTERED agent (as ruled): the owner answers, so the peek exits 0 with registered:false and EMPTY mail", async () => {
    const c = newCase("owner-cli-unreg");
    seedWasmDb(c);
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    const r = spawnSync(process.execPath, [RELAY, "owner", "peek", "pr1-newcomer", "--json", "--timeout-ms", "5000"], { encoding: "utf-8", env: baseEnv(c) });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, registered: false, count: 0, messages: [], source: "owner" });
    await stopDaemon(d.child);
  }, 90_000);

  it("--timeout-ms is ENFORCED: an owner that never answers → a named failure inside the bound", async () => {
    const c = newCase("owner-cli-timeout");
    seedWasmDb(c);
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    // A listener that accepts and never answers, recorded in place of the owner's port (the owner still holds the lock).
    const silent = http.createServer(() => {});
    servers.push(silent);
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", () => r()));
    const rec = readRecord(c);
    fs.writeFileSync(c.record, JSON.stringify({ ...rec, port: (silent.address() as { port: number }).port }), { mode: 0o600 });
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [RELAY, "owner", "peek", AGENT, "--json", "--timeout-ms", "1500"], { encoding: "utf-8", env: baseEnv(c), timeout: 30_000 });
    expect(Date.now() - t0, "bounded by --timeout-ms (plus node's start)").toBeLessThan(6000);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/relay owner: .*(timed out|no answer|did not answer)/i);
    await stopDaemon(d.child);
  }, 90_000);
});

/**
 * Q9, as ruled: the record ALWAYS names a listener the hooks reach as 127.0.0.1. A daemon 127.0.0.1 cannot reach (bound
 * to ::1 or one LAN address, or whose Host allowlist leaves 127.0.0.1 out) also opens the loopback OWNER-PEEK listener,
 * and the record names it. That listener serves ONLY the two door endpoints.
 */
const LAN_V4 = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal)?.address ?? null;
const V6_LOOPBACK = await new Promise<boolean>((resolve) => {
  const srv = http.createServer();
  srv.once("error", () => resolve(false));
  srv.listen(0, "::1", () => srv.close(() => resolve(true)));
});
const UNREACHABLE_BINDS: Array<[string, string | null]> = [
  ["::1 (IPv6 loopback only)", V6_LOOPBACK ? "::1" : null],
  ["one LAN IPv4 address (with an http_secret, as a non-loopback bind requires)", LAN_V4],
];
const PEEK_SECRET = `pr1-peek-secret-${crypto.randomBytes(16).toString("hex")}`;

describe("hook PR 1 (Q9): a main listener 127.0.0.1 cannot reach → the loopback owner-peek listener, and the record names it", () => {
  it.skipIf(!V6_LOOPBACK)("a daemon bound to ::1 (IPv6 loopback only; skipped by name where the runner has no ::1)", () => peekListenerRow("::1"), 90_000);
  it.skipIf(LAN_V4 === null)("a daemon bound to one LAN IPv4 address (skipped by name where the runner has none)", () => peekListenerRow(LAN_V4!), 90_000);
  async function peekListenerRow(host: string) {
    const c = newCase(`peek-${host.replace(/[^0-9a-z]/gi, "")}`);
    seedWasmDb(c, "pr1 peek-listener mail");
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm", http_secret: PEEK_SECRET }), { mode: 0o600 });
    const d = await startOwnerDaemon(c, host);
    const rec = readRecord(c);
    expect(rec.host).toBe("127.0.0.1");
    expect(rec.port, "the record names the peek listener, not the main one").not.toBe(d.port);
    const r = await door(rec.port, rec.key, PEEK, { with_content: 5 });
    expect(r.status, r.text).toBe(200);
    expect(r.macOk).toBe(true);
    expect(r.text).toContain("pr1 peek-listener mail");
    if (host === LAN_V4) {
      const off = await fetch(`http://${LAN_V4}:${rec.port}${PEEK}`, { method: "POST", body: "{}" }).then((x) => x.status, () => "refused");
      expect(off, "the peek listener is bound to 127.0.0.1 only").toBe("refused");
    }
    await stopDaemon(d.child);
  }

  it.skipIf(!V6_LOOPBACK && LAN_V4 === null)("the peek listener serves ONLY the two door endpoints: every other route of startHttpServer, /mcp, /owner-id, /health → 403; a WS upgrade is never accepted (skipped by name with no address 127.0.0.1 cannot reach)", async () => {
    const host = (V6_LOOPBACK ? "::1" : LAN_V4)!;
    const c = newCase("peek-gate");
    seedWasmDb(c);
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm", http_secret: PEEK_SECRET }), { mode: 0o600 });
    const d = await startOwnerDaemon(c, host);
    const rec = readRecord(c);
    const peek = `http://127.0.0.1:${rec.port}`;
    const src = fs.readFileSync(path.join(REPO, "src", "transport", "http.ts"), "utf-8");
    const routes = [...src.matchAll(/app\.(get|post|put|delete|patch|all)\(\s*"([^"]+)"/g)].map((m) => [m[1]!.toUpperCase(), m[2]!] as const);
    expect(routes.length, "precondition: the route scan found the routes").toBeGreaterThan(15);
    expect(routes.some(([m, r]) => m === "POST" && r === PEEK), "precondition: the door's routes are literal in http.ts").toBe(true);
    for (const [method, route] of routes) {
      if (method === "POST" && (route === PEEK || route === LIVENESS)) continue;
      const res = await fetch(`${peek}${route.replace(/:[a-z_]+/gi, "x")}`, { method: method === "ALL" ? "GET" : method, headers: { "X-Relay-Secret": PEEK_SECRET }, body: method === "GET" ? undefined : "{}" });
      expect(res.status, `${method} ${route}`).toBe(403);
    }
    for (const [m, r] of [["POST", "/mcp"], ["GET", "/mcp"], ["GET", "/owner-id"], ["GET", "/health"]] as const) {
      expect((await fetch(`${peek}${r}`, { method: m, body: m === "POST" ? "{}" : undefined })).status, `${m} ${r}`).toBe(403);
    }
    const upgraded = await new Promise<string>((resolve) => {
      const req = http.request({ host: "127.0.0.1", port: rec.port, path: "/dashboard/ws", headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64") } });
      req.on("upgrade", () => resolve("upgraded"));
      req.on("response", (x) => resolve(`status ${x.statusCode}`));
      req.on("error", () => resolve("refused"));
      req.end();
    });
    expect(upgraded, "a WS upgrade is never accepted").not.toBe("upgraded");
    await stopDaemon(d.child);
  }, 180_000);

  it("twin: a daemon bound to 127.0.0.1 records its MAIN port (no second listener)", async () => {
    const c = newCase("peek-twin");
    seedWasmDb(c);
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    expect(readRecord(c).port).toBe(d.port);
    await stopDaemon(d.child);
  }, 90_000);

  it("a daemon whose Host allowlist leaves 127.0.0.1 out → the peek listener (loopback-only Host check); the main door is Host-checked", async () => {
    const c = newCase("peek-hostlist");
    seedWasmDb(c);
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    const d = await startOwnerDaemon(c, "127.0.0.1", { RELAY_HTTP_ALLOWED_HOSTS: "relay.example.internal" });
    const rec = readRecord(c);
    expect(rec.port).not.toBe(d.port);
    expect((await door(rec.port, rec.key, PEEK, {})).status).toBe(200);
    expect((await door(d.port, rec.key, PEEK, {})).status, "the main door is Host-checked").toBe(421);
    await stopDaemon(d.child);
  }, 90_000);

  it("the peek listener's bind host is a CONSTANT 127.0.0.1: startHttpServer in owner-peek mode refuses any other host", async () => {
    // A LITERAL specifier (the parser-pin gate refuses a computed one); the assert throws before any setup.
    const mod = (await import("../src/transport/http.js")) as { startHttpServer: (p: number, h: string, o?: { ownerPeek?: boolean }) => unknown };
    for (const h of ["0.0.0.0", "::", "::1", "localhost", LAN_V4 ?? "10.0.0.1"]) {
      expect(() => mod.startHttpServer(0, h, { ownerPeek: true }), h).toThrow(/127\.0\.0\.1/);
    }
  });

  it("the owner-peek listener SURVIVES its own listen failure (an async 'error' event): logged, no record, the process lives", () => {
    const c = newCase("peek-error");
    fs.writeFileSync(c.cfg, "{}", { mode: 0o600 });
    const script = path.join(c.home, "peek-error.mjs");
    fs.writeFileSync(
      script,
      `const { startHttpServer } = await import(${JSON.stringify(pathToFileURL(path.join(REPO, "dist", "transport", "http.js")).href)});
       const s = startHttpServer(0, "127.0.0.1", { ownerPeek: true });
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

// ---------------------------------------------------------------------------------------------------------------------
// The hook rows: bash, POSIX. Spies stand in for an inherited destination, a proxy, or a port thief.
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
/** PATH stubs: node and curl log their argv AND environment; rm copies each file the hook deletes; sqlite3 logs calls. */
const STUBS = path.join(ROOT, "stubs");
fs.mkdirSync(STUBS, { recursive: true });
const ARGV_LOG = path.join(ROOT, "argv.log");
const ENV_LOG = path.join(ROOT, "env.log");
const RM_CAPTURE = path.join(ROOT, "rm-capture.log");
fs.writeFileSync(
  path.join(STUBS, "node"),
  `#!/bin/sh\nprintf 'node %s\\n' "$*" >> "${ARGV_LOG}"\nenv >> "${ENV_LOG}"\n` +
    `if [ -n "$FAKE_NODE_HANG" ]; then case "$*" in *"$FAKE_NODE_HANG"*) exec sleep 30 ;; esac; fi\n` +
    `case "$2 $3" in "where --fields") if [ -n "$FAKE_WHERE_FILE" ]; then cat "$FAKE_WHERE_FILE"; exit 0; fi ;; esac\n` +
    `if [ -n "$FAKE_PENDING_RC" ] && [ "$2" = pending ]; then exit "$FAKE_PENDING_RC"; fi\n` +
    `exec "${process.execPath}" "$@"\n`,
  { mode: 0o755 }
);
const REAL_CURL = spawnSync("sh", ["-c", "command -v curl"], { encoding: "utf-8" }).stdout.trim();
const REAL_RM = spawnSync("sh", ["-c", "command -v rm"], { encoding: "utf-8" }).stdout.trim();
fs.writeFileSync(path.join(STUBS, "curl"), `#!/bin/sh\nprintf 'curl %s\\n' "$*" >> "${ARGV_LOG}"\nenv >> "${ENV_LOG}"\nexec "${REAL_CURL}" "$@"\n`, { mode: 0o755 });
fs.writeFileSync(
  path.join(STUBS, "rm"),
  `#!/bin/sh\nfor a in "$@"; do case "$a" in -*) ;; *) [ -f "$a" ] && { printf '== %s\\n' "$a"; cat "$a"; printf '\\n'; } >> "${RM_CAPTURE}" ;; esac; done\nexec "${REAL_RM}" "$@"\n`,
  { mode: 0o755 }
);
const REAL_PS = spawnSync("sh", ["-c", "command -v ps"], { encoding: "utf-8" }).stdout.trim();
fs.writeFileSync(path.join(STUBS, "ps"), `#!/bin/sh\nprintf 'ps %s\\n' "$*" >> "${ARGV_LOG}"\nif [ -n "$FAKE_PS_HANG" ]; then exec sleep 30; fi\nexec "${REAL_PS}" "$@"\n`, { mode: 0o755 });
const SQLITE_LOG = path.join(ROOT, "sqlite3.log");
fs.writeFileSync(path.join(STUBS, "sqlite3"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${SQLITE_LOG}"\nexit 1\n`, { mode: 0o755 });

/** The hook, run ASYNCHRONOUSLY (a spy in this process must not be starved by a spawnSync). */
async function runHook(c: Case, hook: string, extra: Record<string, string>, input = "") {
  for (const f of [SQLITE_LOG, ARGV_LOG, ENV_LOG, RM_CAPTURE]) fs.rmSync(f, { force: true });
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
  const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf-8") : "");
  return { status, out: `${stdout}\n${stderr}`, sqliteCalls: read(SQLITE_LOG).split("\n").filter(Boolean), argv: read(ARGV_LOG), env: read(ENV_LOG), removed: read(RM_CAPTURE), ms: Date.now() - t0 };
}
function fakeWhere(c: Case, line7: string, line8: string | null): string {
  const f = path.join(c.home, `where-${crypto.randomBytes(4).toString("hex")}.txt`);
  const lines = ["explicit-db", c.db, "true", "", "", path.join(c.dir, "agents"), line7, ...(line8 === null ? [] : [line8])];
  fs.writeFileSync(f, lines.join("\n") + "\n");
  return f;
}
const HOOK_SET = ["check-relay.sh", "stop-check.sh", "post-tool-use-check.sh"] as const;
const inputFor = (hook: string) => (hook === "check-relay.sh" ? "" : JSON.stringify({ session_id: "s-pr1", hook_event_name: hook === "stop-check.sh" ? "Stop" : "PostToolUse" }));
const mailIn = (out: string, text: string) => new RegExp(`${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|pr1-sender`).test(out);
const SECRET = `pr1-http-secret-${crypto.randomBytes(16).toString("hex")}`;
const TOKEN = "pr1-secret-token-aaaaaaaaaaaaaaaa";

describe.skipIf(WIN_NO_BASH_HOOKS)("hook PR 1: the hooks read mail through the owner door (POSIX)", () => {
  it.each(HOOK_SET)("%s: a wasm DAEMON owner → the agent's mail through the door, never sqlite3", async (hook) => {
    const c = newCase(`deliver-${hook.split(".")[0]}`);
    const token = seedWasmDb(c, `pr1 mail for ${hook}`);
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm", http_secret: SECRET }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    const r = await runHook(c, hook, { RELAY_AGENT_TOKEN: token }, inputFor(hook));
    expect(r.sqliteCalls, "never a sqlite3 read on a wasm DB").toEqual([]);
    expect(mailIn(r.out, `pr1 mail for ${hook}`), `the mail arrives\n${r.out}\n${d.stderr()}`).toBe(true);
    await stopDaemon(d.child);
  }, 120_000);

  it.skipIf(!V6_LOOPBACK && LAN_V4 === null).each(HOOK_SET)("%s through the PEEK LISTENER (a daemon 127.0.0.1 cannot reach) → the mail, never sqlite3 (skipped by name with no such address)", async (hook) => {
    const host = (V6_LOOPBACK ? "::1" : LAN_V4)!;
    const c = newCase(`peek-${hook.split(".")[0]}`);
    const token = seedWasmDb(c, `pr1 peek mail for ${hook}`);
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm", http_secret: PEEK_SECRET }), { mode: 0o600 });
    const d = await startOwnerDaemon(c, host);
    const r = await runHook(c, hook, { RELAY_AGENT_TOKEN: token }, inputFor(hook));
    expect(r.sqliteCalls).toEqual([]);
    expect(mailIn(r.out, `pr1 peek mail for ${hook}`), `${r.out}\n${d.stderr()}`).toBe(true);
    await stopDaemon(d.child);
  }, 120_000);

  it.each(["check-relay.sh", "post-tool-use-check.sh"])("%s: a PORT THIEF (the record's port answered by someone without the key) gets NO credential, and its forged reply is never shown", async (hook) => {
    const c = newCase(`thief-${hook.split(".")[0]}`);
    const token = seedWasmDb(c, "pr1 real mail");
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm", http_secret: SECRET }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    const forged = JSON.stringify({ ok: true, registered: true, session_bound: false, count: 1, top_priority: "high", messages: [{ id: "x", from_agent: "pr1-sender", content: "FORGED-MAIL-INJECTION", created_at: "now", priority: "high" }] });
    const thief = await startSpy((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain", "X-Owner-MAC": "00".repeat(32) });
      res.end(forged);
    });
    fs.writeFileSync(c.record, JSON.stringify({ ...readRecord(c), port: thief.port }), { mode: 0o600 });
    const r = await runHook(c, hook, { RELAY_AGENT_TOKEN: token, RELAY_HTTP_HOST: "127.0.0.1", RELAY_HTTP_PORT: String(thief.port) }, inputFor(hook));
    expect(thief.requests.length, `precondition: the thief was asked (${r.out})`).toBeGreaterThan(0);
    expect(thief.bytes(), "the thief got no agent token").not.toContain(token);
    expect(thief.bytes(), "the thief got no http_secret").not.toContain(SECRET);
    expect(thief.requests.every((q) => q.headers["x-agent-token"] === undefined && q.headers["x-relay-secret"] === undefined && q.headers.authorization === undefined), "no bearer header at all").toBe(true);
    expect(r.out, "the forged reply is never rendered").not.toContain("FORGED-MAIL-INJECTION");
    expect(r.out).toMatch(/relay owner: .*reply .*(MAC|forged|altered)/i);
    expect(r.sqliteCalls).toEqual([]);
    await stopDaemon(d.child);
  }, 120_000);

  it("a TAMPERED reply (relayed from the real owner, its body altered, the owner's MAC kept) → nothing from it is shown", async () => {
    const c = newCase("tamper");
    const token = seedWasmDb(c, "pr1 tamper mail");
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    const relayTo = d.port;
    const mitm = await startSpy((req, res, body) => {
      const up = http.request({ host: "127.0.0.1", port: relayTo, path: req.url, method: req.method, headers: req.headers }, (ur) => {
        let ub = "";
        ur.on("data", (x: Buffer) => (ub += x));
        ur.on("end", () => {
          res.writeHead(ur.statusCode ?? 500, { "Content-Type": "text/plain", "X-Owner-MAC": String(ur.headers["x-owner-mac"] ?? "") });
          res.end(ub.replace("pr1 tamper mail", "pr1 TAMPERED mail"));
        });
      });
      up.end(body);
    });
    fs.writeFileSync(c.record, JSON.stringify({ ...readRecord(c), port: mitm.port }), { mode: 0o600 });
    const r = await runHook(c, "check-relay.sh", { RELAY_AGENT_TOKEN: token });
    expect(mitm.requests.length, "precondition: the exchange went through the relay").toBeGreaterThan(0);
    expect(r.out).not.toContain("TAMPERED");
    expect(r.out).not.toContain("pr1 tamper mail");
    expect(r.out).toMatch(/relay owner: .*reply .*(MAC|forged|altered)/i);
    await stopDaemon(d.child);
  }, 120_000);

  it("the owner's KEY is in no argv, no environment, no file the hook wrote or removed, and no output; nor is the http_secret", async () => {
    const c = newCase("key-conf");
    const token = seedWasmDb(c, "pr1 confidential mail");
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm", http_secret: SECRET }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    const { key } = readRecord(c);
    for (const hook of HOOK_SET) {
      const r = await runHook(c, hook, { RELAY_AGENT_TOKEN: token }, inputFor(hook));
      expect(r.argv.length, `precondition: the stubs logged ${hook}'s children`).toBeGreaterThan(0);
      for (const [where, text] of [["argv", r.argv], ["a child's environment", r.env], ["a removed file", r.removed], ["the output", r.out]] as const) {
        expect(text, `${hook}: the owner key in ${where}`).not.toContain(key);
        expect(text, `${hook}: the http_secret in ${where}`).not.toContain(SECRET);
      }
      const tmp = path.join(c.home, ".tmp");
      const left = fs.existsSync(tmp) ? fs.readdirSync(tmp).map((f) => { try { return fs.readFileSync(path.join(tmp, f), "utf-8"); } catch { return ""; } }).join("\n") : "";
      expect(left, `${hook}: nothing left in the temp dir holds the key`).not.toContain(key);
    }
    await stopDaemon(d.child);
  }, 180_000);

  it.each(HOOK_SET)("%s: inherited PROXY settings (http_proxy, HTTP_PROXY, https_proxy, ALL_PROXY; no no_proxy) and a planted ~/.curlrc (proxy + location) receive ZERO requests", async (hook) => {
    const c = newCase(`proxy-${hook.split(".")[0]}`);
    const token = seedWasmDb(c, `pr1 proxied mail ${hook}`);
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    const proxy = await startSpy((req, res) => {
      res.writeHead(502);
      res.end();
    });
    const purl = `http://127.0.0.1:${proxy.port}`;
    fs.writeFileSync(path.join(c.home, ".curlrc"), `proxy = "${purl}"\nlocation\n`);
    const r = await runHook(
      c,
      hook,
      { RELAY_AGENT_TOKEN: token, RELAY_HTTP_HOST: "127.0.0.1", RELAY_HTTP_PORT: String(d.port), http_proxy: purl, HTTP_PROXY: purl, https_proxy: purl, HTTPS_PROXY: purl, ALL_PROXY: purl, all_proxy: purl, no_proxy: "", NO_PROXY: "" },
      inputFor(hook)
    );
    expect(proxy.requests, `the proxy saw nothing\n${r.out}`).toEqual([]);
    expect(mailIn(r.out, `pr1 proxied mail ${hook}`), r.out).toBe(true);
    await stopDaemon(d.child);
  }, 120_000);

  it.each(HOOK_SET)("%s: a HUNG `relay owner peek` is bounded in time: the hook ends inside its budget and names it", async (hook) => {
    const c = newCase(`hang-${hook.split(".")[0]}`);
    const token = seedWasmDb(c, "pr1 hang mail");
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    const r = await runHook(c, hook, { RELAY_AGENT_TOKEN: token, FAKE_NODE_HANG: "owner peek" }, inputFor(hook));
    expect(r.argv, "precondition: the hung step ran").toContain("owner peek");
    expect(r.status, "the hook exited by itself").not.toBeNull();
    expect(r.ms, `the stub sleeps 30s: the hook must end inside its budget\n${r.out}`).toBeLessThan(hook === "check-relay.sh" ? 10_000 : 5_000);
    expect(r.out).toMatch(/timed out|no time budget|could not be read/i);
    await stopDaemon(d.child);
  }, 120_000);

  it("SessionStart's mail RENDERER (node) on the owner route is bounded too: a hung renderer ends inside the budget, named", async () => {
    const c = newCase("hang-render");
    const token = seedWasmDb(c, "pr1 render mail");
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    const r = await runHook(c, "check-relay.sh", { RELAY_AGENT_TOKEN: token, FAKE_NODE_HANG: "Pending messages for" });
    expect(r.argv, "precondition: the renderer ran").toContain("Pending messages for");
    expect(r.ms, r.out).toBeLessThan(10_000);
    expect(r.out).toMatch(/timed out|could not be (read|shown|rendered)/i);
    await stopDaemon(d.child);
  }, 120_000);

  it("a 7-line answer (an older relay CLI than these hooks) → a named version-skew skip: no sqlite3, no owner-door read", async () => {
    // (The configured endpoint's own calls, e.g. the token health check, are the native behaviour on an unjudged
    // verdict: the pre-existing configured-endpoint trust, out of this row's scope as ruled.)
    const c = newCase("seven");
    seedNativeDb(c);
    const r = await runHook(c, "check-relay.sh", { RELAY_AGENT_TOKEN: TOKEN, FAKE_WHERE_FILE: fakeWhere(c, "http", null) });
    expect(r.argv, "precondition: the hook ran its relay CLI").toContain("where --fields");
    expect(r.argv, "no owner-door read on a skewed answer").not.toContain("owner peek");
    expect(r.sqliteCalls).toEqual([]);
    expect(r.out).toMatch(/7-line answer[\s\S]*(version skew|update the relay)/i);
  }, 60_000);
});

describe.skipIf(WIN_NO_BASH_HOOKS)("hook PR 1, as ruled (P1-3 as modified): on `http`, SessionStart's credential calls go ONLY to the configured endpoint when it IS the proven owner", () => {
  it("the configured endpoint IS the owner (127.0.0.1 at the record's port) → SessionStart registers there, as on native", async () => {
    const c = newCase("cred-owner");
    const token = seedWasmDb(c, "pr1 cred mail");
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    const r = await runHook(c, "check-relay.sh", { RELAY_AGENT_TOKEN: token, RELAY_HTTP_HOST: "127.0.0.1", RELAY_HTTP_PORT: String(d.port), RELAY_HOOK_DEBUG: "1" });
    expect(r.out, "the registration call ran (its debug summary)").toMatch(/register_agent reply:/);
    expect(mailIn(r.out, "pr1 cred mail"), r.out).toBe(true);
    await stopDaemon(d.child);
  }, 120_000);

  it("an UNREGISTERED agent: the door proves the owner, so the gate passes and SessionStart goes on to register (no 'door failed')", async () => {
    const c = newCase("cred-unreg");
    seedWasmDb(c);
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    const r = await runHook(c, "check-relay.sh", { RELAY_AGENT_NAME: "pr1-newcomer", RELAY_HTTP_HOST: "127.0.0.1", RELAY_HTTP_PORT: String(d.port), RELAY_HOOK_DEBUG: "1" });
    expect(r.out).not.toMatch(/the owner door failed/);
    expect(r.out, "the registration call ran").toMatch(/register_agent reply:/);
    await stopDaemon(d.child);
  }, 120_000);

  it("SessionStart's process discovery is BOUNDED: a hung `ps` (relay_agent_pid / relay_pid_start) → the hook still ends inside its budget", async () => {
    const c = newCase("cred-ps-hang");
    const token = seedWasmDb(c, "pr1 ps mail");
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    const r = await runHook(c, "check-relay.sh", { RELAY_AGENT_TOKEN: token, RELAY_HTTP_HOST: "127.0.0.1", RELAY_HTTP_PORT: String(d.port), FAKE_PS_HANG: "1" });
    expect(r.argv, "precondition: the hung ps ran").toContain("ps ");
    expect(r.status, "the hook exited by itself").not.toBeNull();
    expect(r.ms, `the stub sleeps 30s: the hook must end inside its 10s budget\n${r.out}`).toBeLessThan(10_000);
    await stopDaemon(d.child);
  }, 120_000);

  it("an inherited RELAY_HTTP_HOST/PORT that is NOT the owner → ZERO token bytes there (a recording listener), named skip, mail still read from the owner", async () => {
    const c = newCase("cred-elsewhere");
    const token = seedWasmDb(c, "pr1 elsewhere mail");
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    const elsewhere = await startSpy((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    const r = await runHook(c, "check-relay.sh", { RELAY_AGENT_TOKEN: token, RELAY_HTTP_HOST: "127.0.0.1", RELAY_HTTP_PORT: String(elsewhere.port) });
    expect(elsewhere.bytes(), "the inherited destination got no token").not.toContain(token);
    expect(r.out).toMatch(/register through your MCP connection/);
    expect(mailIn(r.out, "pr1 elsewhere mail"), r.out).toBe(true);
    await stopDaemon(d.child);
  }, 120_000);

  it("the door exchange FAILS (a thief on the record's port) → NO credential-bearing call at all, even to a configured endpoint", async () => {
    const c = newCase("cred-doorfail");
    const token = seedWasmDb(c);
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    const thief = await startSpy((req, res) => {
      res.writeHead(200, { "X-Owner-MAC": "00".repeat(32) });
      res.end("{}");
    });
    fs.writeFileSync(c.record, JSON.stringify({ ...readRecord(c), port: thief.port }), { mode: 0o600 });
    const r = await runHook(c, "check-relay.sh", { RELAY_AGENT_TOKEN: token, RELAY_HTTP_HOST: "127.0.0.1", RELAY_HTTP_PORT: String(thief.port) });
    expect(thief.requests.length, `precondition: the door was tried (${r.out})`).toBeGreaterThan(0);
    expect(thief.bytes(), "no token to the configured endpoint after a failed door").not.toContain(token);
    await stopDaemon(d.child);
  }, 120_000);
});

describe.skipIf(WIN_NO_BASH_HOOKS)("hook PR 1, as ruled (a structural skip): the REMOTE route is not the owner route", () => {
  it.each(["stop-check.sh", "post-tool-use-check.sh"])("%s on the REMOTE route (RELAY_HTTP_HOST) still probes /health and sends no http_secret, even with an inherited RELAY_OWNER_PORT equal to its port", async (hook) => {
    const c = newCase(`remote-${hook.split(".")[0]}`);
    const secret = `pr1-remote-secret-${crypto.randomBytes(16).toString("hex")}`;
    fs.writeFileSync(c.cfg, JSON.stringify({ http_secret: secret }), { mode: 0o600 });
    const spy = await startSpy((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(req.url === "/health" ? "{}" : JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ messages: [], count: 0, has_more: false, total_pending: 0 }) }] } }));
    });
    const port = String(spy.port);
    const input = JSON.stringify({ session_id: "s-pr1", hook_event_name: hook === "stop-check.sh" ? "Stop" : "PostToolUse" });
    const r = await runHook(c, hook, { RELAY_AGENT_TOKEN: TOKEN, FAKE_PENDING_RC: "3", RELAY_HTTP_HOST: "127.0.0.1", RELAY_HTTP_PORT: port, RELAY_OWNER_PORT: port }, input);
    expect(spy.requests.length, `precondition: the remote route ran (${r.out})`).toBeGreaterThan(0);
    expect(spy.requests.some((q) => q.url === "/health"), "the remote route probes /health (an inherited RELAY_OWNER_PORT proves nothing)").toBe(true);
    expect(spy.bytes(), "no http_secret goes to an unproved endpoint").not.toContain(secret);
  }, 120_000);
});

