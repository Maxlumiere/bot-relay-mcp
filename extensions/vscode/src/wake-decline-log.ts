// bot-relay-mcp — Tether (VS Code extension)
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0026 item 1 / M3 — the wake-decision observability sink (SHAPE T).
 *
 * The wake router (wake-routing.ts) computes a structured `reason` for every decision and
 * WakeGate.consider() then DISCARDS it (`if (route.action === "suppress") return false`). A
 * decline was therefore unobservable: you could see mail sitting undrained but never why the
 * wake for it was withheld. This sink records every decision — with its INPUTS, not just the
 * conclusion — to a durable NDJSON log that fails INDEPENDENTLY of the wake path it watches
 * (a separate fs append: when the routing is WRONG, the record is still written, which is the
 * failure we care about).
 *
 * WATERMARK, NOT message_id (deliberate, not an approximation). Every route reason is a
 * function of INBOX STATE — (mail pending?) x (agent busy?) x (injection outstanding?) — never
 * of a single message. So the record's message identity is `last_message_at`, the newest-message
 * watermark, which is the CORRECT unit: the question this log answers is "was the mail pending
 * at this decline EVER delivered, and how long did it take?" — a watermark comparison (does the
 * agent's read-watermark advance past the decline's). Two messages sharing the newest timestamp
 * does not degrade it, because the record never claimed to be about one of them. This is a strict
 * PREFIX of a future message_id design: if buildInboxSnapshot later carries a newest message_id,
 * this record gains one field and every existing line still joins by watermark — no migration.
 *
 * LOG THE INPUTS. `reason` is a CONCLUSION; with only conclusions you can audit "did it decline"
 * but never "SHOULD it have". So the decision INPUTS ride alongside — `state`, `busyCoveredByHook`,
 * `injectionOutstanding`, `pending_count`, `last_message_at` — letting a later reader FALSIFY the
 * routing, not merely replay it. In particular `state` is the FULL observed state, never a busy
 * boolean: a decline taken on `state:"unknown"` is a wake decision on an UNDECIDABLE predicate and
 * is its OWN population (knew-busy / knew-idle / could-not-tell are three buckets, not two); a
 * boolean would fold the could-not-tell case — the one most likely to be the live bug — into the
 * benign knew-busy one and make it permanently invisible.
 */
import fs from "node:fs";
import path from "node:path";
import type { ObservedAgentState } from "./wake-routing.js";

export type WakeDecisionAction = "suppress" | "inject";

/** One wake-routing decision, with the inputs that produced it. */
export interface WakeDecisionRecord {
  readonly kind: "decision";
  /** Schema version — present on EVERY record from record one. A reader treats a missing/unknown
   *  version as UNKNOWN, never "assume v1" (the #215 lesson, one layer down). Bump on any shape change. */
  readonly v: 1;
  readonly agentName: string;
  /** ISO8601 of the decision. */
  readonly decided_at: string;
  /** The router's conclusion — the COMPLETE set wake-routing can emit (enumerated once, lesson 1). */
  readonly action: WakeDecisionAction;
  /** The router's structured reason. The producer (routeWake) emits exactly these:
   *    suppress: "no pending mail"
   *            | "busy + hook-covered — PostToolUse owns delivery"
   *            | "an injection is already outstanding"
   *    inject:   "state=<idle|busy|unknown> — Tether owns this wake"
   *  Recorded VERBATIM (not classified here) so a NEW reason added upstream is captured and VISIBLE
   *  in the log, never silently dropped into a benign bucket (derive-by-exclusion, lesson 2). */
  readonly reason: string;
  /** The ACTUAL outcome: did a wake actually FIRE this consideration? routeWake PROPOSES (`action`);
   *  decideWake DISPOSES. The GAP — action:"inject" while woke:false (e.g. autoInjectInbox off by
   *  DEFAULT, or an already-woken watermark) — is itself a finding: a wake nobody else can see. So the
   *  record carries BOTH the proposal and the outcome, never just what routeWake wanted. */
  readonly woke: boolean;
  /** The WATERMARK: newest-message timestamp (MAX(created_at)); null when the inbox is empty. */
  readonly last_message_at: string | null;
  /** Pending (undrained) mail count — separates a benign "declined, 0 pending" from the defect
   *  "declined, 12 pending"; without it benign and pathological declines are indistinguishable. */
  readonly pending_count: number;
  /** FULL observed state — idle / busy / unknown. `unknown` is its own bucket (a decline on an
   *  undecidable predicate), never collapsed into busy. */
  readonly state: ObservedAgentState;
  /** Was a busy agent already covered by a tool-result hook (a routing premise)? */
  readonly busyCoveredByHook: boolean;
  /** Was a prior injection outstanding at decision time (a routing premise)? */
  readonly injectionOutstanding: boolean;
  /** Present ONLY when records were LOST before this one (a sink write failed, e.g. EACCES). N
   *  decisions vanished between the previous logged record and this one — so the FACT of loss
   *  survives into the artifact even though the failed writes left nothing behind. A lossy log that
   *  looks healthy is worse than no log; this is how a reader sees "I don't know", not "I checked". */
  readonly droppedSince?: number;
}

