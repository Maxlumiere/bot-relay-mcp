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
import ts from "typescript-legacy";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST_INDEX = path.join(REPO, "dist", "index.js");
const DIST_DB = pathToFileURL(path.join(REPO, "dist", "db.js")).href;
const DIST_TOKEN_STORE = pathToFileURL(path.join(REPO, "dist", "token-store.js")).href;
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
/** Windows: an owner-only ACL on each path (what the trusted writers set); a no-op elsewhere (the modes do it). */
async function privatize(...items: Array<[string, boolean]>): Promise<void> {
  if (process.platform !== "win32") return;
  const { restrictToOwnerWindows } = (await import("../src/fs-perms.js")) as { restrictToOwnerWindows: (p: string, isDir: boolean) => string[] };
  for (const [p, isDir] of items) expect(restrictToOwnerWindows(p, isDir), `precondition: ${p} made private`).toEqual([]);
}
/** A recording listener on `host`: every request (method, url, headers, body). */
async function recorder(host = "127.0.0.1", handler?: (req: http.IncomingMessage, res: http.ServerResponse) => void, atPort = 0) {
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
  await new Promise<void>((r, j) => {
    server.once("error", j);
    server.listen(atPort, host, () => r());
  });
  const port = (server.address() as { port: number }).port;
  return { port, reqs, bytes: () => reqs.map((q) => `${q.method} ${q.url}\n${JSON.stringify(q.headers)}\n${q.body}`).join("\n") };
}
function relayAsync(c: Case, args: string[], extra: Record<string, string> = {}, input = ""): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return relayWithEnv(baseEnv(c, extra), args, input);
}
function relayWithEnv(env: NodeJS.ProcessEnv, args: string[], input = ""): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RELAY, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
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

/**
 * An INSTANCE relay, as every real install runs it: HOME/.bot-relay/instances/<id>/ (instance.json, config.json),
 * selected by RELAY_INSTANCE_ID, with NO RELAY_DB_PATH. Its daemon's owner record carries instance_id = <id> (an
 * explicit-RELAY_DB_PATH daemon's carries ""), and a verb that pins RELAY_DB_PATH mid-run must still present <id>.
 */
