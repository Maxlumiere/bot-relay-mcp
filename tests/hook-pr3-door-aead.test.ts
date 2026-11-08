// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Hook PR 3 (as ruled after Codex #418 R2): the OWNER DOOR is CONFIDENTIAL. Requests and replies are AES-256-GCM sealed
 * under HKDF(owner key) ("relay-owner-door v1 req" / "... resp"), the AAD binding path, ts, nonce, instance id and
 * canonical DB path (+ status on replies). A port thief sees only ciphertext and can forge nothing. register, health and
 * liveness run the SAME dispatcher as /mcp (the same auth, mint gate, limits and audit), with the agent token and mint
 * secret INSIDE the ciphertext; every daemon (native too) writes its record. TS rows on every OS; hook rows POSIX.
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
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hookpr3-")));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const AGENT = "pr3-agent";
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
       db.registerAgent("pr3-sender", "r", []);
       db.sendMessage("pr3-sender", ${JSON.stringify(AGENT)}, ${JSON.stringify(message)}, "normal");
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
/** The owner daemon (HTTP) on the case's DB. Resolves once /health answers and its record exists. */
async function startDaemon(c: Case, extraEnv: Record<string, string> = {}): Promise<{ child: ChildProcess; port: number; stderr: () => string }> {
  const port = await getFreePort();
  const child = spawn(process.execPath, [DIST_INDEX], { env: baseEnv(c, { RELAY_TRANSPORT: "http", RELAY_HTTP_HOST: "127.0.0.1", RELAY_HTTP_PORT: String(port), ...extraEnv }), stdio: ["ignore", "pipe", "pipe"] });
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
  throw new Error(`the daemon did not come up with its record (exit ${child.exitCode}):\n${err}`);
}
async function stopDaemon(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
interface Rec { port: number; key: string; instance_id: string; db_path: string; v: number }
const readRecord = (c: Case) => JSON.parse(fs.readFileSync(c.record, "utf-8")) as Rec;
const mintSecretOf = (c: Case): string => {
  const hits: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name === "mint.secret") hits.push(p); } };
  walk(c.home);
  expect(hits.length, "precondition: the daemon created its registration secret").toBeGreaterThan(0);
  return fs.readFileSync(hits[0]!, "utf-8").trim();
};

// ---------------------------------------------------------------------------------------------------------------------
// THE AEAD DOOR, as ruled (an independent client implementing the spec).
const hkdf = (key: string, dir: "req" | "resp") => Buffer.from(crypto.hkdfSync("sha256", Buffer.from(key, "hex"), Buffer.alloc(0), `relay-owner-door v1 ${dir}`, 32));
const reqAad = (r: Rec, p: string, ts: number, nonce: string) => Buffer.from(`req\n${p}\n${ts}\n${nonce}\n${r.instance_id}\n${r.db_path}`);
const respAad = (r: Rec, p: string, ts: number, nonce: string, status: number) => Buffer.from(`resp\n${p}\n${ts}\n${nonce}\n${r.instance_id}\n${r.db_path}\n${status}`);
function seal(key: Buffer, aad: Buffer, plain: unknown) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(JSON.stringify(plain), "utf-8"), c.final()]);
  return { iv: iv.toString("base64"), ct: ct.toString("base64"), tag: c.getAuthTag().toString("base64") };
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
const HEALTH = "/owner/v1/health";
const REGISTER = "/owner/v1/register";
const LIVENESS = "/owner/v1/liveness";
const SESSION = "/owner/v1/session";
interface DoorOpts { key?: string; tamper?: boolean; aadPath?: string; agent?: string }
/** One sealed exchange; `opened` is the reply's plaintext when it authenticates (null otherwise). */
async function door(r: Rec, p: string, args: Record<string, unknown>, o: DoorOpts = {}) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString("hex");
  const env = seal(hkdf(o.key ?? r.key, "req"), reqAad(r, o.aadPath ?? p, ts, nonce), { agent_name: o.agent ?? AGENT, args });
  if (o.tamper) {
    const ct = Buffer.from(env.ct, "base64");
    ct[0] = ct[0]! ^ 0xff;
    env.ct = ct.toString("base64");
  }
  const body = JSON.stringify({ ts, client_nonce: nonce, ...env });
  const res = await fetch(`http://127.0.0.1:${r.port}${p}`, { method: "POST", headers: { "Content-Type": "text/plain" }, body });
  const text = await res.text();
  let envR: { iv?: string; ct?: string; tag?: string } = {};
  try { envR = JSON.parse(text) as typeof envR; } catch { /* not JSON */ }
  const opened = openSealed(hkdf(r.key, "resp"), respAad(r, p, ts, nonce, res.status), envR) as Record<string, unknown> | null;
  return { status: res.status, raw: body + "\n" + text, opened };
}
const rpc = (name: string, args: Record<string, unknown>) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
/** The dispatcher's tool result inside a sealed reply, as the hooks parse it (its JSON text). */
const toolText = (o: Record<string, unknown> | null) => JSON.stringify((o as { result?: unknown } | null)?.result ?? null);
/** The whole DB, from a COPY read with sql.js (never an open of the live file). */
async function dbDump(c: Case): Promise<Record<string, unknown[][]>> {
  const copy = path.join(c.home, `copy-${crypto.randomBytes(4).toString("hex")}.db`);
  fs.copyFileSync(c.db, copy);
  const initSqlJs = (await import("sql.js")).default;
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(copy));
  const out: Record<string, unknown[][]> = {};
  const tables = db.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")[0]?.values.map((x: unknown[]) => String(x[0])) ?? [];
  for (const t of tables) {
    const q = db.exec(`SELECT * FROM "${t}" ORDER BY rowid`)[0];
    out[t] = q ? [q.columns, ...q.values] : [];
  }
  db.close();
  return out;
}
async function wasmOwner(c: Case, message = "pr3 door mail") {
  const token = seedWasmDb(c, message);
  fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
  const d = await startDaemon(c);
  return { token, d, rec: readRecord(c) };
}

