// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * INV-DB-01 (slice 2b-ii): an OWNED wasm DB (stamped RLYW, see db-header.ts) is opened by ONE process only: the holder
 * of its single-owner lock. Ported from the INV-DB-01 single-owner draft at its last reviewed state, scoped to owned
 * DBs: native processes do not probe (an RLYW header refuses them), so the probe is not part of this module.
 *
 * The owner holds ONE exclusive KERNEL lock per platform, released by the kernel when the owner dies (no pid, no lock
 * file judged for staleness; a pid file is not consulted either, since a reused pid would make it lie):
 * - POSIX (ruling 594ca4cc: ONE scheme): a flock-class exclusive lock on <the DB's real parent dir>/.<canonical
 *   basename>.relay-owner (0600, O_NOFOLLOW), beside the DB, never under HOME, so every process on the DB contends for
 *   the same file whatever its HOME or its network namespace (two users, a launchd daemon, two containers sharing the
 *   directory). A flock lock belongs to the open file, not to the process, so the wasm driver's opens and closes of
 *   the DB file never drop it.
 *   - macOS: open(... O_RDWR|O_CREAT|O_NONBLOCK|O_NOFOLLOW|O_EXLOCK). O_EXLOCK is 0x20 there (Node has no constant;
 *     libuv passes the flag through, MEASURED).
 *   - Linux: Node core has no flock (MEASURED, v24: no fs.flock/flockSync), and the wasm owner cannot rely on a native
 *     addon. This process opens the lock file itself and runs the system `flock -n 3` (SEC-22: its trusted absolute
 *     path, a clean env) with that open file as the child's fd 3: the child locks the SHARED open file and exits, and
 *     the lock stays with this process's descriptor until it closes or dies. No holder process is left behind.
 *   - Linux with no trusted `flock` (a non-FHS host): the listening ABSTRACT-namespace socket ("\0bot-relay-<key>").
 *     STATED LIMIT, warned once per process: abstract sockets are per network namespace, so that fallback excludes
 *     only processes in the SAME network namespace (one container per DB).
 *   The leading "." keeps the lock file out of SQLite's side-file names and the backup's destination-name rule; it is
 *   never archived and NEVER deleted (an unlink would let a contender lock a new file: two owners). A lock file that
 *   is not private (another owner, a wider mode, a symlink) or that has more than one link (a hard link to anything,
 *   e.g. a DB a native handle holds: opening it would drop that handle's locks) is refused by name, the link count
 *   BEFORE it is opened. While held, its identity is re-checked before every owner write (assertLockIntact): a lock
 *   file removed or replaced under the owner stops the owner's writes.
 * - Windows: a listening named pipe (\\.\pipe\bot-relay-<key>); a second listener fails. STATED LIMIT: per session
 *   namespace (one container per DB).
 *
 * THE KEY (ruled): the PARENT directory's (dev, ino), as bigint, plus the DB's canonical basename
 * (path.basename(fs.realpathSync.native(db))), hashed. Never the DB file's own (dev, ino): the wasm persist is tmp +
 * rename, which gives the DB a NEW inode (MEASURED), so a file-inode key would split after the first persist; renaming a
 * file inside a directory leaves the directory's inode alone. Symlink and `..` aliases resolve to the same canonical
 * file, and its parent's identity also collapses a bind mount of that directory; the basename is the OS's own
 * canonical spelling, so case variants collapse where the volume folds case. To have a canonical path, an absent DB is
 * MATERIALIZED first: its first image (already stamped RLYW) is written to a temp file in the same directory and LINKED
 * into place (link fails if the name exists), so the name only ever appears complete and stamped: a native opener
 * never sees an empty or unstamped file there. After the lock is held the key is RE-DERIVED: if it changed, the lock
 * is released and the acquire retried, so no owner stays on a stale key.
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
import { log } from "./logger.js";
import { spawnSystem, systemBinary } from "./system-binary.js";

/**
 * The platforms whose lock CI has measured green: the racer harness (exactly one owner in every round, the key stable
 * across a rename persist, alias spellings one owner; on Linux a bind mount one owner too) AND the behavioural
 * single-owner rows.
 * - macOS: the primitive at f3bba84 (job 123434320925); the behaviour at 48f24d5 (job 123461087379).
 * - Linux: the ABSTRACT-SOCKET primitive (now only the no-flock fallback) at f3bba84 (jobs 123434321139 and
 *   123434320394, where the bind-mount row ran); the behaviour at 48f24d5 (jobs 123461087219 and 123461086526). The
 *   FLOCK-FILE scheme (ruling 594ca4cc) is measured by the same harness plus its two-network-namespace rows in the CI
 *   of the PR that introduced it (its job ids are recorded there).
 * - Windows: the primitive at f3bba84 (job 123434321133); the behaviour at 8820fa2 (job 123848369286: every
 *   behavioural single-owner row passed, none refused by ADR-0048).
 */
export const MEASURED_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set<NodeJS.Platform>(["darwin", "linux", "win32"]);

const O_EXLOCK_DARWIN = 0x20;

export class OwnerLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnerLockError";
  }
}

