// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The doorbell's ONE append-only, write-ahead JSONL log (ADR-0038 Q2; plan v3 PR 1).
 * It is both the record and the transport: an intent is written HERE, durably, before
 * anything acts on it, and an out-of-process driver tails this file read-only.
 *
 *   - CLOSED SCHEMA (C3): every record has an exact key set. An intent is exactly
 *     {intent_id, agent_name, binding_id, during_escalation}; WHY each id is rung is a
 *     closed enum ON EACH ID (`covers.kinds`, PR 3 ruling c04f463a Q3), never one
 *     intent-level reason and never free text. An extra field is refused by the writer,
 *     so it never reaches the file.
 *   - CONTENT-FREE (A1): no message content, sender or subject. An intent record says
 *     which ids it covers, for which reading session (V4 rung memory), and nothing more.
 *   - RUNG MEMORY (V4) is rebuilt from the intents on every start, keyed
 *     (reading session, message id), so a restart never re-rings the same pair.
 *   - Mode 0600 in a 0700 state dir; an existing file readable by anyone else is refused.
 */
import fs from "fs";
import path from "path";
import { AGENT_NAME_PATTERN } from "./types.js";
import { ACTIVE_INSTANCE_MARKER } from "./resolve-instance.js";

/**
 * Why each id is rung, ON EACH ID (C3; ruling c04f463a Q3): a closed ENUM, never free text.
 *   - "new": not rung before for this reading session (the V4 trigger);
 *   - "still_pending": rung before, still pending at its horizon: a RE-RING (PR 3), the only
 *     path that rings an already-rung key, and only under the per-key cap.
 */
export const ID_KINDS = ["new", "still_pending"] as const;
export type IdKind = (typeof ID_KINDS)[number];

export interface Intent {
  intent_id: string;
  agent_name: string;
  binding_id: string;
  /** The ONE extra ring an open agent_unresponsive escalation allows (ruling c04f463a Q4). */
  during_escalation: boolean;
}

export interface IntentRecord {
  v: 1;
  type: "intent";
  /** Wall time (for humans and across restarts). */
  at: string;
  /** Monotonic ms since this job lifetime's header (ruling 622689ba: the in-lifetime clock). */
  mono_ms: number;
  intent: Intent;
  /**
   * What this intent rings for: the reading session (PR 0b digest), the message ids (a
   * canonical set), and each id's kind, index-aligned with message_ids.
   */
  covers: { reading_session: string; message_ids: string[]; kinds: IdKind[] };
}

export interface HeaderRecord {
  v: 1;
  type: "header";
  at: string;
  pid: number;
  /** ADR-0047: what THIS process loaded (LOADED_BUILD), exactly its seven keys. */
  build: {
    build_id: string;
    commit: string | null;
    dirty: boolean | null;
    built_at: string | null;
    deps_id: string | null;
    deps_state: "known" | "unknown" | "error";
    node: string;
  };
  install_dir: string;
  /** ADR-0048: the resolution it runs against (serializeResolution of a non-error kind). */
  resolution: Record<string, unknown>;
}

/**
 * PR 2 (ADR-0038 Q4 + A3.2): an agent's ring-budget STATE CHANGED. Written once per change
 * (never once per refused cycle), and again when it changes back.
 */
export const BUDGET_STATES = ["exhausted", "available"] as const;
export interface BudgetRecord {
  v: 1;
  type: "budget";
  at: string;
  agent_name: string;
  state: (typeof BUDGET_STATES)[number];
  /** Rings in the trailing hour when the state changed. */
  rings_in_hour: number;
  budget_per_hour: number;
}

/** Ruling 622689ba (4): an in-lifetime WALL-CLOCK JUMP (|wall delta − mono delta| > 5 s), for audit. */
export interface ClockRecord {
  v: 1;
  type: "clock";
  at: string;
  mono_ms: number;
  wall_delta_ms: number;
  mono_delta_ms: number;
}

/**
 * PR 3 (A2.3 as corrected by V4): what became of rings, judged for ONE (agent, reading
 * session). Written once per judgement (A3.2), so a restart rebuilds the ineffective-ring
 * counter and the un-judged ("outstanding") rings from the log alone.
 *   - "effective": rung ids of this session LEFT its pending set (`left`); every ring still
 *     outstanding (`intent_ids`, possibly none) is judged effective, and the counter resets.
 *     One batch may span several records, each within the per-record id bound (never both
 *     lists empty).
 *   - "ineffective": ONE ring (`intent_ids`, exactly one) reached its horizon with no rung id
 *     of this session having left since; the counter goes up by one.
 *   - "session_changed": the reading session moved; the rings still outstanding for the OLD
 *     one (`intent_ids`, never empty) are moot (the V4 rescue path, never effectiveness).
 */
export const EFFECT_OUTCOMES = ["effective", "ineffective", "session_changed"] as const;
export interface EffectRecord {
  v: 1;
  type: "effect";
  at: string;
  agent_name: string;
  reading_session: string;
  outcome: (typeof EFFECT_OUTCOMES)[number];
  intent_ids: string[];
  left: string[];
}

/**
 * PR 3 (V1, V3; ruling c04f463a): an escalation, to the board and THIS log only (never a
 * relay message). Opened once, closed once (A3.2), matched by escalation_id. It is never a
 * failure and never counts as one.
 *   - "agent_unresponsive": ESCALATE_AFTER ineffective rings in a row for one (agent, reading
 *     session). While open, the agent is not rung, except ONE ring for new mail.
 *   - "id_stuck": one id rung RE_RING_CAP times without leaving pending: dropped from re-ring.
 * `operator` is the configured operator agent (V3, default null): ATTRIBUTION ONLY, never a
 * ring target. It closes when an id of `message_ids` (or of the escalation's extra ring)
 * leaves pending for the same reading session ("progress"), or the reading session changes.
 */
