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
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { probeLockHeld, readHolderInfo, type HolderInfo } from "./doorbell-lock.js";
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
// The watch's files (ruling ffcaf608): <instance dir>/watch/<agent>/ (0700, the AGENT dir: its
// existence means "this agent armed a watch once"; the Stop hook's heal state lives here) and, per
// WINDOW (D1 (iv): the lock key is the agent + its window's pid and start), <agent dir>/<window key>/:
//   - gen-<N>: the GENERATIONS (D2). The current one is the highest N. Advancing N → N+1 is an O_EXCL
//     create of gen-<N+1>: exactly one creator per N, decided by the kernel. A holder at N is
//     superseded iff gen-<N+1> exists.
//   - watch.lock.<N>.db (+ watch.lock.<N>.holder.json): generation N's kernel-held lock.
//   - heartbeat.json: the holder's heartbeat (its pid and generation, wall and monotonic time).
//   - woken.json: the woken-for state.
// NOTHING IS EVER SIGNALLED (D2): a stale holder is abandoned by advancing the generation, never killed.

export const watchLockFile = (gen: number): string => `watch.lock.${gen}.db`;
export const watchHolderFile = (gen: number): string => `watch.lock.${gen}.holder.json`;
export const HEARTBEAT_FILE = "heartbeat.json";
export const WOKEN_FILE = "woken.json";
/** The Stop hook's once-per-session heal state, in the AGENT dir (written by the hook, no-follow). */
export const HEAL_FILE = "heal-session";
/** A held lock whose holder showed no life for this much AWAKE time is a HUNG watch (watch_stale). */
export const HEARTBEAT_STALE_MS = 5 * 60_000;

/**
 * The AGENT dir, beside the resolved relay DB. Refuses a name that is not an agent name, and an all-dot
 * one (`.` and `..` ARE valid agent names, but as a path segment they would name the watch dir's
 * parent or itself): such an agent simply has no watch.
 */
export function watchAgentDir(dbPath: string, agent: string): string {
  if (!watchableName(agent)) throw new Error(`no watch for this agent name: ${JSON.stringify(agent)}`);
  return path.join(path.dirname(dbPath), "watch", agent);
}
/** A window's key: its pid and a digest of its start token (the token may hold spaces and colons). */
export function windowKey(pid: number, start: string): string {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`not a window pid: ${pid}`);
  return `w${pid}-${crypto.createHash("sha256").update(start).digest("hex").slice(0, 16)}`;
}
/** The WINDOW dir: one watch per (agent, window) (ruling ffcaf608 D1 (iv)). */
export function watchWindowDir(dbPath: string, agent: string, win: { pid: number; start: string }): string {
  return path.join(watchAgentDir(dbPath, agent), windowKey(win.pid, win.start));
}

const GEN = /^gen-(0|[1-9][0-9]{0,8})$/;
/** The current generation: the highest gen-<N> in the window dir (0 when none was ever created). */
export function currentGen(dir: string): number {
  let max = 0;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const n of names) {
    const m = GEN.exec(n);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}
/**
 * Is generation `gen` superseded? Checked by the holder every check AND immediately before every
 * write. It is "a later generation exists": gen-<gen+1> was created (the ruled test), or it has since
 * been pruned under a still later one, which never lowers the current (highest) generation.
 */
export function superseded(dir: string, gen: number): boolean {
  return currentGen(dir) > gen;
}
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
/**
 * Advance from `gen` to gen+1: an O_EXCL create of gen-<gen+1> (ruling ffcaf608 D2). Exactly one
 * caller per `gen` gets true; every other sees EEXIST (false) and contests that generation's lock.
 */
export function advanceGen(dir: string, gen: number): boolean {
  try {
    fs.closeSync(fs.openSync(path.join(dir, `gen-${gen + 1}`), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o600));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}
/**
 * Remove the files of generations below `gen` (bounded growth; a holder there is superseded anyway).
 * NEVER the highest generation (ruling 1e72ed63): the bound is min(gen, the current max), so the max
 * gen-* file always survives and `superseded` (currentGen > mine) stays monotonic.
 */
export function pruneGenerations(dir: string, gen: number): void {
  const below = Math.min(gen, currentGen(dir));
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const m = /^(?:gen-|watch\.lock\.)(0|[1-9][0-9]{0,8})(?:\.db|\.holder\.json)?$/.exec(n);
    if (!m) continue;
    const k = Number(m[1]);
    // Strictly below the bound: the highest gen-* (it defines the current generation) and its lock stay.
    if (k < below) {
      try {
        fs.unlinkSync(path.join(dir, n));
      } catch {
        /* already gone */
      }
    }
  }
}

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

