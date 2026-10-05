// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The OPERATOR TRIPWIRE's in-process half: plain JS, so a node CHILD can load it with
 * `--import` (tests/_setup/operator-tripwire.ts puts it in every child's NODE_OPTIONS), and
 * the test process loads the same file. ONE implementation for both.
 *
 *   - PORT: every TCP connect goes through net.Socket.prototype.connect (net.connect,
 *     http.request and fetch's connector included). A connect to a LOOPBACK host on an
 *     operator port is recorded and THROWS: it never reaches the operator's live relay.
 *   - INSTANCE: every synchronous fs call that reads or changes CONTENT under the operator's
 *     REAL relay root (~/.bot-relay of the passwd home) is recorded and THROWS: no test
 *     resolves, reads or writes the operator's live instance (its active-instance marker,
 *     read to resolve, names the live DB). Metadata-only calls are not flagged (see below).
 *
 * The record is what the test process reads: a violation inside a child, or one a test
 * catches, still fails the test that caused it.
 *
 * Configuration (set by the setup module; the test process also keeps it in a process-global
 * that survives a test replacing process.env):
 *   RELAY_TEST_OPERATOR_PORTS  comma-separated ports
 *   RELAY_TEST_OPERATOR_ROOTS  a JSON array of absolute directories
 *   RELAY_TEST_TRIPWIRE_LOG    the log file (one line per violation)
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";

const INSTALLED = Symbol.for("bot-relay.operator-tripwire.preload");
const CONFIG = Symbol.for("bot-relay.operator-tripwire.config");

export function setTripwireConfig(ports, roots, log) {
  globalThis[CONFIG] = { ports: [...ports], roots: [...roots], log };
}

export class OperatorTripwireError extends Error {
  constructor(message) {
    super(message);
    this.name = "OperatorTripwireError";
    this.code = "OPERATOR_TRIPWIRE";
  }
}

/** Loopback (or unspecified, which connects locally) hosts: the operator's relay is local. */
export function isLoopbackHost(host) {
  if (host === undefined || host === null || host === "") return true;
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "0.0.0.0" || h === "::" || h === "::1" || /^127\./.test(h) || /^::ffff:127\./.test(h) || h === "0:0:0:0:0:0:0:1";
}

export function operatorPorts(env = process.env) {
  const fromEnv = String(env.RELAY_TEST_OPERATOR_PORTS ?? "")
    .split(",")
    .map((p) => Number(p.trim()))
    .filter((p) => Number.isInteger(p) && p > 0);
  return new Set([...fromEnv, ...(globalThis[CONFIG]?.ports ?? [])]);
}

export function operatorRoots(env = process.env) {
  let fromEnv = [];
  try {
    fromEnv = JSON.parse(env.RELAY_TEST_OPERATOR_ROOTS ?? "[]");
  } catch {
    fromEnv = [];
  }
  return [...new Set([...fromEnv, ...(globalThis[CONFIG]?.roots ?? [])])].filter((r) => typeof r === "string" && path.isAbsolute(r));
}

/** Is `p` the operator's real relay root or anything under it? */
export function underOperatorRoot(p, roots = operatorRoots()) {
  let s;
  try {
    s = p instanceof URL ? fileURLToPath(p) : Buffer.isBuffer(p) ? p.toString("utf-8") : typeof p === "string" ? p : null;
  } catch {
    s = null;
  }
  if (s === null) return null;
  const abs = path.resolve(s);
  return roots.find((r) => abs === r || abs.startsWith(r + path.sep)) ?? null;
}

export function recordViolation(line, env = process.env) {
  const log = globalThis[CONFIG]?.log ?? env.RELAY_TEST_TRIPWIRE_LOG;
  if (!log) return;
  try {
    ORIGINAL_APPEND(log, `${line.replace(/\n/g, " ")}\n`);
  } catch {
    /* the throw still stops the access */
  }
}

/** The (port, host) a Socket#connect call targets, whichever of its call shapes was used. */
function target(args) {
  let first = args[0];
  // net.connect() hands Socket#connect its already-normalized [options, cb] array.
  if (Array.isArray(first)) first = first[0];
  if (first !== null && typeof first === "object") {
    if (first.path !== undefined && first.port === undefined) return null; // a unix socket
    return { port: Number(first.port), host: first.host ?? first.hostname };
  }
  if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) {
    return { port: Number(first), host: typeof args[1] === "string" ? args[1] : undefined };
  }
  return null; // a unix socket path
}

// The UNWRAPPED fs functions, captured by the FIRST instance of this module in the process,
// before it wraps anything. A process can evaluate this file twice (node's --import, then the
// test runner's own module graph); the second instance must not capture the wrappers.
const RAW_KEY = Symbol.for("bot-relay.operator-tripwire.raw-fs");
globalThis[RAW_KEY] ??= Object.freeze({ readFileSync: fs.readFileSync, readdirSync: fs.readdirSync, appendFileSync: fs.appendFileSync });
/** For the tripwire's own read-only discovery of the operator's ports. Nothing else may use them. */
export const RAW_FS = globalThis[RAW_KEY];
// Recording a violation can never recurse into the tripwire.
const ORIGINAL_APPEND = RAW_FS.appendFileSync;

/**
 * Synchronous fs calls that read or change CONTENT (a file, a directory listing, a link's
 * target) under a path argument. Pure metadata (exists, stat, lstat, access, realpath) is NOT
 * flagged: the relay's own write guard canonicalizes the operator's real config path in order
 * to REFUSE writing it. Resolving the live instance always reads content: its marker is read
 * with readlinkSync or readFileSync (src/resolve-instance.ts).
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

function installNetTripwire() {
  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function connect(...args) {
    const t = target(args);
    if (t && isLoopbackHost(t.host) && operatorPorts().has(t.port)) {
      const where = `${t.host ?? "localhost"}:${t.port}`;
      recordViolation(`node pid=${process.pid} connect ${where}`);
      throw new OperatorTripwireError(
        `OPERATOR_TRIPWIRE: a test connected to ${where}, an OPERATOR relay port. Tests must never reach the operator's live relay: pin RELAY_HTTP_PORT (and the host) for this code path.`,
      );
    }
    return original.apply(this, args);
  };
}

if (!globalThis[INSTALLED]) {
  globalThis[INSTALLED] = true;
  installNetTripwire();
  installFsTripwire();
  syncBuiltinESMExports(); // named ESM imports of node:fs see the wrappers too
}