interface InstCase { id: string; home: string; dir: string; db: string; record: string }
function newInstanceCase(tag: string): InstCase {
  const home = fs.mkdtempSync(path.join(ROOT, `${tag}-`));
  const id = crypto.randomUUID();
  const dir = path.join(home, ".bot-relay", "instances", id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "instance.json"), JSON.stringify({ instance_id: id, created_at: new Date().toISOString(), hostname: "test", daemon_version_first_seen: "0.0.0", label: null }), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "config.json"), "{}", { mode: 0o600 });
  return { id, home, dir, db: path.join(dir, "relay.db"), record: path.join(dir, ".relay.db.relay-owner.json") };
}
const instEnv = (c: InstCase, extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const env = sandboxEnv(c.home);
  delete env.RELAY_HOME;
  return { ...env, RELAY_INSTANCE_ID: c.id, RELAY_WAKE_COVERAGE_STATUS_PATH: path.join(c.home, "wc.json"), ...extra };
};
/** Register `names` on the instance's DB and write each token to the instance's VAULT (the product's own token store). */
function seedInstanceVault(c: InstCase, names: string[]): string[] {
  const r = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `const db = await import(${JSON.stringify(DIST_DB)}); const ts = await import(${JSON.stringify(DIST_TOKEN_STORE)});
const toks = ${JSON.stringify(names)}.map((n) => db.registerAgent(n, "r", []).plaintext_token); db.closeDb();
for (const [i, n] of ${JSON.stringify(names)}.entries()) await ts.defaultTokenStore().write(n, toks[i]);
process.stdout.write(JSON.stringify(toks));`],
    { encoding: "utf-8", env: instEnv(c) }
  );
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout.trim()) as string[];
}
async function startInstanceDaemon(c: InstCase): Promise<{ child: ChildProcess; port: number; stderr: () => string }> {
  const port = await getFreePort();
  const child = spawn(process.execPath, [DIST_INDEX], { env: instEnv(c, { RELAY_TRANSPORT: "http", RELAY_HTTP_HOST: "127.0.0.1", RELAY_HTTP_PORT: String(port) }), stdio: ["ignore", "pipe", "pipe"] });
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
  throw new Error(`the instance daemon did not come up with its record (exit ${child.exitCode}):\n${err}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// THE SCAN (every OS): every network client SITE in src/cli/, bin/ and tools/ is CLASSIFIED; a new one fails CI.
// As ruled after #434 R2 (P2-3): JS/TS is read as SYNTAX (the TypeScript parser over the whole file, so a call split
// across lines, a bare `import "node:https"` and a comment are all what they are), not as lines. A code site is: a
// fetch CALL; ANY import / export-from / import-equals / require / dynamic import() of a network module; a dynamic
// import() or require() whose module is not a literal (it could be anything: a dispatcher, listed); a curl/wget
// SUBPROCESS (spawn/exec family with that program). A file's language is its extension or, extensionless, its shebang
// (bin/relay is node). Shell (bin/, tools/) keeps the command-position check for curl/wget.
type Klass = "door-client" | "relay-client" | "port-probe" | "hooks-family" | "dispatch";
const HTTP_REGISTRY: Record<string, Record<string, { n: number; klass: Klass }>> = {
  "src/cli/owner.ts": { net: { n: 1, klass: "door-client" } },
  "src/cli/relay-client.ts": { net: { n: 2, klass: "relay-client" } },
  "src/cli/mint-token.ts": { net: { n: 1, klass: "port-probe" } },
  "src/cli/open.ts": { net: { n: 1, klass: "port-probe" } },
  "src/cli/recover.ts": { net: { n: 1, klass: "port-probe" } },
  // the subcommand dispatcher: import(`../dist/cli/${sub}.js`), whose targets are src/cli/*, scanned here themselves
  "bin/relay": { "import(?)": { n: 1, klass: "dispatch" } },
  "bin/codex-relay": { curl: { n: 2, klass: "hooks-family" } },
};
const NET_MODULE = /^(?:node:)?(?:https?|http2|net|tls|undici|dgram)$/;
const SUBPROC = new Set(["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]);
// curl/wget at a command position followed by an argument (not `route=curl`, `command -v curl` or `= curl ]`).
const SHELL_RE = /(?:^|[\s;|&(!`])(?:curl|wget)\s+[-"'$\w]/g;
function langOf(file: string, src: string): "code" | "shell" | null {
  if (/\.(ts|mts|cts|mjs|js|cjs)$/.test(file)) return "code";
  if (/\.(sh|bash|zsh)$/.test(file)) return "shell";
  if (/^#!.*\bnode\b/.test(src)) return "code";
  if (/^#!.*\b(?:ba|z|da|k)?sh\b/.test(src)) return "shell";
  return null;
}
const calleeName = (e: ts.Expression): string | null => (ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null);
/** Every site in one file, by kind ("fetch", "net", "import(?)", "require(?)", "subprocess", "curl"; "health" = healthGet calls). */
function httpSites(file: string, src: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const lang = langOf(file, src);
  if (!lang) return out;
  if (lang === "shell") {
    src.split("\n").forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith("#")) return;
      for (const _m of line.matchAll(SHELL_RE)) (out.curl ??= []).push(`${file}:${i + 1}: ${t.slice(0, 140)}`);
    });
    return out;
  }
  const sf = ts.createSourceFile(file, src.replace(/^#!.*/, ""), ts.ScriptTarget.Latest, true, /\.(ts|mts|cts)$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const add = (k: string, n: ts.Node) => (out[k] ??= []).push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}: ${n.getText().replace(/\s+/g, " ").slice(0, 140)}`);
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteralLike(n.moduleSpecifier) && NET_MODULE.test(n.moduleSpecifier.text)) add("net", n);
    if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteralLike(n.moduleReference.expression) && NET_MODULE.test(n.moduleReference.expression.text)) add("net", n);
    if (ts.isCallExpression(n)) {
      const a0 = n.arguments[0];
      const name = calleeName(n.expression);
      if (n.expression.kind === ts.SyntaxKind.ImportKeyword || name === "require") {
        const k = name === "require" ? "require(?)" : "import(?)";
        if (!a0 || !ts.isStringLiteralLike(a0)) add(k, n);
        else if (NET_MODULE.test(a0.text)) add("net", n);
      }
      if (name === "fetch") add("fetch", n);
      if (name && SUBPROC.has(name) && a0 && ts.isStringLiteralLike(a0) && /(?:^|[\\/])(?:curl|wget)(?:\.exe)?$/.test(a0.text)) add("subprocess", n);
      if (name === "healthGet" || name === "healthGetHost") add("health", n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
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
/** The tree's sites (health calls kept apart: they are asserted per verb, not registered). */
function scanTree(): { sites: Record<string, Record<string, string[]>>; health: Record<string, number>; scanned: number } {
  const sites: Record<string, Record<string, string[]>> = {};
  const health: Record<string, number> = {};
  let scanned = 0;
  for (const f of [...walk(path.join(REPO, "src", "cli")), ...walk(path.join(REPO, "bin")), ...walk(path.join(REPO, "tools"))]) {
    const rel = path.relative(REPO, f).split(path.sep).join("/");
    const src = fs.readFileSync(f, "utf-8");
    if (langOf(rel, src)) scanned++;
    const { health: h, ...rest } = httpSites(rel, src);
    if (h) health[rel] = h.length;
    if (Object.keys(rest).length > 0) sites[rel] = rest;
  }
  return { sites, health, scanned };
}
/** Where the found sites differ from the registry ([] = every site classified, none stale). */
function registryDiff(sites: Record<string, Record<string, string[]>>): string[] {
  const out: string[] = [];
  const keys = new Set([...Object.keys(sites), ...Object.keys(HTTP_REGISTRY)]);
  for (const f of keys) {
    const kinds = new Set([...Object.keys(sites[f] ?? {}), ...Object.keys(HTTP_REGISTRY[f] ?? {})]);
    for (const k of kinds) {
      const got = sites[f]?.[k]?.length ?? 0;
      const want = HTTP_REGISTRY[f]?.[k]?.n ?? 0;
      if (got !== want) out.push(`${f} ${k}: found ${got}, registered ${want}${got ? ` (${sites[f]![k]!.join(" | ")})` : ""}`);
    }
  }
  return out;
}

describe("PR 4: every HTTP client call site in src/cli, bin and tools is classified (a scan, every OS)", () => {
  it("NEGATIVE CONTROLS (#434 R1 P2-5, R2 P2-3): each forbidden form, ADDED to the real tree, makes the registry check FAIL", () => {
    const { sites } = scanTree();
    expect(registryDiff(sites), "control: the real tree is clean").toEqual([]);
    const forms: Array<[string, string, string]> = [
      ["src/cli/x.ts", 'const r = await fetch(`${base}/mcp`, { headers: { "X-Agent-Token": t } });', "fetch("],
      ["src/cli/x.ts", "const r = await fetch\n  (url, init);", "a fetch split across lines"],
      ["src/cli/x.ts", "const r = await globalThis.fetch(url);", "globalThis.fetch("],
      ["src/cli/x.ts", 'const h = await import(\n  "node:https"\n);\nh.request(o);', "a dynamic import split across lines"],
      ["src/cli/x.ts", 'import "node:https";', "a bare import"],
      ["src/cli/x.ts", 'import type { IncomingMessage } from "http";', "a type-only import (still a network module)"],
      ["src/cli/x.ts", 'export { request } from "node:http";', "a re-export"],
      ["src/cli/x.ts", 'const h = require(\n  "http"\n);', "require split across lines"],
      ["src/cli/x.ts", 'import * as u from "undici";', "undici"],
      ["src/cli/x.ts", "const m = await import(name);", "a dynamic import of a non-literal"],
      ["src/cli/x.ts", 'spawn(\n  "curl",\n  ["-s", url]\n);', "spawn(curl) split across lines"],
      ["src/cli/x.ts", 'execFileSync("/usr/bin/wget", [url]);', "execFile(wget)"],
      ["bin/relay-x", "#!/usr/bin/env node\nfetch(url);", "an extensionless NODE file in bin"],
      ["tools/x.sh", 'curl -fsS "$url"', "a tools/ shell script"],
      ["bin/x", '#!/usr/bin/env bash\nwget -q "$u"', "an extensionless shell file, wget"],
    ];
    for (const [file, src, what] of forms) {
      const planted = { ...sites, [file]: httpSites(file, src) };
      expect(registryDiff(planted).length, `${what}: the registry check must FAIL`).toBeGreaterThan(0);
    }
    for (const [file, src, what] of [
      ["bin/x", '#!/bin/sh\ncommand -v curl >/dev/null && route=curl', "a shell mention, not an invocation"],
      ["src/cli/x.ts", "// fetch(url)\n/* import(\"node:https\") */ const s = \"fetch(x)\";", "comments and strings"],
    ] as const) {
      expect(registryDiff({ ...sites, [file]: httpSites(file, src) }), `${what}: not a site`).toEqual([]);
    }
  });

  it("each site is in the registry with its class; no fetch anywhere; every health probe is a healthGet CALL; port probes write nothing; the credential verbs use relay-client", () => {
    const { sites, health, scanned } = scanTree();
    expect(scanned, "precondition: the scan reads the CLI, bin and tools").toBeGreaterThan(30);
    expect(langOf("bin/relay", fs.readFileSync(path.join(REPO, "bin", "relay"), "utf-8")), "precondition: bin/relay is read as code").toBe("code");
    expect(registryDiff(sites), "every site classified").toEqual([]);
    for (const [f, ps] of Object.entries(HTTP_REGISTRY)) {
      if (ps.net?.klass !== "port-probe") continue;
      const src = fs.readFileSync(path.join(REPO, f), "utf-8");
      expect(src, `${f}: a port probe only connects (it writes nothing to the socket)`).not.toMatch(/\b(?:sock|socket|s|conn)\.(?:write|end)\s*\(\s*[^)\s]/);
    }
    // a CALL node, never a comment: R2 found the old text match satisfied by comments alone
    expect(httpSites("src/cli/x.ts", "// healthGet(t)\nconst s = 'healthGetHost(h)';").health ?? [], "control: comments and strings are no call").toEqual([]);
    for (const f of ["doctor.ts", "init.ts", "watch.ts", "test.ts", "pair.ts"]) {
      expect(health[`src/cli/${f}`] ?? 0, `${f}'s health probe is a healthGet / healthGetHost CALL`).toBeGreaterThan(0);
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
    // The id from the send's own --json envelope (the DB is never copied while the daemon holds it: its WAL is live).
    const sent = JSON.parse(s.stdout.trim()) as { message_id?: string };
    expect(typeof sent.message_id, `the message landed: ${s.stdout}`).toBe("string");
    const id = sent.message_id!;
    const r = await relayAsync(c, ["resolve", id, "--agent", "pr4-peer", "--json"], { ...env, RELAY_AGENT_TOKEN: peerTok });
    expect(r.status, `resolve: ${r.stderr}`).toBe(0);
    expect((JSON.parse(r.stdout.trim()) as { resolved_ids?: string[] }).resolved_ids, "the recipient resolved exactly that message").toEqual([id]);
    for (const t of [token, peerTok]) expect(spy.bytes(), "no credential to the configured port").not.toContain(t);
    expect(spy.reqs.filter((q) => q.url !== "/health"), "nothing but /health at the configured port").toEqual([]);
    await stopDaemon(d.child);
  }, 120_000);

  it("an INSTANCE daemon + VAULT tokens (no RELAY_AGENT_TOKEN, no RELAY_DB_PATH): `relay send` and `relay resolve` go through the door", async () => {
    // What every agent's CLI fallback does on a real install. The row above uses an explicit RELAY_DB_PATH daemon and an
    // env token, so it never meets the vault branch, which pins RELAY_DB_PATH before the door call.
    const c = newInstanceCase("cli-inst-vault");
    const [senderTok, peerTok] = seedInstanceVault(c, [AGENT, "pr4-peer"]);
    for (const n of [AGENT, "pr4-peer"]) expect(fs.existsSync(path.join(c.dir, "agents", `${n}.token`)), `precondition: ${n}'s token is in the instance vault`).toBe(true);
    const d = await startInstanceDaemon(c);
    expect(readRecord({ record: c.record } as Case).instance_id, "precondition: the record is bound to the INSTANCE (not \"\")").toBe(c.id);
    const spy = await recorder();
    const env = instEnv(c, { RELAY_HTTP_HOST: "127.0.0.1", RELAY_HTTP_PORT: String(spy.port) });
    expect(env.RELAY_AGENT_TOKEN === undefined && env.RELAY_DB_PATH === undefined, "precondition: no env token, no explicit DB").toBe(true);
    const s = await relayWithEnv(env, ["send", "pr4-peer", "pr4 instance vault hello", "--from", AGENT, "--json"]);
    expect(s.stderr, "no bound-elsewhere refusal").not.toContain("bound-elsewhere");
    expect(s.status, `send: ${s.stderr}`).toBe(0);
    const id = (JSON.parse(s.stdout.trim()) as { message_id?: string }).message_id;
    expect(typeof id, `the message landed: ${s.stdout}`).toBe("string");
    const r = await relayWithEnv(env, ["resolve", id!, "--agent", "pr4-peer", "--json"]);
    expect(r.stderr, "no bound-elsewhere refusal").not.toContain("bound-elsewhere");
    expect(r.status, `resolve: ${r.stderr}`).toBe(0);
    expect((JSON.parse(r.stdout.trim()) as { resolved_ids?: string[] }).resolved_ids, "the recipient resolved exactly that message").toEqual([id]);
    for (const t of [senderTok, peerTok]) expect(spy.bytes(), "neither token reaches the configured port").not.toContain(t);
    expect(spy.reqs.filter((q) => q.url !== "/health"), "nothing but /health at the configured port").toEqual([]);
    // #438 R1 P3-2: an allowed probe is a bare GET /health: no body, no credential header.
    for (const q of spy.reqs) {
      expect(q.method, "a health probe is a GET").toBe("GET");
      expect(q.body, "a health probe has no body").toBe("");
      for (const h of ["authorization", "x-agent-token", "x-relay-secret", "cookie", "proxy-authorization"]) expect(q.headers[h], `a health probe carries no ${h} header`).toBeUndefined();
    }
    await stopDaemon(d.child);
  }, 120_000);

  it("the INSTANCE identity survives a REPEATED pin: pinResolvedDbPath twice in one process, then a door call → not refused (bound-elsewhere)", async () => {
    // A second pin with the environment unchanged reads the FIRST pin's RELAY_DB_PATH (the explicit kind); it must not
    // replace the instance the first pin resolved, or the door call presents "" against the instance's record.
    const c = newInstanceCase("cli-inst-repin");
    const [tok] = seedInstanceVault(c, [AGENT]);
    const d = await startInstanceDaemon(c);
    expect(readRecord({ record: c.record } as Case).instance_id, "precondition: the record is bound to the INSTANCE").toBe(c.id);
    const pin = pathToFileURL(path.join(REPO, "dist", "cli", "_instance-db.js")).href;
    const client = pathToFileURL(path.join(REPO, "dist", "cli", "relay-client.js")).href;
    const script = `const { pinResolvedDbPath } = await import(${JSON.stringify(pin)}); const { localTool } = await import(${JSON.stringify(client)});
for (const i of [1, 2]) { const fault = await pinResolvedDbPath(); if (fault) { process.stdout.write(JSON.stringify({ pin: i, fault })); process.exit(0); } }
try { const r = await localTool("health_check", {}, { agentToken: process.env.T }); process.stdout.write(JSON.stringify({ ok: r.isError !== true })); }
catch (e) { process.stdout.write(JSON.stringify({ error: e.message })); }`;
    const out = await new Promise<string>((resolve) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: instEnv(c, { T: tok }), stdio: ["ignore", "pipe", "pipe"] });
      procs.push(child);
      let so = "";
      child.stdout!.on("data", (b: Buffer) => (so += b));
      child.once("close", () => resolve(so.trim()));
    });
    expect(out, "a door call after two pins").not.toContain("bound-elsewhere");
    expect(JSON.parse(out), "the door answered health_check").toEqual({ ok: true });
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
    const p = await relayAsync(c, ["pair", `http://127.0.0.1:${spy.port}`, "--name", "pr4-pair", "--yes", "--output", path.join(c.home, "pair-loop.json"), "--secret-stdin"], {}, "pr4-hub-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n");
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

// ---------------------------------------------------------------------------------------------------------------------
// As ruled on #434's defaults: the token for a remote; per-remote transport secrets; pair through a tunnel; a two-way
// allowlist.
describe("#434 rulings: per-remote credentials (every OS)", () => {
  it("RELAY_AGENT_TOKEN is honoured for a remote ONLY when the environment selected that remote; otherwise only the remote's own vault entry", async () => {
    const c = newCase("remote-token-rule");
    seedNativeDb(c);
    const scoped = path.join(path.dirname(c.db), "agents", "remote-203.0.113.10-3777");
    fs.mkdirSync(scoped, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(scoped, `${AGENT}.token`), "pr4-the-remotes-own-token-aaaaaaaa\n", { mode: 0o600 });
    await privatize([path.dirname(scoped), true], [scoped, true], [path.join(scoped, `${AGENT}.token`), false]);
    const probe = path.join(c.home, "probe.mjs");
    fs.writeFileSync(probe, `const m = await import(${JSON.stringify(pathToFileURL(path.join(REPO, "dist", "cli", "relay-client.js")).href)});
process.stdout.write(JSON.stringify({ selected: await m.remoteToken("203.0.113.10", 3777, ${JSON.stringify(AGENT)}, { envSelected: true }), other: await m.remoteToken("203.0.113.10", 3777, ${JSON.stringify(AGENT)}, { envSelected: false }) }));`);
    const r = spawnSync(process.execPath, [probe], { env: baseEnv(c, { RELAY_AGENT_TOKEN: "pr4-a-local-launcher-token-aaaaaa" }), encoding: "utf-8" });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout), "env-selected → the env token; a flag-chosen remote → its own vault entry, never the env token").toEqual({ selected: "pr4-a-local-launcher-token-aaaaaa", other: "pr4-the-remotes-own-token-aaaaaaaa" });
  }, 60_000);

  it("a remote's TRANSPORT secret: its own provisioned file (relay remote set-http-secret / set-dashboard-secret, stdin), or the environment; never this machine's config", async () => {
    const c = newCase("remote-secret-rule");
    seedNativeDb(c);
    fs.writeFileSync(c.cfg, JSON.stringify({ http_secret: `pr4-local-config-secret-${"z".repeat(24)}` }), { mode: 0o600 });
    const httpSecret = `pr4-remote-http-secret-${crypto.randomBytes(12).toString("hex")}`;
    const set = spawnSync(process.execPath, [RELAY, "remote", "set-http-secret", "203.0.113.10:3777"], { env: baseEnv(c), input: `${httpSecret}\n`, encoding: "utf-8" });
    expect(set.status, set.stderr).toBe(0);
    const dashSecret = `pr4-remote-dash-secret-${crypto.randomBytes(12).toString("hex")}`;
    const setD = spawnSync(process.execPath, [RELAY, "remote", "set-dashboard-secret", "203.0.113.10:3777"], { env: baseEnv(c), input: `${dashSecret}\n`, encoding: "utf-8" });
    expect(setD.status, setD.stderr).toBe(0);
    const probe = path.join(c.home, "probe-secret.mjs");
    fs.writeFileSync(probe, `const m = await import(${JSON.stringify(pathToFileURL(path.join(REPO, "dist", "cli", "relay-client.js")).href)});
process.stdout.write(JSON.stringify({ file: await m.remoteSecret("203.0.113.10", 3777, "http"), dash: await m.remoteSecret("203.0.113.10", 3777, "dashboard"), none: await m.remoteSecret("203.0.113.11", 3777, "http") }));`);
    const r = spawnSync(process.execPath, [probe], { env: baseEnv(c), encoding: "utf-8" });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout), "the provisioned file; no file and no env → none (never the local config)").toEqual({ file: httpSecret, dash: dashSecret, none: null });
  }, 60_000);

  it("THE ALLOWLIST, both ways: every tool a verb sends through the door is on it, and every entry is used by some verb", async () => {
    const { OWNER_DOOR_TOOL_ALLOWLIST } = (await import("../src/owner-endpoint.js")) as { OWNER_DOOR_TOOL_ALLOWLIST: ReadonlySet<string> };
    const used = new Set<string>();
    for (const f of fs.readdirSync(path.join(REPO, "src", "cli")).filter((x) => x.endsWith(".ts"))) {
      const src = fs.readFileSync(path.join(REPO, "src", "cli", f), "utf-8");
      for (const m of src.matchAll(/localTool\(\s*"([a-z_]+)"/g)) used.add(m[1]!);
      // the self-test's rpc() wrapper names its tools at its call sites
      if (f === "test.ts") for (const m of src.matchAll(/rpc\(\s*"([a-z_]+)"/g)) used.add(m[1]!);
    }
    expect(used.size, "precondition: the scan sees the verbs' door calls").toBeGreaterThanOrEqual(4);
    expect([...used].filter((t) => !OWNER_DOOR_TOOL_ALLOWLIST.has(t)), "every door call is allowlisted").toEqual([]);
    expect([...OWNER_DOOR_TOOL_ALLOWLIST].filter((t) => !used.has(t)), "every allowlist entry is used by some verb").toEqual([]);
  });
});

describe("#434 rulings: pair through a trusted tunnel", () => {
  it("a loopback hub WITH RELAY_HTTP_TRUSTED_TUNNEL_PORT equal to its port is a tunnel: pair proceeds to it (not the loopback refusal); a different port is still refused", async () => {
    const c = newCase("pair-tunnel");
    seedNativeDb(c);
    const hub = await recorder();
    const out = path.join(c.home, "pair-out.json");
    const yes = await relayAsync(c, ["pair", `http://127.0.0.1:${hub.port}`, "--name", "pr4-tunnel-pair", "--yes", "--output", out, "--secret-stdin"], { RELAY_HTTP_TRUSTED_TUNNEL_PORT: String(hub.port) }, "pr4-hub-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n");
    expect(yes.stderr, "not refused as a loopback hub").not.toMatch(/pair is for a remote hub/);
    expect(hub.reqs.length, `the tunnel hub was reached\n${yes.stderr}`).toBeGreaterThan(0);
    const hub2 = await recorder();
    const no = await relayAsync(c, ["pair", `http://127.0.0.1:${hub2.port}`, "--name", "pr4-tunnel-pair2", "--yes", "--output", `${out}.2`, "--secret-stdin"], { RELAY_HTTP_TRUSTED_TUNNEL_PORT: String(hub2.port + 1) }, "pr4-hub-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n");
    expect(no.stderr).toMatch(/pair is for a remote hub/);
    expect(hub2.reqs, "a mismatched opt-in reaches nothing").toEqual([]);
  }, 120_000);
});

describe("#434 rulings: the SELF-PAIR guard (a correctness check)", () => {
  it("the tunnel opt-in port == a VALID local owner record's port → refused by name ('this machine's own relay, not a hub'), no register reaches it", async () => {
    const c = newCase("pair-self");
    seedNativeDb(c);
    const d = await startDaemon(c);
    const rec = readRecord(c);
    const out = path.join(c.home, "pair-self.json");
    const r = await relayAsync(c, ["pair", `http://127.0.0.1:${rec.port}`, "--name", "pr4-self-pair", "--yes", "--output", out, "--secret-stdin"], { RELAY_HTTP_TRUSTED_TUNNEL_PORT: String(rec.port) }, "pr4-hub-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(new RegExp(`127\\.0\\.0\\.1:${rec.port} is this machine's own relay, not a hub`));
    expect(fs.existsSync(out), "nothing written").toBe(false);
    await stopDaemon(d.child);
    const agents = (await dbDump(c)).agents ?? [];
    const cols = (agents[0] ?? []) as string[];
    expect(agents.slice(1).some((x) => x[cols.indexOf("name")] === "pr4-self-pair"), "no registration on the local relay").toBe(false);
  }, 120_000);
});

describe.skipIf(LAN_V4 === null)("#434 rulings: a flag-chosen remote never gets the launcher's RELAY_AGENT_TOKEN (a LAN address; skipped by name where the runner has none)", () => {
  it("RELAY_AGENT_TOKEN set (a LOCAL relay's), no RELAY_HTTP_HOST, `relay doctor --remote http://<LAN>:<port>` → zero bytes of that token at the remote", async () => {
    const c = newCase("doctor-flag-remote");
    seedNativeDb(c);
    const remote = await recorder(LAN_V4!);
    const localTok = "pr4-a-local-launcher-token-bbbbbb";
    await relayAsync(c, ["doctor", "--remote", `http://${LAN_V4}:${remote.port}`], { RELAY_AGENT_TOKEN: localTok });
    expect(remote.reqs.length, "precondition: the remote was probed").toBeGreaterThan(0);
    expect(remote.bytes(), "the launcher's token never reaches a flag-chosen remote").not.toContain(localTok);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------------------------------
// #434 Codex R1 (each RED from the review's own inputs).
const DIST_CLIENT = pathToFileURL(path.join(REPO, "dist", "cli", "relay-client.js")).href;
/** A probe module run as its own process (async: the daemon and the recorders stay responsive). */
function probeAsync(c: Case, body: string, extra: Record<string, string> = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const file = path.join(c.home, `probe-${crypto.randomBytes(4).toString("hex")}.mjs`);
  fs.writeFileSync(file, `const m = await import(${JSON.stringify(DIST_CLIENT)});\n${body}`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { env: baseEnv(c, extra), stdio: ["ignore", "pipe", "pipe"] });
    procs.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d: Buffer) => (stdout += d));
    child.stderr!.on("data", (d: Buffer) => (stderr += d));
    const t = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.once("close", (status) => {
      clearTimeout(t);
      resolve({ status, stdout, stderr });
    });
  });
}
/** Can this runner bind ::1? (a v6 loopback); decided once. */
const V6_LOOPBACK: boolean = await new Promise((resolve) => {
  const s = http.createServer();
  s.once("error", () => resolve(false));
  s.listen(0, "::1", () => s.close(() => resolve(true)));
});

describe.skipIf(!V6_LOOPBACK)("#434 R1 P1: an IPv6 tunnel: EVERY pair request goes to the checked address (skipped by name where ::1 cannot be bound)", () => {
  it("`pair http://[::1]:PORT` + the opt-in, with ANOTHER listener on 127.0.0.1:PORT → the v4 listener gets ZERO bytes; ::1 gets /health and /mcp; Host is bracketed", async () => {
    const c = newCase("pair-v6");
    let v6: Awaited<ReturnType<typeof recorder>> | null = null;
    let v4: Awaited<ReturnType<typeof recorder>> | null = null;
    for (let i = 0; i < 10 && !v4; i++) {
      v6 = await recorder("::1");
      v4 = await recorder("127.0.0.1", undefined, v6.port).catch(() => null);
    }
    expect(v4, "precondition: two listeners on one port (::1 and 127.0.0.1)").not.toBeNull();
    const secret = "pr4-v6-hub-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const r = await relayAsync(c, ["pair", `http://[::1]:${v6!.port}`, "--name", "pr4-v6-pair", "--yes", "--output", path.join(c.home, "o.json"), "--secret-stdin"], { RELAY_HTTP_TRUSTED_TUNNEL_PORT: String(v6!.port) }, `${secret}\n`);
    expect(v4!.reqs, `the IPv4 listener received nothing\n${r.stderr}`).toEqual([]);
    expect(v6!.reqs.map((q) => `${q.method} ${q.url}`), `::1 got the probe and the register\n${r.stderr}`).toEqual(["GET /health", "POST /mcp"]);
    for (const q of v6!.reqs) expect(q.headers.host, "an IPv6 literal is bracketed in Host").toBe(`[::1]:${v6!.port}`);
  }, 120_000);
});

describe("#434 R1 P2-2: the remote client's deadline is ABSOLUTE, and cancellable", () => {
  it("a server sending one byte every 30 ms against a 70 ms deadline → aborted near the deadline (not completed); an AbortSignal cancels it too", async () => {
    const dribble = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      let n = 0;
      const t = setInterval(() => {
        res.write("x");
        if (++n > 60) {
          clearInterval(t);
          res.end();
        }
      }, 30);
      res.on("close", () => clearInterval(t));
    });
    servers.push(dribble);
    await new Promise<void>((r) => dribble.listen(0, "127.0.0.1", () => r()));
    const port = (dribble.address() as { port: number }).port;
    const c = newCase("deadline");
    const r = await probeAsync(c, `const t = { host: "127.0.0.1", ip: "127.0.0.1", port: ${port}, secure: false };
const time = async (f) => { const s = Date.now(); try { await f(); return { ok: true, ms: Date.now() - s }; } catch (e) { return { ok: false, ms: Date.now() - s, why: String(e.message) }; } };
const deadline = await time(() => m.remotePost(t, "/mcp", {}, "{}", 70));
const ac = new AbortController(); setTimeout(() => ac.abort(), 60);
const aborted = await time(() => m.remotePost(t, "/mcp", {}, "{}", 10000, ac.signal));
process.stdout.write(JSON.stringify({ deadline, aborted }));`);
    expect(r.status, r.stderr).toBe(0);
    const o = JSON.parse(r.stdout) as Record<string, { ok: boolean; ms: number; why?: string }>;
    expect(o.deadline!.ok, `the 70 ms deadline aborts a dribbling reply (${JSON.stringify(o.deadline)})`).toBe(false);
    expect(o.deadline!.ms, "aborted near the deadline").toBeLessThan(1000);
    expect(o.aborted!.ok, `an abort signal cancels it (${JSON.stringify(o.aborted)})`).toBe(false);
    expect(o.aborted!.ms).toBeLessThan(1000);
  }, 60_000);
});

describe("#434 R1 P2-3: a boundary-size message goes through the door", () => {
  it("send_message with content at RELAY_MAX_PAYLOAD_BYTES of worst-case JSON escaping (control bytes) succeeds through the door; one byte over is the HANDLER's named refusal, not a door 413", async () => {
    const c = newCase("door-size");
    const token = seedNativeDb(c);
    registerExtra(c, "pr4-big-peer");
    const d = await startDaemon(c);
    const r = await probeAsync(c, `const tok = ${JSON.stringify(token)};
const send = async (n) => { try { const res = await m.localTool("send_message", { from: ${JSON.stringify(AGENT)}, to: "pr4-big-peer", content: "\\u0001".repeat(n) }, { agentToken: tok }, { timeoutMs: 30000 }); return { ok: true, j: m.toolJson(res) }; } catch (e) { return { ok: false, why: String(e.message) }; } };
process.stdout.write(JSON.stringify({ at: await send(65536), over: await send(65537) }));`);
    await stopDaemon(d.child);
    expect(r.status, r.stderr).toBe(0);
    const o = JSON.parse(r.stdout) as { at: { ok: boolean; j?: { success?: boolean; message_id?: string }; why?: string }; over: { ok: boolean; j?: { success?: boolean; error?: string }; why?: string } };
    expect(o.at.ok && o.at.j?.success === true && typeof o.at.j?.message_id === "string", `the boundary-size message lands (${JSON.stringify(o.at).slice(0, 300)})`).toBe(true);
    expect(o.over.ok, `over the limit the door still delivers the call (${JSON.stringify(o.over).slice(0, 300)})`).toBe(true);
    expect(JSON.stringify(o.over.j), "the handler's own payload refusal").toMatch(/RELAY_MAX_PAYLOAD_BYTES/);
  }, 120_000);
});

describe("#434 R1 P2-4: a remote's credential files are read through a trusted chain", () => {
  const linkDir = (target: string, link: string) => fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  const scopeOf = (c: Case, host: string) => path.join(c.dir, "agents", `remote-${host}-3777`);
  const putToken = async (dir: string, tok: string) => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, `${AGENT}.token`), `${tok}\n`, { mode: 0o600 });
    await privatize([path.dirname(dir), true], [dir, true], [path.join(dir, `${AGENT}.token`), false]);
  };
  const ask = (c: Case, host: string) => probeAsync(c, `process.stdout.write(JSON.stringify({ tok: await m.remoteToken(${JSON.stringify(host)}, 3777, ${JSON.stringify(AGENT)}, { envSelected: false }) }));`);

  it("control: a private scope → its token; a scope that is a LINK to the local agents dir → nothing (the local token is never read); a link to ANOTHER remote's scope → refused", async () => {
    const c = newCase("scope-chain");
    seedNativeDb(c);
    await putToken(scopeOf(c, "203.0.113.10"), "pr4-remote-a-own-token-aaaaaaaa");
    const ok = await ask(c, "203.0.113.10");
    expect(JSON.parse(ok.stdout || "{}").tok, `control: a private scope's token (${ok.stderr})`).toBe("pr4-remote-a-own-token-aaaaaaaa");
    // the local vault: agents/<agent>.token; remote-203.0.113.20 → a link to agents/ itself
    fs.writeFileSync(path.join(c.dir, "agents", `${AGENT}.token`), "pr4-the-LOCAL-token-aaaaaaaaaaaa\n", { mode: 0o600 });
    linkDir(path.join(c.dir, "agents"), scopeOf(c, "203.0.113.20"));
    const viaLocal = await ask(c, "203.0.113.20");
    expect(JSON.parse(viaLocal.stdout || "{}").tok ?? null, "a scope linked to the local vault yields nothing").toBeNull();
    expect(viaLocal.stderr, "named").toMatch(/link|not a real directory|refus/i);
    linkDir(scopeOf(c, "203.0.113.10"), scopeOf(c, "203.0.113.30"));
    const cross = await ask(c, "203.0.113.30");
    expect(JSON.parse(cross.stdout || "{}").tok ?? null, "a scope linked to another remote's yields nothing").toBeNull();
  }, 60_000);

  it("the scope directory REPLACED between the check and the read → refused (no decoy token is returned)", async () => {
    const c = newCase("scope-swap");
    seedNativeDb(c);
    const scope = scopeOf(c, "203.0.113.10");
    await putToken(scope, "pr4-remote-a-own-token-aaaaaaaa");
    const decoy = path.join(c.dir, "agents", "decoy");
    await putToken(decoy, "pr4-a-planted-decoy-token-aaaaaa");
    const r = await probeAsync(c, `const { renameSync } = await import("node:fs");
m._setScopeReadHookForTests(() => { renameSync(${JSON.stringify(scope)}, ${JSON.stringify(scope + ".orig")}); renameSync(${JSON.stringify(decoy)}, ${JSON.stringify(scope)}); });
process.stdout.write(JSON.stringify({ tok: await m.remoteToken("203.0.113.10", 3777, ${JSON.stringify(AGENT)}, { envSelected: false }) }));`);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).tok ?? null, "a swapped scope is refused").toBeNull();
    expect(r.stderr).toMatch(/replaced|changed/i);
  }, 60_000);

  it.skipIf(process.platform !== "win32")("WINDOWS, an inheritable foreign ACE (Everyone RX) on a remote's scope → its token is refused, named, nothing returned", async () => {
    const c = newCase("scope-acl");
    seedNativeDb(c);
    const scope = scopeOf(c, "203.0.113.10");
    await putToken(scope, "pr4-remote-a-own-token-aaaaaaaa");
    const okFirst = await ask(c, "203.0.113.10");
    expect(JSON.parse(okFirst.stdout || "{}").tok, `control: the private scope's token (${okFirst.stderr})`).toBe("pr4-remote-a-own-token-aaaaaaaa");
    const g = spawnSync("icacls", [scope, "/grant", "*S-1-1-0:(OI)(CI)(RX)"], { encoding: "utf-8" });
    expect(g.status, `precondition: the foreign ACE was granted: ${g.stdout}${g.stderr}`).toBe(0);
    const r = await ask(c, "203.0.113.10");
    expect(JSON.parse(r.stdout || "{}").tok ?? null, "a scope other accounts can read yields nothing").toBeNull();
    expect(r.stderr, "named").toMatch(/refusing the remote credential/);
  }, 60_000);

  it.skipIf(process.platform === "win32")("POSIX, a scope readable by others, or a token file readable by others → refused, named", async () => {
    const c = newCase("scope-priv");
    seedNativeDb(c);
    const scope = scopeOf(c, "203.0.113.10");
    await putToken(scope, "pr4-remote-a-own-token-aaaaaaaa");
    fs.chmodSync(path.join(scope, `${AGENT}.token`), 0o644);
    const file = await ask(c, "203.0.113.10");
    expect(JSON.parse(file.stdout || "{}").tok ?? null).toBeNull();
    expect(file.stderr).toMatch(/mode|private/i);
    fs.chmodSync(path.join(scope, `${AGENT}.token`), 0o600);
    fs.chmodSync(scope, 0o755);
    const dir = await ask(c, "203.0.113.10");
    expect(JSON.parse(dir.stdout || "{}").tok ?? null).toBeNull();
    expect(dir.stderr).toMatch(/mode|private/i);
  }, 60_000);
});