describe("hook PR 3: the AEAD owner door (every OS)", () => {
  it("a SEALED peek: the reply opens under the response key and AAD; NO plaintext (mail, agent name) crosses the wire", async () => {
    const c = newCase("aead-peek");
    const { d, rec } = await wasmOwner(c, "pr3 sealed mail");
    const r = await door(rec, PEEK, { with_content: 5 });
    expect(r.status, r.raw).toBe(200);
    expect(r.opened, "the reply authenticates").not.toBeNull();
    expect(JSON.stringify(r.opened)).toContain("pr3 sealed mail");
    expect(r.raw, "no mail on the wire").not.toContain("pr3 sealed mail");
    expect(r.raw, "no agent name on the wire").not.toContain(AGENT);
    await stopDaemon(d.child);
  }, 90_000);

  it("REFUSED: a tampered ciphertext, a ciphertext bound to another path (AAD), the wrong key, and the old HMAC request form", async () => {
    const c = newCase("aead-refuse");
    const { d, rec } = await wasmOwner(c, "pr3 refused mail");
    for (const [what, run] of [
      ["a tampered ciphertext", () => door(rec, PEEK, { with_content: 5 }, { tamper: true })],
      ["sealed for /owner/v1/health, posted to peek", () => door(rec, PEEK, { with_content: 5 }, { aadPath: HEALTH })],
      ["the wrong key", () => door(rec, PEEK, { with_content: 5 }, { key: crypto.randomBytes(16).toString("hex") })],
    ] as const) {
      const r = await run();
      expect(r.status, `${what}: ${r.raw}`).toBeGreaterThanOrEqual(400);
      expect(r.raw, what).not.toContain("pr3 refused mail");
    }
    const ts = Math.floor(Date.now() / 1000);
    const old = await fetch(`http://127.0.0.1:${rec.port}${PEEK}`, { method: "POST", headers: { "Content-Type": "text/plain", "X-Owner-MAC": "00".repeat(32) }, body: JSON.stringify({ agent_name: AGENT, args: {}, ts, client_nonce: crypto.randomBytes(16).toString("hex") }) });
    expect(old.status, "the HMAC-era request form is refused").toBeGreaterThanOrEqual(400);
    expect(await old.text()).not.toContain("pr3 refused mail");
    await stopDaemon(d.child);
  }, 90_000);

  it("REGISTER runs the SAME mint gate: a NEW name without the registration secret → MINT_SECRET_REQUIRED; with it → a token, ONLY inside the sealed reply", async () => {
    const c = newCase("aead-register");
    const { d, rec } = await wasmOwner(c);
    const args = { name: "pr3-newcomer", role: "r", capabilities: [] };
    const no = await door(rec, REGISTER, { rpc: rpc("register_agent", args) }, { agent: "pr3-newcomer" });
    expect(no.opened, no.raw).not.toBeNull();
    expect(toolText(no.opened)).toMatch(/MINT_SECRET_REQUIRED/);
    const yes = await door(rec, REGISTER, { rpc: rpc("register_agent", args), mint_secret: mintSecretOf(c) }, { agent: "pr3-newcomer" });
    expect(yes.opened, yes.raw).not.toBeNull();
    expect(toolText(yes.opened), "a token is minted").toMatch(/agent_token/);
    expect(yes.raw, "the token is never on the wire").not.toMatch(/agent_token/);
    await stopDaemon(d.child);
  }, 90_000);

  it("REGISTER keeps the token check: re-registering an EXISTING agent without its token is refused (as on bearer); with it, it is preserved", async () => {
    const c = newCase("aead-reregister");
    const { d, rec, token } = await wasmOwner(c);
    const args = { name: AGENT, role: "r", capabilities: [] };
    const no = await door(rec, REGISTER, { rpc: rpc("register_agent", args) });
    expect(no.opened, no.raw).not.toBeNull();
    expect(toolText(no.opened), "refused without its token").toMatch(/isError\\?"?:\s*true|AUTH|token/i);
    expect(toolText(no.opened)).not.toMatch(/"agent_token\\?"/);
    const yes = await door(rec, REGISTER, { rpc: rpc("register_agent", args), agent_token: token });
    expect(yes.opened, yes.raw).not.toBeNull();
    expect(toolText(yes.opened)).not.toMatch(/isError\\?"?:\s*true/);
    await stopDaemon(d.child);
  }, 90_000);

  it("HEALTH over the door == bearer: a wrong token's auth_error matches the /mcp twin's; and (c) the AUDIT row records the real peer, like the twin", async () => {
    const c = newCase("aead-health");
    const { d, rec } = await wasmOwner(c);
    const wrong = "pr3-wrong-token-aaaaaaaaaaaaaaaaaaaa";
    const viaDoor = await door(rec, HEALTH, { rpc: rpc("health_check", {}), agent_token: wrong });
    expect(viaDoor.opened, viaDoor.raw).not.toBeNull();
    const bearer = await fetch(`http://127.0.0.1:${d.port}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "X-Agent-Token": wrong }, body: JSON.stringify(rpc("health_check", {})) }).then((x) => x.text());
    const authErr = (t: string) => /\\"auth_error\\":\s*true|"auth_error":\s*true/.test(t);
    expect(authErr(toolText(viaDoor.opened)), "the door reports auth_error for a wrong token").toBe(true);
    expect(authErr(toolText(viaDoor.opened)), "== the bearer twin").toBe(authErr(bearer));
    await new Promise((x) => setTimeout(x, 500));
    await stopDaemon(d.child);
    const audit = (await dbDump(c)).audit_log ?? [];
    const cols = (audit[0] ?? []) as string[];
    const rows = audit.slice(1).filter((row) => JSON.stringify(row).includes("health_check"));
    expect(rows.length, "precondition: both health calls are audited").toBeGreaterThanOrEqual(2);
    const ipCol = cols.findIndex((x) => /ip|source/.test(x));
    expect(ipCol, "precondition: the audit has a source column").toBeGreaterThanOrEqual(0);
    const ips = new Set(rows.slice(-2).map((row) => String(row[ipCol])));
    expect(ips.size, `the door call and the bearer twin record the SAME (real) peer: ${[...ips].join(", ")}`).toBe(1);
  }, 90_000);

  it("LIVENESS runs report_liveness's own check: another agent's token is refused; its own restamps", async () => {
    const c = newCase("aead-live");
    const token = seedWasmDb(c);
    fs.writeFileSync(c.cfg, JSON.stringify({ sqlite_driver: "wasm" }), { mode: 0o600 });
    const d = await startDaemon(c);
    const rec = readRecord(c);
    const args = { agent_name: AGENT, agent_pid: 4242, agent_pid_start: "t0" };
    const forged = await door(rec, LIVENESS, { rpc: rpc("report_liveness", { ...args, agent_token: "pr3-not-the-token-aaaaaaaaaaaa" }), agent_token: "pr3-not-the-token-aaaaaaaaaaaa" });
    expect(forged.opened, forged.raw).not.toBeNull();
    expect(toolText(forged.opened)).toMatch(/isError\\?"?:\s*true|AUTH|token/i);
    const own = await door(rec, LIVENESS, { rpc: rpc("report_liveness", { ...args, agent_token: token }), agent_token: token });
    expect(toolText(own.opened)).not.toMatch(/isError\\?"?:\s*true/);
    await stopDaemon(d.child);
    const agents = (await dbDump(c)).agents!;
    const cols = agents[0] as string[];
    const row = agents.slice(1).find((x) => x[cols.indexOf("name")] === AGENT)!;
    expect(row[cols.indexOf("agent_pid")]).toBe(4242);
  }, 90_000);

  it("a NATIVE daemon writes the v2 record too, and its door answers (validity without an owner lock: trust + binding + the reply)", async () => {
    const c = newCase("aead-native");
    const token = seedNativeDb(c);
    const d = await startDaemon(c);
    const rec = readRecord(c);
    expect(rec.v).toBe(2);
    const r = await door(rec, HEALTH, { rpc: rpc("health_check", {}), agent_token: token });
    expect(r.status, r.raw).toBe(200);
    expect(r.opened).not.toBeNull();
    const { ownerEndpointVerdict } = (await import("../src/owner-endpoint.js")) as { ownerEndpointVerdict: (db: string) => { ok: boolean; reason?: string } };
    expect(ownerEndpointVerdict(c.db)).toMatchObject({ ok: true });
    await stopDaemon(d.child);
  }, 90_000);

});

describe("hook PR 3, as ruled: /owner/v1/session (ONE agent's own session_id; no enumeration)", () => {
  it("its own token → exactly {ok, session_id}, the row's; another agent's name, an extra field, or no token → refused, no session_id; nothing but the audit moves", async () => {
    const c = newCase("aead-session");
    const { d, rec, token } = await wasmOwner(c);
    await new Promise((x) => setTimeout(x, 1500));
    const before = await dbDump(c);
    const ok = await door(rec, SESSION, { agent_token: token });
    expect(ok.status, ok.raw).toBe(200);
    expect(Object.keys(ok.opened ?? {}).sort(), "no other field").toEqual(["ok", "session_id"]);
    const cols = before.agents![0] as string[];
    const row = before.agents!.slice(1).find((x) => x[cols.indexOf("name")] === AGENT)!;
    expect((ok.opened as { session_id: unknown }).session_id).toBe(row[cols.indexOf("session_id")]);
    // A second agent, then: A's token naming B, an extra field, no token.
    const reg = await door(rec, REGISTER, { rpc: rpc("register_agent", { name: "pr3-other", role: "r", capabilities: [] }), mint_secret: mintSecretOf(c) }, { agent: "pr3-other" });
    expect(toolText(reg.opened), "precondition: a second agent").toMatch(/agent_token/);
    for (const [what, r] of [
      ["A's token naming B", await door(rec, SESSION, { agent_token: token }, { agent: "pr3-other" })],
      ["an extra field", await door(rec, SESSION, { agent_token: token, fields: ["role"] })],
      ["no token", await door(rec, SESSION, {})],
      ["a wrong token", await door(rec, SESSION, { agent_token: "pr3-not-a-token-aaaaaaaaaaaaaa" })],
    ] as const) {
      expect(r.status, `${what}: ${r.raw}`).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(r.opened ?? {}), what).not.toMatch(/session_id/);
    }
    await stopDaemon(d.child);
    const after = await dbDump(c);
    for (const t of ["messages", "mailbox", "agent_cursor"]) expect(after[t], `table ${t} untouched`).toEqual(before[t]);
  }, 90_000);
});

