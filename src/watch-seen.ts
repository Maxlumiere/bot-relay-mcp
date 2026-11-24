// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Doorbell PR 8b (gate brief §6; ruling 1cd77de6, "A'"): the WATCH-SEEN marker, the durable fact "a watch of ANY
 * kind ran for this agent once". Written by BOTH watch kinds at start (the streaming `relay watch` the fleet's
 * stopgap runs, and `--until-wake`); read ONLY by the wake-coverage detector, to tell an agent that never had an
 * automatic wake (NEEDS_HUMAN: mail waits for a person) from one whose wake path stopped (UNCOVERED, an alarm).
 *
 *   <instance dir>/watch-seen/            0700, created once; its STAMP file holds the creation time (the GRACE starts)
 *   <instance dir>/watch-seen/<agent>     0600, write-once (O_CREAT|O_EXCL|O_NOFOLLOW), an ISO timestamp inside
 *
 * A MARKER, NOT A GATE: every write is best-effort; a failure is reported by the caller in ONE stderr line and
 * never affects watching. Nothing in src/ removes this directory or its files (a tripwire pins it). It is SEPARATE
 * from the --until-wake agent dir (<instance>/watch/<agent>/), whose existence means "armed --until-wake" to the
 * arm-check, the supervisor and the Stop-hook heal: a streaming agent must never be told to arm --until-wake.
 *
 * THE GRACE: for GRACE_MS after the store's creation the detector does not split at all (everything stays
 * UNCOVERED, as before 8b), so an agent whose stopgap watcher was already dead when this shipped is still an alarm.
 */
import fs from "fs";
import path from "path";
import { watchableName } from "./watch-wake.js";

export const WATCH_SEEN_DIR = "watch-seen";
/** The store's creation stamp (a dot name: never an agent marker, since an all-dot name is not watchable). */
export const WATCH_SEEN_STAMP = ".created";
export const WATCH_SEEN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

const NOFOLLOW = process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW;

export const watchSeenDir = (dbPath: string): string => path.join(path.dirname(dbPath), WATCH_SEEN_DIR);

/** Write-once: create `p` holding `text` (0600, no-follow). An existing file is kept (EEXIST is success). */
function writeOnce(p: string, text: string): void {
  let fd: number;
  try {
    fd = fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return;
    throw err;
  }
  try {
    fs.writeSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The store, created once: the directory (0700; a link or a non-directory is refused, never followed) and its
 * creation stamp. Idempotent. Throws on a fault (the caller decides how loud).
 */
export function ensureWatchSeenStore(dbPath: string, now: Date = new Date()): string {
  const dir = watchSeenDir(dbPath);
  try {
    fs.mkdirSync(dir, { mode: 0o700 }); // ONE component: the instance dir is the resolved relay's own
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("the watch-seen store is not a real directory");
  writeOnce(path.join(dir, WATCH_SEEN_STAMP), now.toISOString());
  return dir;
}

/** A watch for `agent` started: record it once. Throws on a fault (the watch says one stderr line and goes on). */
export function recordWatchSeen(dbPath: string, agent: string, now: Date = new Date()): void {
  if (!watchableName(agent)) return; // an all-dot name has no marker (it would name the store or its parent)
  const dir = ensureWatchSeenStore(dbPath, now);
  writeOnce(path.join(dir, agent), now.toISOString());
}

/** Best-effort recording for a watch's start: never throws; ONE stderr line on a fault. */
export function noteWatchSeen(dbPath: string, agent: string, write: (line: string) => void = (l) => process.stderr.write(l)): void {
  try {
    recordWatchSeen(dbPath, agent);
  } catch (err) {
    write(`[sentinel] note: the watch-seen marker for ${agent} could not be written (${err instanceof Error ? err.message : String(err)}); watching is unaffected\n`);
  }
}

/**
 * The detector's read (read-only, no-follow): has the grace ended, and which agents have a marker? A store that is
 * absent, linked, unstamped or unreadable means the grace has NOT ended (no split: everything stays UNCOVERED).
 */
export function readWatchSeen(dbPath: string, nowMs: number): { graceOver: boolean; seen: (agent: string) => boolean } {
  const dir = watchSeenDir(dbPath);
  const none = { graceOver: false, seen: () => false };
  try {
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return none;
    const fd = fs.openSync(path.join(dir, WATCH_SEEN_STAMP), fs.constants.O_RDONLY | NOFOLLOW);
    let stamp: string;
    try {
      stamp = fs.readFileSync(fd, "utf-8").trim();
    } finally {
      fs.closeSync(fd);
    }
    const created = Date.parse(stamp);
    if (!Number.isFinite(created)) return none;
    return {
      graceOver: nowMs - created >= WATCH_SEEN_GRACE_MS,
      seen: (agent) => {
        if (!watchableName(agent)) return false;
        try {
          return fs.lstatSync(path.join(dir, agent)).isFile();
        } catch {
          return false;
        }
      },
    };
  } catch {
    return none;
  }
}
