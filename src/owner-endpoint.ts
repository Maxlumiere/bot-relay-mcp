// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Hook PR 1, as ruled (redesigned after Codex #418 R1, hardened after R2): THE OWNER RECORD AND THE OWNER DOOR. A wasm
 * DB has ONE opener, its owner; the hooks reach its mail through that owner over loopback HTTP, never by the file.
 * - Every LISTENING wasm owner writes `realpath(parent)/.<canonical basename>.relay-owner.json` AFTER it is listening:
 *   `{v: 2, host, port, pid, pid_start, key, transport, instance_id, db_path}`. The writer is bound to ONE fd: the temp
 *   file is created O_CREAT|O_EXCL (+O_NOFOLLOW), protected (POSIX fchmod 0600 through the fd; Windows the owner-only
 *   ACL), VERIFIED (owner, mode/ACL, fstat(fd) == lstat(path) identity), and only THEN receives the key through the fd
 *   (fsync), then is renamed onto the record. It is NEVER deleted; a new owner overwrites it.
 * - The `key` (128 bits, fresh per process) never leaves the record and this process. THE DOOR (POST /owner/v1/peek
 *   and /owner/v1/liveness) carries NO bearer credential: requests and replies are MAC'd with the key over a text that
 *   includes the INSTANCE BINDING (instance_id + the canonical DB path), so a record or a reply bound to another
 *   instance never verifies. |ts - now| <= 30 s; a nonce is accepted once (kept until its ts leaves the window; the cache
 *   is bounded and refuses when full).
 * - The record is TRUSTED (cross-user; the guarantee is FILE-level, as ruled): opened without following a link, it is
 *   a regular file with one link, owned by this user, private (POSIX 0600; Windows the owner-only ACL), its path still
 *   names the opened file (identity), and its IMMEDIATE directory is not writable by others (POSIX: no group/other
 *   write unless sticky; Windows: no foreign write ACE). A trusted record is VALID while it names this DB and the DB's
 *   owner lock is HELD; its pid and start token are informational (the door's MAC proves the owner is live).
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { probeOwnerLock } from "./db-owner-lock.js";
import { readDriverHeader } from "./db-header.js";
import { processStartedAt, startOrNull } from "./liveness.js";
import { restrictToOwnerWindows, privacyFaults, windowsForeignWriteSids } from "./fs-perms.js";
import { sameFileIdentity } from "./file-identity.js";

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
  /** The instance binding (inside every door MAC): the resolved instance id ("" for an explicit DB path or flat). */
  instance_id: string;
  /** The canonical (realpath) DB path this record is for. */
  db_path: string;
}

/** The door's INSTANCE BINDING: both sides MAC it (as ruled). The owner's is set when it writes its record. */
export interface DoorBinding {
  instance_id: string;
  db_path: string;
}
let ownBinding: DoorBinding = { instance_id: "", db_path: "" };

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
export const OWNER_PEEK_REFUSAL = "this listener serves only the hooks' owner door (POST /owner/v1/peek, /liveness, /register, /health)";
export const OWNER_DOOR_PEEK = "/owner/v1/peek";
export const OWNER_DOOR_LIVENESS = "/owner/v1/liveness";
export const OWNER_DOOR_REGISTER = "/owner/v1/register";
export const OWNER_DOOR_HEALTH = "/owner/v1/health";
const OWNER_DOOR_PATHS: ReadonlySet<string> = new Set([OWNER_DOOR_PEEK, OWNER_DOOR_LIVENESS, OWNER_DOOR_REGISTER, OWNER_DOOR_HEALTH]);

/** The owner-peek gate, before any parse: the two door endpoints, POST, without an MCP session. */
export function ownerPeekRouteAllowed(method: string, reqPath: string, hasSession: boolean): boolean {
  return method === "POST" && !hasSession && OWNER_DOOR_PATHS.has(reqPath);
}

// --- Writing the record --------------------------------------------------------------------------------------------

let aclRestrictForTests: ((p: string) => string[]) | null = null;
/** Tests only: replace the platform protection step (and observe the temp file at that moment); null restores it. */
export function _setAclRestrictForTests(fn: ((p: string) => string[]) | null): void {
  aclRestrictForTests = fn;
}
let writerHookForTests: ((tmp: string) => void) | null = null;
/** Tests only: called right after the temp file is created (a race seam: swap its name here). */
export function _setWriterHookForTests(fn: ((tmp: string) => void) | null): void {
  writerHookForTests = fn;
}
function protectPrivate(p: string, fd: number): string[] {
  if (aclRestrictForTests) return aclRestrictForTests(p);
  if (process.platform !== "win32") {
    fs.fchmodSync(fd, 0o600);
    return [];
  }
  const faults = restrictToOwnerWindows(p, false);
  return faults.length > 0 ? faults : privacyFaults(p, 0o600);
}
/** Identity by exact (dev, ino) BigInts (src/file-identity.ts). */
const sameFile = (a: fs.BigIntStats, b: fs.BigIntStats) => sameFileIdentity(a, b);
const euidNow = () => (typeof process.geteuid === "function" ? process.geteuid() : -1);