export const ESCALATION_REASONS = ["agent_unresponsive", "id_stuck"] as const;
export const ESCALATION_STATES = ["open", "closed"] as const;
export const CLOSE_REASONS = ["progress", "session_changed"] as const;
export interface EscalationRecord {
  v: 1;
  type: "escalation";
  at: string;
  escalation_id: string;
  agent_name: string;
  reading_session: string;
  reason: (typeof ESCALATION_REASONS)[number];
  state: (typeof ESCALATION_STATES)[number];
  message_ids: string[];
  operator: string | null;
  close_reason: (typeof CLOSE_REASONS)[number] | null;
}

export type LogRecord = IntentRecord | HeaderRecord | BudgetRecord | ClockRecord | EffectRecord | EscalationRecord;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
/** An ISO UTC timestamp, BOUNDED (#300 R2 #5): at most 9 fractional digits. */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
/** At most this many ids in one intent (a burst is far smaller; a record stays bounded). */
export const MAX_IDS_PER_INTENT = 10_000;

const MAX_PATH = 4096;
const MAX_TEXT = 500;
/** A bounded, single-line string: no control character, at most `max` characters. */
const boundedText = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const nullOr = <T>(v: unknown, ok: (x: unknown) => x is T): boolean => v === null || ok(v);
const HEX64 = /^[0-9a-f]{64}$/;

/** #300 R1 #7: the header's nested objects are CLOSED too: exact keys, typed and bounded values. */
export function buildFault(b: unknown): string | null {
  if (!sameKeys(b, ["build_id", "commit", "dirty", "built_at", "deps_id", "deps_state", "node"])) {
    return "build has exactly build_id, commit, dirty, built_at, deps_id, deps_state, node";
  }
  if (typeof b.build_id !== "string" || !(HEX64.test(b.build_id) || b.build_id === "unbuilt")) return "build.build_id is not a code id";
  if (!nullOr(b.commit, (x): x is string => typeof x === "string" && /^[0-9a-f]{7,64}$/.test(x))) return "build.commit is not a commit id";
  if (!(b.dirty === null || typeof b.dirty === "boolean")) return "build.dirty is not a boolean";
  if (!nullOr(b.built_at, (x): x is string => typeof x === "string" && ISO_RE.test(x))) return "build.built_at is not an ISO timestamp";
  if (!nullOr(b.deps_id, (x): x is string => typeof x === "string" && HEX64.test(x))) return "build.deps_id is not a deps id";
  if (!["known", "unknown", "error"].includes(b.deps_state as string)) return "build.deps_state is not known, unknown or error";
  if (typeof b.node !== "string" || !/^v\d{1,4}\.\d{1,4}\.\d{1,4}([-+][0-9A-Za-z.]{1,24})?$/.test(b.node)) return "build.node is not a bounded node version";
  return null;
}
export function resolutionFault(r: unknown): string | null {
  const kind = (r as { kind?: unknown } | null)?.kind;
  const base = ["kind", "db_path", "exists", "containment"];
  const keys =
    kind === "explicit-db" || kind === "instance"
      ? [...base, "basis", ...(kind === "instance" ? ["id"] : [])]
      : kind === "flat"
        ? (r as Record<string, unknown>).warning === undefined
          ? base
          : [...base, "warning"]
        : null;
  if (!keys) return "resolution.kind is not explicit-db, instance or flat";
  if (!sameKeys(r, keys)) return `resolution (${kind as string}) has exactly ${keys.join(", ")}`;
  if (!boundedText(r.db_path, MAX_PATH)) return "resolution.db_path is not a bounded path";
  if (typeof r.exists !== "boolean") return "resolution.exists is not a boolean";
  if (!["strict", "roots-only"].includes(r.containment as string)) return "resolution.containment is not strict or roots-only";
  if (kind === "explicit-db" && !["RELAY_DB_PATH", "--db-path"].includes(r.basis as string)) return "resolution.basis is not RELAY_DB_PATH or --db-path";
  if (kind === "instance") {
    // That basis IS the marker file's name: the resolver's constant, never re-spelled (ADR-0048 tripwire).
    if (!["RELAY_INSTANCE_ID", ACTIVE_INSTANCE_MARKER].includes(r.basis as string)) return `resolution.basis is not RELAY_INSTANCE_ID or ${ACTIVE_INSTANCE_MARKER}`;
    if (typeof r.id !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(r.id)) return "resolution.id is not an instance id";
  }
  if (r.warning !== undefined && !boundedText(r.warning, MAX_TEXT)) return "resolution.warning is not bounded text";
  return null;
}

/** A bounded integer number of ms (about 317 years either way at most). */
const MAX_MS = 10_000_000_000_000;
const boundedMs = (v: unknown, min: number): boolean => Number.isInteger(v) && (v as number) >= min && (v as number) <= MAX_MS;

