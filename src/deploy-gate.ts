// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0048 — the DEPLOY GATE. Run with the NEW build before restarting a daemon
 * onto it: it proves the new instance resolver, fed the environment the restarted
 * daemon will get, names the SAME relay DB the running daemon holds open. If not,
 * the restart would silently move the daemon to a different mailbox.
 *
 * macOS (launchd), every fact from a source with unambiguous boundaries:
 *   1. the environment comes ONLY from `launchctl print gui/<uid>/<label>` (the
 *      loaded job). Never `ps -E`: its entries are space-joined, so a value can
 *      forge a second HOME or hide a hyphenated secret inside HOME;
 *   2. that output is parsed FAIL-CLOSED, on its STRUCTURE: every line must sit
 *      at exactly one tab deeper than the block that holds it, every `}` must
 *      close the block at its own depth, and every line of an environment
 *      section must be `KEY => VALUE`. A forged `}` inside a value (closing a
 *      section early) therefore leaves the real entries at a wrong depth. A
 *      resolver key found ANYWHERE but the plist's own `environment` section
 *      (the inherited or default environment, launchctl setenv, or a block a
 *      forged value opened) is CANNOT-VERIFY, as is a duplicated resolver key, a
 *      second section, or an unterminated block;
 *   3. the plist file (`plutil -extract EnvironmentVariables json`) must carry
 *      the SAME resolver keys as the loaded job, else FAIL "plist changed since
 *      load" (a restart would load the file); a newline in ANY plist value makes
 *      the line-based launchctl rendering ambiguous: CANNOT-VERIFY;
 *   4. daemon identity: the job's pid must be the :PORT listener, and the
 *      snapshot is bound to that process's START TIME;
 *   5. the new resolver (`bin/relay where --json` under ONLY the resolver keys;
 *      HOME absent ⇒ the directory-service home, labeled) must name a DB whose
 *      (device, inode) is among the files that pid holds open (`lsof -F Din`).
 *      Identity, not names: lsof escapes control characters in names, so a name
 *      match can be ambiguous; no filename heuristic either
 *      (RELAY_DB_PATH=/tmp/team.sqlite is a DB like any other);
 *   6. immediately before PASS, everything is observed AGAIN (the job, its pid
 *      and start time, the resolver env, the listener, the open DB): a daemon
 *      that restarted mid-gate (a KeepAlive crash-restart gets a new pid) or
 *      changed in any way is CANNOT-VERIFY.
 * Linux: /proc/<pid>/environ (NUL-delimited) of the listener; with no modelled
 * service manager a match is CANNOT-VERIFY (a restart may load another env), a
 * mismatch is FAIL. Any other platform: CANNOT-VERIFY.
 *
 * Outcomes: PASS (exit 0) · FAIL (1) · CANNOT-VERIFY (3).
 * Secrets: the printed output carries ONLY RESOLVER_ENV_KEYS values; a parse
 * failure names a line NUMBER, never its text.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { RESOLVER_ENV_KEYS } from "./instance.js";

export type GateOutcome = "PASS" | "FAIL" | "CANNOT-VERIFY";
export interface GateResult {
  outcome: GateOutcome;
  reason: string;
  /** Printable facts. Built ONLY from resolver-key values, pids, ports and paths. */
  details: string[];
}
type Ok<T> = ({ ok: true } & T) | { ok: false; error: string };

/** Every system read, injectable so tests never touch the real launchd. */
export interface GateDeps {
  platform: NodeJS.Platform;
  uid: number;
  launchctlPrint(target: string): Ok<{ text: string }>;
  plutilEnv(plistPath: string): Ok<{ json: string }>;
  listenerPids(port: number): Ok<{ pids: number[] }>;
  openFiles(pid: number): Ok<{ files: OpenFile[] }>;
  procEnviron(pid: number): Ok<{ raw: Buffer }>;
  /** The process's start-time token (null when unreadable): binds a pid to ONE incarnation. */
  processStart(pid: number): string | null;
  dsHome(): string;
  runWhere(env: Record<string, string>): { status: number; stdout: string; stderr: string };
  realpath(p: string): string | null;
  /** (device, inode) of a path, following symlinks; null when it cannot be stat'ed. */
  fileId(p: string): FileId | null;
}

export interface FileId {
  dev: bigint;
  ino: bigint;
}
/** One file a process holds: its identity when lsof reports it, and its (display) name. */
export interface OpenFile {
  dev: bigint | null;
  ino: bigint | null;
  name: string;
}

