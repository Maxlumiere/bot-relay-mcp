// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * INV-DB-01: a wasm-driven DB file is touched by ONE process only, and never while another process has it open.
 *
 * The owner holds ONE exclusive KERNEL primitive per platform, released by the kernel when the owner dies (no pid, no
 * lock file judged for staleness):
 * - macOS/BSD: open(<the DB's real parent dir>/.<canonical basename>.relay-owner,
 *   O_RDWR|O_CREAT|O_NONBLOCK|O_NOFOLLOW|O_EXLOCK, 0600), RULED: beside the DB, never under HOME, so every process on
 *   the DB contends for the same file whatever its HOME (two users, a launchd daemon). O_EXLOCK is 0x20 there (Node
 *   has no constant; libuv passes the flag through, MEASURED). A flock-style lock on its OWN file, so the wasm driver's
 *   opens and closes of the DB file never drop it. The leading "." keeps it out of SQLite's side-file names and the
 *   backup's destination-name rule; it is never archived. A lock file that is not private (another owner, a wider
 *   mode, a symlink) is a named refusal. It is never deleted (an unlink would race a contender).
 * - Linux: a listening ABSTRACT-namespace socket ("\0bot-relay-<key>"): no file, so no stale state.
 * - Windows: a listening named pipe (\\.\pipe\bot-relay-<key>); a second listener fails.
 *
 * THE KEY (ruled): the PARENT directory's (dev, ino), as bigint, plus the DB's canonical basename
 * (path.basename(fs.realpathSync.native(db))), hashed. Never the DB file's own (dev, ino): the wasm persist is tmp +
 * rename, which gives the DB a NEW inode (MEASURED), so a file-inode key would split after the first persist; renaming a
 * file inside a directory leaves the directory's inode alone. Symlink and `..` aliases resolve to the same canonical
 * file, and its parent's identity also collapses a bind mount of that directory; the basename is the OS's own
 * canonical spelling, so case variants collapse where the volume folds case. To have a canonical path, an absent DB is
 * MATERIALIZED first (created empty, O_CREAT|O_EXCL), and after the lock is held the key is RE-DERIVED: if it changed,
 * the lock is released and the acquire retried, so no owner stays on a stale key.
 * Documented limits: the same network share mounted twice (a different dev) stays two keys (a wasm DB must live on a
 * LOCAL filesystem); a HARD-LINKED DB is refused for wasm writes (assertSingleLink), since a rename persist would split
 * its names into two DBs anyway.
 *
 * Enablement by MEASUREMENT: acquireOwnerLock refuses on a platform the CI racer harness has not measured green
 * (MEASURED_PLATFORMS); the harness itself drives the ungated acquirePrimitive.
 */
import crypto from "crypto";
import fs from "fs";
import net from "net";
import path from "path";

/**
 * The platforms whose lock CI has measured green: the racer harness (exactly one owner in every round, the key stable
 * across a rename persist, alias spellings one owner; on Linux a bind mount one owner too) AND the behavioural
 * single-owner rows.
 * - macOS: the primitive at f3bba84 (job 123434320925); the behaviour at 48f24d5 (job 123461087379).
 * - Linux: the primitive at f3bba84 (jobs 123434321139 and 123434320394, where the bind-mount row ran); the behaviour
 *   at 48f24d5 (jobs 123461087219 and 123461086526).
 * - Windows: the primitive at f3bba84 (job 123434321133); its behavioural rows are NOT yet measured (at 48f24d5 a
 *   harness defect had ADR-0048 refuse them before the lock). It is listed so the next run measures them: the commit
 *   after that run cites its job id, or removes win32.
 */
export const MEASURED_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set<NodeJS.Platform>(["darwin", "linux", "win32"]);

const O_EXLOCK_DARWIN = 0x20;
const O_SHLOCK_DARWIN = 0x10;

/** How long an owner probe waits for the owner's socket or pipe to answer before refusing (never guessing). */
export const PROBE_TIMEOUT_MS = 1000;

let probeConnect: (name: string) => net.Socket = (name) => net.connect(name);
/** Test-only: replaces the probe's connect (e.g. with a socket that never answers). */
export function _setProbeConnectForTests(fn: ((name: string) => net.Socket) | null): void {
  probeConnect = fn ?? ((name) => net.connect(name));
}

export class OwnerLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnerLockError";
  }
}

