// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * THE WAKE TRIGGER of `relay watch <agent> --until-wake` (doorbell PR 7, plan §v6; architect rulings
 * 23e9b281, 7224605e, 323f69d5). Zero model tokens: the watch is a plain process; the harness's one
 * completion notification when it exits IS the wake (the inherent turn).
 *
 *   - WHAT WAKES: ids UNDELIVERED TO THE CURRENT READING SESSION, read through db.pendingMetadata
 *     (F1's canonical per-session set, the same read the drain uses), MINUS the ids this agent was
 *     already woken for in THAT reading session. So each id wakes a session at most ONCE: an agent
 *     that wakes and does not drain is never woken again for the same mail (no wake loop), and a
 *     backlog re-pended to a NEW session wakes it exactly once (V4). NEVER_DRAINED_SQL is NOT used:
 *     it is session-agnostic, so re-pended mail would never wake a new session.
 *   - A NULL reading session is "no wake YET" (V4: delivery cannot be measured): the watch keeps
 *     waiting and re-evaluates; it never exits for it (a watch armed before the session binds would
 *     otherwise be dead from birth).
 *   - STANDING + THE PER-PAIR RATE (ruling 7224605e (4)): ONE shared policy, evaluated per id. A
 *     refused id stays pending and visible on the agent's own drain; it just never WAKES anyone. The
 *     default allows everything; PR 8 supplies a default-deny sender → recipient matrix.
 *   - THE WOKEN-FOR SET is persisted (a 0600 file, written atomically) so a re-armed watch never re-wakes
 *     the same ids. It is bounded to the current session's ids and reset when the session changes. It
 *     also keeps the recent wakes per (sender → recipient) pair, for the rate.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { probeLockHeld, WATCH_LOCK_DB_FILENAME } from "./doorbell-lock.js";
import { AGENT_NAME_PATTERN } from "./types.js";

/** An agent name that can name a watch dir: a valid agent name that is not all dots. */
export const watchableName = (agent: string): boolean => AGENT_NAME_PATTERN.test(agent) && !/^\.+$/.test(agent);

import { ALLOW_ALL, DEFAULT_PAIR_WAKES_PER_HOUR, PAIR_WINDOW_MS, pairKey, type StandingCheck, type WakeMeta } from "./wake-policy.js";
export { ALLOW_ALL, DEFAULT_PAIR_WAKES_PER_HOUR, PAIR_WINDOW_MS, pairKey, type StandingCheck, type WakeMeta };

/** The persisted state for ONE agent's watch: what it already woke for, in which session, and recent wakes. */
export interface WokenState {
  v: 1;
  /** The reading-session digest the ids belong to (pendingMetadata's `reading_session`). */
  reading_session: string;
  /** Ids this session was already woken for (a canonical set). */
  ids: string[];
  /** When each of those ids FIRST woke this session (ms): the supervisor's undelivered_with_watch horizon. */
  woken_at: Record<string, number>;
  /** Recent wakes (the trailing hour): when, and which senders' mail each one was for. */
  wakes: Array<{ at: number; senders: string[] }>;
}
export const emptyWoken = (rs: string): WokenState => ({ v: 1, reading_session: rs, ids: [], woken_at: {}, wakes: [] });

export interface WakeDecision {
  /** The ids to wake for now (empty → keep waiting). */
  wake: string[];
  /** Ids NOT woken because their standing was refused, by kind (a count; they stay pending). */
  refused: Record<string, number>;
  /** Ids NOT woken because their pair is over its rate (they stay pending, and due). */
  pairCapped: number;
  /** Why nothing woke, when nothing did ("hold" for a NULL session). */
  hold: boolean;
}

/**
 * PURE: given ONE pending read and the persisted state, which ids wake the agent now? The state for a
 * different reading session is IGNORED (a new session starts clean: its re-pended backlog wakes it once).
 */
export function decideWake(
  read: { registered: boolean; reading_session: string | null; ids: readonly string[]; meta?: ReadonlyMap<string, WakeMeta> },
  recipient: string,
  woken: WokenState | null,
  now: number,
  policy: { standing?: StandingCheck; pairWakesPerHour?: number } = {},
): WakeDecision {
  const out: WakeDecision = { wake: [], refused: {}, pairCapped: 0, hold: false };
  if (!read.registered) return out;
  if (read.reading_session === null) return { ...out, hold: true }; // V4: no wake YET, keep waiting
  const prior = woken && woken.reading_session === read.reading_session ? woken : null;
  const already = new Set(prior?.ids ?? []);
  const standing = policy.standing ?? ALLOW_ALL;
  const budget = policy.pairWakesPerHour ?? DEFAULT_PAIR_WAKES_PER_HOUR;
  const inHour = new Map<string, number>();
  for (const w of prior?.wakes ?? []) {
    if (now - w.at >= PAIR_WINDOW_MS) continue;
    for (const s of w.senders) inHour.set(pairKey(s, recipient), (inHour.get(pairKey(s, recipient)) ?? 0) + 1);
  }
  for (const id of [...new Set(read.ids)].sort()) {
    if (already.has(id)) continue;
    const m = read.meta?.get(id) ?? { from: null, lane: "direct" as const };
    const v = standing({ sender: m.from, recipient, kind: m.lane, id });
    if (v !== "allowed") {
      out.refused[v.refused] = (out.refused[v.refused] ?? 0) + 1;
      continue;
    }
    if ((inHour.get(pairKey(m.from, recipient)) ?? 0) >= budget) {
      out.pairCapped += 1;
      continue;
    }
    out.wake.push(id);
  }
  return out;
}

/** The state AFTER waking for `ids` (bounded to ids still pending in this session; the trailing hour of wakes). */
export function recordWake(prev: WokenState | null, rs: string, ids: readonly string[], stillPending: readonly string[], senders: readonly string[], now: number): WokenState {
  const base = prev && prev.reading_session === rs ? prev : emptyWoken(rs);
  const pending = new Set(stillPending);
  const all = [...new Set([...base.ids, ...ids])].filter((id) => pending.has(id)).sort();
  const woken_at: Record<string, number> = {};
  for (const id of all) woken_at[id] = base.woken_at[id] ?? now; // the FIRST wake is kept
  const wakes = [...base.wakes.filter((w) => now - w.at < PAIR_WINDOW_MS), { at: now, senders: [...new Set(senders)].sort() }];
  return { v: 1, reading_session: rs, ids: all, woken_at, wakes };
}

// ---------------------------------------------------------------------------------------------------
// The per-agent watch dir: <instance dir>/watch/<agent>/ (0700): the lock, its holder sidecar, the
// heartbeat, and the woken-for state.

export const WATCH_LOCK_FILE = WATCH_LOCK_DB_FILENAME;
export const WATCH_HOLDER_FILE = "watch.lock.holder.json";
export const HEARTBEAT_FILE = "heartbeat.json";
export const WOKEN_FILE = "woken.json";
/** A held lock whose heartbeat is older than this is a HUNG watch (watch_stale; ruling 7224605e (2)). */
export const HEARTBEAT_STALE_MS = 5 * 60_000;

/**
 * The watch dir for `agent`, beside the resolved relay DB. Refuses a name that is not an agent name,
 * and an all-dot one (`.` and `..` ARE valid agent names, but as a path segment they would name the
 * watch dir's parent or itself): such an agent simply has no watch.
 */
export function watchDirFor(dbPath: string, agent: string): string {
  if (!watchableName(agent)) throw new Error(`no watch for this agent name: ${JSON.stringify(agent)}`);
  return path.join(path.dirname(dbPath), "watch", agent);
}

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
/** Read one small JSON file, no-follow; null when absent or invalid (never a guess). */
function readJson(file: string): unknown {
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW);
    try {
      return JSON.parse(fs.readFileSync(fd, "utf-8"));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}
/** Replace one small file atomically: a random 0600 temp, created exclusive and no-follow, renamed over the target. */
function writeJsonAtomic(dir: string, file: string, value: unknown): void {
  const tmp = path.join(dir, `.tmp-${crypto.randomBytes(8).toString("hex")}`);
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(value) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, path.join(dir, file));
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw err;
  }
}

