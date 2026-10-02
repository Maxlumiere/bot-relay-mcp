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
 *     {intent_id, agent_name, binding_id, reason}, and `reason` is an enum; a free-text
 *     reason or an extra field is refused by the writer, so it never reaches the file.
 *   - CONTENT-FREE (A1): no message content, sender or subject. An intent record says
 *     which ids it covers, for which reading session (V4 rung memory), and nothing more.
 *   - RUNG MEMORY (V4) is rebuilt from the intents on every start, keyed
 *     (reading session, message id), so a restart never re-rings the same pair.
 *   - Mode 0600 in a 0700 state dir; an existing file readable by anyone else is refused.
 */
import fs from "fs";
import path from "path";
import { AGENT_NAME_PATTERN } from "./types.js";

/** Why an intent exists. An ENUM (C3): later PRs add members; free text never. */
export const INTENT_REASONS = ["new_mail"] as const;
export type IntentReason = (typeof INTENT_REASONS)[number];

export interface Intent {
  intent_id: string;
  agent_name: string;
  binding_id: string;
  reason: IntentReason;
}

export interface IntentRecord {
  v: 1;
  type: "intent";
  at: string;
  intent: Intent;
  /** What this intent rings for: the reading session (PR 0b digest) and the message ids. */
  covers: { reading_session: string; message_ids: string[] };
}

export interface HeaderRecord {
  v: 1;
  type: "header";
  at: string;
  pid: number;
  /** ADR-0047: what THIS process loaded (LOADED_BUILD), and the install it came from. */
  build: Record<string, unknown>;
  install_dir: string;
  /** ADR-0048: the resolution it runs against (serializeResolution). */
  resolution: Record<string, unknown>;
}

export type LogRecord = IntentRecord | HeaderRecord;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const sameKeys = (o: unknown, keys: readonly string[]): o is Record<string, unknown> =>
  !!o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).sort().join(",") === [...keys].sort().join(",");
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200 && !/[\u0000-\u001f\u007f]/.test(v);