/**
 * Create the DB file empty if it is absent (O_CREAT|O_EXCL: never truncates, a racer's file is kept). When THIS call
 * created it, `verifyCreated` runs with the creating fd still open (e.g. the caller's containment re-check: its path
 * may have been swapped since the caller last checked). A refusal removes the file only when it is PROVABLY the one
 * just created: the name still resolves to the fd's (dev, ino) and both are still empty. Otherwise it is left, and the
 * refusal says so. Residual (stated): the name can still be re-pointed between that comparison and the unlink.
 */
export function materializeDb(dbPath: string, verifyCreated?: (dbPath: string) => void): void {
  let fd: number;
  try {
    fd = fs.openSync(dbPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR, 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return;
    throw err;
  }
  try {
    verifyCreated?.(dbPath);
  } catch (err) {
    const left = removeIfJustCreated(dbPath, fd);
    if (left && err instanceof Error) err.message += ` The empty file this open had created at ${dbPath} was NOT removed (${left}).`;
    throw err;
  } finally {
    fs.closeSync(fd);
  }
}

/** Unlink `dbPath` only if it still names the fd's file and both are empty; returns why it was kept, or null. */
function removeIfJustCreated(dbPath: string, fd: number): string | null {
  try {
    const created = fs.fstatSync(fd, { bigint: true });
    const named = fs.lstatSync(dbPath, { bigint: true });
    if (named.dev !== created.dev || named.ino !== created.ino) return "the name now resolves to another file";
    if (created.size !== 0n || named.size !== 0n) return "it is no longer empty";
    fs.unlinkSync(dbPath);
    return null;
  } catch (err) {
    return `it could not be checked or removed: ${(err as Error).message}`;
  }
}

/**
 * The lock key of an EXISTING DB: its canonical file's PARENT directory (dev, ino) as bigint, plus its canonical
 * basename (the OS's own spelling), hashed. Stable across a rename persist (the directory's inode does not change).
 */
export function lockKey(dbPath: string): string {
  const real = fs.realpathSync.native(dbPath);
  const parent = fs.statSync(path.dirname(real), { bigint: true });
  return crypto.createHash("sha256").update(`${parent.dev}:${parent.ino}:${path.basename(real)}`).digest("hex").slice(0, 32);
}

/** A wasm WRITE refuses a hard-linked DB: a rename persist would turn its two names into two different DBs. */
export function assertSingleLink(dbPath: string): void {
  const st = fs.statSync(dbPath);
  if (st.nlink > 1) {
    throw new OwnerLockError(
      `the DB at ${dbPath} has ${st.nlink} hard links; the wasm driver refuses to write it (a write would split its names into separate databases). Remove the extra links, or use the native driver.`
    );
  }
}

/** macOS: the owner's lock file, a private dotfile beside the DB's canonical file (RULED). */
export function lockFilePath(dbPath: string): string {
  const real = fs.realpathSync.native(dbPath);
  return path.join(path.dirname(real), `.${path.basename(real)}.relay-owner`);
}

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/** Fail closed on a lock file this process cannot trust: not a regular file, another owner, or any group/other bit. */
function assertPrivateLockFile(fd: number, file: string): void {
  const st = fs.fstatSync(fd);
  const uid = typeof process.getuid === "function" ? process.getuid() : st.uid;
  if (!st.isFile() || st.uid !== uid || (st.mode & 0o077) !== 0) {
    throw new OwnerLockError(
      `the owner lock file ${file} is not private to this user (owner uid ${st.uid}, mode ${(st.mode & 0o777).toString(8)}), so it is not trusted. If no relay process uses the DB, remove it.`
    );
  }
}

/**
 * Open the lock file, never through a symlink. Each refusal names its cause: a planted symlink (ELOOP) or a lock file
 * that EXISTS but cannot be opened (another owner, mode 000) is "not private"; a lock file that cannot be CREATED (a
 * read-only DB directory) says so, and where.
 */
function openLockFile(file: string, flags: number, mode?: number): number {
  try {
    return fs.openSync(file, flags | O_NOFOLLOW, mode);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP") {
      throw new OwnerLockError(`the owner lock file ${file} is not private to this user (it is a symlink), so it is not trusted. If no relay process uses the DB, remove it.`);
    }
    if (code === "EACCES" || code === "EPERM") {
      let exists = false;
      try {
        fs.lstatSync(file);
        exists = true;
      } catch {
        /* absent, or its directory cannot be searched */
      }
      if (exists) {
        throw new OwnerLockError(
          `the owner lock file ${file} is not private to this user (it exists but cannot be opened: ${code}; check its owner and mode), so it is not trusted. If no relay process uses the DB, remove it.`
        );
      }
      throw new OwnerLockError(
        `cannot create the owner lock file in ${path.dirname(file)} (${code}): the wasm driver needs to write the DB's directory. Make it writable, or use the native driver.`
      );
    }
    throw err;
  }
}