const sameKeys = (o: unknown, keys: readonly string[]): o is Record<string, unknown> =>
  !!o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).sort().join(",") === [...keys].sort().join(",");
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200 && !/[\u0000-\u001f\u007f]/.test(v);
/** A canonical SET of bounded strings: unique and sorted (#300 R1 #8), at most `max`, at least `min`. */
function setFault(v: unknown, what: string, min: number, max: number, item: (x: unknown) => boolean): string | null {
  if (!Array.isArray(v) || v.length < min || v.length > max || !v.every(item)) return `${what} must be a list of ${min}..${max} bounded ids`;
  for (let k = 1; k < v.length; k++) if (!((v[k - 1] as string) < (v[k] as string))) return `${what} must be unique and sorted (a canonical set)`;
  return null;
}
const isUuid = (x: unknown): boolean => typeof x === "string" && UUID_RE.test(x);

/** Why this is not a valid record, or null. The schema is CLOSED: an extra key anywhere is invalid. */
export function recordFault(r: unknown): string | null {
  if (!r || typeof r !== "object") return "not an object";
  const t = (r as { type?: unknown }).type;
  if (t === "intent") {
    if (!sameKeys(r, ["v", "type", "at", "mono_ms", "intent", "covers"])) return "an intent record has exactly v, type, at, mono_ms, intent, covers";
    if (r.v !== 1) return "unknown record version";
    if (typeof r.at !== "string" || !ISO_RE.test(r.at)) return "at is not an ISO UTC timestamp";
    if (!boundedMs(r.mono_ms, 0)) return "mono_ms is not a bounded non-negative integer";
    const i = r.intent;
    if (!sameKeys(i, ["intent_id", "agent_name", "binding_id", "during_escalation"])) return "an intent has exactly intent_id, agent_name, binding_id, during_escalation";
    if (typeof i.intent_id !== "string" || !UUID_RE.test(i.intent_id)) return "intent_id is not a v4 UUID";
    if (typeof i.agent_name !== "string" || !AGENT_NAME_PATTERN.test(i.agent_name)) return "agent_name is not a valid agent name";
    if (!nonEmpty(i.binding_id)) return "binding_id is empty or holds a control character";
    if (typeof i.during_escalation !== "boolean") return "during_escalation is not a boolean";
    const c = r.covers;
    if (!sameKeys(c, ["reading_session", "message_ids", "kinds"])) return "covers has exactly reading_session, message_ids, kinds";
    if (typeof c.reading_session !== "string" || !DIGEST_RE.test(c.reading_session)) return "reading_session is not a 64-hex digest";
    if (!Array.isArray(c.message_ids) || c.message_ids.length === 0 || c.message_ids.length > MAX_IDS_PER_INTENT || !c.message_ids.every(nonEmpty)) {
      return `message_ids must be a non-empty list of at most ${MAX_IDS_PER_INTENT} bounded ids`;
    }
    // #300 R1 #8: a SET in canonical form: unique and sorted, at the writer AND on replay.
    const ids = c.message_ids as string[];
    for (let k = 1; k < ids.length; k++) if (!(ids[k - 1] < ids[k])) return "message_ids must be unique and sorted (a canonical set)";
    if (!Array.isArray(c.kinds) || c.kinds.length !== ids.length) return "kinds must have one entry per message id";
    if (!c.kinds.every((k) => (ID_KINDS as readonly unknown[]).includes(k))) return `each kind must be one of ${ID_KINDS.join(", ")} (never free text)`;
    // Ruling c04f463a Q4: the extra ring during an escalation is for NEW mail only.
    if (i.during_escalation && !c.kinds.every((k) => k === "new")) return "an intent during an escalation rings new ids only";
    return null;
  }
  if (t === "effect") {
    if (!sameKeys(r, ["v", "type", "at", "agent_name", "reading_session", "outcome", "intent_ids", "left"])) {
      return "an effect record has exactly v, type, at, agent_name, reading_session, outcome, intent_ids, left";
    }
    if (r.v !== 1) return "unknown record version";
    if (typeof r.at !== "string" || !ISO_RE.test(r.at)) return "at is not an ISO UTC timestamp";
    if (typeof r.agent_name !== "string" || !AGENT_NAME_PATTERN.test(r.agent_name)) return "agent_name is not a valid agent name";
    if (typeof r.reading_session !== "string" || !DIGEST_RE.test(r.reading_session)) return "reading_session is not a 64-hex digest";
    if (!(EFFECT_OUTCOMES as readonly unknown[]).includes(r.outcome)) return `outcome must be one of ${EFFECT_OUTCOMES.join(", ")}`;
    // An `effective` batch over the per-record bound is split across records (#302 Codex R1 F4),
    // so a continuation chunk may carry only intent_ids; never neither.
    const shape =
      r.outcome === "effective" ? { iMin: 0, iMax: MAX_IDS_PER_INTENT, lMin: 0, lMax: MAX_IDS_PER_INTENT } : r.outcome === "ineffective" ? { iMin: 1, iMax: 1, lMin: 0, lMax: 0 } : { iMin: 1, iMax: MAX_IDS_PER_INTENT, lMin: 0, lMax: 0 };
    const f = setFault(r.intent_ids, `${r.outcome as string} intent_ids`, shape.iMin, shape.iMax, isUuid) ?? setFault(r.left, `${r.outcome as string} left`, shape.lMin, shape.lMax, nonEmpty);
    if (f) return f;
    if (r.outcome === "effective" && (r.intent_ids as string[]).length === 0 && (r.left as string[]).length === 0) return "an effective record names at least one intent or one left id";
    return null;
  }
  if (t === "escalation") {
    if (!sameKeys(r, ["v", "type", "at", "escalation_id", "agent_name", "reading_session", "reason", "state", "message_ids", "operator", "close_reason"])) {
      return "an escalation record has exactly v, type, at, escalation_id, agent_name, reading_session, reason, state, message_ids, operator, close_reason";
    }
    if (r.v !== 1) return "unknown record version";
    if (typeof r.at !== "string" || !ISO_RE.test(r.at)) return "at is not an ISO UTC timestamp";
    if (!isUuid(r.escalation_id)) return "escalation_id is not a v4 UUID";
    if (typeof r.agent_name !== "string" || !AGENT_NAME_PATTERN.test(r.agent_name)) return "agent_name is not a valid agent name";
    if (typeof r.reading_session !== "string" || !DIGEST_RE.test(r.reading_session)) return "reading_session is not a 64-hex digest";
    if (!(ESCALATION_REASONS as readonly unknown[]).includes(r.reason)) return `reason must be one of ${ESCALATION_REASONS.join(", ")} (never free text)`;
    if (!(ESCALATION_STATES as readonly unknown[]).includes(r.state)) return `state must be one of ${ESCALATION_STATES.join(", ")}`;
    const f = setFault(r.message_ids, "message_ids", 1, MAX_IDS_PER_INTENT, nonEmpty);
    if (f) return f;
    if (r.reason === "id_stuck" && (r.message_ids as string[]).length !== 1) return "an id_stuck escalation is for exactly one id";
    if (!(r.operator === null || (typeof r.operator === "string" && AGENT_NAME_PATTERN.test(r.operator)))) return "operator is not null or a valid agent name";
    if (r.state === "open" ? r.close_reason !== null : !(CLOSE_REASONS as readonly unknown[]).includes(r.close_reason)) {
      return `close_reason is null while open, and one of ${CLOSE_REASONS.join(", ")} once closed`;
    }
    return null;
  }
  if (t === "clock") {
    if (!sameKeys(r, ["v", "type", "at", "mono_ms", "wall_delta_ms", "mono_delta_ms"])) return "a clock record has exactly v, type, at, mono_ms, wall_delta_ms, mono_delta_ms";
    if (r.v !== 1) return "unknown record version";
    if (typeof r.at !== "string" || !ISO_RE.test(r.at)) return "at is not an ISO UTC timestamp";
    if (!boundedMs(r.mono_ms, 0) || !boundedMs(r.wall_delta_ms, -MAX_MS) || !boundedMs(r.mono_delta_ms, 0)) return "a clock record's ms fields are not bounded integers";
    return null;
  }
  if (t === "budget") {
    if (!sameKeys(r, ["v", "type", "at", "agent_name", "state", "rings_in_hour", "budget_per_hour"])) {
      return "a budget record has exactly v, type, at, agent_name, state, rings_in_hour, budget_per_hour";
    }
    if (r.v !== 1) return "unknown record version";
    if (typeof r.at !== "string" || !ISO_RE.test(r.at)) return "at is not an ISO UTC timestamp";
    if (typeof r.agent_name !== "string" || !AGENT_NAME_PATTERN.test(r.agent_name)) return "agent_name is not a valid agent name";
    if (!(BUDGET_STATES as readonly unknown[]).includes(r.state)) return `state must be one of ${BUDGET_STATES.join(", ")}`;
    // Bounded (#300 R2 #5): a budget is at most 60/hour (doorbell-core bounds), so these stay small.
    if (!Number.isInteger(r.rings_in_hour) || (r.rings_in_hour as number) < 0 || (r.rings_in_hour as number) > 100_000) return "rings_in_hour is not a bounded non-negative integer";
    if (!Number.isInteger(r.budget_per_hour) || (r.budget_per_hour as number) < 1 || (r.budget_per_hour as number) > 1000) return "budget_per_hour is not a bounded positive integer";
    return null;
  }
  if (t === "header") {
    if (!sameKeys(r, ["v", "type", "at", "pid", "build", "install_dir", "resolution"])) return "a header record has exactly v, type, at, pid, build, install_dir, resolution";
    if (r.v !== 1) return "unknown record version";
    if (typeof r.at !== "string" || !ISO_RE.test(r.at)) return "at is not an ISO UTC timestamp";
    if (!Number.isInteger(r.pid) || (r.pid as number) <= 0 || (r.pid as number) > 0x7fffffff) return "pid is not a positive 32-bit integer";
    const bf = buildFault(r.build);
    if (bf) return bf;
    if (!boundedText(r.install_dir, MAX_PATH)) return "install_dir is not a bounded path";
    return resolutionFault(r.resolution);
  }
  return "unknown record type";
}

