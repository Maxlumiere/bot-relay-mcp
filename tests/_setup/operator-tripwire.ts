// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * OPERATOR TRIPWIRE: a vitest `setupFiles` module. No test, and no child a test spawns, may
 * reach the operator's LIVE relay: neither its daemon port nor its instance (DB, config,
 * markers) under the real ~/.bot-relay.
 *
 * The defect it closes (MEASURED 2026-10-05): every local gate run sent 7
 * `register_agent {"name":"probe"}` calls to the live daemon on 127.0.0.1:3777, and the same
 * hook runs RESOLVED and READ the live instance DB. A hook test passed its options under the
 * wrong keys, so the hook ran with no HOME (bash and node then fall back to the passwd home,
 * whose ~/.bot-relay/active-instance names the live DB) and no port (it defaults to 3777).
 *
 * Closed BY CONSTRUCTION, where the access happens, wherever the port or path came from:
 *   - THIS PROCESS: a private HOME per worker, on every platform's spelling (the operator's
 *     ~/.bot-relay is never the default), and tests/_setup/operator-tripwire-preload.mjs: any TCP connect to a
 *     loopback operator port, and any fs call naming a path under the operator's real relay
 *     root, THROWS.
 *   - EVERY CHILD (the child_process spawn family is wrapped; an env a test built from
 *     scratch included):
 *       * a missing HOME, USERPROFILE, HOMEDRIVE or HOMEPATH → the private one (never the
 *         account's real home: passwd on unix, the profile on Windows);
 *       * an env that NAMES the operator's home or relay root (HOME, USERPROFILE,
 *         HOMEDRIVE+HOMEPATH, RELAY_HOME, RELAY_DB_PATH, RELAY_CONFIG_PATH) → refused BEFORE the
 *         child starts;
 *       * the same preload in node children, via NODE_OPTIONS;
 *       * a `curl` shim first on PATH that refuses an operator-port URL (exit 7) and
 *         otherwise execs the curl the ORIGINAL PATH resolves (a test's stub included); only
 *         when that PATH has a curl, so "curl missing" stays missing.
 *   - Every refusal is RECORDED in a per-worker log. A synchronous spawn that caused one
 *     THROWS at the test's own line; anything else fails the test in afterEach. A test
 *     cannot swallow it.
 *
 * Operator ports: 3777 (the default), every `http_port` in the operator's real relay config
 * and instance configs, and an ambient RELAY_HTTP_PORT inherited from the shell. Operator
 * roots: the passwd home's ~/.bot-relay, and an ambient RELAY_HOME from the shell.
 *
 * Not covered (stated, not hidden): a non-node child that reads the operator's files by a
 * path it builds itself (bash `sqlite3 <path>`), when nothing in its env names that path; a
 * child that reaches the network through something other than curl or node; Windows
 * children (no shim). The private HOME removes the default route to all of these.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach } from "vitest";
import { OperatorTripwireError, RAW_FS, setTripwireConfig, underOperatorRoot } from "./operator-tripwire-preload.mjs";

const PRELOAD = fileURLToPath(new URL("./operator-tripwire-preload.mjs", import.meta.url));
const STATE_KEY = Symbol.for("bot-relay.operator-tripwire.state");
const WRAPPED = Symbol.for("bot-relay.operator-tripwire.wrapped");
export const DEFAULT_OPERATOR_PORT = 3777;
/** The worker's default RELAY_HTTP_PORT: nothing listens, nothing unprivileged can. */
export const SAFE_PORT = "1";

interface TripwireState {
  dir: string;
  home: string;
  realHome: string;
  shimDir: string;
  log: string;
  offset: number;
  ports: Set<number>;
  roots: string[];
}