/**
 * Parse `lsof -F Din` output: one record per `f` (file descriptor) field, with
 * `D` (device, hex), `i` (inode, decimal) and `n` (name) fields. Names are for
 * display only: membership uses (dev, ino).
 */
export function parseLsofF(stdout: string): OpenFile[] {
  const files: OpenFile[] = [];
  let cur: OpenFile | null = null;
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const tag = line[0];
    const val = line.slice(1);
    if (tag === "f") {
      cur = { dev: null, ino: null, name: "" };
      files.push(cur);
    } else if (cur && tag === "D") {
      try {
        cur.dev = BigInt(val.startsWith("0x") ? val : `0x${val}`);
      } catch {
        cur.dev = null;
      }
    } else if (cur && tag === "i") {
      cur.ino = /^\d+$/.test(val) ? BigInt(val) : null;
    } else if (cur && tag === "n") {
      cur.name = val;
    }
  }
  return files;
}

export const DEFAULT_LABEL = "com.lumiereventures.bot-relay";
export const DEFAULT_PORT = 3777;
/** Every external command gets this bound (one wait each, all bounded). */
const CMD_TIMEOUT_MS = 10_000;
const RELAY_BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "relay");
const KEYS: ReadonlySet<string> = new Set(RESOLVER_ENV_KEYS);

