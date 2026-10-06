// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The doorbell's HEARTBEAT (ADR-0038 Q3, V2; plan v3 PR 5; architect ruling 9987c113): one small
 * JSON file in the state dir, `heartbeat.json`, that says the job is cycling and how.
 *
 *   - STRUCTURAL (ruling Q1 (i)): it is written ONLY by the cycle path, ONCE per cycle ATTEMPT
 *     (success or failure), with `cycles` incremented in that same write. Nothing else writes it
 *     (no timer, no start-up write), so "a frozen counter under a fresh timestamp" cannot exist.
 *   - STALENESS (Q1 (ii)): the WALL age of `at` > max(3 × interval, 15 s), or `at` more than 5 s in
 *     the FUTURE (a backward clock jump: loud, never masking). No rate check: a long sleep would
 *     false-stale for hours. KNOWN LIMIT: a read within one interval after a wake can say stale,
 *     truthfully (the job has not cycled since waking); it self-heals on the next cycle.
 *   - `condition` (Q2): ok | waiting-for-writer | log-full | failing, never merged into V2's states.
 *     `failing` = the last FAILING_AFTER cycle attempts ALL failed.
 *   - `starts` / `starts_since` (Q4): the previous heartbeat's starts + 1; an unreadable previous one
 *     resets the count to 1 and moves `starts_since`, so a reset is visible, never silent.
 *   - `last_failure` (Q5): {at, kind}, kind a CLOSED enum; never free text (no paths, no content).
 *   - Written atomically (temp, fsync, rename; replaceStateFile), read no-follow; a file that fails
 *     the closed schema is UNREADABLE, never a guess.
 */
import fs from "fs";
import path from "path";
import { buildFault, resolutionFault } from "./doorbell-log.js";

export const HEARTBEAT_FILENAME = "heartbeat.json";
export const HEARTBEAT_CONDITIONS = ["ok", "waiting-for-writer", "log-full", "failing"] as const;
export type HeartbeatCondition = (typeof HEARTBEAT_CONDITIONS)[number];
/** Q5: why a cycle attempt failed. A CLOSED enum; PR 7 adds driver kinds. */
export const FAILURE_KINDS = ["pending-read", "db-open", "record-refused", "log-write", "other"] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];
/** Q2: the last K cycle attempts all failed → `failing`. */
export const FAILING_AFTER = 3;
/** Q1 (ii): stale when the wall age exceeds max(STALE_INTERVALS × interval, STALE_FLOOR_MS). */
export const STALE_INTERVALS = 3;
export const STALE_FLOOR_MS = 15_000;
/** Q1 (ii): `at` more than this far in the FUTURE is a backward clock jump: stale. */
export const FUTURE_TOLERANCE_MS = 5_000;
/**
 * F1 (ruling b556c011): waiting-for-writer is EXPECTED only TRANSIENTLY (the SessionStart race: a new
 * window's server may not have opened the DB yet). Persisting beyond this grace, it means no relay
 * process holds the DB (the daemon is down, or the DB left WAL mode): the hook then WARNS.
 */
export const WAITING_GRACE_FLOOR_MS = 60_000;
export const waitingGraceMs = (intervalMs: number): number => Math.max(STALE_INTERVALS * intervalMs, WAITING_GRACE_FLOOR_MS);
/**
 * F7 (#304 R1): every counter is bounded by what the READER accepts. A counter at the bound
 * saturates (failures) or, for `starts`, resets VISIBLY (count 1, `starts_since` moves); it never
 * writes a value its own validator would refuse.
 */
export const MAX_COUNT = Number.MAX_SAFE_INTEGER;
export const saturatingInc = (n: number): number => (n >= MAX_COUNT ? MAX_COUNT : n + 1);

export interface Heartbeat {
  v: 1;
  /** Wall time of this write (ISO UTC). */
  at: string;
  pid: number;
  /** The job's start token, from the ONE UTC producer (liveness.processStartedAt); null if unreadable. */
  proc_start: string | null;
  /** This lifetime's start (ISO UTC). */
  started_at: string;
  starts: number;
  /** When the `starts` count began (ISO UTC): moves when the count resets. */
  starts_since: string;
  /** Cycle ATTEMPTS this lifetime, this one included. */
  cycles: number;
  interval_ms: number;
  condition: HeartbeatCondition;
  /** When the current condition began (ISO UTC); resets on any change, carried across restarts while unchanged (F1). */
  condition_since: string;
  /** Failed cycle attempts in a row, carried across restarts (F3); a success resets it. */
  consecutive_failures: number;
  /** Failed cycle attempts this lifetime, in total (Q5; F4). */
  cycle_failures: number;
  last_failure: { at: string; kind: FailureKind } | null;
  /** ADR-0047: what THIS process loaded (LOADED_BUILD), exactly its seven keys. */
  build: Record<string, unknown>;
  install_dir: string;
  /** ADR-0048: the resolution it runs against (serializeResolution). */
  resolution: Record<string, unknown>;
  /**
   * PR 6 (ruling 5dda2752 Q3 (i)): the agents THIS attempt's cycle could not evaluate (a HOLD: their
   * board state is untouched), so a hold is never silent. A cycle field, never per-agent log records,
   * so it cannot churn. Null when no cycle was planned this attempt (the condition says why).
   */
  not_evaluated: { count: number; names: string[] } | null;
}

/** At most this many names in `not_evaluated` (the count is exact). */
export const NOT_EVALUATED_MAX_NAMES = 20;

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const isIso = (v: unknown): v is string => typeof v === "string" && ISO_RE.test(v) && Number.isFinite(Date.parse(v));
const isCount = (v: unknown, min = 0): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= MAX_COUNT;
const sameKeys = (o: unknown, keys: readonly string[]): o is Record<string, unknown> =>
  !!o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).sort().join(",") === [...keys].sort().join(",");
