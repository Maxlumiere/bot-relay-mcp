// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0026 item 1 — the wake-coverage DURABLE STATUS SINK: pure I/O + formatting, split
 * out of wake-coverage-detector.ts on purpose.
 *
 * WHY A SEPARATE MODULE. The detector imports db.js (pendingGlobalClause), which pulls in
 * the native better-sqlite3 binding. The SessionStart hook (hooks/check-relay.sh) must be
 * able to READ this status and print one line WITHOUT dragging native sqlite into every
 * session start — on a wasm-only / npm-v12 scripts-off machine importing the detector would
 * THROW at load and the hook's `2>/dev/null` would swallow the coverage line into silence.
 * So the reader/formatter live here with a fs/path/os-only import graph, and the hook imports
 * THIS module. wake-coverage-detector.ts re-exports every symbol below for back-compat, and
 * remains the single writer (runWakeCoverageSweep).
 *
 * The staleness-enforcing reader (formatWakeCoverageStatusLine) is the SSOT the hook calls,
 * so the "poisoned/ancient file must read UNKNOWN, never a live alert" rule is tested once
 * and enforced everywhere (daemon-briefing and SessionStart alike).
 */
import fs from "fs";
import path from "path";
import os from "os";
import type { WakeCoverageFinding } from "./wake-coverage-detector.js";

/**
 * The DEFAULT live sink path. Fixed, instance-independent (~/.bot-relay/wake-coverage-status.json)
 * so a reader needs no instance discovery. Env override: RELAY_WAKE_COVERAGE_STATUS_PATH.
 */
export function defaultWakeCoverageStatusPath(): string {
  return path.join(os.homedir(), ".bot-relay", "wake-coverage-status.json");
}
export function resolveWakeCoverageStatusPath(): string {
  const env = process.env.RELAY_WAKE_COVERAGE_STATUS_PATH;
  if (env && env.trim() !== "") return env;
  return defaultWakeCoverageStatusPath();
}

export interface WakeCoverageStatus {
  /** Schema version. A record with NO v (or a different v) is UNINTERPRETABLE, not assumed-
   *  current — it MUST read UNKNOWN. Defaulting a missing version to 1 would be the same
   *  default-to-healthy bug the validation exists to catch. Bump on any shape change. */
  readonly v: 1;
  /** ISO8601 of the evaluation that produced these findings. A stale generatedAt is a
   *  reader's signal that the sweep stopped — it MUST be treated as UNKNOWN, not healthy. */
  readonly generatedAt: string;
  /** Effective fire threshold (boundMs + antiFlapMarginMs) the findings were judged against. */
  readonly thresholdMs: number;
  readonly uncoveredCount: number;
  readonly findings: readonly WakeCoverageFinding[];
}

/**
 * ATOMIC write (temp + rename) so a concurrent reader never sees a half-written file.
 * mkdir -p the parent first. Throws only on a genuine FS failure — the caller keeps it
 * non-fatal so a transient disk error never takes down the daemon.
 */
