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
 *   1. PROTECTION by construction (the base config): a private HOME and port 1 for every worker, before
 *      this file runs; this file narrows HOME to a private one PER WORKER, and gives every CHILD a test
 *      starts the same: a missing HOME, USERPROFILE, HOMEDRIVE, HOMEPATH or RELAY_HTTP_PORT gets the
 *      private one / port 1 (never the account's real home or the default 3777), and an env whose HOME
 *      is the operator's home or inside an operator root, or that points RELAY_HOME / RELAY_DB_PATH /
 *      RELAY_CONFIG_PATH inside one, is REFUSED before the child starts.
 *   2. TARGET HARDENING: PR-B and PR-D (not here).
 *   3. DETECTION, best effort, catch-proof, fail-closed (tests/_setup/operator-tripwire-preload.mjs, in
 *      this worker and, via NODE_OPTIONS, in every node child): refused connects and fs access are each
 *      recorded as a file the run's teardown fails on. Here: a synchronous spawn that caused one THROWS
 *      at the test's own line, and afterEach fails the test that caused any (even one it caught). A
 *      violations directory this worker cannot read, or a record that could not be written, fails too.
 *
 * The operator snapshot (home, roots, ports) comes from the base config's env and is FROZEN at load:
 * deleting an env var later cannot drop protection. See the preload for the KNOWN RESIDUAL list.
 */
import fs from "node:fs";
import path from "node:path";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach } from "vitest";
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
  Object.assign(process.env, privateHomeEnv(home)); // this worker's own HOME (and the Windows spellings)
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
for (const k of ["RELAY_HOME", "RELAY_DB_PATH", "RELAY_CONFIG_PATH"]) {
  const v = process.env[k];
  if (v && pre.underOperatorRoot(v)) delete process.env[k];
}
export const { OperatorTripwireError, RAW_FS, underOperatorRoot, isOperatorHome, isLocalAddress } = pre;

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
      `OPERATOR_TRIPWIRE (${where}): this test reached the OPERATOR's live relay (refused, never delivered). Pin RELAY_HTTP_PORT / HOME / RELAY_DB_PATH for the child or code path:\n  ${v.join("\n  ")}`,
    );
  }
}

const INSTANCE_ENV = ["RELAY_HOME", "RELAY_DB_PATH", "RELAY_CONFIG_PATH"] as const;

/** The env a child actually gets: the test's env (or ours), plus the tripwire. Throws BEFORE the spawn on an operator path. */
export function decorateChildEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
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
  for (const k of INSTANCE_ENV) if (base[k] && pre.underOperatorRoot(base[k])) named.push(`${k}=${base[k]}`);
  if (named.length) {
    const line = `env a child env names the OPERATOR's home or relay root: ${named.join(" ")}`;
    pre.recordViolation(line); // also fails this test's afterEach, and the run, even if the throw is caught
    throw new pre.OperatorTripwireError(`OPERATOR_TRIPWIRE: refused to spawn: ${line}. Give the child its own HOME / RELAY_HOME / RELAY_DB_PATH.`);
  }
  const out: NodeJS.ProcessEnv = { ...base };
  // Without them, bash's ~ and node's os.homedir() fall back to the ACCOUNT's real home (passwd on unix,
  // the profile on Windows), and the hooks fall back to port 3777: the operator's. Each missing one gets
  // the private one.
  const priv = privateHomeEnv(st.home);
  for (const k of HOME_KEYS) if (base[k] === undefined) out[k] = priv[k as keyof typeof priv];
  if (base.RELAY_HTTP_PORT === undefined) out.RELAY_HTTP_PORT = SAFE_PORT;
  Object.assign(out, st.childVars); // the frozen snapshot, whatever the test did to its own env
  const imp = `--import=${pathToFileURL(PRELOAD).href}`;
  const nodeOpts = base.NODE_OPTIONS ?? "";
  if (!nodeOpts.includes(imp)) out.NODE_OPTIONS = `${nodeOpts} ${imp}`.trim();
  return out;
}

type AnyFn = (...args: unknown[]) => unknown;
/** Rewrite the options argument of a spawn-family call so the child carries the tripwire. */
function withTripwireEnv(args: unknown[], argvAt1: boolean): unknown[] {
  const a = [...args];
  let i = a.findIndex((x, k) => k > 0 && x !== null && typeof x === "object" && !Array.isArray(x));
  if (i < 0) {
    i = argvAt1 && Array.isArray(a[1]) ? 2 : 1;
    a.splice(i, 0, {});
  }
  const opts = a[i] as { env?: NodeJS.ProcessEnv };
  a[i] = { ...opts, env: decorateChildEnv(opts.env) };
  return a;
}

function wrap(name: "spawn" | "spawnSync" | "execFile" | "execFileSync" | "exec" | "execSync" | "fork", sync: boolean, argvAt1: boolean): void {
  const mod = cp as unknown as Record<string, AnyFn & { [WRAPPED]?: true }>;
  const original = mod[name];
  if (original[WRAPPED]) return;
  const wrapped = function (this: unknown, ...args: unknown[]) {
    const r = original.apply(this, withTripwireEnv(args, argvAt1));
    if (sync) failOnViolations(`child_process.${name}`, "spawn");
    return r;
  } as AnyFn & { [WRAPPED]?: true };
  // promisify(exec/execFile) resolves {stdout, stderr} through this custom symbol.
  const custom = (original as unknown as Record<symbol, unknown>)[Symbol.for("nodejs.util.promisify.custom")];
  if (custom !== undefined) Object.defineProperty(wrapped, Symbol.for("nodejs.util.promisify.custom"), { value: (...args: unknown[]) => (custom as AnyFn)(...withTripwireEnv(args, argvAt1)) });
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
