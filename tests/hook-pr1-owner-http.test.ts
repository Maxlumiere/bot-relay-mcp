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
// THE OWNER DOOR (hook PR 3, as ruled after Codex #418 R2): AES-256-GCM requests and replies under HKDF(owner key),
// the AAD binding path, ts, nonce and the instance (+ status on replies); no bearer credential. "\n" separates fields.
const bindingOf = (key: string) => BINDINGS.get(key) ?? { instance_id: "", db_path: "" };
const doorKeyOf = (key: string, dir: "req" | "resp") => Buffer.from(crypto.hkdfSync("sha256", Buffer.from(key, "hex"), Buffer.alloc(0), `relay-owner-door v1 ${dir}`, 32));
const reqAad = (key: string, p: string, ts: number, nonce: string) => {
  const b = bindingOf(key);
  return Buffer.from(`req\n${p}\n${ts}\n${nonce}\n${b.instance_id}\n${b.db_path}`);
};
const respAad = (key: string, p: string, ts: number, nonce: string, status: number) => {
  const b = bindingOf(key);
  return Buffer.from(`resp\n${p}\n${ts}\n${nonce}\n${b.instance_id}\n${b.db_path}\n${status}`);
};
function sealWith(k: Buffer, aad: Buffer, plain: unknown) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", k, iv);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(JSON.stringify(plain), "utf-8"), c.final()]);
  return { iv: iv.toString("base64"), ct: ct.toString("base64"), tag: c.getAuthTag().toString("base64") };
}
function openWith(k: Buffer, aad: Buffer, raw: string): unknown | null {
  try {
    const env = JSON.parse(raw) as { iv: string; ct: string; tag: string };
    const d = crypto.createDecipheriv("aes-256-gcm", k, Buffer.from(env.iv, "base64"));
    d.setAAD(aad);
    d.setAuthTag(Buffer.from(env.tag, "base64"));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(env.ct, "base64")), d.final()]).toString("utf-8"));
  } catch {
    return null;
  }
}
/** A sealed request body, as a client with the key builds it (aadPath: sealed for ANOTHER path; sealKey: another key). */
function sealedBody(key: string, p: string, ts: number, nonce: string, args: Record<string, unknown>, o: { aadPath?: string; sealKey?: string; tamper?: boolean } = {}): string {
  const env = sealWith(doorKeyOf(o.sealKey ?? key, "req"), reqAad(key, o.aadPath ?? p, ts, nonce), { agent_name: AGENT, args });
  if (o.tamper) {
    const ct = Buffer.from(env.ct, "base64");
    ct[0] = ct[0]! ^ 0xff;
    env.ct = ct.toString("base64");
  }
  return JSON.stringify({ ts, client_nonce: nonce, ...env });
}
const PEEK = "/owner/v1/peek";
const LIVENESS = "/owner/v1/liveness";
const rpc = (name: string, args: Record<string, unknown>) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
interface DoorOpts {
  ts?: number;
  nonce?: string;
  body?: string;
  aadPath?: string;
  sealKey?: string;
  tamper?: boolean;
}
/** One door exchange, as a client with the key would make it. sealedOk: the reply OPENS (authenticates); text: its plaintext then. */
async function door(port: number, key: string, p: string, args: Record<string, unknown>, o: DoorOpts = {}) {
  const ts = o.ts ?? Math.floor(Date.now() / 1000);
  const nonce = o.nonce ?? crypto.randomBytes(16).toString("hex");
  const body = o.body ?? sealedBody(key, p, ts, nonce, args, o);
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", headers: { "Content-Type": "text/plain" }, body });
  const raw = await res.text();
  const opened = openWith(doorKeyOf(key, "resp"), respAad(key, p, ts, nonce, res.status), raw);
  return { status: res.status, text: opened !== null ? JSON.stringify(opened) : raw, raw, nonce, sealedOk: opened !== null };
}
/** The whole DB, from a COPY read with sql.js (never an open of the live file): every table's rows, in order. */
async function dbDump(c: Case): Promise<Record<string, unknown[][]>> {
  const copy = path.join(c.home, `copy-${crypto.randomBytes(4).toString("hex")}.db`);
  fs.copyFileSync(c.db, copy);
  const initSqlJs = (await import("sql.js")).default;
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(copy));
  const out: Record<string, unknown[][]> = {};
  const tables = db.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")[0]?.values.map((r: unknown[]) => String(r[0])) ?? [];
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

  it("POST /owner/v1/peek: a sealed request gets the agent's pending set in a sealed reply; no bearer credential is asked for or used", async () => {
    const c = newCase("door-peek");
    seedWasmDb(c, "pr1 door mail");
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm", http_secret: `pr1-door-secret-${"x".repeat(32)}` }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    const { key } = readRecord(c);
    const r = await door(d.port, key, PEEK, { with_content: 5 });
    expect(r.status, r.text).toBe(200);
    expect(r.sealedOk, "the reply is sealed under the owner's response key").toBe(true);
    expect(r.raw, "no mail in plaintext on the wire").not.toContain("pr1 door mail");
    const body = JSON.parse(r.text) as { ok: boolean; registered: boolean; count: number; messages: Array<{ from_agent?: string; content?: string }> };
    expect(body).toMatchObject({ ok: true, registered: true, count: 1 });
    expect(body.messages[0]?.content).toBe("pr1 door mail");
    expect(r.text, "the key is never served").not.toContain(key);
    await stopDaemon(d.child);
  }, 90_000);

  it("the door REFUSES: the wrong key, a stale or future ts, a replayed nonce, a tampered ciphertext, a request sealed for another path, a malformed nonce: none reveals mail", async () => {
    const c = newCase("door-refuse");
    seedWasmDb(c, "pr1 refused mail");
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    const { key } = readRecord(c);
    const now = Math.floor(Date.now() / 1000);
    const cases: Array<[string, Promise<{ status: number; text: string }>]> = [
      ["the wrong key", door(d.port, key, PEEK, { with_content: 5 }, { sealKey: crypto.randomBytes(16).toString("hex") })],
      ["a stale ts (60s old)", door(d.port, key, PEEK, { with_content: 5 }, { ts: now - 60 })],
      ["a future ts (60s ahead)", door(d.port, key, PEEK, { with_content: 5 }, { ts: now + 60 })],
      ["a tampered ciphertext", door(d.port, key, PEEK, { with_content: 5 }, { tamper: true })],
      ["sealed for the liveness path, posted to peek", door(d.port, key, PEEK, { with_content: 5 }, { aadPath: LIVENESS })],
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
    const rbody = sealedBody(key, PEEK, rts, rnonce, { with_content: 5 });
    const send = () => fetch(`http://127.0.0.1:${d.port}${PEEK}`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: rbody });
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

  it("POST /owner/v1/liveness runs report_liveness (its own token check): it restamps ONLY agent_pid / agent_pid_start / host_id (+ the dispatcher's audit row); any other argument key is refused", async () => {
    const c = newCase("door-live");
    const token = seedWasmDb(c);
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    const { key } = readRecord(c);
    await new Promise((r) => setTimeout(r, 1500));
    // A FIRST authentication stamps once (established_at, first_authed_at, the registration-recovery handle): a bearer
    // call before the snapshot takes those, so the door's call and its /mcp twin below are compared as equals.
    const prime = await fetch(`http://127.0.0.1:${d.port}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "X-Agent-Token": token }, body: JSON.stringify(rpc("report_liveness", { agent_name: AGENT, agent_pid: 4141, agent_pid_start: "t-prime", agent_token: token })) });
    expect(prime.status, await prime.clone().text()).toBe(200);
    await new Promise((r) => setTimeout(r, 500));
    const before = await dbDump(c);
    const live = { agent_name: AGENT, agent_pid: 4242, agent_pid_start: "t0", agent_token: token };
    const extra = await door(d.port, key, LIVENESS, { rpc: rpc("report_liveness", live), agent_token: token, status: "busy" });
    expect(extra.status, `an extra key: ${extra.text}`).toBeGreaterThanOrEqual(400);
    const r = await door(d.port, key, LIVENESS, { rpc: rpc("report_liveness", live), agent_token: token });
    expect(r.status, r.text).toBe(200);
    expect(r.sealedOk).toBe(true);
    expect(r.text, "the tool answered (not an error)").not.toMatch(/isError\\?"?:\s*true/);
    await new Promise((r2) => setTimeout(r2, 500));
    const after = await dbDump(c);
    for (const t of Object.keys(before)) {
      if (t === "agents" || t === "audit_log") continue; // the dispatcher audits every tool call, as on /mcp
      expect(after[t], `table ${t} untouched by the liveness door`).toEqual(before[t]);
    }
    const cols = before.agents![0] as string[];
    const rowOf = (d: Record<string, unknown[][]>) => d.agents!.slice(1).find((x) => x[cols.indexOf("name")] === AGENT)!;
    const moved = (a: unknown[], b: unknown[]) => cols.filter((_, i) => JSON.stringify(a[i]) !== JSON.stringify(b[i])).sort();
    const row = rowOf(after);
    expect(row[cols.indexOf("agent_pid")]).toBe(4242);
    expect(row[cols.indexOf("agent_pid_start")]).toBe("t0");
    // THE SAME DISPATCHER: the door's report_liveness moves exactly the columns the /mcp bearer twin's does (the anchor,
    // and the dispatcher's own authentication stamps), nothing else.
    const doorMoved = moved(rowOf(before), row);
    const twin = await fetch(`http://127.0.0.1:${d.port}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "X-Agent-Token": token }, body: JSON.stringify(rpc("report_liveness", { ...live, agent_pid: 4343, agent_pid_start: "t1" })) });
    expect(twin.status, await twin.clone().text()).toBe(200);
    await new Promise((r2) => setTimeout(r2, 500));
    const twinMoved = moved(row, rowOf(await dbDump(c)));
    expect(doorMoved.filter((k) => !["agent_pid", "agent_pid_start", "host_id"].includes(k)), "the door's other stamps are the bearer twin's").toEqual(twinMoved.filter((k) => !["agent_pid", "agent_pid_start", "host_id"].includes(k)));
    expect(doorMoved, "the anchor moved").toEqual(expect.arrayContaining(["agent_pid", "agent_pid_start"]));
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
  type Verify = (p: string, raw: unknown, nowMs?: number) => { ok: boolean; status?: number; error?: string };
  async function doorModule() {
    const m = (await import("../src/owner-endpoint.js")) as {
      openDoorRequest: Verify;
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
  const signed = (key: string, ts: number, nonce = crypto.randomBytes(16).toString("hex")) => ({ body: sealedBody(key, PEEK, ts, nonce, {}) });

  it("Codex's sequence and every t in the window: a request accepted once is REFUSED at every later instant it would still validate", async () => {
    const { m, key } = await doorModule();
    const T = 2_000_000_000;
    const { body } = signed(key, T);
    expect(m.openDoorRequest(PEEK, body, (T - 30) * 1000).ok, "accepted at the window's first instant").toBe(true);
    for (let t = (T - 30) * 1000; t <= (T + 30) * 1000 + 999; t += 250) {
      const r = m.openDoorRequest(PEEK, body, t);
      expect(r.ok, `a replay at ${t - T * 1000}ms from ts`).toBe(false);
    }
    // Codex's exact numbers: ts 1030 accepted at 1000.000, replayed at 1060.000.
    m._resetDoorNoncesForTests();
    const c2 = signed(key, 1030);
    expect(m.openDoorRequest(PEEK, c2.body, 1_000_000).ok).toBe(true);
    expect(m.openDoorRequest(PEEK, c2.body, 1_060_000).ok, "Codex's replay at 1060").toBe(false);
  });

  it("a FULL cache refuses (fail closed), never evicting a live nonce; expired nonces are swept without new traffic (a timer)", async () => {
    const { m, key } = await doorModule();
    const T = 2_000_000_000;
    for (let i = 0; i < m.DOOR_NONCE_CAPACITY; i++) {
      const { body } = signed(key, T);
      expect(m.openDoorRequest(PEEK, body, T * 1000).ok).toBe(true);
    }
    const extra = signed(key, T);
    const r = m.openDoorRequest(PEEK, extra.body, T * 1000);
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

  it("the WRITER is bound to its fd (as ruled): the temp name swapped for another file between create and write → the key lands only in the fd's own file, and NO record is published (every OS, a seam; REPEATED x20: an intermittent identity collision must not pass once)", () => {
    for (let round = 0; round < 20; round++) writerSwapRound(round);
  }, 300_000);
  function writerSwapRound(round: number) {
    const c = newCase(`writer-swap-${round}`);
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
  }

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
    expect(r.sealedOk).toBe(true);
    expect(r.text).toContain("pr1 peek-listener mail");
    if (host === LAN_V4) {
      const off = await fetch(`http://${LAN_V4}:${rec.port}${PEEK}`, { method: "POST", body: "{}" }).then((x) => x.status, () => "refused");
      expect(off, "the peek listener is bound to 127.0.0.1 only").toBe("refused");
    }
    await stopDaemon(d.child);
  }

  it.skipIf(!V6_LOOPBACK && LAN_V4 === null)("the peek listener serves ONLY the door endpoints: every other route of startHttpServer, /mcp, /owner-id, /health → 403; a WS upgrade is never accepted (skipped by name with no address 127.0.0.1 cannot reach)", async () => {
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
      if (method === "POST" && route.startsWith("/owner/v1/")) continue; // the door's own paths (hook PR 3: five)
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
async function startSpy(handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void, host = "127.0.0.1"): Promise<Spy> {
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
  await new Promise<void>((r) => server.listen(0, host, () => r()));
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
fs.writeFileSync(
  path.join(STUBS, "ps"),
  `#!/bin/sh\nprintf 'ps %s\\n' "$*" >> "${ARGV_LOG}"\nif [ -n "$FAKE_PS_HANG" ]; then exec sleep 30; fi\n` +
    // A SLOW ps over a DEEP chain: every call answers after 0.9s; each pid's parent is pid+1 (a "sh"), for 10
    // levels, counted from this stub's own calls in the argv log (so the depth does not depend on any real pid).
    `if [ -n "$FAKE_PS_SLOW" ]; then sleep 0.9; p=""; for a in "$@"; do case "$prev" in -p) p="$a" ;; esac; prev="$a"; done\n` +
    `  n=$(grep -c '^ps .*ppid=' "${ARGV_LOG}" 2>/dev/null)\n` +
    `  case "$*" in *ppid=*) if [ "\${n:-0}" -le 10 ]; then echo "$((p + 1))"; else echo 1; fi ;; *comm=*) echo sh ;; *args=*) echo sh ;; *lstart=*) echo "Thu Oct  1 11:37:33 2026" ;; esac; exit 0; fi\n` +
    `exec "${REAL_PS}" "$@"\n`,
  { mode: 0o755 }
);
const SQLITE_LOG = path.join(ROOT, "sqlite3.log");
fs.writeFileSync(path.join(STUBS, "sqlite3"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${SQLITE_LOG}"\nexit 1\n`, { mode: 0o755 });

/** The hook, run ASYNCHRONOUSLY (a spy in this process must not be starved by a spawnSync). */
async function runHook(c: Case, hook: string, extra: Record<string, string>, input = "", hooksDir = HOOKS) {
  for (const f of [SQLITE_LOG, ARGV_LOG, ENV_LOG, RM_CAPTURE]) fs.rmSync(f, { force: true });
  const env = baseEnv(c, { PATH: `${STUBS}:${process.env.PATH ?? ""}`, RELAY_AGENT_NAME: AGENT, RELAY_TEST_CLOCK: "0", ...extra });
  const child = spawn("bash", [path.join(hooksDir, hook)], { env, stdio: ["pipe", "pipe", "pipe"] });
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
      res.writeHead(200, { "Content-Type": "text/plain" });
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

  it("a TAMPERED reply (relayed from the real owner, one ciphertext byte flipped, its tag kept) → nothing from it is shown", async () => {
    const c = newCase("tamper");
    const token = seedWasmDb(c, "pr1 tamper mail");
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    const relayTo = d.port;
    let tampered = 0;
    const mitm = await startSpy((req, res, body) => {
      const up = http.request({ host: "127.0.0.1", port: relayTo, path: req.url, method: req.method, headers: req.headers }, (ur) => {
        let ub = "";
        ur.on("data", (x: Buffer) => (ub += x));
        ur.on("end", () => {
          res.writeHead(ur.statusCode ?? 500, { "Content-Type": "text/plain" });
          let out = ub;
          try {
            const env = JSON.parse(ub) as { ct: string };
            const ct = Buffer.from(env.ct, "base64");
            ct[ct.length - 1] = ct[ct.length - 1]! ^ 0x01;
            out = JSON.stringify({ ...env, ct: ct.toString("base64") });
            tampered++;
          } catch {
            /* not an envelope: relayed as is */
          }
          res.end(out);
        });
      });
      up.end(body);
    });
    fs.writeFileSync(c.record, JSON.stringify({ ...readRecord(c), port: mitm.port }), { mode: 0o600 });
    const r = await runHook(c, "check-relay.sh", { RELAY_AGENT_TOKEN: token });
    expect(mitm.requests.length, "precondition: the exchange went through the relay").toBeGreaterThan(0);
    expect(tampered, "precondition: a sealed reply was tampered").toBeGreaterThan(0);
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
    expect(r.argv, "hook PR 3: it ran THROUGH the door").toMatch(/owner tool register_agent/);
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

  it("a SLOW ps (0.9s per call) over a 10-level chain: the pid walk is bounded by the SEAMED budget, the hook ends inside it, and names the cut", async () => {
    const c = newCase("cred-ps-slow");
    const token = seedWasmDb(c, "pr1 slow ps mail");
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    const r = await runHook(c, "check-relay.sh", { RELAY_AGENT_TOKEN: token, RELAY_HTTP_HOST: "127.0.0.1", RELAY_HTTP_PORT: String(d.port), FAKE_PS_SLOW: String(process.pid) });
    expect((r.argv.match(/^ps /gm) ?? []).length, "precondition: the walk made several slow ps calls").toBeGreaterThanOrEqual(3);
    expect(r.status, "the hook exited by itself").not.toBeNull();
    expect(r.ms, `0.9s x 2 calls x 10 levels = 18s of ps: the hook must end inside its 10s budget\n${r.out}`).toBeLessThan(10_000);
    expect(r.out, "the cut is named").toMatch(/no time budget left for a process lookup/);
    await stopDaemon(d.child);
  }, 120_000);

  it("an inherited LOCAL RELAY_HTTP_HOST/PORT that is NOT the owner → ZERO token bytes there (a recording listener); hook PR 3: registration goes THROUGH the door; mail still read from the owner", async () => {
    const c = newCase("cred-elsewhere");
    const token = seedWasmDb(c, "pr1 elsewhere mail");
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    const elsewhere = await startSpy((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    const r = await runHook(c, "check-relay.sh", { RELAY_AGENT_TOKEN: token, RELAY_HTTP_HOST: "127.0.0.1", RELAY_HTTP_PORT: String(elsewhere.port), RELAY_HOOK_DEBUG: "1" });
    expect(elsewhere.bytes(), "the inherited destination got no token").not.toContain(token);
    expect(r.argv, "hook PR 3: the registration ran through the door").toMatch(/owner tool register_agent/);
    expect(r.out).toMatch(/register_agent reply:/);
    expect(mailIn(r.out, "pr1 elsewhere mail"), r.out).toBe(true);
    await stopDaemon(d.child);
  }, 120_000);

  it("the door exchange FAILS (a thief on the record's port) → NO credential-bearing call at all, even to a configured endpoint", async () => {
    const c = newCase("cred-doorfail");
    const token = seedWasmDb(c);
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    const d = await startOwnerDaemon(c);
    const thief = await startSpy((req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("{}");
    });
    fs.writeFileSync(c.record, JSON.stringify({ ...readRecord(c), port: thief.port }), { mode: 0o600 });
    const r = await runHook(c, "check-relay.sh", { RELAY_AGENT_TOKEN: token, RELAY_HTTP_HOST: "127.0.0.1", RELAY_HTTP_PORT: String(thief.port) });
    expect(thief.requests.length, `precondition: the door was tried (${r.out})`).toBeGreaterThan(0);
    expect(thief.bytes(), "no token to the configured endpoint after a failed door").not.toContain(token);
    await stopDaemon(d.child);
  }, 120_000);
});

describe.skipIf(WIN_NO_BASH_HOOKS)("hook PR 3 (as ruled): EVERY local credential call goes through the owner door; with no door, none is sent (POSIX)", () => {
  const recorder = (host = "127.0.0.1") =>
    startSpy((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(req.url === "/health" ? "{}" : JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ success: true, auth_error: false }) }] } }));
    }, host);
  const noCredential = (spy: Spy, ...secrets: string[]) => {
    for (const x of secrets) expect(spy.bytes(), "no credential byte reaches the configured endpoint").not.toContain(x);
    expect(spy.requests.every((q) => q.headers["x-agent-token"] === undefined && q.headers["x-relay-secret"] === undefined && q.headers.authorization === undefined), "no bearer header").toBe(true);
  };
  const agentRow = async (c: Case, name: string) => {
    const t = (await dbDump(c)).agents ?? [];
    const cols = (t[0] ?? []) as string[];
    const row = t.slice(1).find((x) => x[cols.indexOf("name")] === name);
    return row ? Object.fromEntries(cols.map((k, i) => [k, row[i]])) : null;
  };
  const mintSecretIn = (c: Case): string => {
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (e.name === "mint.secret") hits.push(f);
      }
    };
    walk(c.home);
    expect(hits.length, "precondition: the daemon made its registration secret").toBeGreaterThan(0);
    return fs.readFileSync(hits[0]!, "utf-8").trim();
  };

  it("NATIVE: a configured LOCAL endpoint that is not the daemon gets ZERO token bytes; SessionStart's health check and registration run THROUGH the door", async () => {
    const c = newCase("p3-native-reg");
    const token = seedNativeDb(c);
    const d = await startOwnerDaemon(c);
    const spy = await recorder();
    const r = await runHook(c, "check-relay.sh", { RELAY_AGENT_TOKEN: token, RELAY_HTTP_HOST: "127.0.0.1", RELAY_HTTP_PORT: String(spy.port), RELAY_HOOK_DEBUG: "1" });
    noCredential(spy, token);
    expect(r.argv, "the health check went through the door").toMatch(/owner tool health_check/);
    expect(r.argv, "the registration went through the door").toMatch(/owner tool register_agent/);
    expect(r.out).toMatch(/register_agent reply:/);
    expect(r.out).not.toMatch(/REGISTER_FAILED|AUTH_FAILED/);
    await stopDaemon(d.child);
  }, 120_000);

  it.each(["native", "wasm"] as const)("%s FIRST-TIME registration (a new name, no token) goes through the door: the agent is registered, and the registration secret never reaches the configured endpoint", async (kind) => {
    const c = newCase(`p3-first-${kind}`);
    if (kind === "native") seedNativeDb(c);
    else {
      seedWasmDb(c);
      fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    }
    const d = await startOwnerDaemon(c);
    const spy = await recorder();
    const r = await runHook(c, "check-relay.sh", { RELAY_AGENT_NAME: "pr3-newcomer", RELAY_HTTP_HOST: "127.0.0.1", RELAY_HTTP_PORT: String(spy.port), RELAY_HOOK_DEBUG: "1" });
    noCredential(spy, mintSecretIn(c));
    expect(r.argv).toMatch(/owner tool register_agent/);
    await stopDaemon(d.child);
    expect(await agentRow(c, "pr3-newcomer"), `the newcomer is registered:\n${r.out}`).not.toBeNull();
  }, 120_000);

  it.each(["skip-rlyw", "skip-declared-wasm", "skip-owner-locked", "skip-unreadable", "(7-line answer)", "(6-line answer)"])("verdict %s: ZERO credential bytes to a configured local endpoint, and the skip is named", async (verdict) => {
    const c = newCase(`p3-skip-${verdict.replace(/[^a-z0-9]/gi, "")}`);
    seedWasmDb(c);
    const spy = await recorder();
    let where: string;
    if (verdict === "(7-line answer)") where = fakeWhere(c, "skip-rlyw", null);
    else if (verdict === "(6-line answer)") {
      where = path.join(c.home, "where-6.txt");
      fs.writeFileSync(where, ["explicit-db", c.db, "true", "", "", path.join(c.dir, "agents")].join("\n") + "\n");
    } else where = fakeWhere(c, verdict, "");
    const r = await runHook(c, "check-relay.sh", { RELAY_AGENT_TOKEN: TOKEN, RELAY_HTTP_HOST: "127.0.0.1", RELAY_HTTP_PORT: String(spy.port), FAKE_WHERE_FILE: where });
    expect(r.argv, "precondition: the hook ran its relay CLI").toContain("where --fields");
    noCredential(spy, TOKEN);
    expect(r.out, "the skip is named").toMatch(/no credential is sent/);
  }, 120_000);

  // As ruled (the route as modified): an EXPLICIT non-loopback RELAY_HTTP_HOST is the remote-client declaration.
  it.skipIf(LAN_V4 === null)("a REMOTE-configured machine WITH a local DB: the remote gets its bearer, the local door is untouched, and the notice names both (skipped by name where the runner has no LAN address)", async () => {
    const c = newCase("p3-remote-local");
    seedNativeDb(c);
    const d = await startOwnerDaemon(c);
    const remoteToken = "pr3-remote-minted-token-aaaaaaaa";
    const spy = await recorder(LAN_V4!);
    const r = await runHook(c, "check-relay.sh", { RELAY_AGENT_TOKEN: remoteToken, RELAY_HTTP_HOST: LAN_V4!, RELAY_HTTP_PORT: String(spy.port) });
    expect(spy.requests.some((q) => q.headers["x-agent-token"] === remoteToken || q.body.includes(remoteToken)), `the remote got its bearer\n${r.out}`).toBe(true);
    expect(r.argv, "the local door is untouched").not.toMatch(/owner (tool|peek|session|liveness)/);
    expect(r.out).toMatch(new RegExp(`using the remote relay ${LAN_V4!.replace(/\./g, "\\.")}; the local DB at .* is not used for credentials`));
    await stopDaemon(d.child);
  }, 120_000);

  it.skipIf(LAN_V4 === null)("a LOCAL instance's token NEVER reaches a remote (a real LAN address): the local vault holds one, nothing in the environment, a declared remote → not one byte of it there (skipped by name where the runner has no LAN address; the PINNED-remote rows cover it everywhere)", async () => {
    const c = newCase("p3-no-local-token-remote");
    const localToken = seedNativeDb(c);
    const vault = path.join(path.dirname(c.db), "agents");
    fs.mkdirSync(vault, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(vault, `${AGENT}.token`), `${localToken}\n`, { mode: 0o600 });
    const spy = await recorder(LAN_V4!);
    const r = await runHook(c, "check-relay.sh", { RELAY_HTTP_HOST: LAN_V4!, RELAY_HTTP_PORT: String(spy.port) });
    expect(spy.requests.length, `precondition: the remote route ran\n${r.out}`).toBeGreaterThan(0);
    expect(spy.bytes(), "the local token never reaches the remote").not.toContain(localToken);
    for (const hook of ["codex/codex-session-start.sh"]) {
      const r2 = await runHook(c, hook, { RELAY_HTTP_HOST: LAN_V4!, RELAY_HTTP_PORT: String(spy.port) }, JSON.stringify({ session_id: "s-pr3", hook_event_name: "SessionStart" }));
      expect(spy.bytes(), `${hook}: the local token never reaches the remote\n${r2.out}`).not.toContain(localToken);
    }
  }, 120_000);

  // As ruled: a loopback bearer (no local DB) is refused by default; RELAY_HTTP_TRUSTED_TUNNEL_PORT=<port> opts in ONE port.
  it.each([
    { what: "no opt-in", tag: "off", verdict: "REFUSED", optIn: (_p: number): Record<string, string> => ({}), delivered: false },
    { what: "the opt-in for ANOTHER port", tag: "other", verdict: "REFUSED", optIn: (p: number): Record<string, string> => ({ RELAY_HTTP_TRUSTED_TUNNEL_PORT: String(p + 1) }), delivered: false },
    { what: "the opt-in for THIS port", tag: "on", verdict: "DELIVERED", optIn: (p: number): Record<string, string> => ({ RELAY_HTTP_TRUSTED_TUNNEL_PORT: String(p) }), delivered: true },
  ])("a LOOPBACK relay with NO local DB (a tunnel), $what: the bearer is $verdict", async ({ tag, optIn, delivered }) => {
    const c = newCase(`p3-tunnel-${tag}`);
    const spy = await recorder();
    // No local instance: `relay pending` exits 3 (as PR 1's remote rows model it); the DB file does not exist.
    const env = { RELAY_AGENT_TOKEN: TOKEN, FAKE_PENDING_RC: "3", RELAY_HTTP_HOST: "127.0.0.1", RELAY_HTTP_PORT: String(spy.port), ...optIn(spy.port) };
    const r = await runHook(c, "check-relay.sh", env);
    const r2 = await runHook(c, "stop-check.sh", env, inputFor("stop-check.sh"));
    if (delivered) {
      expect(spy.bytes(), `the trusted tunnel got the bearer\n${r.out}`).toContain(TOKEN);
      expect(r.out, "the risk is named every session").toMatch(new RegExp(`bearer to a trusted tunnel on 127\\.0\\.0\\.1:${spy.port}: if the tunnel drops, another local user could take that port`));
    } else {
      noCredential(spy, TOKEN);
      expect(r.out + r2.out, "the default skip names the opt-in").toMatch(/RELAY_HTTP_TRUSTED_TUNNEL_PORT/);
    }
  }, 120_000);

  it("the tunnel opt-in WITH a local DB is ignored: the local DB's door is the only route; zero bearer bytes to the opted-in port", async () => {
    const c = newCase("p3-tunnel-local");
    const token = seedNativeDb(c);
    const d = await startOwnerDaemon(c);
    const spy = await recorder();
    const r = await runHook(c, "check-relay.sh", { RELAY_AGENT_TOKEN: token, RELAY_HTTP_HOST: "127.0.0.1", RELAY_HTTP_PORT: String(spy.port), RELAY_HTTP_TRUSTED_TUNNEL_PORT: String(spy.port) });
    noCredential(spy, token);
    expect(r.argv, "the door was used").toMatch(/owner tool (health_check|register_agent)/);
    expect(r.out).not.toMatch(/bearer to a trusted tunnel/);
    await stopDaemon(d.child);
  }, 120_000);

  it("an OLD daemon (a native DB, no owner record) → no credential to the configured local endpoint, and the skip names the fix (restart the relay daemon)", async () => {
    const c = newCase("p3-old-daemon");
    const token = seedNativeDb(c);
    const spy = await recorder();
    const r = await runHook(c, "check-relay.sh", { RELAY_AGENT_TOKEN: token, RELAY_HTTP_HOST: "127.0.0.1", RELAY_HTTP_PORT: String(spy.port) });
    noCredential(spy, token);
    expect(r.out).toMatch(/restart the relay daemon/);
  }, 120_000);

  it("NATIVE: a PORT THIEF on the record's port gets no credential (every credential call is its own sealed exchange)", async () => {
    const c = newCase("p3-native-thief");
    const token = seedNativeDb(c);
    const d = await startOwnerDaemon(c);
    const thief = await recorder();
    fs.writeFileSync(c.record, JSON.stringify({ ...readRecord(c), port: thief.port }), { mode: 0o600 });
    const r = await runHook(c, "check-relay.sh", { RELAY_AGENT_TOKEN: token, RELAY_HTTP_HOST: "127.0.0.1", RELAY_HTTP_PORT: String(thief.port) });
    expect(thief.requests.length, `precondition: the door was tried (${r.out})`).toBeGreaterThan(0);
    noCredential(thief, token);
    await stopDaemon(d.child);
  }, 120_000);

  it("NATIVE PostToolUse: the liveness restamp goes through the door (zero token bytes to the configured endpoint) and lands", async () => {
    const c = newCase("p3-ptu-live");
    const token = seedNativeDb(c);
    const d = await startOwnerDaemon(c);
    const spy = await recorder();
    const r = await runHook(c, "post-tool-use-check.sh", { RELAY_AGENT_TOKEN: token, RELAY_HTTP_HOST: "127.0.0.1", RELAY_HTTP_PORT: String(spy.port) }, inputFor("post-tool-use-check.sh"));
    noCredential(spy, token);
    expect(r.argv, `the restamp went through the door\n${r.out}`).toMatch(/owner tool report_liveness|owner liveness/);
    await stopDaemon(d.child);
    expect((await agentRow(c, AGENT))?.agent_pid, "the anchor landed").not.toBeNull();
  }, 120_000);

  it.each([["the SAME session (launch-bound)", true], ["a DIFFERENT session", false]] as const)("codex-session-start.sh on the door route, a launch marker naming %s: the handoff check asks the door (/owner/v1/session), and the register is %s", async (_what, same) => {
    const c = newCase(`p3-codex-handoff-${same ? "same" : "diff"}`);
    const token = seedNativeDb(c);
    const d = await startOwnerDaemon(c);
    const before = await agentRow(c, AGENT);
    const sid = String(before?.session_id ?? "");
    expect(sid, "precondition: the agent has a session").toMatch(/^[0-9a-f-]{8,64}$/);
    const marker = same ? sid : "0123abcd-0000-4000-8000-000000000000";
    const spy = await recorder();
    const r = await runHook(c, "codex/codex-session-start.sh", { RELAY_AGENT_TOKEN: token, RELAY_HTTP_HOST: "127.0.0.1", RELAY_HTTP_PORT: String(spy.port), RELAY_LAUNCH_SESSION: marker }, JSON.stringify({ session_id: "s-pr3", hook_event_name: "SessionStart" }));
    noCredential(spy, token);
    expect(r.argv, "the handoff check went through the door").toMatch(/owner session/);
    if (same) expect(r.argv, `a launch-bound session: NO register (no rotation)\n${r.out}`).not.toMatch(/owner tool register_agent/);
    else expect(r.argv, `a different session: it registers\n${r.out}`).toMatch(/owner tool register_agent/);
    await stopDaemon(d.child);
    if (same) expect((await agentRow(c, AGENT))?.session_id, "the launch-bound session is not rotated").toBe(sid);
  }, 120_000);

  it("codex-session-start.sh (NATIVE): registration goes through the door; zero token bytes to the configured endpoint", async () => {
    const c = newCase("p3-codex");
    const token = seedNativeDb(c);
    const d = await startOwnerDaemon(c);
    const spy = await recorder();
    const r = await runHook(c, "codex/codex-session-start.sh", { RELAY_AGENT_TOKEN: token, RELAY_HTTP_HOST: "127.0.0.1", RELAY_HTTP_PORT: String(spy.port), RELAY_LAUNCH_SESSION: "0123abcd-0000-4000-8000-000000000000" }, JSON.stringify({ session_id: "s-pr3", hook_event_name: "SessionStart" }));
    noCredential(spy, token);
    expect(r.argv, `the registration went through the door\n${r.out}`).toMatch(/owner tool register_agent/);
    await stopDaemon(d.child);
  }, 120_000);

  it.skipIf(LAN_V4 === null)("REMOTE mode (no local DB; RELAY_HTTP_HOST a LAN address) keeps its bearer, as today, and makes no door call (skipped by name where the runner has none)", async () => {
    const c = newCase("p3-remote");
    const spy = await recorder(LAN_V4!);
    const r = await runHook(c, "check-relay.sh", { RELAY_AGENT_TOKEN: TOKEN, FAKE_PENDING_RC: "3", RELAY_HTTP_HOST: LAN_V4!, RELAY_HTTP_PORT: String(spy.port) });
    expect(spy.requests.some((q) => q.headers["x-agent-token"] === TOKEN || q.body.includes(TOKEN)), `the remote endpoint got its bearer token\n${r.out}`).toBe(true);
    expect(r.argv).not.toMatch(/owner tool/);
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
    // Hook PR 3 (as ruled): a loopback remote is a trusted tunnel only when opted in for THIS port.
    const r = await runHook(c, hook, { RELAY_AGENT_TOKEN: TOKEN, FAKE_PENDING_RC: "3", RELAY_HTTP_HOST: "127.0.0.1", RELAY_HTTP_PORT: port, RELAY_OWNER_PORT: port, RELAY_HTTP_TRUSTED_TUNNEL_PORT: port }, input);
    expect(spy.requests.length, `precondition: the remote route ran (${r.out})`).toBeGreaterThan(0);
    expect(spy.requests.some((q) => q.url === "/health"), "the remote route probes /health (an inherited RELAY_OWNER_PORT proves nothing)").toBe(true);
    expect(spy.bytes(), "no http_secret goes to an unproved endpoint").not.toContain(secret);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// #433 Codex R1 (REDs, POSIX hooks). A PINNED REMOTE without a LAN address: a hooks copy whose host check answers
// "relay.remote.test → remote, checked address 127.0.0.1", so curl reaches the loopback spy ONLY through the pin
// (--resolve); unpinned, the name does not resolve and nothing is sent. Every other host takes the real check.
const REMOTE_NAME = "relay.remote.test";
let PINNED_HOOKS = "";
function pinnedRemoteHooks(): string {
  if (PINNED_HOOKS) return PINNED_HOOKS;
  const root = path.join(ROOT, "pinned-remote");
  fs.cpSync(HOOKS, path.join(root, "hooks"), { recursive: true });
  fs.symlinkSync(path.join(REPO, "bin"), path.join(root, "bin"));
  const helpers = path.join(root, "hooks", "_vault-helpers.sh");
  const src = fs.readFileSync(helpers, "utf-8");
  expect(src, "precondition: the host check is ONE function").toMatch(/^relay_host_classify\(\) \{/m);
  fs.writeFileSync(
    helpers,
    src.replace(/^relay_host_classify\(\) \{/m, "relay_host_classify_real() {") +
      `\n# TEST ONLY (#433 R1): ${REMOTE_NAME} is a remote whose checked address is the loopback spy.\n` +
      `relay_host_classify() { case "\${RELAY_HTTP_HOST:-}" in ${REMOTE_NAME}) RELAY_HOST_CLASS=remote; RELAY_HOST_PIN=127.0.0.1; RELAY_HOST_WHY="" ;; *) relay_host_classify_real ;; esac; }\n`,
  );
  PINNED_HOOKS = path.join(root, "hooks");
  return PINNED_HOOKS;
}

describe.skipIf(WIN_NO_BASH_HOOKS)("#433 Codex R1 (POSIX hooks): aliases, the destination vault, proxies, the remote mint secret, the record version", () => {
  const spy = () =>
    startSpy((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(req.url === "/health" ? "{}" : JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ success: true, messages: [], count: 0, total_pending: 0, has_more: false }) }] } }));
    });
  const vaultDir = (c: Case) => path.join(path.dirname(c.db), "agents");
  const putToken = (dir: string, token: string) => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, `${AGENT}.token`), `${token}\n`, { mode: 0o600 });
  };
  const localMintSecret = (c: Case): string => {
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (e.name === "mint.secret" && !f.includes(`${path.sep}remote-`)) hits.push(f);
      }
    };
    walk(c.home);
    expect(hits.length, "precondition: the local instance has its registration secret").toBeGreaterThan(0);
    return fs.readFileSync(hits[0]!, "utf-8").trim();
  };

  it.each(["LOCALHOST", "2130706433", "127.1", "0x7f.1"])("P1-1: RELAY_HTTP_HOST=%s is LOOPBACK: a local DB's credentials go through its door; zero bearer bytes to the configured port", async (alias) => {
    const c = newCase(`r1-alias-${alias.replace(/[^a-z0-9]/gi, "")}`);
    const token = seedNativeDb(c);
    const d = await startOwnerDaemon(c);
    const s = await spy();
    const r = await runHook(c, "check-relay.sh", { RELAY_AGENT_TOKEN: token, RELAY_HTTP_HOST: alias, RELAY_HTTP_PORT: String(s.port) });
    expect(s.bytes(), `no bearer to the aliased loopback port\n${r.out}`).not.toContain(token);
    expect(r.argv, "the door route ran").toMatch(/owner tool (health_check|register_agent)/);
    expect(r.out).not.toMatch(/using the remote relay/);
    await stopDaemon(d.child);
  }, 120_000);

  it("P1-3: the vault is scoped by DESTINATION: a token vaulted for tunnel A, and one in the unscoped vault, never reach tunnel B", async () => {
    const c = newCase("r1-vault-ab");
    const a = await spy();
    const b = await spy();
    const tokA = `pr3-token-for-A-${crypto.randomBytes(8).toString("hex")}`;
    const tokU = `pr3-token-unscoped-${crypto.randomBytes(8).toString("hex")}`;
    putToken(path.join(vaultDir(c), `remote-127.0.0.1-${a.port}`), tokA);
    putToken(vaultDir(c), tokU);
    const env = { FAKE_PENDING_RC: "3", RELAY_HTTP_HOST: "127.0.0.1", RELAY_HTTP_PORT: String(b.port), RELAY_HTTP_TRUSTED_TUNNEL_PORT: String(b.port) };
    for (const hook of ["stop-check.sh", "post-tool-use-check.sh"]) {
      const r = await runHook(c, hook, env, inputFor(hook));
      expect(b.bytes(), `${hook}: A's token never reaches B\n${r.out}`).not.toContain(tokA);
      expect(b.bytes(), `${hook}: an unscoped token is never imported into B's scope`).not.toContain(tokU);
    }
    // The control: B's OWN scoped token IS sent to B (the scope is read, not merely ignored).
    const tokB = `pr3-token-for-B-${crypto.randomBytes(8).toString("hex")}`;
    putToken(path.join(vaultDir(c), `remote-127.0.0.1-${b.port}`), tokB);
    const r = await runHook(c, "stop-check.sh", env, inputFor("stop-check.sh"));
    expect(b.bytes(), `control: B's own token reaches B\n${r.out}`).toContain(tokB);
  }, 120_000);

  it("P1-4: a tunnel's (and a pinned remote's) credential calls ignore every proxy and curl config: zero bytes at a proxy from http_proxy or ~/.curlrc", async () => {
    const c = newCase("r1-proxy");
    const target = await spy();
    const proxy = await spy();
    fs.writeFileSync(path.join(c.home, ".curlrc"), `proxy = "http://127.0.0.1:${proxy.port}"\n`);
    const proxyEnv = { http_proxy: `http://127.0.0.1:${proxy.port}`, HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, ALL_PROXY: `http://127.0.0.1:${proxy.port}` };
    const env = { RELAY_AGENT_TOKEN: TOKEN, FAKE_PENDING_RC: "3", RELAY_HTTP_HOST: "127.0.0.1", RELAY_HTTP_PORT: String(target.port), RELAY_HTTP_TRUSTED_TUNNEL_PORT: String(target.port), ...proxyEnv };
    for (const hook of ["check-relay.sh", "stop-check.sh", "post-tool-use-check.sh", "codex/codex-session-start.sh"]) {
      await runHook(c, hook, env, hook.includes("codex") ? JSON.stringify({ session_id: "s-r1", hook_event_name: "SessionStart" }) : inputFor(hook));
    }
    expect(target.requests.length, "precondition: the tunnel was reached").toBeGreaterThan(0);
    expect(proxy.requests.length, `zero requests at the proxy: ${proxy.bytes().slice(0, 300)}`).toBe(0);
    // The pinned remote, too.
    const c2 = newCase("r1-proxy-remote");
    seedNativeDb(c2);
    fs.writeFileSync(path.join(c2.home, ".curlrc"), `proxy = "http://127.0.0.1:${proxy.port}"\n`);
    await runHook(c2, "check-relay.sh", { RELAY_AGENT_TOKEN: TOKEN, RELAY_HTTP_HOST: REMOTE_NAME, RELAY_HTTP_PORT: String(target.port), ...proxyEnv }, "", pinnedRemoteHooks());
    expect(proxy.requests.length, "zero requests at the proxy from the remote route").toBe(0);
  }, 180_000);

  it("P1-1 (pinning): a declared remote's bearer goes to the CHECKED address (curl --resolve): the pinned remote is reached, the local door untouched", async () => {
    const c = newCase("r1-pinned");
    seedNativeDb(c);
    const d = await startOwnerDaemon(c);
    const remote = await spy();
    const remoteToken = `pr3-remote-token-${crypto.randomBytes(8).toString("hex")}`;
    const r = await runHook(c, "check-relay.sh", { RELAY_AGENT_TOKEN: remoteToken, RELAY_HTTP_HOST: REMOTE_NAME, RELAY_HTTP_PORT: String(remote.port) }, "", pinnedRemoteHooks());
    expect(remote.bytes(), `the remote (reached only through the pin) got its bearer\n${r.out}`).toContain(remoteToken);
    expect(r.argv, "the local door is untouched").not.toMatch(/owner (tool|peek|session|liveness)/);
    expect(r.out).toMatch(new RegExp(`using the remote relay ${REMOTE_NAME.replace(/\./g, "\\.")}; the local DB at .* is not used for credentials`));
    await stopDaemon(d.child);
  }, 120_000);

  it("P1-2 (as ruled): a remote registration NEVER sends the local mint secret; absent the remote's own, the skip is named; provisioned, it is the one sent", async () => {
    const c = newCase("r1-remote-mint");
    seedNativeDb(c);
    const d = await startOwnerDaemon(c);
    const local = localMintSecret(c);
    const remote = await spy();
    const env = { RELAY_AGENT_NAME: "pr3-remote-newcomer", RELAY_HTTP_HOST: REMOTE_NAME, RELAY_HTTP_PORT: String(remote.port) };
    const r1 = await runHook(c, "check-relay.sh", env, "", pinnedRemoteHooks());
    expect(remote.requests.length, `precondition: the remote route ran\n${r1.out}`).toBeGreaterThan(0);
    expect(remote.bytes(), "the LOCAL mint secret never reaches the remote").not.toContain(local);
    expect(r1.out, "absent the remote's own secret, the skip is named").toMatch(new RegExp(`provision the remote's mint secret: relay remote set-mint-secret ${REMOTE_NAME.replace(/\./g, "\\.")}:${remote.port}, reading STDIN`));
    const remoteSecret = `pr3-remote-mint-${crypto.randomBytes(16).toString("hex")}`;
    const set = spawnSync(process.execPath, [RELAY, "remote", "set-mint-secret", `${REMOTE_NAME}:${remote.port}`], { env: baseEnv(c), input: `${remoteSecret}\n`, encoding: "utf-8" });
    expect(set.status, set.stderr).toBe(0);
    await runHook(c, "check-relay.sh", env, "", pinnedRemoteHooks());
    expect(remote.bytes(), "provisioned: the REMOTE's own secret is the one sent").toContain(remoteSecret);
    expect(remote.bytes(), "and still never the local one").not.toContain(local);
    await stopDaemon(d.child);
  }, 180_000);

  it("P1-1 (fail closed, named): an explicit host that does NOT resolve gets nothing, and the skip names the host and the deadline", async () => {
    const c = newCase("r1-unresolved");
    const env = { RELAY_AGENT_TOKEN: TOKEN, FAKE_PENDING_RC: "3", RELAY_HTTP_HOST: "relay.does-not-resolve.invalid", RELAY_HTTP_PORT: "4777" };
    const r = await runHook(c, "check-relay.sh", env);
    const r2 = await runHook(c, "stop-check.sh", env, inputFor("stop-check.sh"));
    for (const [hook, out] of [["check-relay.sh", r.out], ["stop-check.sh", r2.out]] as const) {
      expect(out, `${hook}: the skip is named`).toMatch(/the remote host relay\.does-not-resolve\.invalid did not resolve within \d+s[^;]*; nothing (is )?sent/);
    }
    expect(r.argv + r2.argv, "no credential-bearing curl ran").not.toMatch(/^curl .*\/mcp/m);
  }, 120_000);

  it("P2-5: a #418 daemon's v2 record beside a native DB → no credential, and the skip names the fix (restart the relay daemon)", async () => {
    const c = newCase("r1-v2-record");
    const token = seedNativeDb(c);
    const { record418, startDoorServer418 } = await import("./fixtures/owner-door-v2-418.js");
    const key = crypto.randomBytes(16).toString("hex");
    const b = { instance_id: "", db_path: fs.realpathSync(c.db) };
    const old = await startDoorServer418(key, b, { ok: true, registered: true, count: 0, messages: [] });
    servers.push(old.server);
    fs.writeFileSync(c.record, JSON.stringify(record418(old.port, key, b)), { mode: 0o600 });
    const s = await spy();
    const r = await runHook(c, "check-relay.sh", { RELAY_AGENT_TOKEN: token, RELAY_HTTP_HOST: "127.0.0.1", RELAY_HTTP_PORT: String(s.port) });
    expect(s.bytes()).not.toContain(token);
    expect(old.requests(), "no exchange with the old daemon").toBe(0);
    expect(r.out).toMatch(/restart the relay daemon/);
  }, 120_000);
});