export function writeWakeCoverageStatus(statusPath: string, status: WakeCoverageStatus): void {
  // GUARD — MAKE-IMPOSSIBLE, not a convention (learned the hard way: a test seeded a fictional
  // finding into the live ~/.bot-relay/wake-coverage-status.json — a poisoned TRUSTED sink is worse
  // than none). Under a test harness, writing the DEFAULT live path is a HARD, LOUD error. Tests
  // MUST point RELAY_WAKE_COVERAGE_STATUS_PATH at a tmp path (the env seam); so this never fires when
  // a test is correctly pointed, and never fires in production (no VITEST/NODE_ENV=test there).
  const underTest = !!(process.env.VITEST || process.env.NODE_ENV === "test");
  if (underTest && path.resolve(statusPath) === path.resolve(defaultWakeCoverageStatusPath())) {
    throw new Error(
      `wake-coverage: refusing to write the DEFAULT live status path (${statusPath}) from a test harness. ` +
        `Set RELAY_WAKE_COVERAGE_STATUS_PATH to a tmp path — a test that writes the live SessionStart sink poisons a trusted sink.`,
    );
  }
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  const tmp = `${statusPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(status, null, 2), "utf-8");
  fs.renameSync(tmp, statusPath);
}

/** The verdicts the detector can emit (mirrors WakeVerdict in wake-coverage-detector.ts). A
 *  finding carrying any other verdict is a corrupt record — rejected, not silently treated as
 *  "not uncovered". Keep in sync if WakeVerdict grows. */
const KNOWN_VERDICTS = new Set(["covered", "uncovered", "unobservable"]);

/**
 * Runtime schema guard — the ONE gate shared by the reader and the formatter so the two cannot
 * drift. A valid record is an object with the EXACT field types AND schema version v===1. A
 * MISSING version reads UNKNOWN, never assumed-v1 (`v ?? 1` would re-introduce the default-to-
 * healthy bug this guard exists to catch), and sink files from earlier builds/test runs may
 * already sit on disk without it. Anything that fails here degrades to UNKNOWN exactly like an
 * absent file — a malformed record is silence too, never "healthy" (codex P1 #2).
 */
export function isValidWakeCoverageStatus(x: unknown): x is WakeCoverageStatus {
  if (typeof x !== "object" || x === null) return false;
  const s = x as Record<string, unknown>;
  return (
    s.v === 1 &&
    typeof s.generatedAt === "string" &&
    typeof s.thresholdMs === "number" &&
    Number.isInteger(s.uncoveredCount) &&
    (s.uncoveredCount as number) >= 0 &&
    Array.isArray(s.findings) &&
    s.findings.every((f) => {
      if (typeof f !== "object" || f === null) return false;
      const ff = f as Record<string, unknown>;
      const verdict = ff.verdict;
      return typeof ff.agent === "string" && typeof verdict === "string" && KNOWN_VERDICTS.has(verdict);
    })
  );
}

/**
 * Read the status sink, or null if absent/unparseable/malformed/wrong-schema. A consumer MUST
 * treat null (and a stale or future-skewed generatedAt) as UNKNOWN, never as healthy —
 * silence-as-failure is the whole point, and a malformed record is a kind of silence.
 */
export function readWakeCoverageStatus(statusPath?: string): WakeCoverageStatus | null {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(statusPath ?? resolveWakeCoverageStatusPath(), "utf-8"),
    );
    return isValidWakeCoverageStatus(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Compact human age for the briefing line. Sub-hour granularity is deliberate: an age that
 * drifts up is how you SEE a sweep that has stopped while the file still says "OK" — that must
 * be visible in the line, not buried in a log (victra Q1 ruling). Hour-rounding ("0h") hid it.
 */
function humanAge(ms: number): string {
  const m = ms < 0 ? 0 : ms;
  if (m < 60_000) return `${Math.round(m / 1000)}s`;
  if (m < 3_600_000) return `${Math.round(m / 60_000)}m`;
  if (m < 86_400_000) return `${Math.round(m / 3_600_000)}h`;
  return `${Math.round(m / 86_400_000)}d`;
}

/** Strip CR/LF and other control chars from interpolated finding data so a crafted or corrupt
 *  agent name can never inject extra lines into the single-line [RELAY] briefing (codex P2). */
function sanitizeLine(s: string): string {
  // Replace any control char (code point < 0x20, or 0x7f DEL) with a space — computed
  // numerically so no raw control byte ever lives in this source. A crafted or corrupt agent
  // name can never inject extra lines into the single-line [RELAY] briefing.
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    out += c < 0x20 || c === 0x7f ? " " : ch;
  }
  return out.trim();
}

/**
 * FUTURE-SKEW TOLERANCE. A generatedAt AHEAD of now is not "very fresh" — it is evidence of a
 * broken writer or a wrong clock, and left unchecked a healthy-looking record could read OK for
 * years until local time catches up (codex P1). But small negative ages are ordinary NTP/process
 * jitter and must stay OK, or healthy machines manufacture false UNKNOWNs and the detector cries
 * wolf. 60s sits comfortably above jitter yet far below any real staleness. DO NOT tidy this to
 * 0 — a zero tolerance re-creates the false-UNKNOWN failure mode. Tested on BOTH sides.
 */
const FUTURE_SKEW_MS = 60_000;

/**
 * The SessionStart / briefing LINE (ADR-0026 item 1) — a STALENESS-ENFORCING reader. Turns the
 * durable status into the exact `[RELAY]` line injected into session context:
 *  - null (no/unreadable file) → UNKNOWN (never healthy — silence-as-failure).
 *  - generatedAt unparseable OR older than staleAfterMs → STALE/UNKNOWN. This is what makes a
 *    poisoned/ancient file read as UNKNOWN rather than a BELIEVED live finding: a 15-day-old
 *    generatedAt must never be presented as a live "uncovered" alert.
 *  - fresh + uncoveredCount > 0 → a LOUD uncovered alert naming the agents.
 *  - fresh + 0 uncovered → OK.
 */
export function formatWakeCoverageStatusLine(
  status: WakeCoverageStatus | null,
  nowMs: number,
  staleAfterMs: number,
): string {
  // ABSENT or MALFORMED/WRONG-SCHEMA → UNKNOWN, using the SAME guard the reader uses so the two
  // cannot drift: a partial record, a wrong-typed field, or a missing/unknown schema version is
  // silence too, never "healthy" (codex P1 #2).
  if (status === null) {
    return "[RELAY] wake-coverage: UNKNOWN — no status file (the detector may not have run). Treat as unknown, not healthy.";
  }
  if (!isValidWakeCoverageStatus(status)) {
    return "[RELAY] wake-coverage: UNKNOWN — status record is malformed or a different schema version. Treat as unknown, not healthy.";
  }
  // STALE (past) OR FUTURE-SKEWED (ahead of now beyond FUTURE_SKEW_MS) → UNKNOWN. A future
  // generatedAt would otherwise escape the past-only staleness check and read OK indefinitely
  // (codex P1). Small negative ages (NTP jitter) stay within tolerance and read OK below.
  const gen = Date.parse(status.generatedAt);
  const ageMs = nowMs - gen;
  if (!Number.isFinite(gen) || ageMs > staleAfterMs || ageMs < -FUTURE_SKEW_MS) {
    let age: string;
    if (!Number.isFinite(gen)) age = "an unparseable time";
    else if (ageMs < 0) age = `${humanAge(-ageMs)} in the future`;
    else age = `${humanAge(ageMs)} ago`;
    return `[RELAY] wake-coverage: UNKNOWN — status is STALE or clock-skewed (generated ${age}); the sweep may have stopped or the writer's clock is wrong. Treat as unknown, not healthy.`;
  }
  // uncoveredCount is a validated number here (the guard rejects non-numbers) — NO `?? 0` default,
  // which would turn "I don't know" into "0 uncovered = healthy" (the default IS the bug). Finding
  // data is sanitized so a crafted/corrupt agent name cannot make this a multi-line briefing.
  // DERIVE the coverage verdict from the FINDINGS — the authoritative evidence — NOT the redundant
  // stored uncoveredCount (codex P1 r2). A fresh, versioned, schema-valid record whose count says 0
  // while its findings list an uncovered agent must NOT read OK: trust the evidence, never the
  // denormalized field, which can disagree with the very findings it claims to summarize.
  const uncovered = status.findings.filter((f) => f.verdict === "uncovered");
  if (uncovered.length > 0) {
    const names = uncovered.map((f) => sanitizeLine(String(f.agent))).join(", ");
    return `[RELAY] *** wake-coverage: ${uncovered.length} agent(s) UNCOVERED — mail is piling up unwoken: ${names}. A wake path is broken. ***`;
  }
  // ALWAYS emit OK (a sink that speaks only on failure is indistinguishable from a dead sink),
  // and CARRY THE AGE so a drifting age exposes a stopped-but-still-"OK" sweep (victra Q1).
  return `[RELAY] wake-coverage: OK (as of ${humanAge(ageMs)}).`;
}
