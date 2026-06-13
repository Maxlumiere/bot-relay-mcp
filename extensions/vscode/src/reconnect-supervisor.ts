// bot-relay-mcp — Tether for VSCode
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT

/**
 * v0.2.1 P1 — auto-reconnect supervisor.
 *
 * Fixes the "permanent wedge after daemon restart" defect (spec:
 * audit-findings/v0.2.1-tether-p1-autoreconnect-spec.md). Two root causes
 * compounded:
 *   RC-1 — the MCP SDK's StreamableHTTPClientTransport reconnects the SSE
 *          GET on the SAME mcp-session-id captured at initialize. After a
 *          daemon restart that id is unknown → 404 every attempt → drains
 *          the retry budget → onerror("Maximum reconnection attempts (N)
 *          exceeded"), then stops. Retrying a dead session can never win.
 *   RC-2 — the extension's only transport-error sink was setErrorState (a
 *          dead-end painting "Tether: error — run Reconnect"); NO code path
 *          re-invoked connect() on a transport error, so recovery required a
 *          manual Reconnect.
 *
 * This supervisor closes RC-2: on a *recoverable* transport error it drives
 * a FRESH connect() (which tears down the dead transport and performs a new
 * initialize → new session id → re-subscribe), on a capped exponential
 * backoff that **re-arms indefinitely** — a down daemon is retried forever
 * until it returns. It fires on the FIRST recoverable error (e.g. the first
 * 404), which is at/before the SDK's own give-up, so there is no gap (O-1).
 *
 * Backoff math is NOT reimplemented here — it is delegated to RestartPolicy
 * (O-2: "reuse RestartPolicy with an infinite mode; don't duplicate tested
 * backoff"). This module owns only: error classification, single-flight,
 * the scheduling timer, a generation guard against superseded fires, and the
 * success/failure decision after each attempt. The 5/restarts-per-hour cap
 * stays OFF for this path (neverGiveUp policy) — that cap is a fork-bomb
 * guard for *child-process* crash loops (AgentManager), the opposite of what
 * a restarting daemon needs.
 *
 * VSCode-free by design — injectable timer + clock + connect callback so the
 * unit tests (reconnect-supervisor.test.ts) run with fake timers and a spy
 * connect, with zero VSCode stub. All VSCode primitives (status bar, output
 * channel) stay behind the abstract callbacks wired in extension.ts.
 */

import type { RestartPolicy } from "./restart-policy.js";

export type TransportErrorClass = "recoverable" | "unrecoverable";

/**
 * Classify a transport-error message into recoverable (auto-reconnect) vs
 * unrecoverable (manual-Reconnect dead-end).
 *
 * Unrecoverable = auth failures (401/403): re-arming a bad/expired token
 * loops pointlessly and needs operator action. Everything else is treated
 * as recoverable — a dead/unknown session (404 / "Not Found"), the SDK's
 * "Maximum reconnection attempts ... exceeded" give-up, an SSE stream
 * disconnect, or a refused/failed connection to a daemon that is still
 * restarting — all recover via a fresh initialize + indefinite backoff.
 *
 * Assertions in the unit test pin the EXACT strings the SDK emits
 * (streamableHttp.js: "Failed to open SSE stream: Not Found",
 * "Maximum reconnection attempts (N) exceeded.", "SSE stream disconnected")
 * so a drift in the SDK's wording surfaces loud (feedback_test_asserts_contract_not_proxy).
 */
export function classifyTransportError(message: string): TransportErrorClass {
  const m = (message ?? "").toLowerCase();
  if (
    m.includes("401") ||
    m.includes("403") ||
    m.includes("unauthorized") ||
    m.includes("forbidden")
  ) {
    return "unrecoverable";
  }
  return "recoverable";
}

/** Opaque timer handle — Node's setTimeout returns NodeJS.Timeout; tests use numbers. */
export type ReconnectTimer = unknown;

