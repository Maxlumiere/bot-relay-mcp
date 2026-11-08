// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Hook PR 1, as ruled (and redesigned after Codex #418 R1): THE OWNER RECORD AND THE OWNER DOOR. A wasm DB has ONE
 * opener, its owner; the hooks reach its mail through that owner over loopback HTTP instead of opening the file.
 * - Every LISTENING wasm owner writes `realpath(parent)/.<canonical basename>.relay-owner.json` AFTER it is listening:
 *   `{v: 2, host: "127.0.0.1", port, pid, pid_start, key, transport}`. The temp file is created empty, made
 *   owner-only (Windows: the owner-only ACL, verified) BEFORE any key byte is written, then renamed into place. It is
 *   NEVER deleted (not even on a clean exit); a new owner overwrites it.
 * - The `key` (128 bits, fresh per process) never leaves the record and this process. THE DOOR (POST /owner/v1/peek
 *   and /owner/v1/liveness) carries NO bearer credential: the request is MAC'd with the key over
 *   "req\n<path>\n<ts>\n<nonce>\n<body>" (|ts - now| <= 30 s; a nonce is accepted once), and the reply over
 *   "resp\n<nonce>\n<status>\n<body>", which the client verifies BEFORE it shows anything. A process that takes the
 *   port without the key learns a non-secret body and a MAC it cannot reuse, and cannot forge a reply.
 * - The record is TRUSTED only when (cross-user): it is opened without following a link and is a regular file with one
 *   link, owned by this effective uid, with no group/other bits, in a directory (the DB's real parent) owned by this
 *   uid and not group/other-writable; on Windows, not a link and owner-only by the SEC-04 ACL predicate. A trusted
 *   record is VALID while the DB's owner lock is HELD and its pid is alive with the same start token.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { probeOwnerLock } from "./db-owner-lock.js";
import { processStartedAt, startOrNull } from "./liveness.js";
import { restrictToOwnerWindows, privacyFaults } from "./fs-perms.js";

export const OWNER_ENDPOINT_VERSION = 2;
const KEY = crypto.randomBytes(16).toString("hex"); // this process's owner key: fresh per process, never served

export interface OwnerEndpointRecord {
  v: number;
  host: "127.0.0.1";
  port: number;
  pid: number;
  pid_start: string | null;
  key: string;
  transport: "http" | "stdio";
}

/** The record's path for the DB at `dbPath`: beside its CANONICAL file, a dotfile named after it. */
export function ownerEndpointPath(dbPath: string): string {
  const real = fs.realpathSync.native(dbPath);
  return path.join(path.dirname(real), `.${path.basename(real)}.relay-owner.json`);
}

/**
 * A BOUND address (server.address().address, never the requested host) that a client reaches as 127.0.0.1: the IPv4
 * loopback, or every IPv4 address. "::" is NOT counted (a v6-only socket does not take 127.0.0.1), nor ::1.
 */
export function addressReachesLoopback(address: string): boolean {
  return address === "127.0.0.1" || address === "0.0.0.0" || address === "::ffff:127.0.0.1";
}

/** Hook PR 1 (as ruled, Q9): the owner-peek listener's only host, a constant. */
export const OWNER_PEEK_HOST = "127.0.0.1";
export const OWNER_PEEK_REFUSAL = "this listener serves only the hooks' owner door (POST /owner/v1/peek, /owner/v1/liveness)";
export const OWNER_DOOR_PEEK = "/owner/v1/peek";
export const OWNER_DOOR_LIVENESS = "/owner/v1/liveness";

/** The owner-peek gate, before any parse: the two door endpoints, POST, without an MCP session. */
export function ownerPeekRouteAllowed(method: string, reqPath: string, hasSession: boolean): boolean {
  return method === "POST" && !hasSession && (reqPath === OWNER_DOOR_PEEK || reqPath === OWNER_DOOR_LIVENESS);
}

// --- Writing the record --------------------------------------------------------------------------------------------

let aclRestrictForTests: ((p: string) => string[]) | null = null;
/** Tests only: replace the platform ACL step (and observe the temp file at that moment); null restores it. */
export function _setAclRestrictForTests(fn: ((p: string) => string[]) | null): void {
  aclRestrictForTests = fn;
}
function restrictPrivate(p: string): string[] {
  if (aclRestrictForTests) return aclRestrictForTests(p);
  if (process.platform !== "win32") return []; // the 0600 exclusive create is the POSIX step
  const faults = restrictToOwnerWindows(p, false);
  return faults.length > 0 ? faults : privacyFaults(p, 0o600);
}

/**
 * Write this owner's record for the DB at `dbPath`, listening on `port` (called only once listening). The temp file
 * is created EMPTY and exclusive (0600), made owner-only and verified (any fault: no record, and the temp file goes),
 * and only then receives the key bytes (fsync'd) and is renamed onto the record (atomic).
 */
export function writeOwnerEndpoint(dbPath: string, port: number, transport: OwnerEndpointRecord["transport"]): string {
  const file = ownerEndpointPath(dbPath);
  const record: OwnerEndpointRecord = {
    v: OWNER_ENDPOINT_VERSION,
    host: "127.0.0.1",
    port,
    pid: process.pid,
    pid_start: startOrNull(processStartedAt(process.pid)),
    key: KEY,
    transport,
  };
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  fs.closeSync(fs.openSync(tmp, "wx", 0o600));
  try {
    const faults = restrictPrivate(tmp);
    if (faults.length > 0) throw new Error(`the record's temp file could not be made owner-only: ${faults.join("; ")}`);
    const fd = fs.openSync(tmp, "r+");
    try {
      fs.writeSync(fd, JSON.stringify(record) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true }); // this owner's own temp file, never the record
    throw err;
  }
  return file;
}

// --- Reading and trusting the record -------------------------------------------------------------------------------

/** The stat predicate (POSIX): a regular file, one link, owned by `euid`, no group/other permission bits. */
export function recordStatTrusted(st: { isFile(): boolean; nlink: number; uid: number; mode: number }, euid: number): boolean {
  return st.isFile() && st.nlink === 1 && st.uid === euid && (st.mode & 0o077) === 0;
}

export type OwnerEndpointVerdict =
  | { ok: true; url: string; port: number; key: string }
  | { ok: false; reason: "no-record" | "untrusted-record" | "untrusted-dir" | "old-record" | "bad-record" | "lock-free" | "lock-undecidable" | "pid-mismatch" };

function readTrustedRecord(dbPath: string): { text: string } | { reason: "no-record" | "untrusted-record" | "untrusted-dir" } {
  let file: string;
  try {
    file = ownerEndpointPath(dbPath);
  } catch {
    return { reason: "no-record" };
  }
  if (process.platform === "win32") {
    let lst: fs.Stats;
    try {
      lst = fs.lstatSync(file);
    } catch {
      return { reason: "no-record" };
    }
    if (!lst.isFile() || lst.isSymbolicLink() || lst.nlink !== 1) return { reason: "untrusted-record" };
    if (privacyFaults(file, 0o600).length > 0) return { reason: "untrusted-record" };
    try {
      return { text: fs.readFileSync(file, "utf-8") };
    } catch {
      return { reason: "no-record" };
    }
  }
  const euid = typeof process.geteuid === "function" ? process.geteuid() : -1;
  let dirSt: fs.Stats;
  try {
    dirSt = fs.statSync(path.dirname(file));
  } catch {
    return { reason: "untrusted-dir" };
  }
  if (dirSt.uid !== euid || (dirSt.mode & 0o022) !== 0) return { reason: "untrusted-dir" };
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    return { reason: (err as NodeJS.ErrnoException).code === "ENOENT" ? "no-record" : "untrusted-record" };
  }
  try {
    if (!recordStatTrusted(fs.fstatSync(fd), euid)) return { reason: "untrusted-record" };
    return { text: fs.readFileSync(fd, "utf-8") };
  } catch {
    return { reason: "untrusted-record" };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The verdict on the DB's owner record, in order: trusted (the record and its directory), well-formed (v2), the owner
 * lock HELD (decided by the lock on every OS), the pid alive with the same start token. Validity is not identity: the
 * door's MACs are.
 */
export function ownerEndpointVerdict(dbPath: string): OwnerEndpointVerdict {
  const r = readTrustedRecord(dbPath);
  if (!("text" in r)) return { ok: false, reason: r.reason };
  let rec: Partial<OwnerEndpointRecord>;
  try {
    rec = JSON.parse(r.text) as Partial<OwnerEndpointRecord>;
  } catch {
    return { ok: false, reason: "bad-record" };
  }
  if (rec.v === 1) return { ok: false, reason: "old-record" };
  if (rec.v !== OWNER_ENDPOINT_VERSION || rec.host !== "127.0.0.1") return { ok: false, reason: "bad-record" };
  if (!Number.isInteger(rec.port) || (rec.port as number) < 1 || (rec.port as number) > 65535) return { ok: false, reason: "bad-record" };
  if (typeof rec.key !== "string" || !/^[0-9a-f]{32}$/.test(rec.key)) return { ok: false, reason: "bad-record" };
  if (!Number.isInteger(rec.pid) || (rec.pid as number) <= 0) return { ok: false, reason: "bad-record" };
  const lock = probeOwnerLock(dbPath).state;
  if (lock === "free") return { ok: false, reason: "lock-free" };
  if (lock !== "held") return { ok: false, reason: "lock-undecidable" };
  const now = processStartedAt(rec.pid as number);
  if (typeof rec.pid_start !== "string" || rec.pid_start.length === 0 || now.kind !== "start" || now.start !== rec.pid_start) return { ok: false, reason: "pid-mismatch" };
  return { ok: true, url: `http://127.0.0.1:${rec.port}`, port: rec.port as number, key: rec.key };
}

/** The VALID record's URL (and key), or null. */
export function validOwnerEndpoint(dbPath: string): { url: string; key: string } | null {
  const v = ownerEndpointVerdict(dbPath);
  return v.ok ? { url: v.url, key: v.key } : null;
}

// --- The door: MACs, the replay window ------------------------------------------------------------------------------

export const DOOR_WINDOW_SECS = 30;
const NONCE_RE = /^[0-9a-f]{32}$/;
const AGENT_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export function doorMac(keyHex: string, text: string): string {
  return crypto.createHmac("sha256", Buffer.from(keyHex, "hex")).update(text).digest("hex");
}
export const doorRequestText = (p: string, ts: number, nonce: string, body: string) => `req\n${p}\n${ts}\n${nonce}\n${body}`;
export const doorResponseText = (nonce: string, status: number, body: string) => `resp\n${nonce}\n${status}\n${body}`;
export function macEqual(a: string, b: string): boolean {
  const x = Buffer.from(/^[0-9a-f]{64}$/.test(a) ? a : "", "hex");
  const y = Buffer.from(/^[0-9a-f]{64}$/.test(b) ? b : "", "hex");
  return x.length === 32 && y.length === 32 && crypto.timingSafeEqual(x, y);
}

const seenNonces = new Map<string, number>(); // nonce -> expiry (ms): a nonce is accepted ONCE within the window
function nonceFresh(nonce: string, nowMs: number): boolean {
  for (const [n, exp] of seenNonces) if (exp <= nowMs) seenNonces.delete(n);
  if (false && seenNonces.has(nonce)) return false; // PROBE
  seenNonces.set(nonce, nowMs + 2 * DOOR_WINDOW_SECS * 1000);
  return true;
}

export interface DoorRequest {
  agent_name: string;
  args: Record<string, unknown>;
  ts: number;
  nonce: string;
}
/**
 * The owner's check of a door request: the raw body parses to {agent_name, args, ts, client_nonce}; the header MAC
 * matches (constant time) THIS process's key over the request text; ts is within the window; the nonce is unseen
 * (recorded only once the MAC holds, so a forged request cannot burn a nonce). `nonce` is returned whenever it is
 * well-formed, so even a refusal can be MAC'd.
 */
export function verifyDoorRequest(
  p: string,
  rawBody: unknown,
  macHeader: unknown,
  nowMs = Date.now(),
): { ok: true; req: DoorRequest } | { ok: false; status: number; error: string; nonce?: string } {
  if (typeof rawBody !== "string" || rawBody.length === 0) return { ok: false, status: 400, error: "the door takes a text/plain JSON body" };
  let b: { agent_name?: unknown; args?: unknown; ts?: unknown; client_nonce?: unknown };
  try {
    b = JSON.parse(rawBody) as typeof b;
  } catch {
    return { ok: false, status: 400, error: "the body is not JSON" };
  }
  if (b === null || typeof b !== "object") return { ok: false, status: 400, error: "the body is not an object" };
  const nonce = typeof b.client_nonce === "string" && NONCE_RE.test(b.client_nonce) ? b.client_nonce : undefined;
  if (!nonce) return { ok: false, status: 400, error: "client_nonce must be 32 hex characters" };
  if (!Number.isInteger(b.ts)) return { ok: false, status: 400, error: "ts must be an integer (unix seconds)", nonce };
  if (typeof b.agent_name !== "string" || !AGENT_RE.test(b.agent_name)) return { ok: false, status: 400, error: "agent_name is not a valid agent name", nonce };
  if (b.args === null || typeof b.args !== "object" || Array.isArray(b.args)) return { ok: false, status: 400, error: "args must be an object", nonce };
  const ts = b.ts as number;
  if (typeof macHeader !== "string" || !macEqual(macHeader, doorMac(KEY, doorRequestText(p, ts, nonce, rawBody)))) {
    return { ok: false, status: 401, error: "the request MAC does not verify", nonce };
  }
  if (Math.abs(Math.floor(nowMs / 1000) - ts) > DOOR_WINDOW_SECS) return { ok: false, status: 401, error: "the request is outside the time window", nonce };
  if (!nonceFresh(nonce, nowMs)) return { ok: false, status: 401, error: "the request was replayed (its nonce was seen)", nonce };
  return { ok: true, req: { agent_name: b.agent_name, args: b.args as Record<string, unknown>, ts, nonce } };
}

/** The owner's MAC on its reply. */
export function signDoorResponse(nonce: string, status: number, body: string): string {
  return doorMac(KEY, doorResponseText(nonce, status, body));
}
