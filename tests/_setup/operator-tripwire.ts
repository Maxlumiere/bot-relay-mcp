// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * OPERATOR TRIPWIRE: the vitest `setupFiles` entry that tests/_setup/vitest-tripwire-base.mjs lists FIRST
 * in every config. No test, and no child a test spawns, may reach the operator's LIVE relay: neither its
 * daemon port nor its instance (DB, config, markers) under the real ~/.bot-relay.
 *
 * The defect it closes (MEASURED 2026-10-05): every local gate run sent 7 `register_agent {"name":"probe"}`
 * calls to the live daemon on 127.0.0.1:3777, and the same hook runs RESOLVED and READ the live instance
 * DB. A hook test passed its options under the wrong keys, so the hook ran with no HOME (bash and node
 * then fall back to the passwd home, whose ~/.bot-relay/active-instance names the live DB) and no port.
 *
 * Architect ruling 621856a0, three roles:
 *   1. PROTECTION by construction, against ACCIDENTAL drift (the base config): a private HOME and port 1 for
 *      every worker, before this file runs; this file narrows HOME to a private one PER WORKER, drops a shell
 *      RELAY_HOME / RELAY_DB_PATH / RELAY_CONFIG_PATH, and gives every CHILD a test starts the same: a
 *      missing or EMPTY HOME, USERPROFILE, HOMEDRIVE, HOMEPATH or RELAY_HTTP_PORT gets the private one /
 *      port 1 (never the account's real home or the default 3777), and an env whose HOME is the operator's
 *      home or inside an operator root, or that points RELAY_HOME / RELAY_DB_PATH / RELAY_CONFIG_PATH inside
 *      one, is REFUSED before the child starts. A GRANDCHILD started with env {} gets none of this (see the
 *      preload's boundary; the live-relay guard detects what it writes).
 *   2. TARGET HARDENING: PR-B and PR-D (not here).
 *   3. DETECTION, best effort, catch-proof, fail-closed (tests/_setup/operator-tripwire-preload.mjs, in
 *      this worker and, via NODE_OPTIONS, in every node child): refused connects and fs access are each
 *      recorded as a file the run's teardown fails on. Here: a synchronous spawn that caused one THROWS
 *      at the test's own line, and afterEach fails the test that caused any (even one it caught). A
 *      violations directory this worker cannot read, or a record that could not be written, fails too.
 *
 * The operator snapshot (home, roots, ports) comes from the base config's env and is FROZEN at load:
 * deleting an env var later cannot drop protection. See the preload for the KNOWN RESIDUAL list.
 *
 * DESKTOP TRIPWIRE (the same sites): no test may raise, open or type into a window on the machine running it
 * (MEASURED on main ba5b97a: the dashboard focus tests ran `osascript … tell application "iTerm2" / activate`
 * twice per run). Three layers:
 *   1. DRY RUN BY DEFAULT: every test file's worker, and every child it starts, gets RELAY_FOCUS_DRY_RUN=1 (a
 *      child whose env already names the key keeps the test's value: unsetting it is deliberate).
 *   2. REFUSED IN THE WORKER: a spawn-family call whose program is a desktop actuator (DESKTOP_ACTUATORS, or
 *      powershell/pwsh with AppActivate / WScript.Shell) is RECORDED and THROWS before anything starts; an
 *      exec() string is refused when an actuator is in COMMAND position (or in a quoted segment: over-detects,
 *      loudly, by design).
 *   3. REFUSED IN A CHILD, by name: every child's PATH starts with a directory of refusing stand-ins (one per
 *      actuator) that record a violation and exit 96 (97 when the record cannot be written), so a bash script
 *      or hook calling `osascript` by name is caught too.
 * NOT COVERED (stated): an actuator started by ABSOLUTE path from a child; a child given an env with no PATH or
 * env {}; Windows children (the stand-ins are POSIX scripts; the worker check still applies on Windows).
 */
import fs from "node:fs";
import path from "node:path";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach } from "vitest";
import type { ChildProcess } from "node:child_process";
import { HOME_KEYS, SAFE_PORT, privateHomeEnv } from "./vitest-tripwire-base.mjs";