/**
 * The system's AWAKE clock (ms since boot, time asleep EXCLUDED), or null when it cannot be read
 * (Codex R2 (c): awake time must ACCUMULATE across any number of sleeps).
 *   - darwin: mach_absolute_time, read as kern.monotonicclock_usecs' second field (ticks) over
 *     hw.tbfrequency. MEASURED (6 Oct, Apple silicon): equal to CLOCK_UPTIME_RAW within 20 ms, while
 *     node's process.hrtime there INCLUDES sleep (it is mach_continuous_time).
 *   - linux: process.hrtime, i.e. CLOCK_MONOTONIC, which excludes suspend.
 *   - otherwise: null.
 */
export function awakeNowMs(run: (cmd: string, args: string[]) => string = (c, a) => execFileSync(c, a, { encoding: "utf-8", timeout: 2_000 }), platform: NodeJS.Platform = process.platform): number | null {
  if (platform === "linux") return Number(process.hrtime.bigint() / 1_000_000n);
  if (platform !== "darwin") return null;
  try {
    const lines = run("sysctl", ["-n", "kern.monotonicclock_usecs", "hw.tbfrequency"]).trim().split("\n");
    const ticks = Number((lines[0] ?? "").trim().split(/\s+/)[1]);
    const freq = Number((lines[1] ?? "").trim());
    if (!Number.isFinite(ticks) || !Number.isFinite(freq) || ticks <= 0 || freq <= 0) return null;
    return Math.floor((ticks / freq) * 1000);
  } catch {
    return null;
  }
}

/** The heartbeat a HOLDER writes (ruling 7224605e (2)): its pid, its generation, wall time, and its AWAKE clock. */
export interface WatchHeartbeat {
  v: 3;
  pid: number;
  gen: number;
  at: string;
  /** awakeNowMs() at the beat (null: unreadable). An integer; never compared across boots (a held lock is this boot's). */
  awake_ms: number | null;
}
export function writeHeartbeat(dir: string, hb: { pid: number; gen: number; at: string; awake_ms?: number | null }): void {
  writeJsonAtomic(dir, HEARTBEAT_FILE, { v: 3, pid: hb.pid, gen: hb.gen, at: hb.at, awake_ms: hb.awake_ms === undefined ? awakeNowMs() : hb.awake_ms } satisfies WatchHeartbeat);
}
export function readHeartbeat(dir: string): WatchHeartbeat | null {
  const o = readJson(path.join(dir, HEARTBEAT_FILE)) as Partial<WatchHeartbeat> | null;
  return o && o.v === 3 && Number.isInteger(o.pid) && Number.isInteger(o.gen) && typeof o.at === "string" && Number.isFinite(Date.parse(o.at)) && (o.awake_ms === null || Number.isInteger(o.awake_ms)) ? (o as WatchHeartbeat) : null;
}

/** The CURRENT holder of generation `gen`, and its own heartbeat (one carrying its pid AND this generation). */
export function holderBeat(dir: string, gen: number): { holder: HolderInfo | null; beat: WatchHeartbeat | null } {
  const holder = readHolderInfo(dir, watchHolderFile(gen));
  const hb = readHeartbeat(dir);
  return { holder, beat: hb && hb.gen === gen && (!holder || hb.pid === holder.pid) ? hb : null };
}

