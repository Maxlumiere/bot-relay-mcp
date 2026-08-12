// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * #60 — S2 wake-coverage detector (ADR-0023). REPORT-FIRST: it makes a coverage
 * gap LOUD and lets a human decide (ADR-0007/ADR-0005). It never changes routing,
 * never wakes anyone, never mutates the DB — pure observation.
 *
 * THE OBSERVABLE IS THE WAKE'S EFFECT, NOT THE ATTEMPT (victra ruling). A wake is
 * "observed" only when the agent actually DRAINED its mailbox via MCP get_messages.
 * A running watcher, a live process, a self-reported status: none count. A wake that
 * fires and produces no drain SHOULD read as uncovered. That is read-the-state
 * applied to coverage. The DURABLE record of that drain is `agents.last_drain_at`
 * (written on every !peek drain), NOT the `inbox_events` message_read stream — see
 * the DURABLE EVIDENCE note below for why the distinction is load-bearing.
 *
 * THREE VERDICTS, derived from the SAME table the detector reads — no allowlist,
 * no exemption lever. For an agent with mail pending past the bound:
 *   - COVERED      — the agent drained SOMETHING since the stuck mail arrived
 *                    (a message_read at/after its created_at). It is awake; the
 *                    specific message still sitting is a routing question, not a
 *                    wake-coverage one. NOT reported.
 *   - UNCOVERED    — the agent HAS drained before (has message_read history) but
 *                    NOT since the stuck mail arrived. It was being woken and now
 *                    is not: the S2 regression. Reported as an alarm.
 *   - UNOBSERVABLE — the agent's durable last-drain marker is unset: it has never
 *                    drained via MCP. It reads out-of-band (direct DB/CLI / non-MCP),
 *                    so the detector cannot judge its coverage AT ALL. Reported,
 *                    but NEVER as uncovered —
 *                    "I cannot observe this" is a different fact from "this is
 *                    broken," and collapsing them is the exact error the whole
 *                    ADR set exists to prevent (the exit-1 vs exit-2 distinction,
 *                    one layer out). victra measured this class has exactly one
 *                    live member — the orchestrator itself — which is why a
 *                    detector that rendered it as "uncovered" would alarm on its
 *                    own operator from day one and be muted by week three.
 *
 * FLAT BOUND + ANTI-FLAP MARGIN (victra ruling, Option A). The discriminator is a
 * flat fleet-wide age bound (`boundMs`, default 24h) — measured on 7 days of real
 * history, a 24h bound yields exactly one alarm (a genuinely 6.9-day-stuck message)
 * and zero false, so per-agent baselines were rejected on evidence (a subject-derived
 * threshold lets a permanently-broken agent redefine its own normal and never alarm).
 *
 * `antiFlapMarginMs` is NOT a second "persistence" check — naming it that would
 * assert a two-observation mechanism this code does not implement. It is simply
 * extra dwell added to the bound: the EFFECTIVE fire threshold is
 * `boundMs + antiFlapMarginMs` (default 24h + 24h = 48h). One longer threshold,
 * honestly named. It works as a SINGLE STATELESS age check because the coverage
 * condition — "no drain since the mail arrived" — is CUMULATIVE over the whole
 * span: one evaluation at age >= boundMs+margin already establishes that nothing
 * drained across that entire window, so a second observation would add state and a
 * missed-evaluation edge case while adding no information (victra).
 *
 * MEASURED RANGE — where the evidence stops: the 7-day sweep gave exactly one true
 * positive and zero false at BOTH a 24h and a 48h effective threshold, so any
 * effective threshold in [24h, 48h] — i.e. a margin in [0, 24h] — is evidence-backed.
 * A margin that pushes the effective threshold PAST 48h is outside what was measured
 * and needs a fresh sweep before it ships. The default is the 48h edge, deliberately:
 * concierge's slowest observed BENIGN gap was 23.4h, so a 24h effective threshold is
 * a coin-flip on its next slow week (0.6h headroom); 48h gives 24.6h of clearance.
 *
 * ⚠ KNOWN LIMIT — TIME-TO-NOTICE IS UP TO TWO DAYS, NOT MINUTES. ADR-0023 framed
 * this detector as converting hours-to-notice into minutes. What ships here does
 * NOT: at a 48h effective threshold, a broken wake path is reported within TWO DAYS,
 * not minutes. This is a deliberate, measured trade, stated as a limit, not an
 * apology. A single fleet-wide threshold must clear the SLOWEST LEGITIMATE agent
 * (concierge, ~1 drain/day, slowest benign gap 23.4h); the FAST, hook-driven agents
 * this detector was actually built for are clean at 30 minutes, and the two days is
 * the price of not false-alarming on the slow ones (the first false alarm is what
 * trains everyone to skim past this log line forever). Closing the gap to minutes
 * needs either per-agent cadence — REJECTED on evidence, because a threshold derived
 * from the subject's own history lets a permanently-broken agent redefine its normal
 * and never alarm — or a different signal entirely. Neither ships here.
 *
 * ⚠ ALARM-RATE ESTIMATE IS FROM A STALE REGIME. The ~0–1 alarms/week figure came
 * from a backtest over PRE-#198 history, when aged never-observed mail sat pending
 * forever. #198 now delivers exactly that mail on the first ordinary drain — the
 * very population this detector counts — so the true post-#198 rate is UNMEASURED.
 * It SHOULD be lower (undelivered mail no longer accumulates), which is why
 * default-on is safe; but "should" is a prediction. FOLLOW-UP (not a blocker):
 * re-run the backtest against post-#198 data after ~a week of real operation to
 * replace the estimate with a measurement.
 *
 * ⚠ DURABLE EVIDENCE — A VERDICT THAT SUPPRESSES AN ALARM MUST NEVER DEPEND ON DATA
 * THAT EXPIRES (victra, codex #200). Both COVERED and UNOBSERVABLE suppress the
 * alarm, so both read the DURABLE `agents.last_drain_at`, never the `inbox_events`
 * message_read stream, which purges at 7 days. Counting the event stream would go
 * blind exactly for the longest outages: an agent dark > 7 days loses its drain
 * events, would read "never drained" → UNOBSERVABLE (non-alarming), and the real
 * regression would be silenced precisely where the harm is greatest. The marker is
 * written on every !peek drain and lives on `agents` (not `mailbox`) so it resets on
 * unregister — durable past retention without outliving the identity.
 * TRANSITIONAL LIMIT (inherent, not a defect): an agent ALREADY dark longer than the
 * inbox_events retention at migration time has no reconstructable drain history
 * (backfill is best-effort from the retained events), so it reads UNOBSERVABLE until
 * it next drains — which a dark agent will not do. Expired history is unrecoverable;
 * the marker guarantees correctness GOING FORWARD, which is what the rule requires.
 */
import type { CompatDatabase } from "./sqlite-compat.js";
import { pendingGlobalClause } from "./db.js";
import { log } from "./logger.js";

export type WakeVerdict = "covered" | "uncovered" | "unobservable";

export interface WakeCoverageFinding {
  readonly agent: string;
  readonly verdict: WakeVerdict;
  /** Count of the agent's pending-global messages that are stuck past the effective threshold (bound + anti-flap margin). */
  readonly pendingCount: number;
  /** ISO created_at of the oldest such message. */
  readonly oldestCreatedAt: string;
  /** Age of the oldest such message in ms, at evaluation time. */
  readonly oldestAgeMs: number;
}

export interface WakeCoverageOptions {
  /** Evaluation "now" in epoch ms. Injected for testability. */
  readonly nowMs: number;
  /** Age past which pending-global mail is "stuck." Default 24h. */
  readonly boundMs: number;
  /**
   * Extra dwell ADDED to the bound before firing (anti-flap). NOT a second check —
   * effective fire threshold = boundMs + antiFlapMarginMs. Default 24h (→ 48h
   * effective, the far edge of the measured [24h,48h] range).
   */
  readonly antiFlapMarginMs: number;
}

const HOUR_MS = 60 * 60 * 1000;
export const DEFAULT_BOUND_MS = 24 * HOUR_MS;
export const DEFAULT_ANTI_FLAP_MARGIN_MS = 24 * HOUR_MS;

function isoAtOrBefore(nowMs: number, offsetMs: number): string {
  return new Date(nowMs - offsetMs).toISOString();
}

/**
 * Pure classification. Reads (never writes) `messages` + `inbox_events`, returns a
 * finding per agent whose oldest pending-global message has been stuck past
 * the effective threshold. COVERED agents are omitted (nothing to report); UNCOVERED and
 * UNOBSERVABLE are returned. Deterministic given (db, nowMs, boundMs, antiFlapMarginMs).
 */
export function classifyWakeCoverage(
  db: CompatDatabase,
  opts: WakeCoverageOptions,
): WakeCoverageFinding[] {
  const { nowMs, boundMs, antiFlapMarginMs } = opts;
  // Effective fire threshold = bound + anti-flap margin. A message older than this,
  // still pending-global, is a candidate. created_at is TEXT ISO8601-Z (lexicographic
  // order == chronological), so a string upper bound is a correct age filter.
  const fireBeforeIso = isoAtOrBefore(nowMs, boundMs + antiFlapMarginMs);
  const pg = pendingGlobalClause(); // resolved_at IS NULL AND read_by_session IS NULL

  // Candidate stuck messages grouped by recipient. pg.params is [] today, but
  // spread it so this stays correct if the SSOT predicate ever takes a param.
  const stuck = db
    .prepare(
      `SELECT to_agent AS agent, COUNT(*) AS pending_count, MIN(created_at) AS oldest_created_at
         FROM messages
        WHERE ${pg.sql}
          AND created_at <= ?
        GROUP BY to_agent`,
    )
    .all(...pg.params, fireBeforeIso) as Array<{
    agent: string;
    pending_count: number;
    oldest_created_at: string;
  }>;

  // #60 DURABILITY FIX (codex #200): BOTH alarm-SUPPRESSING branches — COVERED and
  // UNOBSERVABLE — read the DURABLE per-agent `agents.last_drain_at`, NEVER
  // inbox_events. inbox_events purges at 7d; a >7d-dark agent's message_read rows
  // are gone, so counting them would falsely read "never drained" → UNOBSERVABLE
  // (non-alarming) and SILENCE the alarm for exactly the longest outages — the ones
  // this detector exists to catch. A VERDICT THAT SUPPRESSES AN ALARM MUST NEVER
  // DEPEND ON DATA THAT EXPIRES (victra). `last_drain_at` is written on every !peek
  // drain (db.ts) and lives on `agents` (reset on unregister/reap), so it is durable
  // past event retention yet does NOT outlive the agent's own identity — a
  // re-registered name starts NULL, correctly UNOBSERVABLE until its first drain.
  const lastDrainStmt = db.prepare("SELECT last_drain_at FROM agents WHERE name = ?");

  const findings: WakeCoverageFinding[] = [];
  for (const row of stuck) {
    const agentRow = lastDrainStmt.get(row.agent) as { last_drain_at: string | null } | undefined;
    const lastDrainAt = agentRow?.last_drain_at ?? null;
    // COVERED — the durable marker shows a drain at/after the oldest stuck message
    // arrived (awake since; a message still sitting is a routing question, not a wake
    // one). ISO8601-Z strings compare chronologically. Not reported.
    if (lastDrainAt !== null && lastDrainAt >= row.oldest_created_at) continue;
    // UNOBSERVABLE — the durable marker is unset: never drained via MCP, so the
    // detector cannot judge. Else UNCOVERED — drained before but not since the stuck
    // mail: the S2 regression.
    const verdict: WakeVerdict = lastDrainAt !== null ? "uncovered" : "unobservable";
    findings.push({
      agent: row.agent,
      verdict,
      pendingCount: row.pending_count,
      oldestCreatedAt: row.oldest_created_at,
      oldestAgeMs: nowMs - new Date(row.oldest_created_at).getTime(),
    });
  }
  return findings;
}

function fmtHours(ms: number): string {
  return (ms / HOUR_MS).toFixed(1) + "h";
}

/**
 * REPORT-FIRST rendering. The three verdicts render DISTINCTLY — "uncovered" and
 * "unobservable" must never read the same, and the unobservable line names WHY
 * (no drain events ever) so a reader is never left guessing broken-vs-invisible.
 * One line per finding, prefixed `[wake-coverage]`. Returns the lines; the caller
 * decides the sink (the daemon logs them to stderr — a human decides).
 */
export function formatWakeCoverageFindings(findings: readonly WakeCoverageFinding[]): string[] {
  return findings.map((f) => {
    const age = fmtHours(f.oldestAgeMs);
    if (f.verdict === "uncovered") {
      return (
        `[wake-coverage] UNCOVERED — ${f.agent}: ${f.pendingCount} message(s) pending ` +
        `>= bound (oldest ${age}, arrived ${f.oldestCreatedAt}), and ${f.agent} has emitted ` +
        `no mailbox-drain event since it arrived, though it has drained before. Possible ` +
        `wake-path regression (dead Stop/PostToolUse hook, stopped watcher). Not proof of ` +
        `fault — first check whether ${f.agent} has drained anything since, then check its wake path.`
      );
    }
    // unobservable — informational, explicitly NOT an alarm.
    return (
      `[wake-coverage] UNOBSERVABLE — ${f.agent}: ${f.pendingCount} message(s) pending >= bound ` +
      `(oldest ${age}), but ${f.agent} has never drained via MCP (its durable last-drain marker ` +
      `is unset); it reads out-of-band (direct DB/CLI / non-MCP). The detector cannot judge this ` +
      `agent's coverage and does NOT report it as uncovered.`
    );
  });
}

/**
 * Sweep runner: classify, then emit each finding to the stderr logger (REPORT-FIRST
 * — the daemon makes drift loud and a human decides; ADR-0007/ADR-0005). Returns the
 * findings for callers/tests. Never mutates the DB. The daemon calls this on a
 * periodic tick — the integration point (cadence, enable flag, where the timer
 * lives) is proposed to the architect before it is wired near the running daemon.
 */
export function runWakeCoverageSweep(
  db: CompatDatabase,
  opts: WakeCoverageOptions,
): WakeCoverageFinding[] {
  const findings = classifyWakeCoverage(db, opts);
  for (const line of formatWakeCoverageFindings(findings)) log.warn(line);
  return findings;
}

/** Injectable timer seam (matches src/dashboard-state-broadcaster.ts). */
export interface WakeSweepScheduler {
  setInterval(cb: () => void, ms: number): { stop: () => void };
}
export interface WakeSweepHandle {
  stop(): void;
}

/** Real scheduler — unref'd so the sweep never blocks process shutdown. */
export function realWakeScheduler(): WakeSweepScheduler {
  return {
    setInterval(cb, ms) {
      const handle = setInterval(cb, ms);
      if (typeof (handle as { unref?: () => void }).unref === "function") {
        (handle as { unref: () => void }).unref();
      }
      return { stop: () => clearInterval(handle) };
    },
  };
}

export interface WakeDetectorConfig {
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly boundMs: number;
  readonly antiFlapMarginMs: number;
}

/** Read the detector's config from env. Exported for tests. */
export function wakeConfigFromEnv(): WakeDetectorConfig {
  const num = (v: string | undefined, def: number): number => {
    if (v === undefined || v === "") return def;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : def;
  };
  return {
    // DEFAULT-ON (victra): opt-in would recreate the "guard nobody invokes" class
    // (#196) — a detector no one enables passes its own tests and protects nothing.
    // Disable explicitly with RELAY_WAKE_DETECTOR=0. The cost of a wrong default
    // here is a stderr log line: REPORT-FIRST, no mutation, no page.
    enabled: process.env.RELAY_WAKE_DETECTOR !== "0",
    intervalMs: num(process.env.RELAY_WAKE_DETECTOR_INTERVAL_MS, 60 * 60 * 1000), // 1h
    boundMs: num(process.env.RELAY_WAKE_BOUND_MS, DEFAULT_BOUND_MS),
    antiFlapMarginMs: num(process.env.RELAY_WAKE_ANTI_FLAP_MARGIN_MS, DEFAULT_ANTI_FLAP_MARGIN_MS),
  };
}

/**
 * Start the periodic wake-coverage sweep. HTTP DAEMON ONLY — a per-terminal stdio
 * server must NOT run this: it would multiply one fleet-wide report across every
 * terminal and tie a fleet observation to a single terminal's lifetime. Runs one
 * sweep immediately (a standing regression is reported at startup, not one interval
 * later), then on the interval. Returns a stop handle; the real timer is unref'd so
 * it never blocks shutdown. No-op (stop is a no-op) when disabled.
 */
export function startWakeCoverageSweep(
  db: CompatDatabase,
  deps: { scheduler?: WakeSweepScheduler; now?: () => number } = {},
): WakeSweepHandle {
  const cfg = wakeConfigFromEnv();
  if (!cfg.enabled) return { stop: () => {} };
  const now = deps.now ?? (() => Date.now());
  const scheduler = deps.scheduler ?? realWakeScheduler();
  const tick = (): void => {
    try {
      runWakeCoverageSweep(db, {
        nowMs: now(),
        boundMs: cfg.boundMs,
        antiFlapMarginMs: cfg.antiFlapMarginMs,
      });
    } catch (err) {
      log.debug("[wake-coverage] sweep failed (non-fatal): " + String(err));
    }
  };
  tick(); // fire once at startup
  return scheduler.setInterval(tick, cfg.intervalMs);
}