/** Every port the operator's live relay may listen on, read from the REAL operator relay root (read-only, unwrapped fs). */
export function discoverOperatorPorts(relayRoot: string, ambientPort: string | undefined): Set<number> {
  const ports = new Set<number>([DEFAULT_OPERATOR_PORT]);
  const add = (v: unknown) => {
    const n = Number(v);
    if (Number.isInteger(n) && n > 0 && n < 65536) ports.add(n);
  };
  const configs = [path.join(relayRoot, "config.json")];
  try {
    for (const id of RAW_FS.readdirSync(path.join(relayRoot, "instances"))) configs.push(path.join(relayRoot, "instances", id, "config.json"));
  } catch {
    /* no instances */
  }
  for (const f of configs) {
    try {
      add((JSON.parse(RAW_FS.readFileSync(f, "utf-8")) as { http_port?: unknown }).http_port);
    } catch {
      /* absent or unreadable: the default still applies */
    }
  }
  if (ambientPort !== undefined) add(ambientPort);
  return ports;
}

const CURL_SHIM = `#!/bin/bash
# Test-only operator tripwire (tests/_setup/operator-tripwire.ts).
IFS=, read -ra ports <<< "\${RELAY_TEST_OPERATOR_PORTS:-}"
for a in "$@"; do
  for p in "\${ports[@]}"; do
    re="^([A-Za-z][A-Za-z0-9+.-]*://)?([^/@]*@)?(localhost|127\\.[0-9.]+|\\[::1\\]|\\[::\\]|0\\.0\\.0\\.0):\${p}([/?#].*)?$"
    if [[ "$a" =~ $re ]]; then
      [ -n "\${RELAY_TEST_TRIPWIRE_LOG:-}" ] && printf 'curl pid=%s url=%s\\n' "$$" "$a" >> "$RELAY_TEST_TRIPWIRE_LOG"
      echo "OPERATOR_TRIPWIRE: curl to $a, an OPERATOR relay port: refused" >&2
      exit 7
    fi
  done
done
exec "$RELAY_TEST_REAL_CURL" "$@"
`;

function state(): TripwireState {
  return (globalThis as Record<symbol, TripwireState>)[STATE_KEY];
}

/** The curl a PATH resolves, or null (cached per PATH string). Uses only paths outside the operator root. */
const curlCache = new Map<string, string | null>();
function curlOn(pathVar: string, shimDir: string): string | null {
  if (curlCache.has(pathVar)) return curlCache.get(pathVar)!;
  let found: string | null = null;
  for (const d of pathVar.split(path.delimiter)) {
    if (!d || d === shimDir || underOperatorRoot(d)) continue;
    const c = path.join(d, "curl");
    try {
      fs.accessSync(c, fs.constants.X_OK);
      if (fs.statSync(c).isFile()) {
        found = c;
        break;
      }
    } catch {
      /* not here */
    }
  }
  curlCache.set(pathVar, found);
  return found;
}

const EXECVP_DEFAULT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/**
 * The env that points the HOME of a process at `home` on every platform. Unix (and node's
 * os.homedir() there) read HOME; on Windows node's os.homedir() reads USERPROFILE, and
 * without it falls back to the ACCOUNT's real profile. HOMEDRIVE + HOMEPATH are the other
 * Windows spelling (cmd, Git Bash).
 */
export const HOME_KEYS = ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"] as const;
export function privateHomeEnv(home: string, platform: NodeJS.Platform = process.platform): Record<(typeof HOME_KEYS)[number], string> {
  if (platform === "win32") {
    const drive = path.win32.parse(home).root.replace(/[\\/]+$/, "");
    return { HOME: home, USERPROFILE: home, HOMEDRIVE: drive, HOMEPATH: home.slice(drive.length) || "\\" };
  }
  return { HOME: home, USERPROFILE: home, HOMEDRIVE: "", HOMEPATH: home };
}

