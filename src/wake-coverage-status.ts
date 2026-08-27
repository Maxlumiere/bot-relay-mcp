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

/**
 * Read the status sink, or null if absent/unparseable. A consumer MUST treat null (and a
 * stale generatedAt) as UNKNOWN, never as healthy — silence-as-failure is the whole point.
 */
export function readWakeCoverageStatus(statusPath?: string): WakeCoverageStatus | null {
  try {
    return JSON.parse(fs.readFileSync(statusPath ?? resolveWakeCoverageStatusPath(), "utf-8")) as WakeCoverageStatus;
  } catch {
    return null;
  }
}

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
  if (status === null) {
    return "[RELAY] wake-coverage: UNKNOWN — no status file (the detector may not have run). Treat as unknown, not healthy.";
  }
  const gen = Date.parse(status.generatedAt);
  if (!Number.isFinite(gen) || nowMs - gen > staleAfterMs) {
    const ageH = Number.isFinite(gen) ? `${Math.round((nowMs - gen) / 3_600_000)}h` : "unparseable";
    return `[RELAY] wake-coverage: UNKNOWN — status is STALE (generated ${ageH} ago); the hourly sweep may have stopped. Treat as unknown, not healthy.`;
  }
  const ageH = Math.round((nowMs - gen) / 3_600_000);
  if ((status.uncoveredCount ?? 0) > 0) {
    const names = status.findings.filter((f) => f.verdict === "uncovered").map((f) => f.agent).join(", ");
    return `[RELAY] *** wake-coverage: ${status.uncoveredCount} agent(s) UNCOVERED — mail is piling up unwoken: ${names}. A wake path is broken. ***`;
  }
  return `[RELAY] wake-coverage: OK (${ageH}h ago, 0 uncovered).`;
}