/** Why this is not a valid record, or null. The schema is CLOSED: an extra key anywhere is invalid. */
export function recordFault(r: unknown): string | null {
  if (!r || typeof r !== "object") return "not an object";
  const t = (r as { type?: unknown }).type;
  if (t === "intent") {
    if (!sameKeys(r, ["v", "type", "at", "intent", "covers"])) return "an intent record has exactly v, type, at, intent, covers";
    if (r.v !== 1) return "unknown record version";
    if (typeof r.at !== "string" || !ISO_RE.test(r.at)) return "at is not an ISO UTC timestamp";
    const i = r.intent;
    if (!sameKeys(i, ["intent_id", "agent_name", "binding_id", "reason"])) return "an intent has exactly intent_id, agent_name, binding_id, reason";
    if (typeof i.intent_id !== "string" || !UUID_RE.test(i.intent_id)) return "intent_id is not a v4 UUID";
    if (typeof i.agent_name !== "string" || !AGENT_NAME_PATTERN.test(i.agent_name)) return "agent_name is not a valid agent name";
    if (!nonEmpty(i.binding_id)) return "binding_id is empty or holds a control character";
    if (!(INTENT_REASONS as readonly unknown[]).includes(i.reason)) return `reason must be one of ${INTENT_REASONS.join(", ")} (never free text)`;
    const c = r.covers;
    if (!sameKeys(c, ["reading_session", "message_ids"])) return "covers has exactly reading_session, message_ids";
    if (typeof c.reading_session !== "string" || !DIGEST_RE.test(c.reading_session)) return "reading_session is not a 64-hex digest";
    if (!Array.isArray(c.message_ids) || c.message_ids.length === 0 || !c.message_ids.every(nonEmpty)) return "message_ids must be a non-empty list of ids";
    return null;
  }
  if (t === "header") {
    if (!sameKeys(r, ["v", "type", "at", "pid", "build", "install_dir", "resolution"])) return "a header record has exactly v, type, at, pid, build, install_dir, resolution";
    if (r.v !== 1) return "unknown record version";
    if (typeof r.at !== "string" || !ISO_RE.test(r.at)) return "at is not an ISO UTC timestamp";
    if (!Number.isInteger(r.pid) || (r.pid as number) <= 0) return "pid is not a positive integer";
    if (!r.build || typeof r.build !== "object" || typeof (r.build as { build_id?: unknown }).build_id !== "string") return "build carries no build_id";
    if (!nonEmpty(r.install_dir)) return "install_dir is empty";
    if (!r.resolution || typeof r.resolution !== "object") return "resolution is not an object";
    return null;
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
 * Open (create) the log: the state dir 0700, the file 0600. An existing file or dir that
 * anyone else can read is REFUSED, never silently repaired. WAL recovery: an
 * UNTERMINATED last line (a crash mid-write) was never fully logged, so nothing acted on
 * it; it is truncated, so the next append starts on a clean line. `recoveredBytes` says so.
 */
export function prepareLog(stateDir: string): { logPath: string; recoveredBytes: number } {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const dirMode = fs.statSync(stateDir).mode & 0o777;
  if (dirMode & 0o077) throw new Error(`${stateDir} is mode ${dirMode.toString(8)}: the doorbell state dir must be private (0700)`);
  const logPath = path.join(stateDir, LOG_FILENAME);
  if (fs.existsSync(logPath)) {
    const mode = fs.statSync(logPath).mode & 0o777;
    if (mode & 0o077) throw new Error(`${logPath} is mode ${mode.toString(8)}: the doorbell log must be private (0600)`);
  } else {
    fs.closeSync(fs.openSync(logPath, "a", 0o600));
  }
  const text = fs.readFileSync(logPath);
  let recoveredBytes = 0;
  if (text.length > 0 && text[text.length - 1] !== 0x0a) {
    const keep = text.lastIndexOf(0x0a) + 1;
    recoveredBytes = text.length - keep;
    fs.truncateSync(logPath, keep);
  }
  return { logPath, recoveredBytes };
}

/**
 * WRITE-AHEAD append: validate, then write ONE line and fsync before returning, so
 * nothing can act on a record that is not durably on disk. An invalid record throws
 * and nothing is written.
 */
export function appendRecord(logPath: string, rec: LogRecord): void {
  const fault = recordFault(rec);
  if (fault) throw new Error(`refusing to log an invalid doorbell record: ${fault}`);
  const fd = fs.openSync(logPath, "a", 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(rec) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Rebuild rung memory from the log. A torn tail (an UNTERMINATED last line: a crash, or
 * a writer mid-append seen by a reader) was never fully logged, so nothing acted on it:
 * it is skipped and reported. Any other invalid line, a complete one included, means the
 * log is not what this writer wrote: REFUSED (fail closed: no cycle runs on a memory it
 * cannot trust).
 */
export function readRungMemory(logPath: string): { rung: Set<string>; tornTail: boolean } {
  const text = fs.readFileSync(logPath, "utf-8");
  const terminated = text.endsWith("\n");
  const lines = text.split("\n");
  lines.pop(); // "" after a final newline, or the unterminated tail (checked below)
  const tail = terminated ? null : text.slice(text.lastIndexOf("\n") + 1);
  const rung = new Set<string>();
  let tornTail = false;
  lines.forEach((line, i) => {
    let rec: unknown;
    let fault: string | null;
    try {
      rec = JSON.parse(line);
      fault = recordFault(rec);
    } catch {
      fault = "not JSON";
    }
    if (fault) {
      throw new Error(`${logPath} line ${i + 1} is not a valid doorbell record (${fault}): refusing to rebuild rung memory from it`);
    }
    const r = rec as LogRecord;
    if (r.type === "intent") for (const id of r.covers.message_ids) rung.add(rungKey(r.covers.reading_session, id));
  });
  if (tail !== null && tail.length > 0) tornTail = true;
  return { rung, tornTail };
}