export interface ReconnectSupervisorDeps {
  /** Backoff source — MUST be constructed with `neverGiveUp: true`. */
  policy: RestartPolicy;
  /**
   * Perform a full fresh connect (disconnect → new transport → initialize →
   * re-subscribe). Resolves `true` if the resulting connection is healthy,
   * `false` if it landed in an error state. May reject if connect throws
   * (e.g. daemon still down → ECONNREFUSED) — the supervisor treats both a
   * `false` resolution and a rejection as "unhealthy, retry".
   */
  connect: () => Promise<boolean>;
  /** Schedule `fn` after `ms`. In production: setTimeout. */
  setTimer: (fn: () => void, ms: number) => ReconnectTimer;
  /** Cancel a scheduled timer. In production: clearTimeout. */
  clearTimer: (timer: ReconnectTimer) => void;
  /** Diagnostic log sink. */
  log: (line: string) => void;
  /** Called when an auto-reconnect is scheduled (paint "reconnecting… (attempt N)"). */
  onReconnecting: (attempt: number, delayMs: number) => void;
  /** Called when a reconnect attempt succeeds (clear the reconnecting UI). */
  onReconnected: () => void;
  /** Called for an unrecoverable error (paint the manual-Reconnect dead-end). */
  onUnrecoverable: (message: string) => void;
}

export class ReconnectSupervisor {
  private readonly deps: ReconnectSupervisorDeps;
  /** Single in-flight scheduled timer. undefined when none pending. */
  private pending: ReconnectTimer | undefined;
  /** True while a connect() attempt is awaiting — second-level single-flight guard. */
  private inFlight = false;
  /** Bumped by cancel()/dispose() to invalidate any already-scheduled fire. */
  private generation = 0;
  private disposed = false;

  constructor(deps: ReconnectSupervisorDeps) {
    this.deps = deps;
  }

  /**
   * Entry point from the transport `onerror` sink. Classifies the error and
   * either schedules an auto-reconnect (recoverable) or paints the manual
   * dead-end (unrecoverable).
   */
  handleError(message: string): void {
    if (this.disposed) return;
    if (classifyTransportError(message) === "unrecoverable") {
      this.deps.log(
        `reconnect: unrecoverable transport error — not auto-retrying (manual Reconnect needed): ${message}`,
      );
      this.deps.onUnrecoverable(message);
      return;
    }
    this.deps.log(`reconnect: recoverable transport error — scheduling auto-reconnect: ${message}`);
    this.scheduleReconnect();
  }

  /**
   * The manual "Tether: Reconnect to Relay" command calls this BEFORE its own
   * connect(): cancel any pending auto-reconnect and reset the backoff curve
   * (the operator is forcing a fresh attempt now).
   */
  notifyManualReconnect(): void {
    this.cancel();
    this.deps.policy.recordSuccess();
  }

  /**
   * Report the outcome of an externally-driven connect (activate / config
   * change). On success, reset the backoff so a later failure starts at
   * attempt 1; on failure, hand off to the auto-reconnect loop.
   */
  notifyExternalConnect(healthy: boolean): void {
    if (this.disposed) return;
    if (healthy) {
      this.cancel();
      this.deps.policy.recordSuccess();
    } else {
      this.scheduleReconnect();
    }
  }

  /** Cancel any pending scheduled reconnect and invalidate in-flight fires. */
  cancel(): void {
    this.generation += 1;
    if (this.pending !== undefined) {
      this.deps.clearTimer(this.pending);
      this.pending = undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    // Single-flight: a timer is already armed, or a connect attempt is awaiting.
    if (this.pending !== undefined || this.inFlight) return;
    const decision = this.deps.policy.recordCrash();
    // neverGiveUp policy → always "restart". Defensive: if a caller wired a
    // capped policy by mistake, force a bounded retry rather than wedge.
    const delayMs = decision.kind === "restart" ? decision.delayMs : 30_000;
    const attempt = decision.kind === "restart" ? decision.attempt : 0;
    if (decision.kind !== "restart") {
      this.deps.log(
        `reconnect: policy unexpectedly gave up (${decision.reason}); forcing a ${delayMs}ms retry`,
      );
    }
    this.deps.onReconnecting(attempt, delayMs);
    const myGen = this.generation;
    this.pending = this.deps.setTimer(() => {
      void this.fire(myGen);
    }, delayMs);
  }

  private async fire(myGen: number): Promise<void> {
    this.pending = undefined;
    if (this.disposed || myGen !== this.generation) return; // superseded
    this.inFlight = true;
    let healthy = false;
    try {
      healthy = await this.deps.connect();
    } catch (err) {
      healthy = false;
      this.deps.log(
        `reconnect: attempt threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.inFlight = false;
    }
    if (this.disposed || myGen !== this.generation) return; // superseded mid-connect
    if (healthy) {
      this.deps.policy.recordSuccess();
      this.deps.onReconnected();
      this.deps.log("reconnect: connection healthy — backoff reset");
    } else {
      this.scheduleReconnect(); // grows the backoff and re-arms
    }
  }
}
