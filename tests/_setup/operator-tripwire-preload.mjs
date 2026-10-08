// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The OPERATOR TRIPWIRE's in-process half: plain JS, so a node CHILD can load it with `--import`
 * (tests/_setup/operator-tripwire.ts puts it in every child's NODE_OPTIONS), and the test worker loads
 * the same file. ONE implementation for both. It is DETECTION, best effort and catch-proof; the
 * PROTECTION is the private HOME and closed port every run gets from tests/_setup/vitest-tripwire-base.mjs.
 *
 *   - PORT: every TCP connect goes through net.Socket.prototype.connect (net.connect, http.request and
 *     fetch's connector included). A connect to THIS host on an operator port is recorded and refused.
 *     "This host" is decided on the ADDRESS, never its spelling: every loopback, unspecified and local
 *     interface address, in any spelling (net.BlockList compares bytes; ::ffff:7f00:1 is 127.0.0.1). A
 *     HOSTNAME is checked on what it RESOLVES to (the connect's lookup, a caller's own included).
 *   - INSTANCE: every synchronous fs call that reads or changes CONTENT under an operator root is
 *     recorded and THROWS. Both sides are CANONICAL: the deepest existing ancestor is realpath'd (a
 *     symlink alias such as /tmp -> /private/tmp is the same place), and on a case-insensitive volume
 *     both sides are case-folded. Metadata-only calls are not flagged (see below).
 *   - CONFIG is SNAPSHOT and FROZEN when this module first loads in a process: deleting or changing
 *     RELAY_TEST_* afterwards changes nothing. With no config at all it falls back to the account's real
 *     ~/.bot-relay and port 3777 (fail closed, never open).
 *   - A child whose HOME is the operator's real home, or at or under an operator root, REFUSES TO START.
 *
 * Every refusal is RECORDED as its own file in the run's private violations directory (never consumed,
 * never deleted): the run's global teardown fails the run if any exist, so a test that catches the
 * error cannot hide it. A record that cannot be written FAILS CLOSED: a child exits 97 at once; the test
 * worker marks itself so its next afterEach fails.
 *
 * THE BOUNDARY (ruling 621856a0, and on Codex #305 R2 NEW-1: this stops ACCIDENTAL drift, never a test
 * written to get around it). NOT CHECKED HERE: asynchronous fs (fs.promises, callback fs, streams, a sync
 * read on an fd from an async open); worker_threads (a Worker loads none of this); native SQLite opens
 * (better-sqlite3, node:sqlite: they never call node's fs); a grandchild a child spawns with env {}
 * (child_process is wrapped only in the test worker); a program that is not node (curl, sqlite3, bash).
 * These are NOT contained: an env-{} grandchild falls back to the ACCOUNT home and port 3777 (resolve-
 * instance.ts homeFor), and any of them can build a path from os.userInfo().homedir. What they WRITE to a
 * running live relay is DETECTED after the fact by the live-relay guard (tests/_setup/live-relay-guard.mjs),
 * which fails the run; what they only READ is neither contained nor detected (stated in the CHANGELOG; the
 * OS-level boundary, a disposable account, is its own project). tests/operator-path-scan.test.ts fails on a
 * LITERAL operator path or instance id in tests/ and hooks/.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import dns from "node:dns";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";

const INSTALLED = Symbol.for("bot-relay.operator-tripwire.preload");
const SNAPSHOT = Symbol.for("bot-relay.operator-tripwire.snapshot");
const RECORD_FAILED = Symbol.for("bot-relay.operator-tripwire.record-failed");
const IN_WORKER = Symbol.for("bot-relay.operator-tripwire.in-worker");
export const DEFAULT_OPERATOR_PORT = 3777;
/** Exit code of a child whose violation record could not be written (fail closed). */
export const RECORD_FAILED_EXIT = 97;

export class OperatorTripwireError extends Error {
  constructor(message) {
    super(message);
    this.name = "OperatorTripwireError";
    this.code = "OPERATOR_TRIPWIRE";
  }
}

// The UNWRAPPED fs functions, captured by the FIRST instance of this module in the process, before it
// wraps anything. A process can evaluate this file twice (node's --import, then the test runner's own
// module graph); the second instance must not capture the wrappers.
const RAW_KEY = Symbol.for("bot-relay.operator-tripwire.raw-fs");
globalThis[RAW_KEY] ??= Object.freeze({
  readFileSync: fs.readFileSync,
  readdirSync: fs.readdirSync,
  writeFileSync: fs.writeFileSync,
  mkdirSync: fs.mkdirSync,
  statSync: fs.statSync,
  realpathSync: fs.realpathSync.native,
});
/** For the tripwire's own discovery, recording and static scan. Nothing else may use them. */
export const RAW_FS = globalThis[RAW_KEY];

/** Is the volume holding `dir` case-insensitive? (Its case-swapped spelling names the same inode.) */
function caseInsensitiveAt(dir) {
  const swapped = dir.replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
  if (swapped === dir) return false;
  try {
    const a = RAW_FS.statSync(dir);
    const b = RAW_FS.statSync(swapped);
    return a.ino === b.ino && a.dev === b.dev;
  } catch {
    return false;
  }
}

const SEPARATORS = process.platform === "win32" ? /[\\/]+/ : /\/+/;
/**
 * Where the kernel would land for `abs`, resolved ONE COMPONENT AT A TIME (Codex #305 R2 NEW-4). A `..`
 * steps up from the REAL directory reached so far, so `<link>/../x` resolves from where the link points,
 * exactly as open(2) does (path.normalize would erase the link first and name another place). From the
 * first component that does not exist, the rest is joined lexically: nothing there can be a link.
 */
function realpathComponentwise(abs) {
  const { root } = path.parse(abs);
  const parts = abs.slice(root.length).split(SEPARATORS).filter(Boolean);
  // Without a `..`, the realpath of the deepest existing ancestor IS the answer: one call, not one per component.
  if (!parts.includes("..")) {
    const rest = [];
    let cur = abs;
    for (;;) {
      try {
        return path.join(RAW_FS.realpathSync(cur), ...rest.reverse());
      } catch {
        const parent = path.dirname(cur);
        if (parent === cur) return path.join(abs);
        rest.push(path.basename(cur));
        cur = parent;
      }
    }
  }
  let cur;
  try {
    cur = RAW_FS.realpathSync(root);
  } catch {
    cur = root;
  }
  for (let i = 0; i < parts.length; i++) {
    const c = parts[i];
    if (c === ".") continue;
    if (c === "..") {
      cur = path.dirname(cur);
      continue;
    }
    try {
      cur = RAW_FS.realpathSync(path.join(cur, c));
    } catch {
      return path.join(cur, ...parts.slice(i));
    }
  }
  return cur;
}

/** A path as a string, or null (a URL, a Buffer, a string; anything else is not a path). */
function asPath(p) {
  try {
    if (p instanceof URL) return fileURLToPath(p);
    if (Buffer.isBuffer(p)) return p.toString("utf-8");
    return typeof p === "string" ? p : null;
  } catch {
    return null;
  }
}

/** One canonical spelling of a path: absolute, symlinks resolved, case-folded when `fold`. */
export function canonicalPath(p, fold) {
  const s = asPath(p);
  if (s === null) return null;
  // Never normalized first: `..` is resolved against the real path reached so far (see realpathComponentwise).
  const real = realpathComponentwise(path.isAbsolute(s) ? s : `${process.cwd()}${path.sep}${s}`);
  return fold ? real.normalize("NFC").toLowerCase() : real;
}

function makeRoot(r) {
  const canonical = canonicalPath(r, false);
  // Probe case-sensitivity on the deepest EXISTING ancestor (the root itself may not exist).
  let probe = canonical;
  while (probe !== path.dirname(probe)) {
    try {
      RAW_FS.statSync(probe);
      break;
    } catch {
      probe = path.dirname(probe);
    }
  }
  const fold = caseInsensitiveAt(probe);
  return Object.freeze({ raw: r, fold, key: fold ? canonical.normalize("NFC").toLowerCase() : canonical });
}

function parseList(raw, fallback) {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

/** Build the frozen snapshot from an env (the process's own env, at first load). */
export function snapshotFromEnv(env) {
  const realHome = typeof env.RELAY_TEST_OPERATOR_HOME === "string" && path.isAbsolute(env.RELAY_TEST_OPERATOR_HOME) ? env.RELAY_TEST_OPERATOR_HOME : os.userInfo().homedir;
  const roots = parseList(env.RELAY_TEST_OPERATOR_ROOTS ?? "", null)?.filter((r) => typeof r === "string" && path.isAbsolute(r)) ?? [path.join(realHome, ".bot-relay")];
  const ports = String(env.RELAY_TEST_OPERATOR_PORTS ?? "")
    .split(",")
    .map((p) => Number(p.trim()))
    .filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
  return Object.freeze({
    realHome: makeRoot(realHome),
    roots: Object.freeze((roots.length ? roots : [path.join(realHome, ".bot-relay")]).map(makeRoot)),
    ports: Object.freeze(new Set(ports.length ? ports : [DEFAULT_OPERATOR_PORT])),
    recordDir: typeof env.RELAY_TEST_TRIPWIRE_DIR === "string" && path.isAbsolute(env.RELAY_TEST_TRIPWIRE_DIR) ? env.RELAY_TEST_TRIPWIRE_DIR : null,
  });
}

/** The frozen snapshot this process runs under. */
export function tripwireSnapshot() {
  return globalThis[SNAPSHOT];
}

/** Is `p` at or under an operator root? Returns that root's spelling, or null. Both sides canonical. */
export function underOperatorRoot(p, snap = tripwireSnapshot()) {
  const real = canonicalPath(p, false); // one realpath walk; folded per root below
  if (real === null) return null;
  for (const r of snap.roots) {
    const c = r.fold ? real.normalize("NFC").toLowerCase() : real;
    if (c === r.key || c.startsWith(r.key + path.sep)) return r.raw;
  }
  return null;
}

/** Is `p` the operator's real home (canonical)? */
export function isOperatorHome(p, snap = tripwireSnapshot()) {
  const c = canonicalPath(p, snap.realHome.fold);
  return c !== null && c === snap.realHome.key;
}

/** Record one violation as its OWN file (never consumed). Fails CLOSED when it cannot be written. */
export function recordViolation(line) {
  const dir = tripwireSnapshot()?.recordDir;
  const text = `${line.replace(/\n/g, " ")}\n`;
  try {
    if (!dir) throw new Error("no violations directory (RELAY_TEST_TRIPWIRE_DIR) in this process");
    RAW_FS.writeFileSync(path.join(dir, `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.txt`), text, { flag: "wx" });
  } catch (err) {
    const why = `OPERATOR_TRIPWIRE: could not record a violation (${err instanceof Error ? err.message : String(err)}): ${text}`;
    if (globalThis[IN_WORKER]) {
      globalThis[RECORD_FAILED] = why; // the worker's next afterEach fails on it
      return;
    }
    try {
      process.stderr.write(`${why}\n`);
    } finally {
      process.exit(RECORD_FAILED_EXIT);
    }
  }
}

/** The test worker marks itself, so a record failure fails its next afterEach instead of exiting it. */
export function markTestWorker() {
  globalThis[IN_WORKER] = true;
}
/** A record failure since the last check, consumed. */
export function takeRecordFailure() {
  const v = globalThis[RECORD_FAILED] ?? null;
  globalThis[RECORD_FAILED] = undefined;
  return v;
}

// ---------------------------------------------------------------------------------------------------
// PORT

/** Every address that reaches THIS host: loopback, unspecified, and each local interface address. */
function localAddresses() {
  const bl = new net.BlockList();
  bl.addSubnet("127.0.0.0", 8, "ipv4");
  bl.addSubnet("0.0.0.0", 8, "ipv4");
  bl.addAddress("::1", "ipv6");
  bl.addAddress("::", "ipv6");
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list ?? []) {
        const addr = a.address.split("%")[0];
        if (net.isIP(addr)) bl.addAddress(addr, net.isIPv6(addr) ? "ipv6" : "ipv4");
      }
    }
  } catch {
    /* loopback and unspecified still apply */
  }
  return bl;
}
let LOCAL = null;
/** Does this ADDRESS reach this host, in any spelling? Not an address → false (hostnames are resolved first). */
export function isLocalAddress(host) {
  const h = String(host ?? "").replace(/^\[|\]$/g, "").split("%")[0];
  const fam = net.isIP(h);
  if (!fam) return false;
  LOCAL ??= localAddresses();
  return LOCAL.check(h, fam === 6 ? "ipv6" : "ipv4");
}
const isLocalName = (h) => {
  const s = String(h).toLowerCase().replace(/\.$/, "");
  return s === "localhost" || s.endsWith(".localhost");
};

