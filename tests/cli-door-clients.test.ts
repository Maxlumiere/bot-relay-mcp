// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * PR 4 (as ruled after #433 R1): EVERY credential-bearing CLI client reaches its relay one of two ways. A LOCAL relay
 * (loopback, any spelling) only through the owner door (a sealed /owner/v1/tool with an allowlist; the normal handler
 * auth, the token inside the ciphertext). A REMOTE relay (an explicit non-loopback host, a hub) by bearer, hardened: no
 * redirect followed, no proxy, the checked address, per-remote credentials only. An unresolved host gets nothing. A
 * scan row enumerates every HTTP client call site so a new one fails CI until it is classified.
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
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clidoor-")));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const AGENT = "pr4-agent";
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

const TOOL = "/owner/v1/tool";
const LAN_V4 = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal)?.address ?? null;
/** A second agent, registered directly (dist/db.js) on the case's DB; its token. */
function registerExtra(c: Case, name: string): string {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `const db = await import(${JSON.stringify(DIST_DB)}); const a = db.registerAgent(${JSON.stringify(name)}, "r", []); db.closeDb(); process.stdout.write(a.plaintext_token);`], { encoding: "utf-8", env: baseEnv(c) });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
}
/** A recording listener on `host`: every request (method, url, headers, body). */
async function recorder(host = "127.0.0.1", handler?: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const reqs: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders; body: string }> = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => (body += d));
    req.on("end", () => {
      reqs.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      if (handler) handler(req, res);
      else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(req.url === "/health" ? JSON.stringify({ status: "ok", version: "0", protocol_version: "2.1.0" }) : "{}");
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, host, () => r()));
  const port = (server.address() as { port: number }).port;
  return { port, reqs, bytes: () => reqs.map((q) => `${q.method} ${q.url}\n${JSON.stringify(q.headers)}\n${q.body}`).join("\n") };
}
function relayAsync(c: Case, args: string[], extra: Record<string, string> = {}, input = ""): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RELAY, ...args], { env: baseEnv(c, extra), stdio: ["pipe", "pipe", "pipe"] });
    procs.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d: Buffer) => (stdout += d));
    child.stderr!.on("data", (d: Buffer) => (stderr += d));
    child.stdin!.end(input);
    const t = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.once("close", (status) => {
      clearTimeout(t);
      resolve({ status, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// THE SCAN (every OS): every HTTP client call site in src/cli/, bin/ and tools/ is CLASSIFIED; a new one fails CI.
type Klass = "health-only" | "door-client" | "relay-client" | "hooks-family";
/** file → pattern → { n, klass }. The FINAL shape: credential-bearing verbs reach HTTP only through relay-client. */
const HTTP_REGISTRY: Record<string, Record<string, { n: number; klass: Klass }>> = {
  "src/cli/pair.ts": { "fetch(": { n: 1, klass: "health-only" } },
  "src/cli/doctor.ts": { "fetch(": { n: 2, klass: "health-only" } },
  "src/cli/init.ts": { "fetch(": { n: 1, klass: "health-only" } },
  "src/cli/watch.ts": { "fetch(": { n: 1, klass: "health-only" } },
  "src/cli/test.ts": { "fetch(": { n: 1, klass: "health-only" } },
  "src/cli/owner.ts": { "http.request(": { n: 1, klass: "door-client" } },
  "src/cli/relay-client.ts": { "http.request(": { n: 1, klass: "relay-client" }, "https.request(": { n: 1, klass: "relay-client" } },
  "bin/codex-relay": { "curl ": { n: 2, klass: "hooks-family" } },
};
// curl: an INVOCATION (at a command position, followed by an argument), as the hook tripwire counts it: not `route=curl`,
// `command -v curl` or `= curl ]`.
const PATTERNS = [/\bfetch\(/g, /\bhttps\.request\(/g, /(?<![A-Za-z.])http\.request\(/g, /(?:^|[\s;|&(!])curl\s+[-"'$h]/g];
const PATTERN_KEYS = ["fetch(", "https.request(", "http.request(", "curl "];
function httpSites(file: string, src: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const isShell = !/\.(ts|mjs|js|cjs)$/.test(file);
  src.split("\n").forEach((line, i) => {
    const t = line.trim();
    if (isShell ? t.startsWith("#") : /^(\/\/|\*|\/\*)/.test(t)) return;
    PATTERNS.forEach((re, k) => {
      if (isShell !== (PATTERN_KEYS[k] === "curl ")) return;
      if ((line.match(re) ?? []).length > 0) (out[PATTERN_KEYS[k]!] ??= []).push(`${file}:${i + 1}: ${t.slice(0, 140)}`);
    });
  });
  return out;
}
function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.name === "node_modules" || e.name === "dist") return [];
    return e.isDirectory() ? walk(p) : [p];
  });
}

describe("PR 4: every HTTP client call site in src/cli, bin and tools is classified (a scan, every OS)", () => {
  it("each site is in the registry with its class; a planted unclassified fetch is caught; health-only sites carry no credential; the credential verbs use relay-client", () => {
    const planted = httpSites("src/cli/planted.ts", 'const r = await fetch(`${base}/mcp`, { headers: { "X-Agent-Token": t } });');
    expect(planted["fetch("], "control: a planted fetch is a site").toHaveLength(1);
    const files = [...walk(path.join(REPO, "src", "cli")), ...walk(path.join(REPO, "bin")), ...walk(path.join(REPO, "tools"))].filter((f) => /\.(ts|mjs|js|cjs)$/.test(f) || path.dirname(f) === path.join(REPO, "bin"));
    expect(files.length, "precondition: the scan sees the CLI").toBeGreaterThan(20);
    const found: Record<string, Record<string, string[]>> = {};
    for (const f of files) {
      const rel = path.relative(REPO, f).split(path.sep).join("/");
      const s = httpSites(rel, fs.readFileSync(f, "utf-8"));
      if (Object.keys(s).length > 0) found[rel] = s;
    }
    const shape = (o: Record<string, Record<string, unknown[]>>) =>
      Object.fromEntries(Object.entries(o).map(([f, ps]) => [f, Object.fromEntries(Object.entries(ps).map(([p, v]) => [p, v.length]))]));
    const want = Object.fromEntries(Object.entries(HTTP_REGISTRY).map(([f, ps]) => [f, Object.fromEntries(Object.entries(ps).map(([p, v]) => [p, v.n]))]));
    expect(shape(found), `every site classified (found:\n${Object.values(found).flatMap((p) => Object.values(p).flat()).join("\n")})`).toEqual(want);
    for (const [f, ps] of Object.entries(HTTP_REGISTRY)) {
      for (const [p, v] of Object.entries(ps)) {
        if (v.klass !== "health-only") continue;
        for (const site of found[f]?.[p] ?? []) {
          expect(site, `${site}: a health-only site probes /health`).toMatch(/\/health/);
          expect(site, `${site}: a health-only site carries no credential`).not.toMatch(/token|secret|authorization|x-agent|x-relay/i);
        }
      }
    }
    for (const f of ["send.ts", "resolve.ts", "pair.ts", "doctor.ts", "test.ts"]) {
      expect(fs.readFileSync(path.join(REPO, "src", "cli", f), "utf-8"), `${f} reaches its relay through relay-client`).toMatch(/from "\.\/relay-client\.js"|import\("\.\/relay-client\.js"\)/);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("PR 4: the door's /owner/v1/tool (an allowlist; the handlers' own auth)", () => {
  it("a tool outside the allowlist is refused (sealed 403); an allowlisted one runs its handler auth: a wrong token AUTH_FAILED, its own token succeeds", async () => {
    const c = newCase("tool-allow");
    const token = seedNativeDb(c);
    const d = await startDaemon(c);
    const rec = readRecord(c);
    const no = await door(rec, TOOL, { rpc: rpc("unregister_agent", { name: AGENT }), agent_token: token });
    expect(no.status, no.raw).toBe(403);
    expect(no.opened, "the refusal is sealed").not.toBeNull();
    const wrong = await door(rec, TOOL, { rpc: rpc("resolve_messages", { agent_name: AGENT, message_ids: ["x"] }), agent_token: "pr4-not-a-token-aaaaaaaaaaaaaaaa" });
    expect(wrong.status, wrong.raw).toBe(200);
    expect(toolText(wrong.opened)).toMatch(/AUTH_FAILED/);
    const ok = await door(rec, TOOL, { rpc: rpc("resolve_messages", { agent_name: AGENT, message_ids: ["00000000-0000-4000-8000-000000000000"] }), agent_token: token });
    expect(shapeOf((ok.opened as { result?: unknown }).result).outcome, toolText(ok.opened)).toBe("success");
    await stopDaemon(d.child);
  }, 90_000);
});

describe("PR 4: a LOCAL relay's CLI credentials go ONLY through its door (every OS)", () => {
  it("`relay send` and `relay resolve`: zero credential bytes to the configured port; the message lands and is resolved", async () => {
    const c = newCase("cli-local");
    const token = seedNativeDb(c);
    const peerTok = registerExtra(c, "pr4-peer");
    const d = await startDaemon(c);
    const spy = await recorder();
    const env = { RELAY_HTTP_HOST: "127.0.0.1", RELAY_HTTP_PORT: String(spy.port) };
    const s = await relayAsync(c, ["send", "pr4-peer", "pr4 local hello", "--from", AGENT, "--json"], { ...env, RELAY_AGENT_TOKEN: token });
    expect(s.status, `send: ${s.stderr}`).toBe(0);
    await new Promise((r) => setTimeout(r, 300));
    const msgs = ((await dbDump(c)).messages ?? []) as unknown[][];
    const cols = msgs[0] as string[];
    const row = msgs.slice(1).find((m) => m[cols.indexOf("content")] === "pr4 local hello");
    expect(row, "the message landed").toBeDefined();
    const id = String(row![cols.indexOf("id")]);
    const r = await relayAsync(c, ["resolve", id, "--agent", "pr4-peer", "--json"], { ...env, RELAY_AGENT_TOKEN: peerTok });
    expect(r.status, `resolve: ${r.stderr}`).toBe(0);
    for (const t of [token, peerTok]) expect(spy.bytes(), "no credential to the configured port").not.toContain(t);
    expect(spy.reqs.filter((q) => q.url !== "/health"), "nothing but /health at the configured port").toEqual([]);
    await stopDaemon(d.child);
  }, 120_000);

  it("`relay doctor --remote http://127.0.0.1:<port>` (a LOOPBACK hub): its token check goes through the door, never to that port", async () => {
    const c = newCase("cli-doctor-loop");
    const token = seedNativeDb(c);
    const d = await startDaemon(c);
    const spy = await recorder();
    await relayAsync(c, ["doctor", "--remote", `http://127.0.0.1:${spy.port}`], { RELAY_AGENT_TOKEN: token });
    expect(spy.bytes(), "the token never reaches the loopback port").not.toContain(token);
    await stopDaemon(d.child);
  }, 120_000);

  it("an UNRESOLVED relay host gets nothing, named; `relay pair` to a LOOPBACK hub is refused by name", async () => {
    const c = newCase("cli-unres");
    const token = seedNativeDb(c);
    const s = await relayAsync(c, ["send", "x", "hi", "--from", AGENT], { RELAY_HTTP_HOST: "relay.does-not-resolve.invalid", RELAY_HTTP_PORT: "4777", RELAY_AGENT_TOKEN: token });
    expect(s.status).not.toBe(0);
    expect(s.stderr).toMatch(/did not resolve/);
    const spy = await recorder();
    const p = await relayAsync(c, ["pair", `http://127.0.0.1:${spy.port}`, "--name", "pr4-pair", "--yes", "--secret-stdin"], {}, "pr4-hub-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n");
    expect(p.status).not.toBe(0);
    expect(p.stderr).toMatch(/pair is for a remote hub/);
    expect(spy.bytes()).not.toMatch(/pr4-hub-secret/);
  }, 120_000);
});

describe.skipIf(LAN_V4 === null)("PR 4: a REMOTE relay's bearer is hardened (a LAN address; skipped by name where the runner has none)", () => {
  it("a 302 is NOT followed (named); HTTP_PROXY + NODE_USE_ENV_PROXY=1 → zero bytes at the proxy; the local vault token and the local secrets never reach the remote", async () => {
    const c = newCase("cli-remote");
    const localTok = seedNativeDb(c);
    fs.writeFileSync(c.cfg, JSON.stringify({ http_secret: `pr4-local-http-secret-${"x".repeat(24)}`, dashboard_secret: `pr4-local-dash-secret-${"y".repeat(24)}` }), { mode: 0o600 });
    const vault = path.join(path.dirname(c.db), "agents");
    fs.mkdirSync(vault, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(vault, `${AGENT}.token`), `${localTok}\n`, { mode: 0o600 });
    const landing = await recorder(LAN_V4!);
    const redirect = await recorder(LAN_V4!, (_q, res) => {
      res.writeHead(302, { Location: `http://${LAN_V4}:${landing.port}/api/send-message` });
      res.end();
    });
    const s1 = await relayAsync(c, ["send", "x", "hi", "--from", AGENT], { RELAY_HTTP_HOST: LAN_V4!, RELAY_HTTP_PORT: String(redirect.port), RELAY_AGENT_TOKEN: "pr4-remote-explicit-token-aaaaaaaa" });
    expect(s1.status, "a redirect fails").not.toBe(0);
    expect(s1.stderr).toMatch(/redirect/i);
    expect(landing.reqs, "the redirect is never followed").toEqual([]);
    const proxy = await recorder("127.0.0.1");
    const target = await recorder(LAN_V4!);
    await relayAsync(c, ["send", "x", "hi", "--from", AGENT], { RELAY_HTTP_HOST: LAN_V4!, RELAY_HTTP_PORT: String(target.port), RELAY_AGENT_TOKEN: "pr4-remote-explicit-token-aaaaaaaa", HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, http_proxy: `http://127.0.0.1:${proxy.port}`, NODE_USE_ENV_PROXY: "1" });
    expect(proxy.reqs, "zero requests at the proxy").toEqual([]);
    expect(target.reqs.length, "the remote itself was reached").toBeGreaterThan(0);
    // No RELAY_AGENT_TOKEN: the LOCAL vault token must not be what a remote receives; nor the local secrets.
    const r3 = await recorder(LAN_V4!);
    await relayAsync(c, ["send", "x", "hi", "--from", AGENT], { RELAY_HTTP_HOST: LAN_V4!, RELAY_HTTP_PORT: String(r3.port) });
    expect(r3.bytes(), "the local vault token never reaches a remote").not.toContain(localTok);
    expect(r3.bytes(), "the local secrets never reach a remote").not.toMatch(/pr4-local-(http|dash)-secret/);
  }, 120_000);
});