const KEYS = ["v", "at", "pid", "proc_start", "started_at", "starts", "starts_since", "cycles", "interval_ms", "condition", "condition_since", "consecutive_failures", "cycle_failures", "last_failure", "build", "install_dir", "resolution", "not_evaluated"];
const AGENT_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** Why this is not a valid heartbeat, or null. CLOSED: an extra or missing key is invalid. */
export function heartbeatFault(h: unknown): string | null {
  if (!sameKeys(h, KEYS)) return `a heartbeat has exactly ${KEYS.join(", ")}`;
  if (h.v !== 1) return "unknown heartbeat version";
  if (!isIso(h.at) || !isIso(h.started_at) || !isIso(h.starts_since) || !isIso(h.condition_since)) return "at, started_at, starts_since and condition_since must be ISO UTC timestamps";
  if (!isCount(h.pid, 1) || (h.pid as number) > 0x7fffffff) return "pid is not a positive 32-bit integer";
  if (!(h.proc_start === null || (typeof h.proc_start === "string" && h.proc_start.length > 0 && h.proc_start.length <= 64 && !/[\u0000-\u001f\u007f]/.test(h.proc_start)))) {
    return "proc_start is not null or a bounded start token";
  }
  if (!isCount(h.starts, 1) || !isCount(h.cycles, 1) || !isCount(h.consecutive_failures, 0) || !isCount(h.cycle_failures, 0)) {
    return "starts and cycles must be integers >= 1, consecutive_failures and cycle_failures >= 0 (all bounded)";
  }
  if (!isCount(h.interval_ms, 1)) return "interval_ms is not a positive integer";
  if (!(HEARTBEAT_CONDITIONS as readonly unknown[]).includes(h.condition)) return `condition must be one of ${HEARTBEAT_CONDITIONS.join(", ")}`;
  const f = h.last_failure;
  if (!(f === null || (sameKeys(f, ["at", "kind"]) && isIso(f.at) && (FAILURE_KINDS as readonly unknown[]).includes(f.kind)))) {
    return `last_failure is null or exactly {at, kind} with kind one of ${FAILURE_KINDS.join(", ")} (never free text)`;
  }
  if (typeof h.install_dir !== "string" || h.install_dir.length === 0 || h.install_dir.length > 4096 || /[\u0000-\u001f\u007f]/.test(h.install_dir)) return "install_dir is not a bounded path";
  const ne = h.not_evaluated;
  if (ne !== null) {
    if (!sameKeys(ne, ["count", "names"]) || !isCount(ne.count, 0) || !Array.isArray(ne.names)) return "not_evaluated is null or exactly {count, names}";
    const names = ne.names as unknown[];
    if (names.length !== Math.min(ne.count as number, NOT_EVALUATED_MAX_NAMES) || !names.every((n) => typeof n === "string" && AGENT_NAME.test(n))) {
      return `not_evaluated.names holds the first min(count, ${NOT_EVALUATED_MAX_NAMES}) agent names`;
    }
    for (let k = 1; k < names.length; k++) if (!((names[k - 1] as string) < (names[k] as string))) return "not_evaluated.names must be unique and sorted";
  }
  return buildFault(h.build) ?? resolutionFault(h.resolution);
}

/** Q2: the condition of THIS attempt. Waiting and log-full are states of the job, not failures. */
export function conditionOf(attempt: { waiting: boolean; logFull: boolean }, consecutiveFailures: number): HeartbeatCondition {
  if (attempt.waiting) return "waiting-for-writer";
  if (attempt.logFull) return "log-full";
  return consecutiveFailures >= FAILING_AFTER ? "failing" : "ok";
}

/** V2's liveness verdict from one heartbeat read (`not-installed`/`disabled`/`unreadable` are decided before it). */
export function judgeHeartbeat(h: Pick<Heartbeat, "at" | "interval_ms">, nowWall: number): { state: "healthy" | "stale"; age_ms: number; why: string } {
  const at = Date.parse(h.at);
  const age = nowWall - at;
  if (age < -FUTURE_TOLERANCE_MS) return { state: "stale", age_ms: age, why: `the heartbeat is ${Math.round(-age / 1000)} s in the FUTURE (the wall clock went back)` };
  const limit = Math.max(STALE_INTERVALS * h.interval_ms, STALE_FLOOR_MS);
  if (age > limit) return { state: "stale", age_ms: age, why: `the last cycle was ${Math.round(age / 1000)} s ago (stale after ${Math.round(limit / 1000)} s)` };
  return { state: "healthy", age_ms: age, why: "cycling" };
}

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/** Read the heartbeat no-follow. Absent is NOT an error (not-installed); anything else that fails is unreadable. */
export function readHeartbeat(stateDir: string): { kind: "absent" } | { kind: "ok"; heartbeat: Heartbeat } | { kind: "unreadable"; reason: string } {
  const p = path.join(stateDir, HEARTBEAT_FILENAME);
  let fd: number;
  try {
    fd = fs.openSync(p, fs.constants.O_RDONLY | O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable", reason: `cannot open ${p} (${code ?? String(err)})` };
  }
  try {
    if (!fs.fstatSync(fd).isFile()) return { kind: "unreadable", reason: `${p} is not a regular file` };
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(fd, "utf-8"));
    } catch {
      return { kind: "unreadable", reason: `${p} is not JSON` };
    }
    const fault = heartbeatFault(parsed);
    return fault ? { kind: "unreadable", reason: `${p} is not a valid heartbeat (${fault})` } : { kind: "ok", heartbeat: parsed as Heartbeat };
  } finally {
    fs.closeSync(fd);
  }
}