export { HOME_KEYS, SAFE_PORT, privateHomeEnv };

const PRELOAD = fileURLToPath(new URL("./operator-tripwire-preload.mjs", import.meta.url));
const STATE_KEY = Symbol.for("bot-relay.operator-tripwire.state");
const WRAPPED = Symbol.for("bot-relay.operator-tripwire.wrapped");

interface TripwireState {
  runDir: string;
  home: string;
  recordDir: string;
  /**
   * Violations already REPORTED, one cursor per reporter. They are independent: a synchronous spawn's
   * throw must not consume what afterEach reports, or a test that catches that throw passes (Codex #305
   * R1 P2 #12). afterEach reports everything recorded since the previous afterEach, thrown or not.
   */
  seen: { spawn: Set<string>; afterEach: Set<string> };
  /** The snapshot children inherit, frozen from THIS worker's env at load. */
  childVars: Readonly<Record<string, string>>;
}

function state(): TripwireState {
  return (globalThis as Record<symbol, TripwireState>)[STATE_KEY];
}

// ---- first load in this worker: freeze the snapshot, then arm the preload --------------------------
if (!state()) {
  const runDir = process.env.RELAY_TEST_TRIPWIRE_RUN_DIR;
  if (!runDir || !path.isAbsolute(runDir) || !process.env.RELAY_TEST_OPERATOR_ROOTS) {
    throw new Error("operator tripwire: this run's config does not extend tests/_setup/vitest-tripwire-base.mjs (no RELAY_TEST_TRIPWIRE_RUN_DIR / operator snapshot): refusing to run unprotected");
  }
  const worker = path.join(runDir, "workers", String(process.pid));
  const home = path.join(worker, "home");
  const recordDir = path.join(runDir, "violations", String(process.pid));
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(recordDir, { recursive: true, mode: 0o700 });
  const priv = privateHomeEnv(home);
  Object.assign(process.env, priv); // this worker's own HOME (and the Windows spellings, and its TEMP)
  if ("TEMP" in priv) fs.mkdirSync(priv.TEMP, { recursive: true, mode: 0o700 });
  process.env.RELAY_HTTP_PORT = SAFE_PORT;
  process.env.RELAY_TEST_TRIPWIRE_DIR = recordDir; // read by the preload's snapshot, below
  const childVars = Object.freeze({
    RELAY_TEST_OPERATOR_HOME: process.env.RELAY_TEST_OPERATOR_HOME ?? "",
    RELAY_TEST_OPERATOR_ROOTS: process.env.RELAY_TEST_OPERATOR_ROOTS ?? "",
    RELAY_TEST_OPERATOR_PORTS: process.env.RELAY_TEST_OPERATOR_PORTS ?? "",
    RELAY_TEST_TRIPWIRE_DIR: recordDir,
  });
  (globalThis as Record<symbol, TripwireState>)[STATE_KEY] = { runDir, home, recordDir, seen: { spawn: new Set(), afterEach: new Set() }, childVars };
}

// After the env above is set: the preload snapshots it on its FIRST load in this process.
const pre = await import("./operator-tripwire-preload.mjs");
pre.markTestWorker();
// The shell's own RELAY_HOME / RELAY_DB_PATH / RELAY_CONFIG_PATH are the OPERATOR's (the base config's
// discovery made each one a root), and a worker inherits them from the main process. Drop each that names
// an operator root, so this worker, and every child built from its env, starts away from the operator
// instead of being refused at its first spawn. (hermetic-config, next, sets its own RELAY_CONFIG_PATH.)
// A RELATIVE one resolves against the launch cwd, as production does (Codex #305 R2 NEW-2); an empty one means
// "the default" to every consumer, which now resolves under the private HOME.
const LAUNCH_CWD = process.env.RELAY_TEST_LAUNCH_CWD || process.cwd();
for (const k of ["RELAY_HOME", "RELAY_DB_PATH", "RELAY_CONFIG_PATH"]) {
  const v = process.env[k];
  if (v === "" || (v && pre.underOperatorRoot(path.resolve(LAUNCH_CWD, v)))) delete process.env[k];
}
export const { OperatorTripwireError, RAW_FS, underOperatorRoot, isOperatorHome, isLocalAddress } = pre;