/**
 * Written ONCE at extension activation. Its whole job is to make PRESENCE the norm so that
 * ABSENCE is a signal: without it, "no decision records" is ambiguous across {no declines
 * happened / the extension never activated / the sink is broken}. With it, an empty-but-present
 * log means "activated, no decisions yet" and a MISSING log means "the sink itself is broken" —
 * the same silence-as-failure lesson the SessionStart sink enforces, one layer down.
 */
export interface WakeActivationRecord {
  readonly kind: "activation";
  readonly at: string; // ISO8601
  /** Schema/version marker so a future reader can tell an old log from a new one. */
  readonly v: 1;
}

export type WakeLogRecord = WakeDecisionRecord | WakeActivationRecord;

/** Default log location under the extension's global storage dir. */
export function defaultWakeLogPath(storageDir: string): string {
  return path.join(storageDir, "wake-decision-log.ndjson");
}

/**
 * Append one record as an NDJSON line. mkdir -p the parent first. A single-writer append of a
 * newline-terminated line is atomic enough for this log (one extension host writes it); a partial
 * line at most drops the tail record on crash, never corrupts prior lines. Best-effort: a sink
 * write must never take down the extension, so callers wrap this and swallow FS errors.
 */
export function appendWakeLogRecord(filePath: string, record: WakeLogRecord): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(record) + "\n", "utf-8");
}

/** Write the activation record. Call once, at activate(), before any decisions can be recorded. */
export function writeActivationRecord(filePath: string, atMs: number): void {
  appendWakeLogRecord(filePath, { kind: "activation", at: new Date(atMs).toISOString(), v: 1 });
}

/** A sink degraded/recovered transition — reported through a channel INDEPENDENT of the failing log
 *  artifact (the same output channel the P1a activation-unavailable diagnostic uses), so a PERSISTENT
 *  write fault is observable even when nothing can be persisted. */
export type WakeSinkReport = { kind: "degraded" } | { kind: "recovered"; dropped: number };

/**
 * Wrap an `append` into a DROP-TRACKING decision sink. A lossy log that LOOKS healthy is worse than no
 * log, so loss is made visible TWO independent ways, for two DIFFERENT failure timings:
 *  - TRANSIENT (a write fails, a later write lands): stamp `droppedSince: N` onto the record that DOES
 *    write, so the loss survives INTO the artifact for an offline reader.
 *  - PERSISTENT (storage was writable AT activate, then permanently fails — the WORSE case, because the
 *    activation record already made the log look initialized/healthy while every later decline vanishes):
 *    droppedSince would be trapped in this closure forever (no future success to carry it), so it emits
 *    a `report` through a channel INDEPENDENT of the failing artifact — the same P1a doctrine, applied a
 *    second time: the reporter must fail independently of the failure it reports. (This is DISTINCT from
 *    storage-unavailable AT activate(), which the DEGRADED diagnostic at activate() handles.)
 * Reported ON STATE TRANSITION only — once on healthy->degraded, once on recovery — never per-failure, or
 * a persistent fault turns a signal into ignored noise. The append NEVER throws out of here; a logging
 * fault must not disturb the wake path.
 */