/**
 * Is the watch of this WINDOW dir live? (for OTHER processes: `--lock-status`/`--arm-check`, `relay
 * pending --watch-status`, the doorbell supervisor, and a new watch deciding whether to take over).
 * The current generation's kernel-held lock is the liveness proof; its holder's AWAKE time since its
 * own last heartbeat tells a HUNG one.
 *   - "live": held, and its holder beat within HEARTBEAT_STALE_MS of awake time, OR its staleness cannot
 *     be judged (no own heartbeat yet, or an awake clock unreadable on either side): FAIL-SAFE, never a
 *     false stale (Codex R2 (c): never after a long sleep). Residual: a holder that hangs before its
 *     first heartbeat (written at once on acquisition), or a host with no readable awake clock, is never
 *     judged stale; it lives until its window does.
 *   - "stale": held, and its holder's last heartbeat is older than that in awake time (hung).
 *   - "absent": nothing holds the current generation's lock.
 * ⚠ Never called inside the holder's own process (probeLockHeld would drop its POSIX lock).
 */
export function watchStatus(dir: string, awakeNow: number | null = awakeNowMs()): "live" | "stale" | "absent" {
  const gen = currentGen(dir);
  if (probeLockHeld(path.join(dir, watchLockFile(gen))) !== "held") return "absent";
  const { beat } = holderBeat(dir, gen);
  if (!beat || beat.awake_ms === null || awakeNow === null) return "live";
  return awakeNow - beat.awake_ms >= HEARTBEAT_STALE_MS ? "stale" : "live";
}

// --- DORMANT watches (ruling 9becb599): a watch exits only to wake, or when its window is gone. ---
export const DORMANT_DIR = "dormant";
export interface DormantRecord {
  v: 1;
  pid: number;
  proc_start: string | null;
  reason: string;
  at: string;
}
const dormantName = (pid: number, start: string | null) => `${pid}-${crypto.createHash("sha256").update(start ?? "").digest("hex").slice(0, 16)}`;
/** Record this process as dormant under `dir` (a window or agent dir): 0600, no-follow, atomic. */
export function writeDormant(dir: string, rec: Omit<DormantRecord, "v">): string {
  const d = path.join(dir, DORMANT_DIR);
  try {
    fs.mkdirSync(d, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  const st = fs.lstatSync(d);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${d} is not a real directory: refusing`);
  const name = dormantName(rec.pid, rec.proc_start);
  writeJsonAtomic(d, name, { v: 1, ...rec } satisfies DormantRecord);
  return path.join(d, name);
}
export function removeDormant(file: string | null): void {
  if (!file) return;
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
}
/**
 * How many DORMANT watches of `agent` are alive right now (for the supervisor's status): every record
 * under its agent dir and window dirs whose process (pid + start) still runs. Read-only.
 */
export function countLiveDormant(agentDir: string, isAlive: (pid: number, start: string | null) => boolean): number {
  let n = 0;
  const dirs = [agentDir];
  try {
    for (const e of fs.readdirSync(agentDir, { withFileTypes: true })) if (e.isDirectory() && !e.isSymbolicLink()) dirs.push(path.join(agentDir, e.name));
  } catch {
    return 0;
  }
  for (const d of dirs) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(path.join(d, DORMANT_DIR));
    } catch {
      continue;
    }
    for (const nm of names) {
      const r = readJson(path.join(d, DORMANT_DIR, nm)) as Partial<DormantRecord> | null;
      if (r && r.v === 1 && Number.isInteger(r.pid) && isAlive(r.pid as number, r.proc_start ?? null)) n++;
    }
  }
  return n;
}

/**
 * The supervisor's view of ONE agent's watch on its ONE live window (read-only; never in the holder's
 * process): its liveness, and whether mail it ALREADY woke this session for is still undelivered
 * after `horizonMs` (the agent woke and did not drain, or the watch is hung): undelivered_with_watch.
 */
export function watchSupervision(dir: string, read: { reading_session: string | null; ids: readonly string[] }, wallMs: number, horizonMs: number, awakeNow: number | null = awakeNowMs()): { status: "live" | "stale" | "absent"; undeliveredAfterWake: boolean } {
  const status = watchStatus(dir, awakeNow);
  const w = readWoken(dir);
  const pending = new Set(read.ids);
  const undeliveredAfterWake = !!w && w.reading_session === read.reading_session && w.ids.some((id) => pending.has(id) && wallMs - (w.woken_at[id] ?? 0) >= horizonMs);
  return { status, undeliveredAfterWake };
}