function refuseConnect(where) {
  recordViolation(`node pid=${process.pid} connect ${where}`);
  return new OperatorTripwireError(
    `OPERATOR_TRIPWIRE: a test connected to ${where}, an OPERATOR relay port on this host. Tests must never reach the operator's live relay: pin RELAY_HTTP_PORT (and the host) for this code path.`,
  );
}

/** A lookup that refuses (records, errors) when the name resolves to this host. */
function guardedLookup(original, port, hostLabel) {
  return function lookup(hostname, options, cb) {
    if (typeof options === "function") {
      cb = options;
      options = {};
    }
    original(hostname, options, (err, address, family) => {
      if (err) return cb(err, address, family);
      const all = Array.isArray(address) ? address.map((a) => a.address) : [address];
      const hit = all.find((a) => isLocalAddress(a));
      if (hit !== undefined) return cb(refuseConnect(`${hostLabel} (${hit}):${port}`));
      cb(null, address, family);
    });
  };
}

function installNetTripwire() {
  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function connect(...args) {
    let opts;
    let cb;
    if (Array.isArray(args[0])) {
      [opts, cb] = args[0]; // net.connect hands over its normalized [options, cb]
    } else if (args[0] !== null && typeof args[0] === "object") {
      [opts, cb] = args;
    } else if (typeof args[0] === "number" || (typeof args[0] === "string" && /^\d+$/.test(args[0]))) {
      opts = { port: args[0], host: typeof args[1] === "string" ? args[1] : undefined };
      cb = args.find((a) => typeof a === "function");
    } else {
      return original.apply(this, args); // a unix socket path
    }
    if (!opts || (opts.path !== undefined && opts.port === undefined)) return original.apply(this, args); // a unix socket
    const port = Number(opts.port);
    if (!tripwireSnapshot().ports.has(port)) return original.apply(this, args);
    const host = opts.host ?? opts.hostname;
    if (host === undefined || host === null || host === "" || isLocalName(host) || isLocalAddress(host)) throw refuseConnect(`${host || "localhost"}:${port}`);
    if (net.isIP(String(host).replace(/^\[|\]$/g, ""))) return original.apply(this, args); // a remote address
    // A hostname on an operator port: decided on what it RESOLVES to (the caller's own lookup included).
    const lookup = guardedLookup(opts.lookup ?? dns.lookup, port, host);
    return original.call(this, { ...opts, lookup }, cb);
  };
}