/** The rung-memory key: (reading session, message id). */
export const rungKey = (readingSession: string, messageId: string): string => `${readingSession}\u0000${messageId}`;

/** The state dir beside the resolved DB (plan v3 Q5): per instance, mode 0700. */
export function stateDirFor(dbPath: string): string {
  return path.join(path.dirname(dbPath), "doorbell");
}
export const LOG_FILENAME = "actuation.jsonl";

/**
 * EVERY open of doorbell state is no-follow (#300 R1 #2; ruling 8c83e4ce): a symlink
 * planted at the log path (say, to the relay DB) is refused by the kernel, never written
 * through. Where the platform has no O_NOFOLLOW, the lstat + identity checks still refuse it.
 */
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/** The file I/O an append uses (injectable, so a short write or a failed fsync can be tested). */
export interface LogIo {
  writeSync(fd: number, buf: Buffer, offset: number, length: number): number;
  fsyncSync(fd: number): void;
  fstatSync(fd: number): fs.Stats;
}
export const realLogIo: LogIo = {
  writeSync: (fd, buf, offset, length) => fs.writeSync(fd, buf, offset, length),
  fsyncSync: (fd) => fs.fsyncSync(fd),
  fstatSync: (fd) => fs.fstatSync(fd),
};

/** The log, held open for the job's life: one identity-checked, no-follow descriptor. */
export interface LogHandle {
  fd: number;
  path: string;
  io: LogIo;
  /** The VERIFIED state dir, held open (no-follow), and its identity (#300 R2 #2). */
  dirFd: number;
  dirDev: number;
  dirIno: number;
}

