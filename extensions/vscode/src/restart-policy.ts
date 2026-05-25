// bot-relay-mcp — Tether for VSCode
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT

/**
 * v0.2 — RestartPolicy: pure state machine for auto-restart backoff +
 * rate cap.
 *
 * Lives in its own module (no vscode deps) so the timing + cap logic
 * is testable with a fake clock — see src/restart-policy.test.ts.
 * Per `feedback_test_path_must_match_shipped_path.md`: the shipped
 * AgentManager (src/agent-manager.ts) consumes the *same* class the
 * tests exercise.
 *
 * Contract from the v0.2 brief:
 *   - Trigger conditions live in the caller (process non-zero exit,
 *     transport disconnect past reconnect-max-retries, heartbeat
 *     timeout). This module ONLY decides "given a crash event, when
 *     (if ever) should the next restart fire?"
 *   - Backoff sequence: 1s → 2s → 4s → 8s → 16s, capped at 30s.
 *     Attempt 0 (no prior crashes) restarts immediately with no
 *     delay; attempt 1 waits 1s; attempt 5+ waits 16s (or whatever
 *     30s clamp catches first).
 *   - Hard rate cap: 5 restarts per agent per rolling hour. Once the
 *     6th would fire, the policy refuses (decision: GIVE_UP). Caller
 *     surfaces the "agent crash-looping" toast + error state.
 *   - The hour window is rolling, not calendar-aligned: an agent
 *     that crashes 5x in 10 minutes hits the cap; an agent that
 *     crashed 4x at minute 0, has a quiet 59-minute window, then
 *     crashes again does NOT hit the cap (the 4 older crashes have
 *     aged out by the time the 5th lands).
 *   - `recordSuccess()` is the reset hook: once the agent has been
 *     running successfully (stayed up past a configurable
 *     stability-threshold), the backoff sequence resets to attempt
 *     0. This prevents the case where a transient SSE drop drains
 *     the 5/hr budget and then a real crash a week later has no
 *     remaining attempts.
 */

export type RestartDecision =
  | { kind: "restart"; delayMs: number; attempt: number }
  | { kind: "give_up"; reason: string; recentCrashes: number };

export interface RestartPolicyOptions {
  /**
   * Maximum restarts within the rolling window before refusing.
   * Default: 5 (per v0.2 brief).
   */
  maxRestartsPerWindow?: number;
  /**
   * Length of the rolling rate-limit window in milliseconds.
   * Default: 60 * 60 * 1000 (1 hour, per v0.2 brief).
   */
  windowMs?: number;
  /**
   * First-restart delay in ms; subsequent doublings clamp to
   * `maxDelayMs`. Default: 1000 (v0.2: "1s → 2s → 4s → 8s → 16s").
   */
  initialDelayMs?: number;
  /**
   * Backoff doubling factor. Default 2 (1→2→4→8→16). 1 disables
   * doubling (every restart waits initialDelayMs).
   */
  backoffFactor?: number;
  /**
   * Hard delay ceiling. Default: 30_000 (v0.2: "capped at 30s").
   */
  maxDelayMs?: number;
  /**
   * Clock function — returns ms since epoch. Default: Date.now.
   * Tests inject a fake clock so they don't have to sleep through
   * real wall-clock time.
   */
  now?: () => number;
}

interface CrashRecord {
  /** Wall-clock ms when this crash was recorded. */
  at: number;
}

export class RestartPolicy {
  private readonly maxRestartsPerWindow: number;
  private readonly windowMs: number;
  private readonly initialDelayMs: number;
  private readonly backoffFactor: number;
  private readonly maxDelayMs: number;
  private readonly now: () => number;
  /**
   * Crash history. Newest at the tail. Trimmed to entries within
   * `windowMs` on every read so memory stays bounded by the window
   * size, not lifetime crash count.
   */
  private crashes: CrashRecord[] = [];
  /**
   * Consecutive-restart counter for the backoff curve. Reset by
   * recordSuccess(). Distinct from `crashes.length` because the
   * hour-window can age entries out without resetting the backoff
   * curve, and recordSuccess() resets the curve without clearing
   * the hour history.
   */
  private consecutiveAttempts = 0;