/** Does this env name the operator's REAL home through any of the HOME spellings? */
function namesRealHome(env: NodeJS.ProcessEnv, realHome: string): string[] {
  const hit: string[] = [];
  const same = (v: string | undefined) => !!v && path.resolve(v) === realHome;
  if (same(env.HOME)) hit.push(`HOME=${env.HOME}`);
  if (same(env.USERPROFILE)) hit.push(`USERPROFILE=${env.USERPROFILE}`);
  if (env.HOMEPATH && same(`${env.HOMEDRIVE ?? ""}${env.HOMEPATH}`)) hit.push(`HOMEDRIVE+HOMEPATH=${env.HOMEDRIVE ?? ""}${env.HOMEPATH}`);
  return hit;
}
const INSTANCE_ENV = ["RELAY_HOME", "RELAY_DB_PATH", "RELAY_CONFIG_PATH"] as const;

function recordViolationLine(line: string): void {
  try {
    fs.appendFileSync(state().log, `${line.replace(/\n/g, " ")}\n`);
  } catch {
    /* best effort */
  }
}

/** The env a child actually gets: the test's env (or ours), plus the tripwire. Throws BEFORE the spawn on an operator path. */
export function decorateChildEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const st = state();
  const base = env ?? process.env;
  const named: string[] = namesRealHome(base, st.realHome);
  for (const k of INSTANCE_ENV) if (base[k] && underOperatorRoot(base[k])) named.push(`${k}=${base[k]}`);
  if (named.length) {
    const line = `env a child env names the OPERATOR's home or relay root: ${named.join(" ")}`;
    recordViolationLine(line);
    drainTripwireViolations(); // reported here, at the spawn: not again in afterEach
    throw new OperatorTripwireError(`OPERATOR_TRIPWIRE: refused to spawn: ${line}. Give the child its own HOME / RELAY_HOME / RELAY_DB_PATH.`);
  }
  const out: NodeJS.ProcessEnv = { ...base };
  // Without them, bash's ~ and node's os.homedir() fall back to the ACCOUNT's real home (passwd
  // on unix, the profile on Windows): the operator's. Each missing spelling gets the private one.
  const priv = privateHomeEnv(st.home);
  for (const k of HOME_KEYS) if (base[k] === undefined) out[k] = priv[k];
  out.RELAY_TEST_OPERATOR_PORTS = [...st.ports].join(",");
  out.RELAY_TEST_OPERATOR_ROOTS = JSON.stringify(st.roots);
  out.RELAY_TEST_TRIPWIRE_LOG = st.log;
  const imp = `--import=${pathToFileURL(PRELOAD).href}`;
  const nodeOpts = base.NODE_OPTIONS ?? "";
  if (!nodeOpts.includes(imp)) out.NODE_OPTIONS = `${nodeOpts} ${imp}`.trim();
  if (process.platform !== "win32") {
    const original = base.PATH ?? EXECVP_DEFAULT_PATH;
    const real = curlOn(original, st.shimDir);
    if (real) {
      out.RELAY_TEST_REAL_CURL = real;
      if (!original.split(path.delimiter).includes(st.shimDir)) out.PATH = `${st.shimDir}${path.delimiter}${original}`;
    }
  }
  return out;
}

/** The tripwire's own tests: treat `port` as an operator port until the returned function runs. */
export function addOperatorPortForTest(port: number): () => void {
  const st = state();
  st.ports.add(port);
  setTripwireConfig(st.ports, st.roots, st.log);
  process.env.RELAY_TEST_OPERATOR_PORTS = [...st.ports].join(",");
  return () => {
    st.ports.delete(port);
    setTripwireConfig(st.ports, st.roots, st.log);
    process.env.RELAY_TEST_OPERATOR_PORTS = [...st.ports].join(",");
  };
}

/** The operator's real relay roots and home, as the tripwire sees them (for its own tests). */
export function tripwireView(): { roots: string[]; realHome: string; privateHome: string } {
  const st = state();
  return { roots: [...st.roots], realHome: st.realHome, privateHome: st.home };
}

/** New violations since the last check, consumed. */
export function drainTripwireViolations(): string[] {
  const st = state();
  let text = "";
  try {
    const buf = fs.readFileSync(st.log);
    text = buf.subarray(st.offset).toString("utf-8");
    st.offset = buf.length;
  } catch {
    return [];
  }
  return text.split("\n").filter(Boolean);
}

