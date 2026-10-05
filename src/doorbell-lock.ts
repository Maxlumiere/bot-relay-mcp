// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * SINGLE-INSTANCE EXCLUSION for the doorbell job (#304 Codex R1 F5; ruling b556c011). Two live
 * jobs on one instance would mean two appenders to the actuation log, divergent rung memory and
 * DOUBLED RINGS. The supervisor (one launchd label per instance) makes that unlikely, but a manual
 * run, a mis-labelled plist or a second install all reach it, so the invariant is enforced here.
 *
 *   - Taken FIRST, before anything else touches the state dir (openLog's temp cleanup included).
 *   - The lock file `doorbell.lock` is created COMPLETE: written to a private temp file, then
 *     link()ed into place, which fails if a lock exists (an O_EXCL create that can never leave a
 *     half-written lock behind). It holds {pid, proc_start, host_id, token}.
 *   - A lock that exists is JUDGED with the relay's OWN liveness (anchorLivenessVerdict, the ONE UTC
 *     start token): alive → REFUSE (exit EXIT_ALREADY_RUNNING); unverifiable (another host, no start
 *     token) → REFUSE, fail closed; dead → TAKE OVER.
 *   - A takeover is itself EXCLUSIVE: the taker first creates `doorbell.lock.takeover` the same
 *     way, so of two starters racing on one dead lock exactly one takes over and the other refuses.
 *     Under it, the lock is re-read and must still be the SAME dead holder (its token), then a new
 *     lock is renamed into place and re-read to verify it is ours.
 *   - A stale takeover file (a crash mid-takeover) is judged the same way; a dead one is removed
 *     and the start retried ONCE. KNOWN LIMIT: removing a stale takeover file and another starter
 *     creating a fresh one can interleave; it needs a crash inside a takeover AND a racing start.
 *   - Released on clean exit, and only if it is still ours (the token). A stale lock is harmless:
 *     the next start judges it dead.
 *   - The running job re-verifies it holds the lock before every cycle (lockStillOurs).
 */
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { ensurePrivateDir } from "./doorbell-log.js";
import { anchorLivenessVerdict, type AnchorVerdict } from "./liveness.js";

export const LOCK_FILENAME = "doorbell.lock";
export const TAKEOVER_FILENAME = "doorbell.lock.takeover";
/** The job's exit code when another live doorbell holds this instance (distinct from 0/1/2). */
export const EXIT_ALREADY_RUNNING = 4;

export interface LockBody {
  v: 1;
  pid: number;
  proc_start: string | null;
  host_id: string | null;
  token: string;
}
export interface LockHandle {
  path: string;
  token: string;
}
export type LockResult = { ok: true; handle: LockHandle; tookOver: boolean } | { ok: false; reason: string };

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const isBody = (b: unknown): b is LockBody => {
  const o = b as Record<string, unknown> | null;
  return (
    !!o && o.v === 1 && Number.isInteger(o.pid) && (o.pid as number) > 0 && (o.proc_start === null || typeof o.proc_start === "string") &&
    (o.host_id === null || typeof o.host_id === "string") && typeof o.token === "string" && o.token.length > 0
  );
};

/** Read a lock-style file no-follow: its body, absent, or unreadable (never a guess). */
export function readLockFile(p: string): { kind: "absent" } | { kind: "ok"; body: LockBody } | { kind: "unreadable"; reason: string } {
  let fd: number;
  try {
    fd = fs.openSync(p, fs.constants.O_RDONLY | O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? { kind: "absent" } : { kind: "unreadable", reason: `cannot open ${p} (${code ?? String(err)})` };
  }
  try {
    if (!fs.fstatSync(fd).isFile()) return { kind: "unreadable", reason: `${p} is not a regular file` };
    let body: unknown;
    try {
      body = JSON.parse(fs.readFileSync(fd, "utf-8"));
    } catch {
      return { kind: "unreadable", reason: `${p} is not JSON` };
    }
    return isBody(body) ? { kind: "ok", body } : { kind: "unreadable", reason: `${p} is not a doorbell lock` };
  } finally {
    fs.closeSync(fd);
  }
}

/** Create `target` COMPLETE and EXCLUSIVELY (temp file + link). False if it already exists. */
function createExclusive(dir: string, target: string, body: LockBody): boolean {
  const tmp = path.join(dir, `.lock-tmp-${body.token}`);
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(body) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(tmp, target);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    fs.unlinkSync(tmp);
  }
}