export function makeDroppingDecisionSink(
  append: (record: WakeDecisionRecord) => void,
  report?: (event: WakeSinkReport) => void,
): (record: WakeDecisionRecord) => void {
  let droppedSince = 0;
  let degraded = false;
  // NON-THROWING BY CONSTRUCTION (codex r3): the reporter runs in its OWN swallowing try/catch, OUTSIDE
  // the append boundary. Channel-independence (the reporter is a different sink from the NDJSON file) is
  // NOT failure-accounting-independence: if a report throw shared the append's catch, a SUCCESSFULLY
  // written record would be miscounted as dropped and `degraded` would never clear. So state + count
  // derive from the APPEND outcome ONLY — the reporter's success has ZERO influence on them.
  // This is where the "what does ITS failure look like?" recursion BOTTOMS OUT: a reporter that cannot
  // report cannot report its OWN failure — genuinely terminal, so we make it unable to throw rather than
  // watch it. Acceptable because the reporter is the outputChannel (already independent of the NDJSON
  // storage) and it fails only if the extension host is going down, when nothing else is working either.
  const safeReport = (event: WakeSinkReport): void => {
    try {
      report?.(event);
    } catch {
      /* the reporter's own failure is terminal + unobservable by construction */
    }
  };
  return (record) => {
    const toWrite = droppedSince > 0 ? { ...record, droppedSince } : record;
    let appended = false;
    try {
      append(toWrite);
      appended = true;
    } catch {
      appended = false;
    }
    // STATE + COUNT derive from the APPEND outcome ONLY — never from whether the reporter succeeded.
    if (appended) {
      const wasDegraded = degraded;
      const recoveredCount = droppedSince;
      degraded = false;
      droppedSince = 0; // the loss count is now durable in the artifact (stamped on toWrite above)
      // RECOVERY (degraded -> healthy): report ONCE, AFTER state is already cleared, so a throwing
      // reporter cannot revert it. A successfully-written record is NEVER marked dropped.
      if (wasDegraded) safeReport({ kind: "recovered", dropped: recoveredCount });
    } else {
      droppedSince += 1; // this record was lost
      if (!degraded) {
        degraded = true; // FIRST failure (healthy -> degraded)
        // Report ONCE via the independent channel so a PERSISTENT fault is observable; later failures
        // stay silent (a persistent fault is a signal, not per-decline noise).
        safeReport({ kind: "degraded" });
      }
    }
  };
}

/**
 * A record is valid only with a KNOWN kind and schema version v===1. A record with no version (or a
 * different version, or an unknown kind, or a wrong-typed field) is UNINTERPRETABLE — it is SKIPPED,
 * never coerced into a typed record it does not match (the #215 unchecked-`as` lesson, one layer
 * down). state is validated against the closed tri-state so a decline-on-`unknown` cannot be lost.
 */
export function isValidWakeLogRecord(x: unknown): x is WakeLogRecord {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  if (r.v !== 1) return false;
  if (r.kind === "activation") return typeof r.at === "string";
  if (r.kind === "decision") {
    return (
      typeof r.agentName === "string" &&
      typeof r.decided_at === "string" &&
      (r.action === "suppress" || r.action === "inject") &&
      typeof r.reason === "string" &&
      typeof r.woke === "boolean" &&
      (r.last_message_at === null || typeof r.last_message_at === "string") &&
      typeof r.pending_count === "number" &&
      (r.state === "idle" || r.state === "busy" || r.state === "unknown") &&
      typeof r.busyCoveredByHook === "boolean" &&
      typeof r.injectionOutstanding === "boolean" &&
      (r.droppedSince === undefined || typeof r.droppedSince === "number")
    );
  }
  return false;
}

/** Read the log back (for offline analysis + tests), keeping only VALID records. Returns [] if
 *  absent/unreadable — a consumer distinguishes "[] because missing" from "[] because empty" by
 *  whether the file exists, not by this return. A torn/partial line or an unversioned record is
 *  skipped, never coerced; the activation record (written at activate) makes an empty-but-present
 *  log mean "activated, no decisions yet" rather than "sink broken". */
export function readWakeLog(filePath: string): WakeLogRecord[] {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }
  const out: WakeLogRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // torn / partial line — skip, never crash the analysis
    }
    if (isValidWakeLogRecord(parsed)) out.push(parsed); // unversioned / unknown-kind — skip, never coerce
  }
  return out;
}