function failOnViolations(where: string): void {
  const v = drainTripwireViolations();
  if (v.length) {
    throw new OperatorTripwireError(
      `OPERATOR_TRIPWIRE (${where}): this test reached the OPERATOR's live relay (refused, never delivered). Pin RELAY_HTTP_PORT / HOME / RELAY_DB_PATH for the child or code path:\n  ${v.join("\n  ")}`,
    );
  }
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
    if (sync) failOnViolations(`child_process.${name}`);
    return r;
  } as AnyFn & { [WRAPPED]?: true };
  // promisify(exec/execFile) resolves {stdout, stderr} through this custom symbol.
  const custom = (original as unknown as Record<symbol, unknown>)[Symbol.for("nodejs.util.promisify.custom")];
  if (custom !== undefined) Object.defineProperty(wrapped, Symbol.for("nodejs.util.promisify.custom"), { value: (...args: unknown[]) => (custom as AnyFn)(...withTripwireEnv(args, argvAt1)) });
  wrapped[WRAPPED] = true;
  mod[name] = wrapped;
}

if (!state()) {
  const realHome = path.resolve(os.userInfo().homedir);
  const roots = [path.join(realHome, ".bot-relay")];
  if (process.env.RELAY_HOME && path.isAbsolute(process.env.RELAY_HOME)) roots.push(path.resolve(process.env.RELAY_HOME));
  for (const r of [...roots]) {
    try {
      const real = fs.realpathSync(r);
      if (!roots.includes(real)) roots.push(real);
    } catch {
      /* absent: nothing to resolve */
    }
  }
  const ports = discoverOperatorPorts(roots[0], process.env.RELAY_HTTP_PORT);
  // Canonical (realpath): a HOME behind a symlink (macOS /var → /private/var) reads as outside
  // itself to code that compares a resolved cwd with $HOME.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bot-relay-tripwire-")));
  const shimDir = path.join(dir, "bin");
  fs.mkdirSync(shimDir);
  fs.writeFileSync(path.join(shimDir, "curl"), CURL_SHIM, { mode: 0o755 });
  const log = path.join(dir, "violations.log");
  fs.writeFileSync(log, "");
  // The INSTANCE half's default route: a private HOME for this worker. A test that needs its
  // own HOME or RELAY_HOME still sets it; this only replaces the ambient one.
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  Object.assign(process.env, privateHomeEnv(home)); // HOME, and USERPROFILE + HOMEDRIVE/HOMEPATH for Windows
  // The PORT half's default route: code that falls back to RELAY_HTTP_PORT (a doctor probe, the
  // mint-token "is a daemon up?" check) reaches a closed port, never the operator's. Port 1:
  // refused at once, and no unprivileged test can bind it. A test that needs its own port sets
  // it; a child env built from scratch does not inherit this, and the tripwire covers it.
  process.env.RELAY_HTTP_PORT = SAFE_PORT;
  (globalThis as Record<symbol, TripwireState>)[STATE_KEY] = { dir, home, realHome, shimDir, log, offset: 0, ports, roots };
  process.env.RELAY_TEST_OPERATOR_PORTS = [...ports].join(",");
  process.env.RELAY_TEST_OPERATOR_ROOTS = JSON.stringify(roots);
  process.env.RELAY_TEST_TRIPWIRE_LOG = log;
  setTripwireConfig(ports, roots, log); // arms the preload's net and fs halves (installed on import)
  wrap("spawn", false, true);
  wrap("execFile", false, true);
  wrap("fork", false, true);
  wrap("exec", false, false);
  wrap("spawnSync", true, true);
  wrap("execFileSync", true, true);
  wrap("execSync", true, false);
  syncBuiltinESMExports(); // named ESM imports of node:child_process see the wrappers too
}

afterEach(() => failOnViolations("afterEach"));