export interface LockDeps {
  /** The relay's own liveness verdict for a holder (default: anchorLivenessVerdict). */
  judge?: (holder: LockBody) => AnchorVerdict;
  /** Test seam: runs between judging a dead holder and taking the takeover file. */
  beforeTakeover?: () => void;
}

const defaultJudge = (h: LockBody): AnchorVerdict => anchorLivenessVerdict({ host_id: h.host_id, agent_pid: h.pid, agent_pid_start: h.proc_start });

/** Take the instance lock in `stateDir` for `me`. */
export function acquireInstanceLock(stateDir: string, me: { pid: number; proc_start: string | null; host_id: string | null }, deps: LockDeps = {}): LockResult {
  ensurePrivateDir(stateDir);
  const judge = deps.judge ?? defaultJudge;
  const lockPath = path.join(stateDir, LOCK_FILENAME);
  const takeoverPath = path.join(stateDir, TAKEOVER_FILENAME);
  const body: LockBody = { v: 1, ...me, token: randomUUID() };
  const describe = (h: LockBody) => `pid ${h.pid}${h.host_id ? ` on host ${h.host_id}` : ""}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (createExclusive(stateDir, lockPath, body)) return { ok: true, handle: { path: lockPath, token: body.token }, tookOver: false };
    const held = readLockFile(lockPath);
    if (held.kind === "absent") continue; // released between our attempt and the read: try again
    if (held.kind === "unreadable") return { ok: false, reason: `${held.reason}: refusing to start (remove it only if no doorbell runs for this instance)` };
    const verdict = judge(held.body);
    if (verdict === "alive") return { ok: false, reason: `another doorbell (${describe(held.body)}) is running for this instance` };
    if (verdict === "unverifiable") return { ok: false, reason: `the instance lock is held by ${describe(held.body)}, whose liveness cannot be verified from this host: refusing (fail closed)` };
    // DEAD holder: take over, EXCLUSIVELY.
    deps.beforeTakeover?.();
    const takeoverBody: LockBody = { v: 1, ...me, token: randomUUID() };
    if (!createExclusive(stateDir, takeoverPath, takeoverBody)) {
      const other = readLockFile(takeoverPath);
      if (other.kind === "ok" && judge(other.body) === "dead") {
        // A crash mid-takeover left it: remove it and retry ONCE (the known limit is in the header).
        try {
          fs.unlinkSync(takeoverPath);
        } catch {
          /* already gone */
        }
        continue;
      }
      return { ok: false, reason: "another start is taking over this instance's lock right now: refusing" };
    }
    try {
      const again = readLockFile(lockPath);
      if (again.kind !== "ok" || again.body.token !== held.body.token) {
        // It changed while we judged it: judge the NEW holder on the next pass.
        continue;
      }
      const tmp = path.join(stateDir, `.lock-tmp-${body.token}`);
      const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o600);
      try {
        fs.writeSync(fd, JSON.stringify(body) + "\n");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, lockPath);
      const mine = readLockFile(lockPath);
      if (mine.kind !== "ok" || mine.body.token !== body.token) return { ok: false, reason: "the instance lock changed during the takeover: refusing" };
      return { ok: true, handle: { path: lockPath, token: body.token }, tookOver: true };
    } finally {
      try {
        fs.unlinkSync(takeoverPath);
      } catch {
        /* best effort: a leftover is judged dead next time */
      }
    }
  }
  return { ok: false, reason: "the instance lock could not be taken (it kept changing): refusing" };
}

/** Is the lock still ours? (The running job checks this before every cycle.) */
export function lockStillOurs(h: LockHandle): boolean {
  const r = readLockFile(h.path);
  return r.kind === "ok" && r.body.token === h.token;
}

/** Release the lock, only if it is still ours. */
export function releaseInstanceLock(h: LockHandle): void {
  if (!lockStillOurs(h)) return;
  try {
    fs.unlinkSync(h.path);
  } catch {
    /* gone already */
  }
}