// ---------------------------------------------------------------------------------------------------
// INSTANCE

/**
 * Synchronous fs calls that read or change CONTENT (a file, a directory listing, a link's target) under a
 * path argument. Pure metadata (exists, stat, lstat, access, realpath) is NOT flagged: the relay's own
 * write guard canonicalizes the operator's real config path in order to REFUSE writing it. Resolving the
 * live instance always reads content: its marker is read with readlinkSync or readFileSync.
 */
const FS_ONE_PATH = ["openSync", "readFileSync", "readlinkSync", "readdirSync", "opendirSync", "writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "rmdirSync", "unlinkSync", "chmodSync", "chownSync", "utimesSync", "truncateSync"];
const FS_TWO_PATHS = ["renameSync", "copyFileSync", "symlinkSync", "linkSync", "cpSync"];

function installFsTripwire() {
  const wrapOne = (name, positions) => {
    const original = fs[name];
    if (typeof original !== "function") return;
    const wrapped = function (...args) {
      for (const i of positions) {
        const root = underOperatorRoot(args[i]);
        if (root) {
          recordViolation(`fs pid=${process.pid} ${name} ${String(args[i])}`);
          throw new OperatorTripwireError(
            `OPERATOR_TRIPWIRE: fs.${name}(${String(args[i])}) names the OPERATOR's live relay root (${root}). Tests must never resolve, read or write the operator's instance: give this code path its own HOME / RELAY_HOME / RELAY_DB_PATH.`,
          );
        }
      }
      return original.apply(this, args);
    };
    for (const k of Object.keys(original)) wrapped[k] = original[k]; // carry any statics over
    fs[name] = wrapped;
  };
  for (const n of FS_ONE_PATH) wrapOne(n, [0]);
  for (const n of FS_TWO_PATHS) wrapOne(n, [0, 1]);
}

// ---------------------------------------------------------------------------------------------------

if (!globalThis[INSTALLED]) {
  globalThis[INSTALLED] = true;
  globalThis[SNAPSHOT] = snapshotFromEnv({ ...process.env });
  // A process whose HOME is the operator's, or inside its relay root, must not run at all.
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home && (isOperatorHome(home) || underOperatorRoot(home))) {
    recordViolation(`home pid=${process.pid} HOME=${home}`);
    throw new OperatorTripwireError(`OPERATOR_TRIPWIRE: this process's HOME (${home}) is the OPERATOR's home or inside its relay root: refused to start.`);
  }
  installNetTripwire();
  installFsTripwire();
  syncBuiltinESMExports(); // named ESM imports of node:fs see the wrappers too
}