describe("#434 R1 P2-5: every health probe is credential-free BY RECORDING", () => {
  it("healthGet sends only GET /health with no credential header, though the environment holds a token and both secrets; `relay doctor` against a recorder sends only that", async () => {
    const c = newCase("health-rec");
    seedNativeDb(c);
    fs.writeFileSync(c.cfg, JSON.stringify({ http_secret: `pr4-config-http-secret-${"q".repeat(24)}` }), { mode: 0o600 });
    const creds = { RELAY_AGENT_TOKEN: "pr4-env-agent-token-aaaaaaaaaaaa", RELAY_HTTP_SECRET: `pr4-env-http-secret-${"w".repeat(24)}`, RELAY_DASHBOARD_SECRET: `pr4-env-dash-secret-${"e".repeat(24)}` };
    const rec = await recorder();
    const r = await probeAsync(c, `const h = await m.healthGet({ host: "127.0.0.1", ip: "127.0.0.1", port: ${rec.port}, secure: false }, 5000); process.stdout.write(JSON.stringify({ status: h.status }));`, creds);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).status).toBe(200);
    expect(m_parseHeaders(rec.reqs), "healthGet: GET /health with only transport headers").toEqual(["GET /health connection,host"]);
    const rec2 = await recorder();
    await relayAsync(c, ["doctor"], { ...creds, RELAY_HTTP_HOST: "127.0.0.1", RELAY_HTTP_PORT: String(rec2.port) });
    expect(rec2.reqs.length, "precondition: doctor probed the configured port").toBeGreaterThan(0);
    expect(rec2.reqs.every((q) => q.method === "GET" && q.url === "/health"), `doctor sends only GET /health there (${rec2.reqs.map((q) => q.url)})`).toBe(true);
    for (const v of [...Object.values(creds), `pr4-config-http-secret-${"q".repeat(24)}`]) {
      expect(rec.bytes() + rec2.bytes(), "no credential in any health probe").not.toContain(v);
    }
  }, 120_000);
});
/** "METHOD /url header,names" per request (sorted names; the transport's own: host, connection). */
function m_parseHeaders(reqs: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders }>): string[] {
  return reqs.map((q) => `${q.method} ${q.url} ${Object.keys(q.headers).sort().join(",")}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// #434 Codex R2 (each RED from the review's own inputs).
const DIST_OWNER = pathToFileURL(path.join(REPO, "dist", "cli", "owner.js")).href;
/** A listener that answers 200 and then trickles one byte every 30 ms for `secs` (a stale owner port, a slow thief). */
async function trickler(secs = 40, host = "127.0.0.1", atPort = 0) {
  const s = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    let n = 0;
    const t = setInterval(() => {
      res.write("x");
      if (++n > (secs * 1000) / 30) {
        clearInterval(t);
        res.end();
      }
    }, 30);
    res.on("close", () => clearInterval(t));
  });
  servers.push(s);
  await new Promise<void>((r, j) => {
    s.once("error", j);
    s.listen(atPort, host, () => r());
  });
  return (s.address() as { port: number }).port;
}

describe("#434 R2 P2-2: the owner door's deadline is ABSOLUTE (send, resolve, doctor's local token check)", () => {
  it("doorExchange and localTool with a 70 ms deadline against a 30 ms trickle → rejected near 70 ms, not when the reply ends", async () => {
    const c = newCase("door-deadline");
    const token = seedNativeDb(c);
    const d = await startDaemon(c);
    const port = await trickler();
    // the record now names the trickler's port (a stale record / a thief on the port): the door client must give up on time
    fs.writeFileSync(c.record, JSON.stringify({ ...readRecord(c), port }), { mode: 0o600 });
    const r = await probeAsync(c, `const o = await import(${JSON.stringify(DIST_OWNER)});
const rec = JSON.parse((await import("node:fs")).readFileSync(${JSON.stringify(c.record)}, "utf-8"));
const time = async (f) => { const s = Date.now(); try { await f(); return { ok: true, ms: Date.now() - s }; } catch (e) { return { ok: false, ms: Date.now() - s, why: String(e.message) }; } };
const exchange = await time(() => o.doorExchange(rec.port, rec.key, { instance_id: rec.instance_id, db_path: rec.db_path }, "/owner/v1/tool", { agent_name: "x", args: {} }, Date.now() + 70));
const out = { exchange };
for (const tool of ["send_message", "resolve_messages", "health_check"]) out[tool] = await time(() => m.localTool(tool, {}, { agentToken: ${JSON.stringify(token)} }, { timeoutMs: 70 }));
process.stdout.write(JSON.stringify(out));`);
    await stopDaemon(d.child);
    expect(r.status, r.stderr).toBe(0);
    const o = JSON.parse(r.stdout) as Record<string, { ok: boolean; ms: number; why?: string }>;
    for (const [k, v] of Object.entries(o)) {
      expect(v.ok, `${k}: rejected (${JSON.stringify(v)})`).toBe(false);
      expect(v.ms, `${k}: near its 70 ms deadline, not the trickle's end (${JSON.stringify(v)})`).toBeLessThan(1000);
    }
  }, 120_000);
});

