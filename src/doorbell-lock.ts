// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * SINGLE-INSTANCE EXCLUSION for the doorbell job (#304 Codex R1 F5; ruling ecf50062, which replaces
 * b556c011's file-judging shape). Two live jobs on one instance would mean two appenders to the
 * actuation log, divergent rung memory and DOUBLED RINGS.
 *
 * A KERNEL-HELD lock, so there is nothing to judge: any lock FILE judged for staleness has stale and
 * unjudgeable states (a crash with an unreadable start token would wedge every later start).
 *   - One better-sqlite3 connection to `<state dir>/doorbell.lock.db` (its OWN file, NEVER the relay
 *     DB, so V1 holds), busy timeout 0, and `BEGIN EXCLUSIVE` as its FIRST statement, held open for
 *     the job's lifetime and never committed. SQLITE_BUSY → another doorbell holds it → refuse.
 *     Process death → the kernel drops the lock: no takeover code, no liveness judgement.
 *   - ⚠ TRAP (measured, ruling ecf50062): NO `locking_mode` pragma and NO read before BEGIN EXCLUSIVE
 *     (with locking_mode=EXCLUSIVE, a read first left every racer holding SHARED: ZERO winners).
 *   - ⚠ POSIX: an fcntl lock belongs to the PROCESS, and closing ANY descriptor of the file drops
 *     it. The job never opens this file through a second handle (fs or SQLite); it only lstat()s it.
 *   - The state dir must be LOCAL: SQLite locks with fcntl on unix and LockFileEx on Windows, and a
 *     network filesystem's locking is not reliable.
 *   - Deleting the lock file would let a new starter lock a NEW file while we still hold the old
 *     one, so the job checks before every attempt that the path still names the inode it locked.
 *   - A sidecar `doorbell.lock.holder.json` (pid, proc_start, host_id, since) is written for the
 *     status verb's "held by …" line ONLY. Correctness never reads it.
 *   - ⚠ GARBAGE COLLECTION (MEASURED 2026-10-05): a better-sqlite3 connection nobody references is
 *     CLOSED when it is collected, and the kernel lock goes with it. With the handle unreferenced,
 *     8 racers held SIMULTANEOUSLY in 15 of 20 rounds; pinned, exactly one in 20 of 20. So every
 *     held connection is pinned HERE, in a module-level set, until releaseInstanceLock: the lock can
 *     never depend on a caller happening to keep its handle alive.
 */
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { ensurePrivateDir } from "./doorbell-log.js";

export const LOCK_DB_FILENAME = "doorbell.lock.db";
export const HOLDER_FILENAME = "doorbell.lock.holder.json";
/** The job's exit code when another live doorbell holds this instance (distinct from 0/1/2). */
export const EXIT_ALREADY_RUNNING = 4;

export interface LockHandle {
  db: Database.Database;
  path: string;
  dev: number;
  ino: number;
}
export interface HolderInfo {
  pid: number;
  proc_start: string | null;
  host_id: string | null;
  since: string;
}
export type LockResult = { ok: true; handle: LockHandle } | { ok: false; reason: string; holder: HolderInfo | null };

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
/** Every HELD lock connection, pinned against garbage collection until it is released. */
const HELD = new Set<Database.Database>();

/** The non-authoritative holder sidecar (for display only; null when absent or unreadable). */
export function readHolderInfo(stateDir: string): HolderInfo | null {
  try {
    const fd = fs.openSync(path.join(stateDir, HOLDER_FILENAME), fs.constants.O_RDONLY | O_NOFOLLOW);
    try {
      const o = JSON.parse(fs.readFileSync(fd, "utf-8")) as Record<string, unknown>;
      if (!Number.isInteger(o.pid) || typeof o.since !== "string") return null;
      return { pid: o.pid as number, proc_start: typeof o.proc_start === "string" ? o.proc_start : null, host_id: typeof o.host_id === "string" ? o.host_id : null, since: o.since };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Take the instance lock in `stateDir`. Throws only on an environment fault (the caller exits 1). */
export function acquireInstanceLock(stateDir: string, me: { pid: number; proc_start: string | null; host_id: string | null }, now: () => string = () => new Date().toISOString()): LockResult {
  ensurePrivateDir(stateDir);
  const lockPath = path.join(stateDir, LOCK_DB_FILENAME);
  let pre: fs.Stats | null = null;
  try {
    pre = fs.lstatSync(lockPath);
  } catch {
    pre = null;
  }
  if (pre && (pre.isSymbolicLink() || !pre.isFile())) throw new Error(`${lockPath} is not a regular file (a symlink or another type): refusing to lock through it`);
  const db = new Database(lockPath, { timeout: 0 });
  try {
    db.exec("BEGIN EXCLUSIVE"); // the FIRST statement: no pragma, no read before it (the trap)
  } catch (err) {
    db.close();
    if ((err as { code?: string }).code === "SQLITE_BUSY") {
      return { ok: false, reason: "another doorbell holds this instance's lock", holder: readHolderInfo(stateDir) };
    }
    throw err;
  }
  HELD.add(db); // pinned: a collected connection would silently drop the lock
  const st = fs.lstatSync(lockPath); // the inode we now hold (lstat: never a second descriptor)
  try {
    const tmp = path.join(stateDir, `.holder-tmp-${me.pid}`);
    fs.writeFileSync(tmp, JSON.stringify({ pid: me.pid, proc_start: me.proc_start, host_id: me.host_id, since: now() }) + "\n", { mode: 0o600, flag: "w" });
    fs.renameSync(tmp, path.join(stateDir, HOLDER_FILENAME));
  } catch {
    /* the sidecar is display-only: its failure never affects the lock */
  }
  return { ok: true, handle: { db, path: lockPath, dev: st.dev, ino: st.ino } };
}

/** Does the lock path still name the inode we hold? (lstat only: never a second descriptor.) */
export function lockStillOurs(h: LockHandle): boolean {
  try {
    const st = fs.lstatSync(h.path);
    return st.isFile() && st.dev === h.dev && st.ino === h.ino;
  } catch {
    return false;
  }
}

/** Release: roll back and close the ONE connection (the kernel drops the lock with it). */
export function releaseInstanceLock(h: LockHandle): void {
  try {
    h.db.exec("ROLLBACK");
  } catch {
    /* nothing to roll back */
  }
  try {
    h.db.close();
  } catch {
    /* already closed */
  }
  HELD.delete(h.db);
}
