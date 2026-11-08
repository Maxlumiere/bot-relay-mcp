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
/** A JSON-RPC result out of an /mcp reply (plain JSON or one SSE `data:` line). */
function rpcResultOf(raw: string): unknown {
  const line = raw.split("\n").find((l) => l.startsWith("data:"));
  try {
    return (JSON.parse(line ? line.slice(5) : raw) as { result?: unknown }).result;
  } catch {
    return undefined;
  }
}
/** A tool result's definite outcome: its stringified content parsed, {success, error_code}; "unparsed" otherwise. */
function shapeOf(result: unknown): { outcome: "success" | "error" | "unparsed"; error_code?: string } {
  const text = (result as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text;
  try {
    const t = JSON.parse(String(text)) as { success?: boolean; error_code?: string };
    if (t.success === true) return { outcome: "success" };
    if (t.success === false && typeof t.error_code === "string") return { outcome: "error", error_code: t.error_code };
  } catch {
    /* not a tool result */
  }
  return { outcome: "unparsed" };
}
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
    // With its token the token check passes (no AUTH refusal); what follows is register_agent's own answer, the SAME
    // as the /mcp bearer twin's (here: the live-session collision guard, a seeded agent being online).
    expect(toolText(yes.opened)).not.toMatch(/AUTH_FAILED/);
    const bearer = await fetch(`http://127.0.0.1:${d.port}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "X-Agent-Token": token }, body: JSON.stringify(rpc("register_agent", args)) }).then((x) => x.text());
    // PARSED shapes (#433 R1 coverage): both answers parse to a tool result with a definite outcome, and agree.
    const viaDoor = shapeOf((yes.opened as { result?: unknown }).result);
    const viaBearer = shapeOf(rpcResultOf(bearer));
    expect(viaDoor.outcome, `the door's answer parses to a definite outcome: ${toolText(yes.opened)}`).not.toBe("unparsed");
    expect(viaBearer.outcome, `the bearer twin's answer parses to a definite outcome: ${bearer.slice(0, 300)}`).not.toBe("unparsed");
    expect(viaDoor, "== the bearer twin's answer (success, error_code)").toEqual(viaBearer);
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

  it("a NATIVE daemon writes the record too (version 3), and its door answers (validity without an owner lock: trust + binding + the reply)", async () => {
    const c = newCase("aead-native");
    const token = seedNativeDb(c);
    const d = await startDaemon(c);
    const rec = readRecord(c);
    expect(rec.v).toBe(3);
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


describe("hook PR 3 (#433 macOS): a process-lookup cut is never hidden (every OS, structural)", () => {
  // relay_pid_chain / relay_agent_pid / relay_pid_start print exactly one thing on stderr: relay_ps's NAMED cut ("no
  // time budget left for a process lookup"). A call site that sends their stderr to /dev/null hides the cut: on macOS
  // (#433, job 128832503669) the first walk (relay_pid_chain) took the cut silently and the hook named nothing.
  const WALKERS = /\brelay_(?:pid_chain|agent_pid|pid_start)\b/;
  const hidden = (src: string, file: string) =>
    src.split("\n").flatMap((line, i) => {
      if (/^\s*#/.test(line) || /\(\)\s*\{/.test(line) || !WALKERS.test(line) || /command -v/.test(line)) return [];
      return /2>\s*\/dev\/null|&>\s*\/dev\/null/.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : [];
    });
  it("no hook call site of a ps-walking helper discards its stderr (the cut stays named); a planted one is caught", () => {
    const hooks = path.join(REPO, "hooks");
    const files = [
      ...fs.readdirSync(hooks).filter((f) => f.endsWith(".sh") && f !== "_vault-helpers.sh").map((f) => path.join(hooks, f)),
      ...fs.readdirSync(path.join(hooks, "codex")).filter((f) => f.endsWith(".sh")).map((f) => path.join(hooks, "codex", f)),
    ];
    expect(files.length, "precondition: the hook entrypoints").toBeGreaterThanOrEqual(4);
    const sites = files.flatMap((f) => fs.readFileSync(f, "utf-8").split("\n").filter((l) => WALKERS.test(l) && !/^\s*#/.test(l) && !/command -v/.test(l)));
    expect(sites.length, "precondition: the scan sees the walk call sites").toBeGreaterThanOrEqual(5);
    expect(hidden('  X=$(relay_pid_chain 2>/dev/null || printf "")', "planted"), "control: a hidden cut is caught").toHaveLength(1);
    expect(files.flatMap((f) => hidden(fs.readFileSync(f, "utf-8"), path.relative(REPO, f))), "no call site hides a cut").toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// #433 Codex R1 (REDs, every OS): the host check, a null reply, the record version, the remote mint secret.
const runRelay = (c: Case, args: string[], input = "", extra: Record<string, string> = {}) =>
  spawnSync(process.execPath, [RELAY, ...args], { env: baseEnv(c, extra), input, encoding: "utf-8", timeout: 30_000 });
/** ASYNC: a server in THIS process must keep answering while the CLI runs (spawnSync would starve it). */
function runRelayAsync(c: Case, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RELAY, ...args], { env: baseEnv(c), stdio: ["ignore", "pipe", "pipe"] });
    procs.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d: Buffer) => (stdout += d));
    child.stderr!.on("data", (d: Buffer) => (stderr += d));
    const t = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.once("close", (status) => {
      clearTimeout(t);
      resolve({ status, stdout, stderr });
    });
  });
}
/** Point the record at another port: an atomic 0600 rewrite by the record's own user (the trust model holds). */
function retarget(c: Case, rec: Record<string, unknown>): void {
  const tmp = `${c.record}.re-${crypto.randomBytes(3).toString("hex")}`;
  const fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(rec));
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, c.record);
}

describe("#433 Codex R1 P1-1: the relay host is NORMALIZED and classified (aliases, IPv4-mapped IPv6, names under a deadline)", () => {
  it("every loopback alias is loopback; a name is resolved (any loopback address = loopback); an unresolvable or slow name is unresolved; a remote is pinned", async () => {
    const { classifyHost } = (await import("../src/host-class.js")) as {
      classifyHost: (h: string, o?: { lookup?: (h: string) => Promise<string[]>; timeoutMs?: number }) => Promise<{ kind: string; ip?: string }>;
    };
    const lookup = async (h: string): Promise<string[]> => {
      if (h === "loop.test") return ["127.0.0.2"];
      if (h === "mixed.test") return ["192.0.2.9", "127.0.0.1"];
      if (h === "mapped.test") return ["::ffff:127.0.0.1"];
      if (h === "remote.test") return ["192.0.2.7", "192.0.2.8"];
      if (h === "slow.test") return new Promise(() => {});
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    };
    for (const h of ["LOCALHOST", "localhost.", "Localhost", "2130706433", "0x7f.1", "0x7f000001", "127.1", "0177.0.0.1", "::ffff:127.0.0.1", "[::ffff:127.0.0.1]", "::ffff:7f00:1", "0:0:0:0:0:0:0:1", "::1", "[::1]", "0.0.0.0", "::", "loop.test", "mixed.test", "mapped.test", "a.localhost"]) {
      expect((await classifyHost(h, { lookup, timeoutMs: 500 })).kind, h).toBe("loopback");
    }
    expect(await classifyHost("203.0.113.10", { lookup })).toEqual({ kind: "remote", ip: "203.0.113.10" });
    expect(await classifyHost("remote.test", { lookup })).toEqual({ kind: "remote", ip: "192.0.2.7" });
    expect((await classifyHost("nx.test", { lookup })).kind).toBe("unresolved");
    const t0 = Date.now();
    expect((await classifyHost("slow.test", { lookup, timeoutMs: 200 })).kind, "a name that never resolves is unresolved at the deadline").toBe("unresolved");
    expect(Date.now() - t0, "inside the deadline").toBeLessThan(2000);
  });

  it("`relay host-class` prints the class and the checked address (the hooks pin curl to it)", () => {
    const c = newCase("host-class");
    for (const [h, want] of [["LOCALHOST", "loopback 127.0.0.1"], ["2130706433", "loopback 127.0.0.1"], ["203.0.113.10", "remote 203.0.113.10"]] as const) {
      const r = runRelay(c, ["host-class", h, "--timeout-ms", "2000"]);
      expect(r.status, `${h}: ${r.stderr}`).toBe(0);
      expect(r.stdout.trim(), h).toBe(want);
    }
  });
});

describe("#433 Codex R1 P3-6: a non-object reply is a NAMED failure, never an exception", () => {
  it("doorOpen refuses null, an array, a string and an empty object without throwing", async () => {
    const { doorOpen, doorKey } = (await import("../src/owner-endpoint.js")) as { doorOpen: (k: Buffer, a: Buffer, e: unknown) => unknown; doorKey: (k: string, d: "req" | "resp") => Buffer };
    const k = doorKey("00".repeat(16), "resp");
    for (const e of [null, [], "x", {}, 7]) expect(() => doorOpen(k, Buffer.from("a"), e), JSON.stringify(e)).not.toThrow();
    for (const e of [null, [], "x", {}, 7]) expect(doorOpen(k, Buffer.from("a"), e), JSON.stringify(e)).toBeNull();
  });

  it("`relay owner peek` against a listener answering `null` (and `[]`, a string): exit 1, the named failure, no TypeError", async () => {
    const c = newCase("null-reply");
    const { d, rec } = await wasmOwner(c);
    for (const body of ["null", "[]", '"x"']) {
      const srv = http.createServer((_q, res) => res.end(body));
      servers.push(srv);
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
      retarget(c, { ...rec, port: (srv.address() as { port: number }).port });
      const r = await runRelayAsync(c, ["owner", "peek", AGENT, "--json", "--timeout-ms", "4000"]);
      expect(r.status, `${body}: ${r.stderr}`).toBe(1);
      expect(r.stderr, body).toMatch(/relay owner: the owner's reply failed its authentication/);
      expect(r.stderr, body).not.toMatch(/TypeError|at .*\.js:\d+/);
    }
    await stopDaemon(d.child);
  }, 90_000);
});

describe("#433 Codex R1 P2-5: the record and protocol are version 3; a skew either way is named (the #418 v2 protocol, frozen)", () => {
  it("a new daemon writes v3; the #418 client's gate refuses it (bad-record) and its v2 exchange cannot pass the new door", async () => {
    const c = newCase("skew-new-daemon");
    const { d, rec } = await wasmOwner(c);
    expect(rec.v).toBe(3);
    const { gate418, exchange418 } = await import("./fixtures/owner-door-v2-418.js");
    expect(gate418(rec as unknown as Record<string, unknown>), "the #418 client refuses a v3 record before any exchange").toBe("bad-record");
    const ts = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomBytes(16).toString("hex");
    await expect(exchange418(rec.port, rec.key, { instance_id: rec.instance_id, db_path: rec.db_path }, PEEK, { agent_name: AGENT, args: {}, ts, client_nonce: nonce }, nonce), "even forced, a v2 exchange gets no MAC'd answer").rejects.toThrow();
    await stopDaemon(d.child);
  }, 90_000);

  it("a #418 daemon (its v2 record and door) with the new client: `relay owner peek` is refused BEFORE any exchange, named 'restart the relay daemon'", async () => {
    const c = newCase("skew-old-daemon");
    seedNativeDb(c);
    const { record418, startDoorServer418 } = await import("./fixtures/owner-door-v2-418.js");
    const key = crypto.randomBytes(16).toString("hex");
    const b = { instance_id: "", db_path: fs.realpathSync(c.db) };
    const old = await startDoorServer418(key, b, { ok: true, registered: true, count: 0, messages: [] });
    servers.push(old.server);
    retarget(c, record418(old.port, key, b));
    const r = await runRelayAsync(c, ["owner", "peek", AGENT, "--json", "--timeout-ms", "4000"]);
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toMatch(/old-record\).*restart the relay daemon/);
    expect(old.requests(), "no exchange with the old daemon").toBe(0);
  }, 60_000);
});

describe("#433 Codex R1 P1-2 (as ruled): `relay remote set-mint-secret <host:port>` writes the REMOTE's own secret (stdin only)", () => {
  it("stdin → agents/remote-<host>-<port>/mint.secret, private; a secret on argv is refused; a planted symlink is never followed", () => {
    const c = newCase("remote-mint");
    seedNativeDb(c);
    const secret = `pr3-remote-mint-${crypto.randomBytes(16).toString("hex")}`;
    const r = runRelay(c, ["remote", "set-mint-secret", "203.0.113.10:3777"], `${secret}\n`);
    expect(r.status, r.stderr).toBe(0);
    const file = path.join(path.dirname(c.db), "agents", "remote-203.0.113.10-3777", "mint.secret");
    expect(fs.readFileSync(file, "utf-8").trim()).toBe(secret);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(r.stdout + r.stderr, "the secret is never printed").not.toContain(secret);
    const argv = runRelay(c, ["remote", "set-mint-secret", "203.0.113.10:3777", secret]);
    expect(argv.status, "a secret on argv is refused").not.toBe(0);
    if (process.platform !== "win32") {
      const victim = path.join(c.home, "victim.txt");
      fs.writeFileSync(victim, "untouched");
      const dir2 = path.join(path.dirname(c.db), "agents", "remote-203.0.113.11-3777");
      fs.mkdirSync(dir2, { recursive: true, mode: 0o700 });
      fs.symlinkSync(victim, path.join(dir2, "mint.secret"));
      const sym = runRelay(c, ["remote", "set-mint-secret", "203.0.113.11:3777"], `${secret}\n`);
      expect(sym.status, "a planted symlink is refused").not.toBe(0);
      expect(fs.readFileSync(victim, "utf-8"), "its target is untouched").toBe("untouched");
    }
  }, 60_000);
});