describe.skipIf(!V6_LOOPBACK)("#434 R2 P2-4: the self-pair guard compares the checked ADDRESS and the port (skipped by name where ::1 cannot be bound)", () => {
  it("an owner on 127.0.0.1:P + a trusted tunnel on [::1]:P → pair proceeds to ::1; `pair http://127.0.0.1:P` (the owner's own address) → refused", async () => {
    const c = newCase("pair-self-v6");
    seedNativeDb(c);
    const d = await startDaemon(c);
    const P = readRecord(c).port;
    const v6 = await recorder("::1", undefined, P).catch(() => null);
    expect(v6, "precondition: a ::1 listener on the owner's port").not.toBeNull();
    const env = { RELAY_HTTP_TRUSTED_TUNNEL_PORT: String(P) };
    const secret = "pr4-v6-hub-secret-bbbbbbbbbbbbbbbbbbbbbbbbbbbb\n";
    const go = await relayAsync(c, ["pair", `http://[::1]:${P}`, "--name", "pr4-v6-self", "--yes", "--output", path.join(c.home, "v6.json"), "--secret-stdin"], env, secret);
    expect(go.stderr, "the ::1 tunnel is not this machine's own relay").not.toMatch(/this machine's own relay/);
    expect(v6!.reqs.map((q) => `${q.method} ${q.url}`), `the ::1 tunnel was paired\n${go.stderr}`).toEqual(["GET /health", "POST /mcp"]);
    const self = await relayAsync(c, ["pair", `http://127.0.0.1:${P}`, "--name", "pr4-v4-self", "--yes", "--output", path.join(c.home, "v4.json"), "--secret-stdin"], env, secret);
    expect(self.stderr).toMatch(new RegExp(`127\\.0\\.0\\.1:${P} is this machine's own relay, not a hub`));
    await stopDaemon(d.child);
  }, 120_000);
});