// ---- DESKTOP TRIPWIRE ---------------------------------------------------------------------------------
/** Programs that raise, open or type into a window. powershell/pwsh count only with WINDOWS_ACTUATION. */
export const DESKTOP_ACTUATORS: readonly string[] = Object.freeze(["osascript", "open", "xdg-open", "wmctrl", "xdotool"]);
const WINDOWS_ACTUATION = /AppActivate|WScript\.Shell/i;
/** Exit code of a refusing stand-in that RECORDED its violation (97 = it could not: RECORD_FAILED_EXIT). */
export const DESKTOP_REFUSED_EXIT = 96;

const progName = (p: string) => path.basename(p.replace(/\\/g, "/")).toLowerCase().replace(/\.exe$/, "");
/**
 * Programs that START their operand (Codex #333 R1 P1): `env PATH=… osascript` replaces the decorated PATH, and
 * `command -p open` searches the shell's DEFAULT path; both reach the real program past the stand-ins. After one of
 * these, EVERY later word naming an actuator counts (their options vary by platform: over-detects, loudly).
 */
const WRAPPERS: ReadonlySet<string> = new Set(["env", "command", "exec", "builtin", "nohup", "sudo", "doas", "nice", "time", "timeout", "stdbuf", "setsid", "caffeinate", "arch", "xargs"]);
/** Shells: only a -c style option's operand is a command line (a script's own arguments are not parsed). */
const SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The actuator a command's words (program first) would start, or null. Pure. */
function actuatorInWords(words: readonly string[]): string | null {
  let i = 0;
  while (i < words.length && ASSIGNMENT.test(words[i]!)) i++; // VAR=value prefixes
  if (i >= words.length) return null;
  const name = progName(words[i]!);
  const rest = words.slice(i + 1);
  if (DESKTOP_ACTUATORS.includes(name)) return name;
  if ((name === "powershell" || name === "pwsh") && rest.some((a) => WINDOWS_ACTUATION.test(a))) {
    return `${name} (${rest.find((a) => WINDOWS_ACTUATION.test(a))!.match(WINDOWS_ACTUATION)![0]})`;
  }
  if (WRAPPERS.has(name)) {
    for (let k = 0; k < rest.length; k++) {
      const w = rest[k]!;
      if (ASSIGNMENT.test(w) || w.startsWith("-")) continue;
      const hit = actuatorInWords(rest.slice(k)); // the operand is a command of its own (it may be a wrapper or a shell)
      if (hit) return hit;
      if (/\s/.test(w)) {
        const inLine = desktopActuatorInShell(w); // e.g. caffeinate -i "osascript …" handed as one word
        if (inLine) return inLine;
      }
    }
    return null;
  }
  if (SHELLS.has(name)) {
    const c = rest.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
    if (c >= 0 && typeof rest[c + 1] === "string") return desktopActuatorInShell(rest[c + 1]!);
  }
  return null;
}

/** The desktop actuator a program + argv would start, or null. Pure. */
export function desktopActuator(program: string, args: readonly unknown[] = []): string | null {
  return actuatorInWords([program, ...args.filter((a): a is string => typeof a === "string")]);
}

/**
 * The desktop actuator a SHELL string would start, or null. Pure. Each segment between command separators
 * (; & | newline ( ) backtick) and quotes is a command; its program (after VAR=value assignments, and through any
 * wrapper) is checked. Splitting at quotes over-detects (`echo "open it"` is fine, `env x "open"` is refused):
 * loud, never silent.
 */
