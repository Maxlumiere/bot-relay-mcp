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
 *   2. that output is parsed FAIL-CLOSED: every line of every environment section
 *      must be `KEY => VALUE`; a duplicated resolver key, a second section, an
 *      unterminated section, or a resolver key set OUTSIDE the plist's own
 *      section (launchctl setenv) is CANNOT-VERIFY;
 *   3. the plist file (`plutil -extract EnvironmentVariables json`) must carry
 *      the SAME resolver keys as the loaded job, else FAIL "plist changed since
 *      load" (a restart would load the file); a newline in ANY plist value makes
 *      the line-based launchctl rendering ambiguous: CANNOT-VERIFY;
 *   4. daemon identity: the job's pid must be the :PORT listener;
 *   5. the new resolver (`bin/relay where --json` under ONLY the resolver keys;
 *      HOME absent ⇒ the directory-service home, labeled) must name a DB whose
 *      real path is among the files that pid holds open (`lsof -p`). No filename
 *      heuristic: RELAY_DB_PATH=/tmp/team.sqlite is a DB like any other.
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
  openFiles(pid: number): Ok<{ paths: string[] }>;
  procEnviron(pid: number): Ok<{ raw: Buffer }>;
  dsHome(): string;
  runWhere(env: Record<string, string>): { status: number; stdout: string; stderr: string };
  realpath(p: string): string | null;
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
      const r = cmd("lsof", ["-nP", "-p", String(pid), "-Fn"]);
      return r.ok ? { ok: true, paths: r.stdout.split("\n").filter((l) => l.startsWith("n/")).map((l) => l.slice(1)) } : r;
    },
    procEnviron: (pid) => {
      try {
        return { ok: true, raw: fs.readFileSync(`/proc/${pid}/environ`) };
      } catch (err) {
        return { ok: false, error: (err as NodeJS.ErrnoException).code ?? String(err) };
      }
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
  };
}

const ENV_SECTIONS = ["inherited environment", "default environment", "environment"] as const;
type SectionName = (typeof ENV_SECTIONS)[number];
export type LaunchctlParse =
  | { ok: true; sections: Record<SectionName, Map<string, string[]>>; pid: number | null; plistPath: string | null; state: string | null }
  | { ok: false; error: string };

/**
 * FAIL-CLOSED parse of `launchctl print`. Top-level fields are one-tab lines; an
 * environment section's entries are two-tab `KEY => VALUE` lines up to a `\t}`.
 * Values are kept as LISTS so a duplicate is visible to the caller. Errors name
 * line numbers only: a line may hold a secret.
 */
export function parseLaunchctlPrint(text: string): LaunchctlParse {
  // The terminating newline ends the last line; it does not start an empty one
  // (an empty line INSIDE a section is still malformed).
  const lines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  const sections = Object.fromEntries(ENV_SECTIONS.map((s) => [s, new Map<string, string[]>()])) as Record<SectionName, Map<string, string[]>>;
  const seen = new Set<SectionName>();
  const top: Record<string, string[]> = { pid: [], path: [], state: [] };
  for (let i = 0; i < lines.length; i++) {
    const header = /^\t(inherited environment|default environment|environment) = \{$/.exec(lines[i]);
    if (header) {
      const name = header[1] as SectionName;
      if (seen.has(name)) return { ok: false, error: `the "${name}" section appears twice (line ${i + 1})` };
      seen.add(name);
      let closed = false;
      for (i++; i < lines.length; i++) {
        if (lines[i] === "\t}") {
          closed = true;
          break;
        }
        const m = /^\t\t(\S+) => (.*)$/.exec(lines[i]);
        if (!m) return { ok: false, error: `line ${i + 1} of the "${name}" section is not \`KEY => VALUE\`` };
        const vals = sections[name].get(m[1]) ?? [];
        vals.push(m[2]);
        sections[name].set(m[1], vals);
      }
      if (!closed) return { ok: false, error: `the "${name}" section is not terminated` };
      continue;
    }
    const field = /^\t(pid|path|state) = (.*)$/.exec(lines[i]);
    if (field) top[field[1]].push(field[2]);
  }
  if (!seen.has("environment")) return { ok: false, error: "no `environment` section (the job's EnvironmentVariables)" };
  for (const k of Object.keys(top)) if (top[k].length > 1) return { ok: false, error: `the top-level "${k}" field appears ${top[k].length} times` };
  const pid = top.pid[0] !== undefined && /^\d+$/.test(top.pid[0]) ? Number(top.pid[0]) : null;
  if (top.pid[0] !== undefined && pid === null) return { ok: false, error: "the pid field is not a number" };
  return { ok: true, sections, pid, plistPath: top.path[0] ?? null, state: top.state[0] ?? null };
}

const result = (outcome: GateOutcome, reason: string, details: string[]): GateResult => ({ outcome, reason, details });

/**
 * Steps 5 of both platforms: the new resolver under `env`, then membership of its
 * DB among the files `pid` holds open. Returns null on a match.
 */
function resolveAndMatch(env: Record<string, string>, pid: number, deps: GateDeps, details: string[]): GateResult | null {
  const w = deps.runWhere(env);
  let res: { kind?: string; db_path?: string; exists?: boolean; reason?: string } | undefined;
  try {
    res = (JSON.parse(w.stdout) as { resolution?: typeof res }).resolution;
  } catch {
    /* handled below */
  }
  if (!res || typeof res.kind !== "string") {
    return result("CANNOT-VERIFY", `the new resolver (relay where --json) gave no parseable result (exit ${w.status})`, details);
  }
  if (res.kind === "error") {
    return result("FAIL", `the NEW resolver fails under the daemon's environment (the new build would refuse to start): ${res.reason}`, details);
  }
  const dbPath = String(res.db_path);
  details.push(`new resolver: ${res.kind} ${dbPath}${res.exists ? "" : " (does not exist)"}`);
  const want = deps.realpath(dbPath);
  if (!want) return result("FAIL", `the new resolver names ${dbPath}, which does not exist: the restart would open a NEW, empty DB`, details);
  const open = deps.openFiles(pid);
  if (!open.ok) return result("CANNOT-VERIFY", `cannot list the files pid ${pid} holds open (${open.error})`, details);
  const held = new Set(open.paths.map((p) => deps.realpath(p)).filter((p): p is string => p !== null));
  if (!held.has(want)) {
    return result("FAIL", `the new resolver names ${want}, but pid ${pid} does not hold it open (checked ${held.size} open files): the restart would MOVE the daemon to a different DB`, details);
  }
  details.push(`pid ${pid} holds ${want} open`);
  return null;
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
  const loaded = pickResolverKeys(parsed.sections.environment, "the job environment");
  if (!loaded.ok) return result("CANNOT-VERIFY", loaded.error, details);

  if (parsed.state !== "running" || parsed.pid === null) {
    return result("CANNOT-VERIFY", `the job is not running (state ${parsed.state ?? "unknown"}): there is no daemon to compare with`, details);
  }
  const pid = parsed.pid;
  details.push(`job pid: ${pid}`);

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
  return resolveAndMatch(env, pid, deps, details) ?? result("PASS", "the new resolver names the DB the running daemon holds open", details);
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
  return (
    resolveAndMatch(env, pid, deps, details) ??
    result("CANNOT-VERIFY", "the RUNNING environment resolves to the held DB, but no service manager is modelled on Linux: a restart may load a different environment", details)
  );
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