/**
 * Write this owner's record for the DB at `dbPath`, listening on `port` (called only once listening), bound to the
 * instance `instanceId`. Fd-bound (as ruled): create O_CREAT|O_EXCL(|O_NOFOLLOW) → protect → VERIFY owner, mode/ACL and
 * fd↔path identity → only then the key, through the fd → fsync → rename. Any fault: no record, the temp name removed.
 */
export function writeOwnerEndpoint(dbPath: string, port: number, transport: OwnerEndpointRecord["transport"], instanceId = ""): string {
  const real = fs.realpathSync.native(dbPath);
  const file = ownerEndpointPath(dbPath);
  ownBinding = { instance_id: instanceId, db_path: real };
  const record: OwnerEndpointRecord = {
    v: OWNER_ENDPOINT_VERSION,
    host: "127.0.0.1",
    port,
    pid: process.pid,
    pid_start: startOrNull(processStartedAt(process.pid)),
    key: KEY,
    transport,
    instance_id: instanceId,
    db_path: real,
  };
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  const nofollow = (fs.constants as Record<string, number>).O_NOFOLLOW ?? 0;
  const fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | nofollow, 0o600);
  try {
    if (writerHookForTests) writerHookForTests(tmp);
    const faults = protectPrivate(tmp, fd);
    if (faults.length > 0) throw new Error(`the record's temp file could not be made owner-only: ${faults.join("; ")}`);
    const st = fs.fstatSync(fd, { bigint: true });
    const lst = fs.lstatSync(tmp, { bigint: true });
    if (!lst.isFile() || lst.isSymbolicLink() || !sameFile(st, lst) || st.nlink !== 1n) throw new Error("the record's temp file changed under its writer (its name no longer names the file it created)");
    if (process.platform !== "win32" && (st.uid !== BigInt(euidNow()) || (st.mode & 0o077n) !== 0n)) throw new Error("the record's temp file is not private to this user");
    fs.writeSync(fd, JSON.stringify(record) + "\n");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
    fs.rmSync(tmp, { force: true }); // this owner's own temp name, never the record
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
  | { ok: true; url: string; port: number; key: string; binding: DoorBinding }
  | {
      ok: false;
      reason: "no-record" | "untrusted-record" | "untrusted-dir" | "old-record" | "bad-record" | "bound-elsewhere" | "lock-free" | "lock-undecidable";
    };

let readerHookForTests: ((file: string) => void) | null = null;
/** Tests only: called after the record's descriptor checks, before the path↔fd identity check (a race seam). */
export function _setReaderHookForTests(fn: ((file: string) => void) | null): void {
  readerHookForTests = fn;
}

/** The IMMEDIATE directory's hygiene (as ruled): POSIX no group/other write unless sticky; Windows no foreign write ACE. */
function dirTrusted(dir: string): boolean {
  if (process.platform === "win32") {
    try {
      return windowsForeignWriteSids(dir).length === 0;
    } catch {
      return false;
    }
  }
  try {
    const st = fs.statSync(dir);
    return (st.mode & 0o022) === 0 || (st.mode & 0o1000) !== 0;
  } catch {
    return false;
  }
}

function readTrustedRecord(dbPath: string): { text: string } | { reason: "no-record" | "untrusted-record" | "untrusted-dir" } {
  let file: string;
  try {
    file = ownerEndpointPath(dbPath);
  } catch {
    return { reason: "no-record" };
  }
  if (!dirTrusted(path.dirname(file))) return { reason: "untrusted-dir" };
  const nofollow = (fs.constants as Record<string, number>).O_NOFOLLOW ?? 0;
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | nofollow);
  } catch (err) {
    return { reason: (err as NodeJS.ErrnoException).code === "ENOENT" ? "no-record" : "untrusted-record" };
  }
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    if (process.platform === "win32") {
      const lst = fs.lstatSync(file);
      if (!st.isFile() || lst.isSymbolicLink() || st.nlink !== 1n || privacyFaults(file, 0o600).length > 0) return { reason: "untrusted-record" };
    } else if (!recordStatTrusted({ isFile: () => st.isFile(), nlink: Number(st.nlink), uid: Number(st.uid), mode: Number(st.mode) }, euidNow())) {
      return { reason: "untrusted-record" };
    }
    if (readerHookForTests) readerHookForTests(file);
    let now: fs.BigIntStats;
    try {
      now = fs.statSync(file, { bigint: true });
    } catch {
      return { reason: "untrusted-record" };
    }
    if (!sameFile(st, now)) return { reason: "untrusted-record" }; // the path no longer names the file we checked
    return { text: fs.readFileSync(fd, "utf-8") };
  } catch {
    return { reason: "untrusted-record" };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The verdict on the DB's owner record, in order: trusted (the file and its immediate directory), well-formed (v2),
 * BOUND to this DB (its canonical path; and `instanceId` when the caller knows its own), and the owner lock HELD. The pid
 * and its start token are informational (as ruled): the door's MAC'd reply is what proves the owner live.
 */
export function ownerEndpointVerdict(dbPath: string, instanceId?: string): OwnerEndpointVerdict {
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
  if (typeof rec.instance_id !== "string" || typeof rec.db_path !== "string") return { ok: false, reason: "bad-record" };
  let real: string;
  try {
    real = fs.realpathSync.native(dbPath);
  } catch {
    return { ok: false, reason: "bound-elsewhere" };
  }
  if (rec.db_path !== real || (instanceId !== undefined && rec.instance_id !== instanceId)) return { ok: false, reason: "bound-elsewhere" };
  // A wasm DB's owner holds its single-owner lock: required. A native DB has no owner lock (hook PR 3: every daemon
  // writes a record); its liveness is the door's own authenticated reply.
  if (readDriverHeader(dbPath).kind === "wasm") {
    const lock = probeOwnerLock(dbPath).state;
    if (lock === "free") return { ok: false, reason: "lock-free" };
    if (lock !== "held") return { ok: false, reason: "lock-undecidable" };
  }
  return { ok: true, url: `http://127.0.0.1:${rec.port}`, port: rec.port as number, key: rec.key, binding: { instance_id: rec.instance_id, db_path: rec.db_path } };
}

/** The VALID record's URL (and key), or null. */
export function validOwnerEndpoint(dbPath: string): { url: string; key: string } | null {
  const v = ownerEndpointVerdict(dbPath);
  return v.ok ? { url: v.url, key: v.key } : null;
}

// --- The door: AES-256-GCM (as ruled after Codex #418 R2), the replay window ----------------------------------------

export const DOOR_WINDOW_SECS = 30;
/** Seconds a nonce is kept past its ts's window: the integer-second rounding of the window check. */
const DOOR_SKEW_SECS = 2;
export const DOOR_NONCE_CAPACITY = 4096;
const NONCE_RE = /^[0-9a-f]{32}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const AGENT_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** The door's two keys: HKDF-SHA256(the owner key, no salt, "relay-owner-door v1 req" / "... resp"), 32 bytes each. */
export function doorKey(keyHex: string, dir: "req" | "resp"): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(keyHex, "hex"), Buffer.alloc(0), `relay-owner-door v1 ${dir}`, 32));
}
/** The AAD of a request and of its reply (the reply adds its HTTP status). */
export const doorRequestAad = (b: DoorBinding, p: string, ts: number, nonce: string): Buffer =>
  Buffer.from(`req\n${p}\n${ts}\n${nonce}\n${b.instance_id}\n${b.db_path}`);