/** Test-only: runs after an absent DB was materialized and before the lock is taken (Q-C's row reads its header). */
let afterMaterializeHook: (() => void) | null = null;
export function _setAfterMaterializeHookForTests(fn: (() => void) | null): void {
  afterMaterializeHook = fn;
}

/**
 * Create the DB at `dbPath` if it is absent, with `initialBytes` (its first image, already stamped), ATOMICALLY: the
 * bytes go to a temp file in the same directory, which is then LINKED to the DB's name (link fails when the name
 * exists: a racer's file is kept, never overwritten), and the temp name is removed. When THIS call created it,
 * `verifyCreated` runs (no production caller passes one in this slice; the racer harness exercises it); a refusal
 * removes the DB only when it is PROVABLY the
 * one just created (the same dev + ino as the temp file's, the same size). Residual (stated): the name can still be
 * re-pointed between that comparison and the unlink.
 */
export function materializeDb(dbPath: string, initialBytes: Uint8Array, verifyCreated?: (dbPath: string) => void): void {
  if (fs.existsSync(dbPath)) return;
  const tmp = path.join(path.dirname(dbPath), `.${path.basename(dbPath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.new`);
  let created = false;
  try {
    // Inside the cleanup scope: a write that fails after the exclusive create (ENOSPC) leaves no partial temp behind.
    fs.writeFileSync(tmp, initialBytes, { mode: 0o600, flag: "wx" });
    try {
      fs.linkSync(tmp, dbPath);
      created = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    if (!created) return;
    const mine = fs.statSync(tmp, { bigint: true });
    try {
      verifyCreated?.(dbPath);
    } catch (err) {
      const left = removeIfJustCreated(dbPath, mine);
      if (left && err instanceof Error) err.message += ` The file this open had created at ${dbPath} was NOT removed (${left}).`;
      throw err;
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Unlink `dbPath` only if it still names the created file (same dev + ino and size); returns why it was kept, or null. */
function removeIfJustCreated(dbPath: string, created: fs.BigIntStats): string | null {
  try {
    const named = fs.lstatSync(dbPath, { bigint: true });
    if (named.dev !== created.dev || named.ino !== created.ino) return "the name now resolves to another file";
    if (named.size !== created.size) return "it changed since it was created";
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

/**
 * The name a persist (or a restore swap) replaces: the DB's CANONICAL path, fully resolved (every directory and the
 * file itself). Renaming onto a symlinked DB path would replace the LINK, leaving the real DB unchanged and a second
 * DB at the link's name; renaming onto the caller's basename would, on a case-insensitive volume, give the file that
 * spelling, so its lock key would drift.
 */
export function canonicalReplaceTarget(dbPath: string): string {
  return fs.realpathSync.native(dbPath);
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
  if (st.nlink !== 1) throw hardLinkedLockFile(file, st.nlink);
  if (!st.isFile() || st.uid !== uid || (st.mode & 0o077) !== 0) {
    throw new OwnerLockError(
      `the owner lock file ${file} is not private to this user (owner uid ${st.uid}, mode ${(st.mode & 0o777).toString(8)}), so it is not trusted. If no relay process uses the DB, remove it.`
    );
  }
}

function hardLinkedLockFile(file: string, nlink: number | bigint): OwnerLockError {
  return new OwnerLockError(
    `the owner lock file ${file} has ${nlink} links, so it is not this relay's (it never links it) and is not opened: it may be another file, even a database another process holds. Remove that name if no relay process uses the DB.`
  );
}

/**
 * Open the lock file, never through a symlink. Each refusal names its cause: a planted symlink (ELOOP) or a lock file
 * that EXISTS but cannot be opened (another owner, mode 000) is "not private"; a lock file that cannot be CREATED (a
 * read-only DB directory) says so, and where.
 */
function openLockFile(file: string, flags: number, mode?: number): number {
  // BEFORE the open: a name with more than one link is never this relay's lock file, and opening (then closing) a
  // hard link to a DB a native handle holds would drop that handle's POSIX locks (INV-DB-01).
  let pre: fs.Stats | null = null;
  try {
    pre = fs.lstatSync(file);
  } catch {
    /* absent: it is created below */
  }
  if (pre && pre.isFile() && pre.nlink > 1) throw hardLinkedLockFile(file, pre.nlink);
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

/** A held primitive: how to drop it, and for a lock FILE, its path and open fd (the identity re-checked while held). */
interface Primitive {
  drop: () => void;
  lockFile?: string;
  fd?: number;
}
/** Every primitive this process holds, by key, PINNED (a collected handle must never drop a lock). */
const HELD = new Map<string, Primitive & { refs: number }>();

export interface OwnerLock {
  key: string;
  /** Released by the kernel when the process exits; release() is for an orderly close. */
  release(): void;
}

function primitiveName(key: string): string {
  return process.platform === "win32" ? `\\\\.\\pipe\\bot-relay-${key}` : `\0bot-relay-${key}`;
}

/** flock's exit status for "held by another" (`-E`), distinct from its own failures. */
const FLOCK_CONFLICT = 75;

/** Linux: whether the trusted system `flock` exists (decided once per process); without it, the stated-limit socket. */
let linuxFlock: string | null | undefined;
let socketLimitWarned = false;
function linuxScheme(): "flock" | "socket" {
  if (linuxFlock === undefined) {
    try {
      linuxFlock = systemBinary("flock");
    } catch {
      linuxFlock = null;
    }
  }
  if (linuxFlock === null && !socketLimitWarned) {
    socketLimitWarned = true;
    log.warn(
      "[db] no trusted system `flock` on this host: the wasm single-owner lock falls back to an abstract socket, which " +
        "excludes only processes in the SAME network namespace. Keep each wasm DB to one network namespace (one " +
        "container), or install util-linux's flock."
    );
  }
  return linuxFlock ? "flock" : "socket";
}
/** Test-only: force the Linux scheme ("socket" = the stated-limit fallback), or null to detect it again. */
export function _setLinuxSchemeForTests(scheme: "flock" | "socket" | null): void {
  linuxFlock = scheme === null ? undefined : scheme === "socket" ? null : systemBinary("flock");
}

/** Lock the open lock file `fd` with the system flock (Linux): true = held by THIS open file, false = held by another. */
function flockFd(fd: number, file: string): boolean {
  const r = spawnSystem("flock", ["-n", "-x", "-E", String(FLOCK_CONFLICT), "3"], {
    stdio: ["ignore", "ignore", "pipe", fd],
    encoding: "utf-8",
    timeout: 10_000,
  });
  if (r.status === 0) return true;
  if (r.status === FLOCK_CONFLICT) return false;
  throw new OwnerLockError(
    `the owner lock file ${file} could not be locked: the system flock failed (status ${r.status}, signal ${r.signal}): ${(r.error?.message ?? r.stderr ?? "").trim().slice(0, 300)}`
  );
}

function tryPrimitiveOnce(key: string, dbPath: string): Promise<Primitive | null> {
  const lockScheme = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? linuxScheme() : null;
  if (lockScheme === "darwin" || lockScheme === "flock") {
    const file = lockFilePath(dbPath);
    const flags = fs.constants.O_RDWR | fs.constants.O_CREAT | (lockScheme === "darwin" ? fs.constants.O_NONBLOCK | O_EXLOCK_DARWIN : 0);
    let fd: number;
    try {
      fd = openLockFile(file, flags, 0o600);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EAGAIN" || code === "EWOULDBLOCK") return Promise.resolve(null);
      return Promise.reject(err);
    }
    try {
      assertPrivateLockFile(fd, file);
      if (lockScheme === "flock" && !flockFd(fd, file)) {
        fs.closeSync(fd);
        return Promise.resolve(null);
      }
    } catch (err) {
      fs.closeSync(fd);
      return Promise.reject(err);
    }
    return Promise.resolve({ drop: () => fs.closeSync(fd), lockFile: file, fd });
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
      resolve({ drop: () => srv.close() });
    });
  });
}

/**
 * INV-DB-01 (Codex #385 R1 P2-6): a materialize that died between linking its temp to the DB's name and removing the
 * temp leaves the DB with TWO names, which every later open refuses (a hard-linked DB). Under the lock, this removes
 * only such a leftover: a name of the materialize temp pattern (.<base>.<pid>.<12 hex>.new) beside the DB that is the
 * SAME file (dev + ino) as the DB. Removing a name opens nothing.
 */
function removeOwnMaterializeLinks(dbPath: string): void {
  let real: string;
  let db: fs.BigIntStats;
  try {
    real = fs.realpathSync.native(dbPath);
    db = fs.lstatSync(real, { bigint: true });
  } catch {
    return;
  }
  if (db.nlink < 2n) return;
  const dir = path.dirname(real);
  const base = path.basename(real).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\.${base}\\.\\d+\\.[0-9a-f]{12}\\.new$`);
  for (const name of fs.readdirSync(dir)) {
    if (!pattern.test(name)) continue;
    const p = path.join(dir, name);
    try {
      const st = fs.lstatSync(p, { bigint: true });
      if (st.isFile() && st.dev === db.dev && st.ino === db.ino) fs.unlinkSync(p);
    } catch {
      /* gone, or not removable: the open's link-count check refuses by name */
    }
  }
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
  /** The first image of an absent DB (already stamped): materialized atomically before the lock is taken. */
  initialBytes?: Uint8Array;
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
    if (opts.initialBytes) materializeDb(dbPath, opts.initialBytes, opts.verifyCreated);
    afterMaterializeHook?.();
    const key = lockKey(dbPath);
    const own = HELD.get(key);
    if (own) {
      own.refs++;
      return { key, release: () => releaseKey(key) };
    }
    const held = await tryPrimitiveOnce(key, dbPath);
    if (held) {
      let now: string | null;
      try {
        afterAcquireHook?.();
        now = lockKey(dbPath);
      } catch {
        now = null;
      }
      if (now === key) {
        HELD.set(key, { ...held, refs: 1 });
        removeOwnMaterializeLinks(dbPath);
        return { key, release: () => releaseKey(key) };
      }
      held.drop(); // the canonical path moved while we took the lock: never keep an owner on a stale key
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

/**
 * The lock FILE this process holds for `dbPath` must still be the file at its name (dev + ino of the held fd against an
 * lstat of the path). Removed or replaced (another process could then create and lock a NEW file there: two owners),
 * this process DROPS its ownership and throws, by name: the owner stops writing. The wasm persist calls it immediately
 * before every rename. A socket or pipe primitive has no file to check.
 */
export function assertLockIntact(dbPath: string): void {
  const key = lockKey(dbPath);
  const h = HELD.get(key);
  if (!h) throw new OwnerLockError(`this process no longer holds the single-owner lock for ${dbPath}`);
  if (h.fd === undefined || h.lockFile === undefined) return;
  const held = fs.fstatSync(h.fd, { bigint: true });
  let named: fs.BigIntStats | null = null;
  try {
    named = fs.lstatSync(h.lockFile, { bigint: true });
  } catch {
    named = null;
  }
  if (named && named.dev === held.dev && named.ino === held.ino) return;
  HELD.delete(key);
  try {
    h.drop();
  } catch {
    /* closing a descriptor is best-effort here: the ownership is dropped either way */
  }
  throw new OwnerLockError(
    `the owner lock file ${h.lockFile} was ${named ? "replaced" : "removed"} while this process held it, so another process may own the DB at ${dbPath} now: this process stops writing it (its ownership is dropped). Restart it once no other relay process uses the DB; never delete that file.`
  );
}

/** Whether THIS process holds the owner lock for the DB at `dbPath` (the wasm persist checks it before every write). */
export function holdsOwnerLock(dbPath: string): boolean {
  try {
    return HELD.has(lockKey(dbPath));
  } catch {
    return false;
  }
}