const isRs = (x: unknown): x is string => typeof x === "string" && /^[0-9a-f]{64}$/.test(x);
export function readWoken(dir: string): WokenState | null {
  const o = readJson(path.join(dir, WOKEN_FILE)) as Partial<WokenState> | null;
  if (!o || o.v !== 1 || !isRs(o.reading_session) || !Array.isArray(o.ids) || !Array.isArray(o.wakes)) return null;
  if (!o.ids.every((x) => typeof x === "string")) return null;
  const wakes = o.wakes.filter((w): w is { at: number; senders: string[] } => !!w && Number.isFinite(w.at) && Array.isArray(w.senders) && w.senders.every((s) => typeof s === "string"));
  const at = (o.woken_at && typeof o.woken_at === "object" ? o.woken_at : {}) as Record<string, unknown>;
  const woken_at: Record<string, number> = {};
  for (const id of o.ids) woken_at[id] = Number.isFinite(at[id]) ? (at[id] as number) : 0; // unknown → oldest (fail visible)
  return { v: 1, reading_session: o.reading_session, ids: o.ids, woken_at, wakes };
}
export function writeWoken(dir: string, s: WokenState): void {
  writeJsonAtomic(dir, WOKEN_FILE, s);
}

/** The heartbeat a HOLDER writes on every check (ruling 7224605e (2)): a hung watch must be visible. */
export interface WatchHeartbeat {
  v: 1;
  pid: number;
  at: string;
}
export function writeHeartbeat(dir: string, pid: number, at: string): void {
  writeJsonAtomic(dir, HEARTBEAT_FILE, { v: 1, pid, at } satisfies WatchHeartbeat);
}
export function readHeartbeat(dir: string): WatchHeartbeat | null {
  const o = readJson(path.join(dir, HEARTBEAT_FILE)) as Partial<WatchHeartbeat> | null;
  return o && o.v === 1 && Number.isInteger(o.pid) && typeof o.at === "string" && Number.isFinite(Date.parse(o.at)) ? (o as WatchHeartbeat) : null;
}