export const doorResponseAad = (b: DoorBinding, p: string, ts: number, nonce: string, status: number): Buffer =>
  Buffer.from(`resp\n${p}\n${ts}\n${nonce}\n${b.instance_id}\n${b.db_path}\n${status}`);
export interface SealedEnvelope {
  iv: string;
  ct: string;
  tag: string;
}
/** Seal `plain` (JSON) under `key` with `aad`: a fresh 96-bit IV per message. */
export function doorSeal(key: Buffer, aad: Buffer, plain: unknown): SealedEnvelope {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(JSON.stringify(plain), "utf-8"), c.final()]);
  return { iv: iv.toString("base64"), ct: ct.toString("base64"), tag: c.getAuthTag().toString("base64") };
}
/** Open an envelope, or null when it does not authenticate (a wrong key, a tampered byte, another AAD). */
export function doorOpen(key: Buffer, aad: Buffer, env: Partial<SealedEnvelope>): unknown | null {
  if (typeof env.iv !== "string" || typeof env.ct !== "string" || typeof env.tag !== "string") return null;
  if (!B64_RE.test(env.iv) || !B64_RE.test(env.tag) || (env.ct.length > 0 && !B64_RE.test(env.ct))) return null;
  const iv = Buffer.from(env.iv, "base64");
  const tag = Buffer.from(env.tag, "base64");
  if (iv.length !== 12 || tag.length !== 16) return null;
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
    d.setAAD(aad);
    d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(Buffer.from(env.ct, "base64")), d.final()]).toString("utf-8"));
  } catch {
    return null;
  }
}