  constructor(opts: RestartPolicyOptions = {}) {
    this.maxRestartsPerWindow = opts.maxRestartsPerWindow ?? 5;
    this.windowMs = opts.windowMs ?? 60 * 60 * 1000;
    this.initialDelayMs = opts.initialDelayMs ?? 1000;
    this.backoffFactor = opts.backoffFactor ?? 2;
    this.maxDelayMs = opts.maxDelayMs ?? 30_000;
    this.now = opts.now ?? (() => Date.now());
    if (this.maxRestartsPerWindow < 1) {
      throw new Error(
        `RestartPolicy.maxRestartsPerWindow must be >= 1, got ${this.maxRestartsPerWindow}`,
      );
    }
    if (this.windowMs <= 0) {
      throw new Error(`RestartPolicy.windowMs must be > 0, got ${this.windowMs}`);
    }
    if (this.initialDelayMs < 0) {
      throw new Error(
        `RestartPolicy.initialDelayMs must be >= 0, got ${this.initialDelayMs}`,
      );
    }
    if (this.maxDelayMs < this.initialDelayMs) {
      throw new Error(
        `RestartPolicy.maxDelayMs (${this.maxDelayMs}) must be >= initialDelayMs (${this.initialDelayMs})`,
      );
    }
    if (this.backoffFactor < 1) {
      throw new Error(
        `RestartPolicy.backoffFactor must be >= 1, got ${this.backoffFactor}`,
      );
    }
  }

  /**
   * Record a crash + decide whether (and after how long) to restart.
   *
   * Returns:
   *   - `{ kind: "restart", delayMs, attempt }` — caller should wait
   *     `delayMs` then attempt to spawn again. `attempt` is the
   *     1-indexed restart number within the current consecutive
   *     backoff curve (1 = first restart, 2 = second, etc).
   *   - `{ kind: "give_up", reason, recentCrashes }` — the hard
   *     rate cap was hit. Caller surfaces the "agent crash-looping"
   *     UI and leaves the agent in the error state. The crash that
   *     triggered the give_up IS counted in `recentCrashes`.
   */
  recordCrash(): RestartDecision {
    const t = this.now();
    this.trim(t);
    this.crashes.push({ at: t });
    if (this.crashes.length > this.maxRestartsPerWindow) {
      return {
        kind: "give_up",
        reason: `agent exceeded ${this.maxRestartsPerWindow} restarts in the last ${Math.round(this.windowMs / 60_000)} minute(s)`,
        recentCrashes: this.crashes.length,
      };
    }
    this.consecutiveAttempts += 1;
    const delayMs = this.delayForAttempt(this.consecutiveAttempts);
    return {
      kind: "restart",
      delayMs,
      attempt: this.consecutiveAttempts,
    };
  }

  /**
   * Reset the consecutive-attempt counter. Call when the agent has
   * been running successfully for a meaningful interval (e.g. past
   * a stability threshold). Does NOT clear the rolling-hour crash
   * history — a flap on minute 0, success at minute 1, then a
   * second flap at minute 5 still counts 2 toward the hour cap.
   */
  recordSuccess(): void {
    this.consecutiveAttempts = 0;
  }

  /** Test/debug introspection. */
  getRecentCrashCount(): number {
    this.trim(this.now());
    return this.crashes.length;
  }

  /** Test/debug introspection. */
  getConsecutiveAttempts(): number {
    return this.consecutiveAttempts;
  }

  /**
   * Compute the backoff delay for a given 1-indexed attempt.
   * attempt=1 → initialDelayMs (default 1000)
   * attempt=2 → initialDelayMs * backoffFactor
   * attempt=N → initialDelayMs * backoffFactor^(N-1), clamped to maxDelayMs
   */
  private delayForAttempt(attempt: number): number {
    if (attempt < 1) return 0;
    const raw = this.initialDelayMs * Math.pow(this.backoffFactor, attempt - 1);
    return Math.min(raw, this.maxDelayMs);
  }

  /** Drop crash entries older than the rolling window. */
  private trim(t: number): void {
    const cutoff = t - this.windowMs;
    // Crashes are appended in time order, so the first entry that
    // survives the cutoff bounds all subsequent ones — splice from
    // the head until we hit it.
    let drop = 0;
    while (drop < this.crashes.length && this.crashes[drop]!.at < cutoff) {
      drop += 1;
    }
    if (drop > 0) {
      this.crashes.splice(0, drop);
    }
  }
}
