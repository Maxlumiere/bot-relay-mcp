// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * INV-DB-01: a wasm-driven DB file is touched by ONE process only, and never while another process has it open.
 *
 * The owner holds ONE exclusive KERNEL primitive per platform, released by the kernel when the owner dies (no pid, no
 * lock file judged for staleness):
 * - macOS/BSD: open(<HOME>/.bot-relay/locks/<key>.owner, O_RDWR|O_CREAT|O_NONBLOCK|O_EXLOCK). O_EXLOCK is 0x20 there
 *   (Node has no constant; libuv passes the flag through, MEASURED). A flock-style lock on its OWN file, so the wasm
 *   driver's opens and closes of the DB file never drop it.
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
import os from "os";
import path from "path";

/** The platforms whose primitive the CI racer harness has measured green (exactly one owner every round). */
export const MEASURED_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set<NodeJS.Platform>(["darwin"]);

const O_EXLOCK_DARWIN = 0x20;

export class OwnerLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnerLockError";
  }
}

/** Create the DB file empty if it is absent (O_CREAT|O_EXCL: never truncates, a racer's file is kept). */
export function materializeDb(dbPath: string): void {
  try {
    fs.closeSync(fs.openSync(dbPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR, 0o600));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
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

function locksDir(): string {
  return path.join(os.homedir(), ".bot-relay", "locks");
}

/** Every primitive this process holds, by key, PINNED (a collected handle must never drop a lock). */
const HELD = new Map<string, { refs: number; drop: () => void }>();

export interface OwnerLock {
  key: string;
  /** Released by the kernel when the process exits; release() is for an orderly close. */
  release(): void;
}

function tryPrimitiveOnce(key: string): Promise<(() => void) | null> {
  if (process.platform === "darwin") {
    fs.mkdirSync(locksDir(), { recursive: true, mode: 0o700 });
    const file = path.join(locksDir(), `${key}.owner`);
    try {
      const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NONBLOCK | O_EXLOCK_DARWIN, 0o600);
      return Promise.resolve(() => fs.closeSync(fd));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EAGAIN" || code === "EWOULDBLOCK") return Promise.resolve(null);
      throw err;
    }
  }
  if (process.platform !== "linux" && process.platform !== "win32") {
    return Promise.reject(new OwnerLockError(`no single-owner lock primitive is defined for ${process.platform}`));
  }
  const name = process.platform === "win32" ? `\\\\.\\pipe\\bot-relay-${key}` : `\0bot-relay-${key}`;
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
export async function acquirePrimitive(dbPath: string, opts: { attempts?: number; baseMs?: number } = {}): Promise<OwnerLock> {
  const attempts = opts.attempts ?? 6;
  const base = opts.baseMs ?? 20;
  let lastReason = "held by another process";
  for (let i = 0; i < attempts; i++) {
    materializeDb(dbPath);
    const key = lockKey(dbPath);
    const own = HELD.get(key);
    if (own) {
      own.refs++;
      return { key, release: () => releaseKey(key) };
    }
    const drop = await tryPrimitiveOnce(key);
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
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, base * (i + 1) + Math.floor(Math.random() * base)));
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

/** The single-owner lock for a wasm-driven DB. Refuses by name on a platform not measured green, or another owner. */
export async function acquireOwnerLock(dbPath: string, opts: { attempts?: number; baseMs?: number } = {}): Promise<OwnerLock> {
  if (!MEASURED_PLATFORMS.has(process.platform)) {
    throw new OwnerLockError(
      `wasm writes are refused on ${process.platform}: its single-owner lock has not been measured here. Use the native driver.`
    );
  }
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
 * absent DB has no owner (a wasm owner materializes the file before it keys it). Probing takes the primitive for an
 * instant; a wasm acquirer racing that instant retries.
 */
export async function isOwnedElsewhere(dbPath: string): Promise<boolean> {
  if (!fs.existsSync(dbPath)) return false;
  if (!["darwin", "linux", "win32"].includes(process.platform)) return false;
  const key = lockKey(dbPath);
  if (HELD.has(key)) return false; // our own wasm connection, not another process
  const drop = await tryPrimitiveOnce(key);
  if (!drop) return true;
  drop();
  return false;
}