export function desktopActuatorInShell(cmd: string): string | null {
  for (const seg of cmd.split(/[;&|\n()`"']+/)) {
    const words = seg.trim().split(/\s+/).filter((w) => w && w !== "$");
    const hit = actuatorInWords(words);
    if (hit) return hit;
  }
  if (/\b(powershell|pwsh)(\.exe)?\b/i.test(cmd) && WINDOWS_ACTUATION.test(cmd)) return `powershell (${cmd.match(WINDOWS_ACTUATION)![0]})`;
  return null;
}

/** Record + THROW before a desktop actuator starts. The record fails this test's afterEach and the run, caught or not. */
function refuseDesktop(what: string, how: string): never {
  const line = `desktop ${how}: refused ${what} (a test must never raise, open or type into a window)`;
  pre.recordViolation(line);
  // This THROW is the spawn-time report: mark what is recorded so far as reported by the "spawn" reporter, so it is not
  // re-thrown at a LATER test's sync spawn (that made a later test "fail" on this test's refusal: seen under mutant
  // MP3). afterEach keeps its own cursor and still fails the test that caused it, caught or not.
  try {
    newViolations("spawn");
  } catch {
    /* unreadable: afterEach fails closed on it */
  }
  throw new pre.OperatorTripwireError(`DESKTOP_TRIPWIRE: ${line}. Use RELAY_FOCUS_DRY_RUN=1 / RELAY_SPAWN_DRY_RUN=1, or test the driver's pure buildCommand.`);
}

/** The refusing stand-ins (POSIX only), one directory per run, shared by its workers. */
const SHIM_DIR = process.platform === "win32" ? null : path.join(state().runDir, "desktop-shims");
/**
 * Where a stand-in records when its env carries no RELAY_TEST_TRIPWIRE_DIR (a child given a stripped env): inside the
 * run's violations tree, which the run's teardown walks, so the RUN still fails (only the per-test attribution is lost).
 */
const SHIM_FALLBACK_DIR = path.join(state().runDir, "violations", "desktop-stand-ins");
if (SHIM_DIR && !fs.existsSync(path.join(SHIM_DIR, ".complete"))) {
  fs.mkdirSync(SHIM_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(SHIM_FALLBACK_DIR, { recursive: true, mode: 0o700 });
  for (const name of DESKTOP_ACTUATORS) {
    // Recording uses ONLY shell builtins ([, printf, >>, echo) and absolute paths (Codex #333 R1 P2): a restricted PATH
    // with no mktemp used to make the record fail, and a caller's `|| true` then swallowed the 97, so the run went green.
    const body =
      `#!/bin/sh\n# DESKTOP TRIPWIRE stand-in (tests/_setup/operator-tripwire.ts): refuses ${name}, records it, never runs it.\n` +
      `d="\${RELAY_TEST_TRIPWIRE_DIR:-${SHIM_FALLBACK_DIR}}"\n` +
      `if [ -n "$d" ] && { printf '%s\\n' "desktop child pid=$$ ppid=$PPID: refused ${name} by name (a test must never raise, open or type into a window)" >> "$d/desktop-$$-${name}.txt"; } 2>/dev/null; then\n` +
      `  echo "DESKTOP_TRIPWIRE: refused ${name}" >&2; exit ${DESKTOP_REFUSED_EXIT}\nfi\n` +
      `echo "DESKTOP_TRIPWIRE: refused ${name} and could not record it" >&2; exit ${pre.RECORD_FAILED_EXIT}\n`;
    const tmp = path.join(SHIM_DIR, `.${name}.${process.pid}`);
    fs.writeFileSync(tmp, body, { mode: 0o755 });
    fs.renameSync(tmp, path.join(SHIM_DIR, name)); // atomic: a parallel worker never runs a half-written stand-in
  }
  fs.writeFileSync(path.join(SHIM_DIR, ".complete"), "");
}
/** PATH with the stand-ins first (unchanged when already first, or when there are none). */
function shimmedPath(p: string): string {
  if (!SHIM_DIR || p.split(path.delimiter)[0] === SHIM_DIR) return p;
  return p ? `${SHIM_DIR}${path.delimiter}${p}` : SHIM_DIR;
}
// EVERY test file (not only the worker's first): a file that deleted these must not leave the next one unprotected.
process.env.RELAY_FOCUS_DRY_RUN = "1";
if (process.env.PATH !== undefined) process.env.PATH = shimmedPath(process.env.PATH);

/** The operator's real home and roots, and this worker's private home (for the tripwire's own tests). */
export function tripwireView(): { roots: string[]; realHome: string; privateHome: string; ports: number[]; runDir: string } {
  const snap = pre.tripwireSnapshot();
  return { roots: snap.roots.map((r: { raw: string }) => r.raw), realHome: snap.realHome.raw, privateHome: state().home, ports: [...snap.ports], runDir: state().runDir };
}

/** Violations recorded for THIS worker (and its children) that `reporter` has not yet reported. Throws when unreadable. */
function newViolations(reporter: keyof TripwireState["seen"]): string[] {
  const seen = state().seen[reporter];
  const names = (pre.RAW_FS.readdirSync(state().recordDir) as string[]).filter((n) => !seen.has(n)).sort();
  return names.map((n) => {
    seen.add(n);
    return pre.RAW_FS.readFileSync(path.join(state().recordDir, n), "utf-8").trim();
  });
}

function failOnViolations(where: string, reporter: keyof TripwireState["seen"]): void {
  let v: string[];
  try {
    v = newViolations(reporter);
  } catch (err) {
    throw new pre.OperatorTripwireError(`OPERATOR_TRIPWIRE (${where}): this worker's violations directory could not be read (${err instanceof Error ? err.message : String(err)}): failing closed.`);
  }
  // A lost record is the worker's own state, not a file: only afterEach consumes it, so a caught
  // spawn throw cannot hide it either.
  const lost = reporter === "afterEach" ? pre.takeRecordFailure() : null;
  if (lost) v.push(lost);
  if (v.length) {
    throw new pre.OperatorTripwireError(
      `OPERATOR_TRIPWIRE (${where}): this test reached the OPERATOR's live relay or desktop (refused, never delivered). A relay access: pin RELAY_HTTP_PORT / HOME / RELAY_DB_PATH for the child or code path. A desktop one: use RELAY_FOCUS_DRY_RUN=1 / RELAY_SPAWN_DRY_RUN=1 or the driver's pure buildCommand:\n  ${v.join("\n  ")}`,
    );
  }
}

const INSTANCE_ENV = ["RELAY_HOME", "RELAY_DB_PATH", "RELAY_CONFIG_PATH"] as const;

/**
 * The env a child actually gets: the test's env (or ours), plus the tripwire. Throws BEFORE the spawn on an
 * operator path. `cwd` is the child's: a relative instance override resolves against it, as in production.
 */
export function decorateChildEnv(env: NodeJS.ProcessEnv | undefined, cwd: string = process.cwd()): NodeJS.ProcessEnv {
  const st = state();
  const base = env ?? process.env;
  const named: string[] = [];
  for (const k of ["HOME", "USERPROFILE"] as const) {
    const v = base[k];
    if (v && (pre.isOperatorHome(v) || pre.underOperatorRoot(v))) named.push(`${k}=${v}`);
  }
  if (base.HOMEPATH) {
    const v = `${base.HOMEDRIVE ?? ""}${base.HOMEPATH}`;
    if (pre.isOperatorHome(v) || pre.underOperatorRoot(v)) named.push(`HOMEDRIVE+HOMEPATH=${v}`);
  }
  for (const k of INSTANCE_ENV) if (base[k] && pre.underOperatorRoot(path.resolve(cwd, base[k]!))) named.push(`${k}=${base[k]}`);
  if (named.length) {
    const line = `env a child env names the OPERATOR's home or relay root: ${named.join(" ")}`;
    pre.recordViolation(line); // also fails this test's afterEach, and the run, even if the throw is caught
    throw new pre.OperatorTripwireError(`OPERATOR_TRIPWIRE: refused to spawn: ${line}. Give the child its own HOME / RELAY_HOME / RELAY_DB_PATH.`);
  }
  const out: NodeJS.ProcessEnv = { ...base };
  // Without them, bash's ~ and node's os.homedir() fall back to the ACCOUNT's real home (passwd on unix,
  // the profile on Windows), and the hooks fall back to port 3777: the operator's. Each missing one gets
  // the private one. EMPTY is missing to those consumers (Codex #305 R2 NEW-1: the hooks read
  // ${RELAY_HTTP_PORT:-3777}, and node's os.homedir() skips an empty HOME), so it is repaired the same way.
  const unset = (v: string | undefined) => v === undefined || v === "";
  const priv: Record<string, string> = privateHomeEnv(st.home);
  for (const [k, v] of Object.entries(priv)) if (unset(base[k]) && !(v === "" && base[k] === "")) out[k] = v;
  if (unset(base.RELAY_HTTP_PORT)) out.RELAY_HTTP_PORT = SAFE_PORT;
  // An empty instance override means "the default" (under the private HOME): removed, never passed on as "".
  for (const k of INSTANCE_ENV) if (base[k] === "") delete out[k];
  Object.assign(out, st.childVars); // the frozen snapshot, whatever the test did to its own env
  // DESKTOP: dry run unless the test's env names the key (then its value is deliberate); stand-ins first on PATH.
  if (!("RELAY_FOCUS_DRY_RUN" in base)) out.RELAY_FOCUS_DRY_RUN = "1";
  if (typeof out.PATH === "string") out.PATH = shimmedPath(out.PATH);
  const imp = `--import=${pathToFileURL(PRELOAD).href}`;
  const nodeOpts = base.NODE_OPTIONS ?? "";
  if (!nodeOpts.includes(imp)) out.NODE_OPTIONS = `${nodeOpts} ${imp}`.trim();
  return out;
}

type AnyFn = (...args: unknown[]) => unknown;

/** Refuse a spawn-family call that would start a desktop actuator (see DESKTOP TRIPWIRE). */
function checkDesktop(name: string, args: unknown[], argvAt1: boolean): void {
  if (name === "fork" || typeof args[0] !== "string") return; // fork runs a node module
  const how = `child_process.${name}`;
  if (!argvAt1) {
    const hit = desktopActuatorInShell(args[0]);
    if (hit) refuseDesktop(hit, how);
    return;
  }
  const argv = Array.isArray(args[1]) ? (args[1] as unknown[]) : [];
  const opts = args.find((x, k) => k > 0 && x !== null && typeof x === "object" && !Array.isArray(x)) as { shell?: unknown } | undefined;
  const hit = opts?.shell ? desktopActuatorInShell([args[0], ...argv].join(" ")) : desktopActuator(args[0], argv);
  if (hit) refuseDesktop(hit, how);
}
/** Rewrite the options argument of a spawn-family call so the child carries the tripwire. */
function withTripwireEnv(args: unknown[], argvAt1: boolean): unknown[] {
  const a = [...args];
  let i = a.findIndex((x, k) => k > 0 && x !== null && typeof x === "object" && !Array.isArray(x));
  if (i < 0) {
    i = argvAt1 && Array.isArray(a[1]) ? 2 : 1;
    a.splice(i, 0, {});
  }
  const opts = a[i] as { env?: NodeJS.ProcessEnv; cwd?: string | URL };
  const cwd = opts.cwd === undefined ? process.cwd() : opts.cwd instanceof URL ? fileURLToPath(opts.cwd) : path.resolve(String(opts.cwd));
  a[i] = { ...opts, env: decorateChildEnv(opts.env, cwd) };
  return a;
}

/**
 * Children this worker started, until they exit. A preloaded child whose violation record could NOT be written
 * exits RECORD_FAILED_EXIT (97); the parent must not lose that (Codex #305 R2 NEW-3): the exit is recorded HERE,
 * in the worker, whose own record failure is sticky (the next afterEach or afterAll fails on it).
 */
const SUPERVISED = new Set<ChildProcess>();
function noteLostRecord(how: string): void {
  pre.recordViolation(`child exited ${pre.RECORD_FAILED_EXIT} (${how}): it refused an operator access and could not record it`);
}
function supervise(child: unknown, how: string): void {
  if (!child || typeof (child as ChildProcess).once !== "function") return;
  const c = child as ChildProcess;
  if (c.exitCode !== null || c.signalCode !== null) {
    if (c.exitCode === pre.RECORD_FAILED_EXIT) noteLostRecord(how);
    return;
  }
  SUPERVISED.add(c);
  c.once("exit", (code) => {
    SUPERVISED.delete(c);
    if (code === pre.RECORD_FAILED_EXIT) noteLostRecord(how);
  });
}

function wrap(name: "spawn" | "spawnSync" | "execFile" | "execFileSync" | "exec" | "execSync" | "fork", sync: boolean, argvAt1: boolean): void {
  const mod = cp as unknown as Record<string, AnyFn & { [WRAPPED]?: true }>;
  const original = mod[name];
  if (original[WRAPPED]) return;
  const wrapped = function (this: unknown, ...args: unknown[]) {
    checkDesktop(name, args, argvAt1);
    let r: unknown;
    try {
      r = original.apply(this, withTripwireEnv(args, argvAt1));
    } catch (err) {
      // execSync / execFileSync throw on a non-zero exit: the status is noted BEFORE the test can swallow it.
      if (sync && (err as { status?: number } | null)?.status === pre.RECORD_FAILED_EXIT) noteLostRecord(`child_process.${name}`);
      throw err;
    }
    if (sync) {
      if ((r as { status?: number } | null)?.status === pre.RECORD_FAILED_EXIT) noteLostRecord(`child_process.${name}`);
      failOnViolations(`child_process.${name}`, "spawn");
    } else supervise(r, `child_process.${name}`);
    return r;
  } as AnyFn & { [WRAPPED]?: true };
  // promisify(exec/execFile) resolves {stdout, stderr} through this custom symbol; its promise carries .child.
  const custom = (original as unknown as Record<symbol, unknown>)[Symbol.for("nodejs.util.promisify.custom")];
  if (custom !== undefined)
    Object.defineProperty(wrapped, Symbol.for("nodejs.util.promisify.custom"), {
      value: (...args: unknown[]) => {
        checkDesktop(name, args, argvAt1);
        const p = (custom as AnyFn)(...withTripwireEnv(args, argvAt1)) as { child?: unknown };
        supervise(p?.child, `child_process.${name} (promisified)`);
        return p;
      },
    });
  wrapped[WRAPPED] = true;
  mod[name] = wrapped;
}

const RAW_SPAWN_KEY = Symbol.for("bot-relay.operator-tripwire.raw-spawn");
(globalThis as Record<symbol, unknown>)[RAW_SPAWN_KEY] ??= cp.spawn;
/**
 * The UNWRAPPED spawn, for the tripwire's OWN tests only: starting a NESTED vitest run (protected by its
 * own base config: its own private HOME, port 1, snapshot, tripwire and teardown; a wrapped spawn would
 * hand it THIS worker's snapshot and violations directory instead), and the harm fixture's one child
 * started past the wrapper on purpose (proving the preload's own start check). Nothing else may use it.
 */
export const spawnNestedRun = (globalThis as Record<symbol, unknown>)[RAW_SPAWN_KEY] as typeof cp.spawn;

wrap("spawn", false, true);
wrap("execFile", false, true);
wrap("fork", false, true);
wrap("exec", false, false);
wrap("spawnSync", true, true);
wrap("execFileSync", true, true);
wrap("execSync", true, false);
syncBuiltinESMExports(); // named ESM imports of node:child_process see the wrappers too

afterEach(() => failOnViolations("afterEach", "afterEach"));

/** How long a file's teardown waits for the children it still supervises (ONE deadline for all of them). */
const SUPERVISE_MS = 5000;
// Registered FIRST (setupFiles run before the file), so it runs LAST: after the file's own afterAll has killed
// its daemons. A child that exits 97 after its test, or a record failure since the last afterEach, fails here.
afterAll(async () => {
  const deadline = Date.now() + SUPERVISE_MS;
  for (const c of [...SUPERVISED]) {
    const left = deadline - Date.now();
    if (left <= 0) break; // still running past the deadline: its later exit is no longer seen (stated boundary)
    if (c.exitCode !== null || c.signalCode !== null) continue;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, left);
      t.unref?.();
      c.once("exit", () => (clearTimeout(t), resolve()));
    });
  }
  failOnViolations("afterAll", "afterEach");
}, SUPERVISE_MS + 5000);