/** Every primitive this process holds, by key, PINNED (a collected handle must never drop a lock). */
const HELD = new Map<string, { refs: number; drop: () => void }>();

export interface OwnerLock {
  key: string;
  /** Released by the kernel when the process exits; release() is for an orderly close. */
  release(): void;
}

function primitiveName(key: string): string {
  return process.platform === "win32" ? `\\\\.\\pipe\\bot-relay-${key}` : `\0bot-relay-${key}`;
}

function tryPrimitiveOnce(key: string, dbPath: string): Promise<(() => void) | null> {
  if (process.platform === "darwin") {
    const file = lockFilePath(dbPath);
    let fd: number;
    try {
      fd = openLockFile(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NONBLOCK | O_EXLOCK_DARWIN, 0o600);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EAGAIN" || code === "EWOULDBLOCK") return Promise.resolve(null);
      return Promise.reject(err);
    }
    try {
      assertPrivateLockFile(fd, file);
    } catch (err) {
      fs.closeSync(fd);
      return Promise.reject(err);
    }
    return Promise.resolve(() => fs.closeSync(fd));
  }
  if (process.platform !== "linux" && process.platform !== "win32") {
    return Promise.reject(new OwnerLockError(`no single-owner lock primitive is defined for ${process.platform}`));
  }
  const name = primitiveName(key);
  return new Promise((resolve, reject) => {
    const srv = net.createServer((c) => c.destroy());
    srv.once("error", (e: NodeJS.ErrnoException) => (e.code === "EADDRINUSE" ? resolve(null) : reject(e)));
    srv.listen(name, () => {
      srv.unref();
      resolve(() => srv.close());
    });
  });
}

/** Test-only: runs after the primitive is held and before the canonical path is re-derived. */
let afterAcquireHook: (() => void) | null = null;
export function _setAfterAcquireHookForTests(fn: (() => void) | null): void {
  afterAcquireHook = fn;
}

/**
 * The primitive for the DB at `dbPath`, NOT gated by MEASURED_PLATFORMS: what the CI racer harness measures, so a
 * platform can be enabled. Production code calls acquireOwnerLock. Materializes the DB, keys it, takes the primitive
 * with a bounded jittered retry, then re-derives the key: a changed key releases and retries; still changing, or
 * still held, is a named refusal.
 */
export interface AcquireOptions {
  /** At most this many tries (default: as many as the time budget allows). */
  attempts?: number;
  /** The total time budget for the retries (default ACQUIRE_BUDGET_MS); exhausting it is a named refusal. */
  budgetMs?: number;
  baseMs?: number;
  /** Runs when the acquire CREATED the DB (see materializeDb); a throw refuses, and the created file is removed. */
  verifyCreated?: (dbPath: string) => void;
  /** The platform the ENABLE gate judges (default: this one), so the gate is testable for any platform on any OS. The
   * primitive is always this OS's own. */
  platform?: NodeJS.Platform;
}

/** The acquire's default retry budget: a probe (a shared lock on macOS) racing the acquirer only delays it. */
export const ACQUIRE_BUDGET_MS = 3000;

export async function acquirePrimitive(dbPath: string, opts: AcquireOptions = {}): Promise<OwnerLock> {
  const attempts = opts.attempts ?? Number.POSITIVE_INFINITY;
  const base = opts.baseMs ?? 20;
  const deadline = Date.now() + (opts.budgetMs ?? ACQUIRE_BUDGET_MS);
  let lastReason = "held by another process";
  for (let i = 0; i < attempts; i++) {
    materializeDb(dbPath, opts.verifyCreated);
    const key = lockKey(dbPath);
    const own = HELD.get(key);
    if (own) {
      own.refs++;
      return { key, release: () => releaseKey(key) };
    }
    const drop = await tryPrimitiveOnce(key, dbPath);
    if (drop) {
      afterAcquireHook?.();
      let now: string | null;
      try {
        now = lockKey(dbPath);
      } catch {
        now = null;
      }
      if (now === key) {
        HELD.set(key, { refs: 1, drop });
        return { key, release: () => releaseKey(key) };
      }
      drop(); // the canonical path moved while we took the lock: never keep an owner on a stale key
      lastReason = "its canonical path changed while the lock was being taken";
    }
    if (i >= attempts - 1) break;
    // Jittered backoff, growing to a cap, never past the budget.
    const wait = Math.min(base * (i + 1), 200) + Math.floor(Math.random() * base);
    if (Date.now() + wait > deadline) break;
    await new Promise((r) => setTimeout(r, wait));
  }
  throw new OwnerLockError(
    `the DB at ${dbPath} could not be locked for this process (${lastReason}). Another relay process (wasm driver) may own it: stop it, or use the native driver.`
  );
}

