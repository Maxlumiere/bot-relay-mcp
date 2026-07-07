// bot-relay-mcp — Tether for VSCode
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT

/**
 * v0.4.1 — health-poll backstop (the belt-and-suspenders reconnect trigger).
 *
 * WHY THIS EXISTS. onclose/onerror cover a transport that reports its own
 * failure. But an SSE stream can die SILENTLY inside VS Code's Electron fetch
 * runtime — no onerror AND no onclose — leaving Tether "connected" over a dead
 * stream (the exact failure class transport-diagnostics.ts was created for).
 * A periodic reachability-plus-health probe of the daemon catches that and
 * hands off to the reconnect supervisor.
 *
 * HEALTH, NOT JUST REACHABILITY. A tick counts as healthy ONLY when the HTTP
 * response is 2xx AND the parsed body reports `status === "ok"`. Anything else
 * — a fetch/abort/timeout error, a non-2xx status, a body that isn't valid
 * JSON, or a JSON body whose `status` is not `"ok"` (e.g. `"degraded"`,
 * `"error"`, or a wrong endpoint that happens to return 200) — is a FAILURE
 * and increments the consecutive-failure counter. N consecutive failures fire
 * `onUnhealthy` (the supervisor handoff) once, then the counter resets so the
 * next window starts clean.
 *
 * VSCode-free by design. The actual fetch (with its AbortController/timeout)
 * is injected as `fetchHealth`, so this module — which owns the load-bearing
 * status check + the counter + the threshold — is the code that ships AND the
 * code the unit test drives (test-path-matches-shipped-path). extension.ts is
 * dumb wiring over it: the interval timer, the real fetch, and an onUnhealthy
 * that stops the poll + calls supervisor.handleError.
 */

/** One raw health probe: HTTP-2xx plus the response body text (or null when
 *  the body was not read, e.g. on a non-2xx response). */
export interface HealthProbe {
  ok: boolean;
  bodyText: string | null;
}

export interface HealthPollDeps {
  /** Consecutive failures required before `onUnhealthy` fires (production: 2). */
  threshold: number;
  /**
   * Perform ONE raw probe of the daemon's /health. Production wires a real
   * `fetch(new URL("/health", endpoint))` with an AbortController timeout and
   * returns `{ ok: res.ok, bodyText: res.ok ? await res.text() : null }`. May
   * reject (network error / abort) — a rejection counts as a failed tick.
   */
  fetchHealth: () => Promise<HealthProbe>;
  /**
   * Fired ONCE when the consecutive-failure counter reaches `threshold`. The
   * counter is reset before this fires, so a subsequent recovery starts clean.
   * Production: stop the poll + hand off to the reconnect supervisor.
   */
  onUnhealthy: () => void;
  /** Optional diagnostic sink. */
  log?: (line: string) => void;
}

export class HealthPoll {
  private failures = 0;

  constructor(private readonly deps: HealthPollDeps) {}

  /**
   * Is a /health body a genuine "ok" health report? True ONLY for a body that
   * parses as JSON with `status === "ok"`. A null body (non-2xx / unread),
   * non-JSON, or any other `status` value → false. This is the load-bearing
   * check the pre-fix code was missing (it trusted HTTP 200 alone).
   */
  static bodyIsOk(bodyText: string | null): boolean {
    if (bodyText == null) return false;
    try {
      const parsed = JSON.parse(bodyText) as { status?: unknown };
      return parsed?.status === "ok";
    } catch {
      return false; // malformed JSON is unhealthy, not "reachable so fine"
    }
  }

  /**
   * Run one tick: probe, decide healthy iff (2xx AND body status==="ok"),
   * update the counter, and fire `onUnhealthy` at the threshold. A rejected
   * probe (network error / timeout) is treated as unhealthy.
   */
  async tick(): Promise<void> {
    let healthy = false;
    try {
      const probe = await this.deps.fetchHealth();
      healthy = probe.ok && HealthPoll.bodyIsOk(probe.bodyText);
    } catch {
      healthy = false; // fetch error / abort / timeout — daemon not answering
    }
    if (healthy) {
      this.failures = 0;
      return;
    }
    this.failures += 1;
    this.deps.log?.(`health-poll: daemon not healthy (${this.failures}/${this.deps.threshold})`);
    if (this.failures >= this.deps.threshold) {
      this.failures = 0; // reset before handoff; a later recovery starts clean
      this.deps.onUnhealthy();
    }
  }

  /** Reset the consecutive-failure counter (called on start/stop of the poll). */
  reset(): void {
    this.failures = 0;
  }

  /** Introspection (tests): current consecutive-failure count. */
  get failureCount(): number {
    return this.failures;
  }
}