/**
 * The state dir must still be the directory openLog verified: a real directory (not a
 * symlink) with the same (dev, ino). Node has no openat/renameat, so path operations are
 * re-anchored by checking this immediately before each of them: it narrows the window to
 * the instant between the check and the call, it cannot close it. A mismatch is a
 * LogWriteError: the job stops, it never writes into a directory it did not verify.
 */
function verifyDir(h: LogHandle, what: string): void {
  const dir = path.dirname(h.path);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dir);
  } catch (err) {
    throw new LogWriteError(`the doorbell state dir is gone ${what} (${err instanceof Error ? err.message : String(err)})`);
  }
  if (st.isSymbolicLink() || !st.isDirectory() || st.dev !== h.dirDev || st.ino !== h.dirIno) {
    throw new LogWriteError(`the doorbell state dir ${dir} was replaced ${what}: refusing to write into it`);
  }
}

/** The state dir must be a REAL directory (not a symlink), private (0700). */
function ensurePrivateDir(dir: string): fs.Stats {
  let st: fs.Stats | null = null;
  try {
    st = fs.lstatSync(dir);
  } catch {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    st = fs.lstatSync(dir);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} is not a real directory (a symlink or another file type): refusing to use it as the doorbell state dir`);
  const mode = st.mode & 0o777;
  if (mode & 0o077) throw new Error(`${dir} is mode ${mode.toString(8)}: the doorbell state dir must be private (0700)`);
  return st;
}

/**
 * Open the log for the job's life. #300 R1 #2:
 *   - the state dir and the log are lstat-checked: a symlink or a non-regular file is REFUSED;
 *   - the log is opened O_NOFOLLOW, and its (dev, ino) must equal what lstat saw (no swap
 *     between the check and the open); a new log is created O_EXCL, mode 0600;
 *   - recovery VALIDATES first: every complete line must be a valid record (else refuse,
 *     touching nothing), and only then is an UNTERMINATED tail truncated (a crash
 *     mid-write; never fully logged, so never acted on).
 * Returns the handle and the state rebuilt from the same read.
 */
export function openLog(stateDir: string, io: LogIo = realLogIo): { handle: LogHandle; state: LogState; recoveredBytes: number } {
  const dirSt = ensurePrivateDir(stateDir);
  // A compaction that crashed before its rename left only its temp file: the log itself is
  // intact, so the temp is discarded (unlink removes a planted symlink itself, never its target).
  for (const name of fs.readdirSync(stateDir)) if (name.startsWith(COMPACT_PREFIX) || name.startsWith(STATE_FILE_TMP_PREFIX)) fs.unlinkSync(path.join(stateDir, name));
  const logPath = path.join(stateDir, LOG_FILENAME);
  let pre: fs.Stats | null = null;
  try {
    pre = fs.lstatSync(logPath);
  } catch {
    pre = null;
  }
  if (pre && (pre.isSymbolicLink() || !pre.isFile())) throw new Error(`${logPath} is not a regular file (a symlink or another file type): refusing to open it`);
  const flags = fs.constants.O_RDWR | fs.constants.O_APPEND | O_NOFOLLOW | (pre ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL);
  const fd = fs.openSync(logPath, flags, 0o600);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error(`${logPath} is not a regular file`);
    if (pre && (st.dev !== pre.dev || st.ino !== pre.ino)) throw new Error(`${logPath} changed between its check and its open: refusing it`);
    const mode = st.mode & 0o777;
    if (mode & 0o077) throw new Error(`${logPath} is mode ${mode.toString(8)}: the doorbell log must be private (0600)`);
    const bytes = fs.readFileSync(fd);
    const state = parseLogText(bytes.toString("utf-8"), logPath); // throws before any truncation
    let recoveredBytes = 0;
    if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) {
      const keep = bytes.lastIndexOf(0x0a) + 1;
      recoveredBytes = bytes.length - keep;
      fs.ftruncateSync(fd, keep);
      state.tornTail = false;
    }
    const dirFd = fs.openSync(stateDir, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | O_NOFOLLOW);
    const held = fs.fstatSync(dirFd);
    if (held.dev !== dirSt.dev || held.ino !== dirSt.ino) {
      fs.closeSync(dirFd);
      throw new Error(`${stateDir} changed between its check and its open: refusing it`);
    }
    return { handle: { fd, path: logPath, io, dirFd, dirDev: held.dev, dirIno: held.ino }, state, recoveredBytes };
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
}

export function closeLog(h: LogHandle): void {
  fs.closeSync(h.fd);
  fs.closeSync(h.dirFd);
}

/** A log append that did not provably complete: the job must FAIL-STOP (#300 R1 #4). */
export class LogWriteError extends Error {}

/**
 * The writer REFUSED a planned record (it fails the closed schema). Nothing was written; the
 * cycle fails, and the heartbeat records it as kind `record-refused` (ruling 9987c113 Q5).
 */
export class RecordRefusedError extends Error {}

/**
 * WRITE-AHEAD append through the held descriptor: validate, write the WHOLE line (a short
 * write is continued, no progress is an error), check the file grew by exactly that many
 * bytes, fsync, and only then return (#300 R1 #3). The caller advances its memory only
 * after this returns; any failure is a LogWriteError, and the job stops rather than retry
 * a record that may already be on disk (#4: a restart rebuilds from the log).
 */
export function appendRecord(h: LogHandle, rec: LogRecord): void {
  const fault = recordFault(rec);
  if (fault) throw new RecordRefusedError(`refusing to log an invalid doorbell record: ${fault}`);
  const buf = Buffer.from(JSON.stringify(rec) + "\n", "utf-8");
  try {
    const before = h.io.fstatSync(h.fd).size;
    let off = 0;
    while (off < buf.length) {
      const n = h.io.writeSync(h.fd, buf, off, buf.length - off);
      if (!(n > 0)) throw new Error(`a write made no progress at byte ${off} of ${buf.length}`);
      off += n;
    }
    const after = h.io.fstatSync(h.fd).size;
    if (after !== before + buf.length) throw new Error(`the log grew by ${after - before} bytes, not ${buf.length}`);
    h.io.fsyncSync(h.fd);
  } catch (err) {
    throw new LogWriteError(`the doorbell log write did not complete (${err instanceof Error ? err.message : String(err)})`);
  }
}

/** Everything the job keeps between cycles, rebuilt from the log on start (never memory-only). */
export interface LogState {
  /** rungKey(reading session, id) for every id an intent covered. */
  rung: Set<string>;
  /** Per agent: the WALL time (ms) of every intent in the log, oldest first (previous lifetimes). */
  ringWalls: Map<string, number[]>;
  /** The wall time (ms) of the LAST header in the log (null if none): a backward-jump detector. */
  lastHeaderWall: number | null;
  /** Agents whose LAST budget record says exhausted (A3.2: so a restart does not log it again). */
  budgetExhausted: Set<string>;
  tornTail: boolean;
  /** Every valid record, in order (compaction and readers use it). */
  records: LogRecord[];
}

/**
 * THE one reducer: what a record changes in the job's state. Replay (parseLogText) and the
 * running job (after each durable append) both go through it, so memory and the log can
 * never disagree about rung memory, budget state, effects or escalations.
 */
export function foldRecord(state: LogState, r: LogRecord): void {
  state.records.push(r);
  if (r.type === "intent") {
    for (const id of r.covers.message_ids) state.rung.add(rungKey(r.covers.reading_session, id));
    const walls = state.ringWalls.get(r.intent.agent_name) ?? [];
    walls.push(Date.parse(r.at));
    state.ringWalls.set(r.intent.agent_name, walls);
  } else if (r.type === "header") {
    state.lastHeaderWall = Date.parse(r.at);
  } else if (r.type === "budget") {
    if (r.state === "exhausted") state.budgetExhausted.add(r.agent_name);
    else state.budgetExhausted.delete(r.agent_name);
  }
}

/**
 * Parse the log text. A torn tail (an UNTERMINATED last line) is skipped and reported. Any
 * other invalid line, a complete one included, means the log is not what this writer
 * wrote: REFUSED (fail closed: no cycle runs on a state it cannot trust).
 */
function parseLogText(text: string, logPath: string): LogState {
  const terminated = text.endsWith("\n");
  const lines = text.split("\n");
  lines.pop(); // "" after a final newline, or the unterminated tail (checked below)
  const tail = terminated ? null : text.slice(text.lastIndexOf("\n") + 1);
  const state: LogState = { rung: new Set(), ringWalls: new Map(), lastHeaderWall: null, budgetExhausted: new Set(), tornTail: false, records: [] };
  lines.forEach((line, i) => {
    let rec: unknown;
    let fault: string | null;
    try {
      rec = JSON.parse(line);
      fault = recordFault(rec);
    } catch {
      fault = "not JSON";
    }
    if (fault) throw new Error(`${logPath} line ${i + 1} is not a valid doorbell record (${fault}): refusing to rebuild rung memory from it`);
    foldRecord(state, rec as LogRecord);
  });
  if (tail !== null && tail.length > 0) state.tornTail = true;
  return state;
}

/** A READER's view of the log (tests, tailers): opened read-only and no-follow, never written. */
export function readLogState(logPath: string): LogState {
  const fd = fs.openSync(logPath, fs.constants.O_RDONLY | O_NOFOLLOW);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`${logPath} is not a regular file`);
    return parseLogText(fs.readFileSync(fd, "utf-8"), logPath);
  } finally {
    fs.closeSync(fd);
  }
}

/** Rung memory only (PR 1's reader name), from the same parse. */
export function readRungMemory(logPath: string): { rung: Set<string>; tornTail: boolean } {
  const s = readLogState(logPath);
  return { rung: s.rung, tornTail: s.tornTail };
}

// ---------------------------------------------------------------------------
// D-2 (ruling 8c83e4ce): compaction on start, and the reference tailer
// ---------------------------------------------------------------------------

const COMPACT_PREFIX = ".actuation.jsonl.compact-";
/** Temp files of replaceStateFile (a crash before the rename leaves one; the next open discards it). */
const STATE_FILE_TMP_PREFIX = ".state-file.tmp-";

/**
 * Replace ONE small file in the VERIFIED state dir, crash-safe and atomic (the heartbeat): a new
 * no-follow, exclusive, 0600 temp is written in full and fsynced, the dir is re-verified, the temp
 * is renamed over the target, and the HELD dir is fsynced. A reader sees the old file or the new
 * one, never a torn one. Any step that does not complete throws (the caller decides; the temp is
 * removed when the rename did not happen).
 */
export function replaceStateFile(h: LogHandle, filename: string, contents: string): void {
  if (filename.includes("/") || filename.startsWith(".")) throw new Error(`not a state file name: ${filename}`);
  const stateDir = path.dirname(h.path);
  const tmp = path.join(stateDir, `${STATE_FILE_TMP_PREFIX}${filename}.${process.pid}`);
  const buf = Buffer.from(contents, "utf-8");
  let renamed = false;
  try {
    verifyDir(h, `before the ${filename} temp file was created`);
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o600);
    try {
      let off = 0;
      while (off < buf.length) {
        const n = h.io.writeSync(fd, buf, off, buf.length - off);
        if (!(n > 0)) throw new Error(`a ${filename} write made no progress at byte ${off} of ${buf.length}`);
        off += n;
      }
      h.io.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    verifyDir(h, `before the ${filename} rename`);
    fs.renameSync(tmp, path.join(stateDir, filename));
    renamed = true;
    h.io.fsyncSync(h.dirFd);
  } finally {
    if (!renamed) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* the temp may not exist; the next open discards any left over */
      }
    }
  }
}
/** Headers kept by a compaction: the most recent ones (provenance of recent runs). */
export const COMPACT_KEEP_HEADERS = 5;
/** Clock records kept by a compaction (#301 Codex R2 #2): the most recent, for audit; never unbounded. */
export const COMPACT_KEEP_CLOCKS = 16;

/**
 * Rewrite the log keeping only what still matters, CRASH-SAFE: the kept records go to a
 * new no-follow, exclusive, 0600 temp file in the state dir, which is fsynced, renamed
 * over the log (atomic), and the dir fsynced. A crash before the rename leaves the old log
 * intact (the temp is discarded on the next open); after it, the new one. Kept records are
 * written UNCHANGED (a tailer dedupes by intent_id, so nothing it already saw is new).
 * Returns a fresh handle on the new file (the old one is closed).
 */
export function compactLog(
  h: LogHandle,
  keepIntent: (rec: IntentRecord) => boolean,
  /** PR 3: which effect and escalation records to keep, given the kept intents (default: all). */
  keepLedger?: (records: readonly LogRecord[], keptIntentIds: ReadonlySet<string>) => ReadonlySet<LogRecord>,
): { handle: LogHandle; state: LogState; beforeBytes: number; afterBytes: number } {
  const stateDir = path.dirname(h.path);
  const beforeBytes = h.io.fstatSync(h.fd).size;
  // Read through the HELD descriptor from byte 0 (its position is at the end after appends).
  const all = Buffer.alloc(beforeBytes);
  let got = 0;
  while (got < beforeBytes) {
    const n = fs.readSync(h.fd, all, got, beforeBytes - got, got);
    if (n <= 0) break;
    got += n;
  }
  const current = parseLogText(all.subarray(0, got).toString("utf-8"), h.path);
  const headers = current.records.filter((r) => r.type === "header").slice(-COMPACT_KEEP_HEADERS);
  // The budget STATE is the last budget record per agent: earlier ones are history.
  const lastBudget = new Map<string, LogRecord>();
  for (const r of current.records) if (r.type === "budget") lastBudget.set(r.agent_name, r);
  const clocks = new Set(current.records.filter((r) => r.type === "clock").slice(-COMPACT_KEEP_CLOCKS));
  const keptIntentIds = new Set<string>();
  for (const r of current.records) if (r.type === "intent" && keepIntent(r)) keptIntentIds.add(r.intent.intent_id);
  const ledger = keepLedger?.(current.records, keptIntentIds) ?? null;
  const kept = current.records.filter((r) =>
    r.type === "header"
      ? headers.includes(r)
      : r.type === "intent"
        ? keptIntentIds.has(r.intent.intent_id)
        : r.type === "budget"
          ? lastBudget.get(r.agent_name) === r
          : r.type === "clock"
            ? clocks.has(r)
            : ledger === null || ledger.has(r),
  );
  const tmp = path.join(stateDir, `${COMPACT_PREFIX}${process.pid}`);
  // #300 R2 #1 + #2: from here on, anything that does not complete is a LogWriteError, and
  // the job FAIL-STOPS (it never resumes on the old descriptor, whose inode may already be
  // unlinked). Every path operation is re-anchored to the verified dir first.
  let renamed = false;
  try {
    verifyDir(h, "before the compaction's temp file was created");
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o600);
    let tmpIno: number;
    try {
      tmpIno = fs.fstatSync(fd).ino;
      const buf = Buffer.from(kept.map((r) => JSON.stringify(r) + "\n").join(""), "utf-8");
      let off = 0;
      while (off < buf.length) {
        const n = h.io.writeSync(fd, buf, off, buf.length - off);
        if (!(n > 0)) throw new Error(`a compaction write made no progress at byte ${off} of ${buf.length}`);
        off += n;
      }
      h.io.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    verifyDir(h, "before the compaction's rename");
    fs.renameSync(tmp, h.path);
    renamed = true;
    const landed = fs.lstatSync(h.path);
    if (landed.ino !== tmpIno || !landed.isFile()) throw new Error("the compacted log is not the file this compaction wrote");
    h.io.fsyncSync(h.dirFd); // the HELD verified dir, never re-opened by path
  } catch (err) {
    if (!renamed) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* the temp may not exist yet; the next open discards any left over */
      }
    }
    throw err instanceof LogWriteError ? err : new LogWriteError(`the compaction did not complete (${err instanceof Error ? err.message : String(err)})`);
  }
  closeLog(h);
  const reopened = openLog(stateDir, h.io);
  return { handle: reopened.handle, state: reopened.state, beforeBytes, afterBytes: reopened.handle.io.fstatSync(reopened.handle.fd).size };
}

/**
 * PR 3's keep rule for effect and escalation records (D-2 (b), ruling 8c83e4ce; c04f463a):
 *   - an escalation whose LAST record is open (its open record), so the board and the
 *     single-record rules (one id_stuck per key) survive a restart; closed ones are history;
 *   - an effect record that judged a KEPT intent (else the restart would judge it again);
 *   - an `effective` record whose `left` names an id of a kept intent of the same agent and
 *     session (else that id would look newly left after the restart: a false progress);
 *   - for each agent's CURRENT session (`currentSession`), its last `effective` record and
 *     every effect record after it: the ineffective-ring counter, exactly.
 */
export function selectLedgerKeep(
  records: readonly LogRecord[],
  keptIntentIds: ReadonlySet<string>,
  currentSession: (agent: string) => string | null | undefined,
): Set<LogRecord> {
  const keep = new Set<LogRecord>();
  const lastEsc = new Map<string, EscalationRecord>();
  for (const r of records) if (r.type === "escalation") lastEsc.set(r.escalation_id, r);
  for (const e of lastEsc.values()) if (e.state === "open") keep.add(e);
  const keptIds = new Set<string>(); // agent \0 session \0 id
  for (const r of records) if (r.type === "intent" && keptIntentIds.has(r.intent.intent_id)) for (const id of r.covers.message_ids) keptIds.add(`${r.intent.agent_name}\u0000${r.covers.reading_session}\u0000${id}`);
  const trailingFrom = new Map<string, number>(); // agent → index of its current session's last effective
  records.forEach((r, i) => {
    if (r.type === "effect" && r.outcome === "effective" && currentSession(r.agent_name) === r.reading_session) trailingFrom.set(r.agent_name, i);
  });
  records.forEach((r, i) => {
    if (r.type !== "effect") return;
    if (r.intent_ids.some((id) => keptIntentIds.has(id))) keep.add(r);
    else if (r.left.some((id) => keptIds.has(`${r.agent_name}\u0000${r.reading_session}\u0000${id}`))) keep.add(r);
    else if (currentSession(r.agent_name) === r.reading_session && i >= (trailingFrom.get(r.agent_name) ?? 0)) keep.add(r);
  });
  return keep;
}

/**
 * The reference TAILER (an out-of-process driver's reader; the log is the transport):
 * follows the log BY PATH, like `tail -F`. Each poll first drains the file it has open to
 * its end, then, if the path now names a different inode (a compaction), switches to it
 * from the start. Intents are de-duplicated by intent_id, so a compaction (which rewrites
 * kept records unchanged) loses nothing and repeats nothing. Read-only and no-follow.
 */
export class LogTailer {
  private fd: number | null = null;
  private ino = 0;
  private offset = 0;
  private partial = "";
  private readonly seen = new Set<string>();
  /** `afterDetect` is a test seam: it runs between the replacement check and the drain. */
  constructor(
    private readonly logPath: string,
    private readonly opts: { afterDetect?: () => void } = {},
  ) {}

  private openCurrent(): void {
    this.fd = fs.openSync(this.logPath, fs.constants.O_RDONLY | O_NOFOLLOW);
    this.ino = fs.fstatSync(this.fd).ino;
    this.offset = 0;
    this.partial = "";
  }

  private drain(out: IntentRecord[]): void {
    if (this.fd === null) return;
    const size = fs.fstatSync(this.fd).size;
    if (size <= this.offset) return;
    const buf = Buffer.alloc(size - this.offset);
    const n = fs.readSync(this.fd, buf, 0, buf.length, this.offset);
    this.offset += n;
    const text = this.partial + buf.subarray(0, n).toString("utf-8");
    const lines = text.split("\n");
    this.partial = lines.pop() ?? ""; // an unterminated line waits for the next poll
    for (const line of lines) {
      const rec = JSON.parse(line) as LogRecord;
      if (recordFault(rec)) continue;
      if (rec.type === "intent" && !this.seen.has(rec.intent.intent_id)) {
        this.seen.add(rec.intent.intent_id);
        out.push(rec);
      }
    }
  }

  /** The intents that are new since the last poll, in log order. */
  poll(): IntentRecord[] {
    const out: IntentRecord[] = [];
    if (this.fd === null) this.openCurrent();
    // #300 R2 #3: DETECT a replacement first, THEN drain the old inode: anything written to
    // it before the replacement was detected is read before it is closed.
    let pathIno: number | null = null;
    try {
      pathIno = fs.lstatSync(this.logPath).ino;
    } catch {
      pathIno = null;
    }
    this.opts.afterDetect?.();
    this.drain(out);
    if (pathIno !== null && pathIno !== this.ino) {
      fs.closeSync(this.fd as number);
      this.openCurrent();
      this.drain(out);
    }
    return out;
  }

  close(): void {
    if (this.fd !== null) fs.closeSync(this.fd);
    this.fd = null;
  }
}