function releaseKey(key: string): void {
  const h = HELD.get(key);
  if (!h) return;
  if (--h.refs > 0) return;
  HELD.delete(key);
  try {
    h.drop();
  } catch {
    /* the kernel releases it at exit anyway */
  }
}

/** The enable gate: a platform whose lock CI has not measured green refuses wasm writes, by name, with the remedy. */
export function assertPlatformEnabled(platform: NodeJS.Platform = process.platform): void {
  if (!MEASURED_PLATFORMS.has(platform)) {
    throw new OwnerLockError(
      `wasm writes are refused on ${platform}: its single-owner lock has not been measured here. Use the native driver.`
    );
  }
}

/**
 * The single-owner lock for a wasm-driven DB. Refuses by name on a platform not measured green (before anything is
 * materialized or locked), or when another process owns it.
 */
export async function acquireOwnerLock(dbPath: string, opts: AcquireOptions = {}): Promise<OwnerLock> {
  assertPlatformEnabled(opts.platform ?? process.platform);
  return acquirePrimitive(dbPath, opts);
}

/** Whether THIS process holds the owner lock for the DB at `dbPath` (the wasm persist checks it before every write). */
export function holdsOwnerLock(dbPath: string): boolean {
  try {
    return HELD.has(lockKey(dbPath));
  } catch {
    return false;
  }
}

/**
 * Whether ANOTHER process owns the DB at `dbPath`: a native process checks before opening and again right after. An
 * absent DB has no owner (a wasm owner materializes the file before it keys it). A probe never TAKES the primitive (two
 * native probers would each read the other as an owner), and CREATES nothing: macOS takes a SHARED flock on the owner
 * file if it exists (probers are compatible with each other; a wasm acquirer racing one retries within its budget); Linux and Windows CONNECT to the owner's socket or
 * pipe (a listener answering is an owner), bounded by PROBE_TIMEOUT_MS: no answer in time is a named refusal, never
 * read as FREE.
 */
export async function isOwnedElsewhere(dbPath: string): Promise<boolean> {
  if (!fs.existsSync(dbPath)) return false;
  if (!["darwin", "linux", "win32"].includes(process.platform)) return false;
  const key = lockKey(dbPath);
  if (HELD.has(key)) return false; // our own wasm connection, not another process
  if (process.platform === "darwin") {
    // A probe CREATES nothing (a native read must not write): an owner creates its lock file before it locks it, so
    // no lock file means no owner. A lock file that is not private is the same named refusal as for an acquire.
    const file = lockFilePath(dbPath);
    let fd: number;
    try {
      fd = openLockFile(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | O_SHLOCK_DARWIN);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return false;
      if (code === "EAGAIN" || code === "EWOULDBLOCK") return true;
      throw err;
    }
    try {
      assertPrivateLockFile(fd, file);
    } finally {
      fs.closeSync(fd);
    }
    return false;
  }
  return new Promise((resolve, reject) => {
    const sock = probeConnect(primitiveName(key));
    const settle = (then: () => void) => {
      clearTimeout(timer);
      sock.destroy();
      then();
    };
    const timer = setTimeout(
      () =>
        settle(() =>
          reject(
            new OwnerLockError(
              `could not tell within ${PROBE_TIMEOUT_MS} ms whether a wasm-driver process owns the DB at ${dbPath} (its owner ${process.platform === "win32" ? "pipe" : "socket"} did not answer), so it is not opened. Retry; if it persists, stop any wasm-driver relay process on it.`
            )
          )
        ),
      PROBE_TIMEOUT_MS
    );
    sock.once("connect", () => settle(() => resolve(true)));
    sock.once("error", (e: NodeJS.ErrnoException) =>
      settle(() => {
        if (e.code === "ECONNREFUSED" || e.code === "ENOENT") resolve(false);
        else if (e.code === "EAGAIN" || e.code === "EBUSY") resolve(true); // a listener exists, its queue is full
        else reject(e);
      })
    );
  });
}