/**
 * The replay cache (as ruled): nonce -> the instant its ts can no longer validate ((ts + window + skew) s). Evicted only
 * then (never by insertion age), by a timer independent of traffic; bounded, and REFUSING when full (fail closed).
 */
const seenNonces = new Map<string, number>();
export function sweepDoorNonces(nowMs: number): void {
  for (const [n, exp] of seenNonces) if (exp <= nowMs) seenNonces.delete(n);
}
export function doorNonceCount(): number {
  return seenNonces.size;
}
export function _resetDoorNoncesForTests(): void {
  seenNonces.clear();
}
setInterval(() => sweepDoorNonces(Date.now()), 10_000).unref();

export interface DoorRequest {
  agent_name: string;
  args: Record<string, unknown>;
  ts: number;
  nonce: string;
}
/**
 * The owner's open of a door request: the envelope {ts, client_nonce, iv, ct, tag}; ts within the window; the GCM
 * open under THIS owner's request key and the bound AAD (path, ts, nonce, instance binding); then the plaintext
 * {agent_name, args}; the nonce unseen (recorded only once it opened, so a forged request cannot burn one). `ts` and
 * `nonce` are returned whenever well-formed, so a refusal after them is sealed.
 */
export function openDoorRequest(
  p: string,
  rawBody: unknown,
  nowMs = Date.now(),
): { ok: true; req: DoorRequest } | { ok: false; status: number; error: string; ts?: number; nonce?: string } {
  if (typeof rawBody !== "string" || rawBody.length === 0) return { ok: false, status: 400, error: "the door takes a text/plain JSON body" };
  let b: { ts?: unknown; client_nonce?: unknown; iv?: unknown; ct?: unknown; tag?: unknown };
  try {
    b = JSON.parse(rawBody) as typeof b;
  } catch {
    return { ok: false, status: 400, error: "the body is not JSON" };
  }
  if (b === null || typeof b !== "object") return { ok: false, status: 400, error: "the body is not an object" };
  const nonce = typeof b.client_nonce === "string" && NONCE_RE.test(b.client_nonce) ? b.client_nonce : undefined;
  if (!nonce || !Number.isInteger(b.ts)) return { ok: false, status: 400, error: "a sealed envelope needs ts (an integer) and client_nonce (32 hex)" };
  const ts = b.ts as number;
  const plain = doorOpen(doorKey(KEY, "req"), doorRequestAad(ownBinding, p, ts, nonce), b as Partial<SealedEnvelope>);
  if (plain === null) return { ok: false, status: 401, error: "the request does not open (a wrong key, an altered byte, or a request bound to another path or instance)", ts, nonce };
  if (Math.abs(Math.floor(nowMs / 1000) - ts) > DOOR_WINDOW_SECS) return { ok: false, status: 401, error: "the request is outside the time window", ts, nonce };
  const pl = plain as { agent_name?: unknown; args?: unknown };
  if (typeof pl.agent_name !== "string" || !AGENT_RE.test(pl.agent_name)) return { ok: false, status: 400, error: "agent_name is not a valid agent name", ts, nonce };
  if (pl.args === null || typeof pl.args !== "object" || Array.isArray(pl.args)) return { ok: false, status: 400, error: "args must be an object", ts, nonce };
  if (seenNonces.has(nonce)) return { ok: false, status: 401, error: "the request was replayed (its nonce was seen)", ts, nonce };
  if (seenNonces.size >= DOOR_NONCE_CAPACITY) {
    sweepDoorNonces(nowMs);
    if (seenNonces.size >= DOOR_NONCE_CAPACITY) return { ok: false, status: 503, error: "the door's replay cache is full: try again shortly", ts, nonce };
  }
  seenNonces.set(nonce, (ts + DOOR_WINDOW_SECS + DOOR_SKEW_SECS) * 1000);
  return { ok: true, req: { agent_name: pl.agent_name, args: pl.args as Record<string, unknown>, ts, nonce } };
}

/** The owner's sealed reply (bound to the request's path, ts, nonce, its instance, and the status). */
export function sealDoorResponse(p: string, ts: number, nonce: string, status: number, payload: unknown): string {
  return JSON.stringify(doorSeal(doorKey(KEY, "resp"), doorResponseAad(ownBinding, p, ts, nonce, status), payload));
}