function cmd(bin: string, args: string[]): Ok<{ stdout: string }> {
  const r = spawnSync(bin, args, { encoding: "utf-8", timeout: CMD_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
  if (r.error) return { ok: false, error: `${bin}: ${r.error.message}` };
  if (r.status !== 0) return { ok: false, error: `${bin} exited ${r.status ?? r.signal}` };
  return { ok: true, stdout: r.stdout };
}

export function defaultGateDeps(): GateDeps {
  return {
    platform: process.platform,
    uid: typeof process.getuid === "function" ? process.getuid() : -1,
    launchctlPrint: (target) => {
      const r = cmd("launchctl", ["print", target]);
      return r.ok ? { ok: true, text: r.stdout } : r;
    },
    plutilEnv: (plistPath) => {
      const r = cmd("plutil", ["-extract", "EnvironmentVariables", "json", "-o", "-", plistPath]);
      return r.ok ? { ok: true, json: r.stdout } : r;
    },
    listenerPids: (port) => {
      const r = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf-8", timeout: CMD_TIMEOUT_MS });
      if (r.error) return { ok: false, error: `lsof: ${r.error.message}` };
      // lsof exits 1 with no output when nothing matches: a positive "none".
      if (r.status !== 0 && r.stdout.trim() !== "") return { ok: false, error: `lsof exited ${r.status}` };
      return { ok: true, pids: [...new Set(r.stdout.split("\n").filter((l) => /^\d+$/.test(l)).map(Number))] };
    },
    openFiles: (pid) => {
      const r = cmd("lsof", ["-nP", "-p", String(pid), "-FDin"]);
      return r.ok ? { ok: true, files: parseLsofF(r.stdout) } : r;
    },
    procEnviron: (pid) => {
      try {
        return { ok: true, raw: fs.readFileSync(`/proc/${pid}/environ`) };
      } catch (err) {
        return { ok: false, error: (err as NodeJS.ErrnoException).code ?? String(err) };
      }
    },
    processStart: (pid) => {
      const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf-8", timeout: CMD_TIMEOUT_MS, env: { ...process.env, LC_ALL: "C" } });
      const out = (r.stdout ?? "").trim();
      return r.status === 0 && out ? out : null;
    },
    dsHome: () => os.userInfo().homedir,
    runWhere: (env) => {
      const r = spawnSync(process.execPath, [RELAY_BIN, "where", "--json"], { encoding: "utf-8", timeout: CMD_TIMEOUT_MS, env });
      return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    realpath: (p) => {
      try {
        return fs.realpathSync.native(p);
      } catch {
        return null;
      }
    },
    fileId: (p) => {
      try {
        const st = fs.statSync(p, { bigint: true });
        return { dev: st.dev, ino: st.ino };
      } catch {
        return null;
      }
    },
  };
}

const ENV_SECTIONS = ["inherited environment", "default environment", "environment"] as const;
type SectionName = (typeof ENV_SECTIONS)[number];
export type LaunchctlParse =
  | {
      ok: true;
      sections: Record<SectionName, Map<string, string[]>>;
      pid: number | null;
      plistPath: string | null;
      state: string | null;
      /** Line numbers of resolver-key entries found anywhere but an environment section. */
      strayResolverKeyLines: number[];
    }
  | { ok: false; error: string };

/**
 * FAIL-CLOSED parse of `launchctl print`, on its STRUCTURE. The output is one
 * outer `<target> = {` block; a line ending in `= {` or `=> {` opens a block at
 * its depth (leading tabs), `}` at the same depth closes it, and every line in a
 * block sits exactly one tab deeper. Empty lines appear only between top-level
 * fields. The environment sections are the top-level blocks named in
 * ENV_SECTIONS; each of their lines must be `KEY => VALUE`. Values are kept as
 * LISTS so a duplicate is visible to the caller. Errors name line numbers only:
 * a line may hold a secret.
 */
export function parseLaunchctlPrint(text: string): LaunchctlParse {
  // The terminating newline ends the last line; it does not start an empty one.
  const lines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  const sections = Object.fromEntries(ENV_SECTIONS.map((s) => [s, new Map<string, string[]>()])) as Record<SectionName, Map<string, string[]>>;
  const seen = new Set<SectionName>();
  const top: Record<string, string[]> = { pid: [], path: [], state: [] };
  const stray: number[] = [];
  if (!/^\S.* = \{$/.test(lines[0] ?? "")) return { ok: false, error: "line 1 is not the `<service> = {` header" };
  const stack: Array<{ depth: number; env: SectionName | null }> = [{ depth: 0, env: null }];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const where = `line ${i + 1}`;
    if (stack.length === 0) {
      if (line === "") continue;
      return { ok: false, error: `${where} follows the closing brace of the output` };
    }
    const block = stack[stack.length - 1];
    if (line === "") {
      if (block.depth !== 0) return { ok: false, error: `${where} is an empty line inside a block` };
      continue;
    }
    const tabs = /^\t*/.exec(line)![0].length;
    const rest = line.slice(tabs);
    if (rest === "}") {
      if (tabs !== block.depth) return { ok: false, error: `${where} closes a block at the wrong depth` };
      stack.pop();
      continue;
    }
    if (tabs !== block.depth + 1) return { ok: false, error: `${where} is at an unexpected depth (a section closed early?)` };
    const entry = /^(\S+) => (.*)$/.exec(rest);
    if (block.env) {
      // A `KEY => {` line would open a nested block: never inside a section.
      if (!entry || /=> \{$/.test(rest)) return { ok: false, error: `${where} of the "${block.env}" section is not \`KEY => VALUE\`` };
      const vals = sections[block.env].get(entry[1]) ?? [];
      vals.push(entry[2]);
      sections[block.env].set(entry[1], vals);
      continue;
    }
    if (entry && KEYS.has(entry[1])) stray.push(i + 1);
    const opener = / (?:=|=>) \{$/.test(rest);
    if (opener) {
      const name = rest.replace(/ (?:=|=>) \{$/, "");
      let env: SectionName | null = null;
      if (tabs === 1 && (ENV_SECTIONS as readonly string[]).includes(name)) {
        env = name as SectionName;
        if (seen.has(env)) return { ok: false, error: `the "${env}" section appears twice (${where})` };
        seen.add(env);
      }
      stack.push({ depth: tabs, env });
      continue;
    }
    if (tabs === 1) {
      const field = /^(pid|path|state) = (.*)$/.exec(rest);
      if (field) top[field[1]].push(field[2]);
    }
  }
  if (stack.length !== 0) {
    const open = stack[stack.length - 1];
    return { ok: false, error: open.env ? `the "${open.env}" section is not terminated` : "a block is not terminated" };
  }
  if (!seen.has("environment")) return { ok: false, error: "no `environment` section (the job's EnvironmentVariables)" };
  for (const k of Object.keys(top)) if (top[k].length > 1) return { ok: false, error: `the top-level "${k}" field appears ${top[k].length} times` };
  const pid = top.pid[0] !== undefined && /^\d+$/.test(top.pid[0]) ? Number(top.pid[0]) : null;
  if (top.pid[0] !== undefined && pid === null) return { ok: false, error: "the pid field is not a number" };
  return { ok: true, sections, pid, plistPath: top.path[0] ?? null, state: top.state[0] ?? null, strayResolverKeyLines: stray };
}

const result = (outcome: GateOutcome, reason: string, details: string[]): GateResult => ({ outcome, reason, details });

/** Is the file `want` identifies among the files `pid` holds open? By (dev, ino), never by name. */
function holds(pid: number, want: FileId, deps: GateDeps): Ok<{ held: boolean; count: number }> {
  const open = deps.openFiles(pid);
  if (!open.ok) return open;
  return { ok: true, held: open.files.some((f) => f.dev === want.dev && f.ino === want.ino), count: open.files.length };
}

/**
 * Step 5 of both platforms: the new resolver under `env`, then membership of its
 * DB among the files `pid` holds open. Returns the matched DB, or the outcome.
 */
function resolveAndMatch(env: Record<string, string>, pid: number, deps: GateDeps, details: string[]): { match: { dbPath: string; id: FileId } } | { outcome: GateResult } {
  const w = deps.runWhere(env);
  let res: { kind?: string; db_path?: string; exists?: boolean; reason?: string } | undefined;
  try {
    res = (JSON.parse(w.stdout) as { resolution?: typeof res }).resolution;
  } catch {
    /* handled below */
  }
  if (!res || typeof res.kind !== "string") {
    return { outcome: result("CANNOT-VERIFY", `the new resolver (relay where --json) gave no parseable result (exit ${w.status})`, details) };
  }
  if (res.kind === "error") {
    return { outcome: result("FAIL", `the NEW resolver fails under the daemon's environment (the new build would refuse to start): ${res.reason}`, details) };
  }
  const dbPath = String(res.db_path);
  details.push(`new resolver: ${res.kind} ${dbPath}${res.exists ? "" : " (does not exist)"}`);
  const id = deps.fileId(dbPath);
  if (!id) return { outcome: result("FAIL", `the new resolver names ${dbPath}, which does not exist: the restart would open a NEW, empty DB`, details) };
  const h = holds(pid, id, deps);
  if (!h.ok) return { outcome: result("CANNOT-VERIFY", `cannot list the files pid ${pid} holds open (${h.error})`, details) };
  if (!h.held) {
    return {
      outcome: result("FAIL", `the new resolver names ${dbPath}, but pid ${pid} does not hold that file open (checked ${h.count} open files by device and inode): the restart would MOVE the daemon to a different DB`, details),
    };
  }
  details.push(`pid ${pid} holds ${dbPath} open (same device and inode)`);
  return { match: { dbPath, id } };
}

/** The resolver keys of one env map, duplicates refused. */
function pickResolverKeys(entries: Map<string, string[]>, where: string): Ok<{ env: Record<string, string> }> {
  const env: Record<string, string> = {};
  for (const [k, vals] of entries) {
    if (!KEYS.has(k)) continue;
    if (vals.length !== 1) return { ok: false, error: `${k} appears ${vals.length} times in ${where}` };
    env[k] = vals[0];
  }
  return { ok: true, env };
}

function printable(env: Record<string, string>, homeFromDs: boolean): string[] {
  const out = RESOLVER_ENV_KEYS.filter((k) => k in env).map((k) => `resolver env: ${k}=${env[k]}${k === "HOME" && homeFromDs ? " (directory-service home: HOME is not in the job environment)" : ""}`);
  return out.length ? out : ["resolver env: (none of the resolver keys is set)"];
}

function sameKeys(a: Record<string, string>, b: Record<string, string>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();
}

function gateLaunchd(opts: { label: string; port: number }, deps: GateDeps): GateResult {
  const target = `gui/${deps.uid}/${opts.label}`;
  const details = [`job: ${target}`];
  const lc = deps.launchctlPrint(target);
  if (!lc.ok) return result("CANNOT-VERIFY", `${target} is not a loaded launchd job (${lc.error})`, details);
  const parsed = parseLaunchctlPrint(lc.text);
  if (!parsed.ok) return result("CANNOT-VERIFY", `launchctl print is not parseable: ${parsed.error}`, details);

  // A resolver key outside the plist's own section (launchctl setenv, the default
  // environment) comes from a channel this gate does not model: never guessed.
  for (const s of ["inherited environment", "default environment"] as const) {
    const stray = RESOLVER_ENV_KEYS.filter((k) => parsed.sections[s].has(k));
    if (stray.length) return result("CANNOT-VERIFY", `${stray.join(", ")} set in the "${s}" (outside the plist; launchctl setenv?): unset it, then bootout/bootstrap`, details);
  }
  if (parsed.strayResolverKeyLines.length) {
    return result("CANNOT-VERIFY", `a resolver variable appears outside the environment sections (line ${parsed.strayResolverKeyLines.join(", ")}): the output cannot be trusted`, details);
  }
  const loaded = pickResolverKeys(parsed.sections.environment, "the job environment");
  if (!loaded.ok) return result("CANNOT-VERIFY", loaded.error, details);

  if (parsed.state !== "running" || parsed.pid === null) {
    return result("CANNOT-VERIFY", `the job is not running (state ${parsed.state ?? "unknown"}): there is no daemon to compare with`, details);
  }
  const pid = parsed.pid;
  const started = deps.processStart(pid);
  if (!started) return result("CANNOT-VERIFY", `cannot read the start time of pid ${pid}: the snapshot cannot be bound to one process`, details);
  details.push(`job pid: ${pid} (started ${started})`);

  if (!parsed.plistPath) return result("CANNOT-VERIFY", "launchctl print names no plist path", details);
  const pl = deps.plutilEnv(parsed.plistPath);
  if (!pl.ok) return result("CANNOT-VERIFY", `cannot read EnvironmentVariables from ${parsed.plistPath} (${pl.error})`, details);
  let plistEnv: unknown;
  try {
    plistEnv = JSON.parse(pl.json);
  } catch {
    return result("CANNOT-VERIFY", `EnvironmentVariables in ${parsed.plistPath} is not valid JSON`, details);
  }
  if (!plistEnv || typeof plistEnv !== "object" || Array.isArray(plistEnv)) {
    return result("CANNOT-VERIFY", `EnvironmentVariables in ${parsed.plistPath} is not a dictionary`, details);
  }
  const plistEntries = Object.entries(plistEnv as Record<string, unknown>);
  if (plistEntries.some(([k, v]) => typeof v !== "string" || /[\r\n]/.test(k) || /[\r\n]/.test(v as string))) {
    return result("CANNOT-VERIFY", `a key or value in ${parsed.plistPath} holds a newline or is not a string: launchctl's line-based rendering is ambiguous`, details);
  }
  const fromPlist: Record<string, string> = {};
  for (const [k, v] of plistEntries) if (KEYS.has(k)) fromPlist[k] = v as string;
  const changed = sameKeys(loaded.env, fromPlist);
  if (changed.length) {
    return result("FAIL", `plist changed since load: bootout/bootstrap first (resolver keys differ: ${changed.join(", ")})`, details);
  }

  const listeners = deps.listenerPids(opts.port);
  if (!listeners.ok) return result("CANNOT-VERIFY", `cannot find the :${opts.port} listener (${listeners.error})`, details);
  if (listeners.pids.length === 0) return result("FAIL", `nothing listens on :${opts.port}: the job's pid ${pid} is not a serving relay daemon`, details);
  if (listeners.pids.length !== 1 || listeners.pids[0] !== pid) {
    return result("FAIL", `the :${opts.port} listener is pid ${listeners.pids.join(", ")}, not the job's pid ${pid}: the daemon's identity is unproven`, details);
  }
  details.push(`listener :${opts.port}: pid ${pid}`);

  // The WASM driver reads the DB into memory: it holds no file open to compare.
  if (parsed.sections.environment.get("RELAY_SQLITE_DRIVER")?.[0] === "wasm") {
    return result("CANNOT-VERIFY", "the job runs the WASM SQLite driver, which holds no DB file open: membership is unobservable", details);
  }

  const env = { ...loaded.env };
  const homeFromDs = !("HOME" in env);
  if (homeFromDs) env.HOME = deps.dsHome();
  details.push(...printable(env, homeFromDs));
  const m = resolveAndMatch(env, pid, deps, details);
  if ("outcome" in m) return m.outcome;

  // Everything above is ONE snapshot of a live system. Observe it all again
  // immediately before PASS: any change means the snapshot is not the daemon
  // the restart replaces (a KeepAlive crash-restart mid-gate gets a new pid).
  const drift = revalidateLaunchd(target, { pid, started, env: loaded.env, port: opts.port, db: m.match.id }, deps);
  if (drift) return result("CANNOT-VERIFY", `the daemon changed during the gate (${drift}): run the gate again`, details);
  details.push("re-validated: same job, pid, start time, resolver env, listener and open DB");
  return result("PASS", "the new resolver names the DB the running daemon holds open", details);
}

/** The second observation before PASS. Returns what changed, or null. */
function revalidateLaunchd(
  target: string,
  was: { pid: number; started: string; env: Record<string, string>; port: number; db: FileId },
  deps: GateDeps,
): string | null {
  const lc = deps.launchctlPrint(target);
  if (!lc.ok) return "the job is no longer loaded";
  const p = parseLaunchctlPrint(lc.text);
  if (!p.ok) return "launchctl print is no longer parseable";
  if (p.state !== "running" || p.pid !== was.pid) return `the job's pid is now ${p.pid ?? "none"}, not ${was.pid}`;
  if (p.strayResolverKeyLines.length || ["inherited environment", "default environment"].some((s) => RESOLVER_ENV_KEYS.some((k) => p.sections[s as SectionName].has(k)))) {
    return "a resolver variable appeared outside the environment section";
  }
  const env = pickResolverKeys(p.sections.environment, "the job environment");
  if (!env.ok || sameKeys(env.env, was.env).length) return "the job's resolver environment changed";
  if (deps.processStart(was.pid) !== was.started) return `pid ${was.pid} has a different start time (a new process)`;
  const l = deps.listenerPids(was.port);
  if (!l.ok || l.pids.length !== 1 || l.pids[0] !== was.pid) return `the :${was.port} listener is no longer pid ${was.pid}`;
  const h = holds(was.pid, was.db, deps);
  if (!h.ok || !h.held) return `pid ${was.pid} no longer holds the DB open`;
  return null;
}

function gateLinux(opts: { label: string; port: number }, deps: GateDeps): GateResult {
  const details: string[] = [];
  const listeners = deps.listenerPids(opts.port);
  if (!listeners.ok) return result("CANNOT-VERIFY", `cannot find the :${opts.port} listener (${listeners.error})`, details);
  if (listeners.pids.length !== 1) return result("FAIL", `expected one :${opts.port} listener, found ${listeners.pids.length}`, details);
  const pid = listeners.pids[0];
  details.push(`listener :${opts.port}: pid ${pid}`);
  const pe = deps.procEnviron(pid);
  if (!pe.ok) return result("CANNOT-VERIFY", `cannot read /proc/${pid}/environ (${pe.error})`, details);
  const entries = new Map<string, string[]>();
  for (const e of pe.raw.toString("utf-8").split("\0")) {
    if (!e) continue;
    const eq = e.indexOf("=");
    if (eq <= 0) continue;
    const k = e.slice(0, eq);
    entries.set(k, [...(entries.get(k) ?? []), e.slice(eq + 1)]);
  }
  const running = pickResolverKeys(entries, `/proc/${pid}/environ`);
  if (!running.ok) return result("CANNOT-VERIFY", running.error, details);
  const env = { ...running.env };
  const homeFromDs = !("HOME" in env);
  if (homeFromDs) env.HOME = deps.dsHome();
  details.push(...printable(env, homeFromDs));
  if (entries.get("RELAY_SQLITE_DRIVER")?.[0] === "wasm") {
    return result("CANNOT-VERIFY", "the daemon runs the WASM SQLite driver, which holds no DB file open: membership is unobservable", details);
  }
  const m = resolveAndMatch(env, pid, deps, details);
  if ("outcome" in m) return m.outcome;
  return result("CANNOT-VERIFY", "the RUNNING environment resolves to the held DB, but no service manager is modelled on Linux: a restart may load a different environment", details);
}

export function runGate(opts: { label: string; port: number }, deps: GateDeps = defaultGateDeps()): GateResult {
  if (deps.platform === "darwin") return gateLaunchd(opts, deps);
  if (deps.platform === "linux") return gateLinux(opts, deps);
  return result("CANNOT-VERIFY", `no deploy gate is modelled for ${deps.platform}`, []);
}

export function formatGate(r: GateResult): { stdout: string; stderr: string; exit: 0 | 1 | 3 } {
  const head = `DEPLOY GATE: ${r.outcome} — ${r.reason}\n`;
  const body = r.details.map((d) => `  ${d}\n`).join("");
  const exit = r.outcome === "PASS" ? 0 : r.outcome === "FAIL" ? 1 : 3;
  return r.outcome === "PASS" ? { stdout: head + body, stderr: "", exit } : { stdout: body, stderr: head, exit };
}