/**
 * Is a watch LIVE for this agent? (for OTHER processes: the Stop hook via `--lock-status`, and the
 * doorbell supervisor). The kernel-held lock is the liveness proof; the heartbeat tells a HUNG holder.
 *   - "live": the lock is held and the heartbeat is fresh;
 *   - "stale": the lock is held but the heartbeat is old or missing (a hung watch: watch_stale);
 *   - "absent": nothing holds the lock (no watch, or a dead one: the kernel freed its lock).
 * ⚠ Never called inside the holder's own process (probeLockHeld would drop its POSIX lock).
 */
export function watchStatus(dir: string, now: number = Date.now()): "live" | "stale" | "absent" {
  if (probeLockHeld(path.join(dir, WATCH_LOCK_FILE)) !== "held") return "absent";
  const hb = readHeartbeat(dir);
  return hb && now - Date.parse(hb.at) < HEARTBEAT_STALE_MS ? "live" : "stale";
}

/**
 * The supervisor's view of ONE agent's watch (read-only; never in the holder's process): its liveness,
 * and whether mail it ALREADY woke this session for is still undelivered after `horizonMs` (the agent
 * woke and did not drain, or the watch is hung): the undelivered_with_watch board case.
 */
export function watchSupervision(dir: string, read: { reading_session: string | null; ids: readonly string[] }, now: number, horizonMs: number): { status: "live" | "stale" | "absent"; undeliveredAfterWake: boolean } {
  const status = watchStatus(dir, now);
  const w = readWoken(dir);
  const pending = new Set(read.ids);
  const undeliveredAfterWake = !!w && w.reading_session === read.reading_session && w.ids.some((id) => pending.has(id) && now - (w.woken_at[id] ?? 0) >= horizonMs);
  return { status, undeliveredAfterWake };
}
