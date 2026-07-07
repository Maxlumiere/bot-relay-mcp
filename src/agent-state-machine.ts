// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.8 — Dashboard-state derivation. Five operator-meaningful states
 * computed PURELY from observable agent facts (last_seen, signal_received_at,
 * pending count, last_dispatched_at) + the wall clock. No I/O, no side
 * effects, no DB writes.
 *
 * Lives in its own module so unit tests exercise the EXACT function the
 * decay broadcaster + dashboard derivation call at runtime (so the
 * test path always matches the shipped path). The legacy
 * `deriveAgentStatus` in `src/db.ts` stays untouched — it returns the
 * pre-v2.8 8-state union (`agent_status`) which existing dashboard
 * rendering still consumes. v2.9 will migrate the dashboard UI to use
 * THIS module's output. v2.8 only emits the new state on the wire (via
 * the decay broadcaster) and stamps the new DB columns; no existing
 * consumer changes shape.
 *
 * Architectural calls locked during a v2.8 design review. State count = 6
 * (v2.15.0 added `unknown`; original 5 locked 2026-05-25). Precedence top wins:
 * `closed > unknown > stale > pending > active > waiting`.
 */

/**
 * The operator-facing dashboard state enum. Stable wire format —
 * extending this union requires a v2.9 dashboard UI update + a
 * CHANGELOG entry.
 */
export type DashboardAgentState =
  | "active"
  | "pending"
  | "waiting"
  | "stale"
  | "closed"
  // v2.15.0 — "no liveness data" (agent_pid absent / cross-host). Shown
  // DISTINCTLY from `closed` so the operator never reads "we don't know" as
  // "dead". Age alone never produces `closed` anymore — only a teardown
  // declaration or a positive dead probe does; an old row with no probe-able
  // anchor lands here instead.
  | "unknown";

/**
 * Observable facts used to derive the state. Mirrors the agents-row
 * shape after `migrateSchemaToV2_11`, plus the per-agent pending count
 * which lives in the messages table (caller pre-computes + passes in
 * so the derivation stays a pure function — no DB handle).
 */
export interface AgentStateInputs {
  /** ISO timestamp of the most recent activity from the agent (mirror of `last_seen`). */
  lastSeen: string | null;
  /** Epoch ms of the most recent SIGHUP/SIGINT/SIGTERM, or `null` if none yet. */
  signalReceivedAt: number | null;
  /**
   * 'SIGHUP' | 'SIGINT' | 'SIGTERM' | null. Operator visibility only;
   * doesn't affect the state result (any non-null signal closes the
   * agent). Carried alongside the state so callers can render
   * "closed (SIGHUP)" without a second lookup.
   */
  signalKind: string | null;
  /**
   * Set when the agent has been explicitly unregistered (e.g.
   * `unregister_agent` tool call). Tracked separately from
   * `signalReceivedAt` because the unregister path doesn't always
   * coincide with a signal (a planner can unregister a builder
   * remotely via MCP without the builder's process being killed).
   */
  unregisteredAt: number | null;
  /** Count of pending messages addressed to this agent. */
  pendingCount: number;
  /**
   * Epoch ms of the most recent dispatch event (high-priority message
   * received, task posted to this agent). Used to distinguish `stale`
   * (was actively working, went quiet) from `waiting` (just idle).
   */
  lastDispatchedAt: number | null;
  /**
   * v2.15.0 — the three-way liveness verdict, pre-computed by the caller from
   * the agent's own-process probe. `alive` = process confirmed up → suppresses
   * the age-based `closed`/`unknown` (an alive-and-idle agent derives
   * `waiting`, even with a stale last_seen — the rate-limit case). `dead` =
   * positive dead probe → `closed`. `unknown` = no probe-able anchor → an old
   * row derives `unknown`, NEVER a stale-age `closed`. v2.15.2: an `alive`
   * probe SUPPRESSES the `signalReceivedAt`-derived close (the signal hits the
   * MCP-server process, not the agent); an explicit `unregisteredAt` delete is
   * NOT gated and still wins.
   */
  liveness: "alive" | "dead" | "unknown";
}

/**
 * Tunable thresholds. Caller passes them in so tests don't need to
 * monkey-patch env vars. The actual env-var resolution happens at
 * the broadcaster boundary; this module accepts the resolved values.
 */
export interface AgentStateThresholds {
  /** Window for "active" — most recent activity must be within this. Default 30s. */
  activeWindowMs: number;
  /** "pending" promotion — message older than this counts. Default 60s. */
  pendingWindowMs: number;
  /** "stale" cutoff — was-active but quiet for >= this. Default 5 min. */
  staleWindowMs: number;
  /** "was active recently" — for the stale rule, last activity must be within. Default 1 hour. */
  wasActiveWindowMs: number;
  /** "closed" via session timeout — last_seen older than this. Default 30 min. */
  sessionTimeoutMs: number;
  /** Recent dispatch window — counts toward "stale" when present. Default 10 min. */
  recentDispatchWindowMs: number;
  /** v2.13.0 — positive-liveness freshness window. A `lastAlive` within this
   *  suppresses the session-timeout `closed`. Default 2 min. */
  aliveWindowMs: number;
}

export const DEFAULT_THRESHOLDS: AgentStateThresholds = {
  activeWindowMs: 30 * 1000,
  pendingWindowMs: 60 * 1000,
  staleWindowMs: 5 * 60 * 1000,
  wasActiveWindowMs: 60 * 60 * 1000,
  sessionTimeoutMs: 30 * 60 * 1000,
  recentDispatchWindowMs: 10 * 60 * 1000,
  aliveWindowMs: 2 * 60 * 1000,
};

/**
 * Resolve thresholds from env vars with fallback to DEFAULT_THRESHOLDS.
 * Each var is independent — operators can tune only the windows they
 * care about without re-declaring the whole shape.
 *
 *   RELAY_STATE_ACTIVE_WINDOW_SEC      → activeWindowMs
 *   RELAY_STATE_PENDING_WINDOW_SEC     → pendingWindowMs
 *   RELAY_STATE_STALE_WINDOW_SEC       → staleWindowMs
 *   RELAY_STATE_WAS_ACTIVE_WINDOW_SEC  → wasActiveWindowMs
 *   RELAY_SESSION_TIMEOUT_SEC          → sessionTimeoutMs
 *   RELAY_STATE_RECENT_DISPATCH_SEC    → recentDispatchWindowMs
 */
export function resolveThresholdsFromEnv(
  env: Record<string, string | undefined> = process.env as Record<
    string,
    string | undefined
  >,
): AgentStateThresholds {
  const sec = (raw: string | undefined, fallback: number): number => {
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return fallback;
    return Math.floor(n) * 1000;
  };
  return {
    activeWindowMs: sec(env.RELAY_STATE_ACTIVE_WINDOW_SEC, DEFAULT_THRESHOLDS.activeWindowMs),
    pendingWindowMs: sec(env.RELAY_STATE_PENDING_WINDOW_SEC, DEFAULT_THRESHOLDS.pendingWindowMs),
    staleWindowMs: sec(env.RELAY_STATE_STALE_WINDOW_SEC, DEFAULT_THRESHOLDS.staleWindowMs),
    wasActiveWindowMs: sec(env.RELAY_STATE_WAS_ACTIVE_WINDOW_SEC, DEFAULT_THRESHOLDS.wasActiveWindowMs),
    sessionTimeoutMs: sec(env.RELAY_SESSION_TIMEOUT_SEC, DEFAULT_THRESHOLDS.sessionTimeoutMs),
    recentDispatchWindowMs: sec(env.RELAY_STATE_RECENT_DISPATCH_SEC, DEFAULT_THRESHOLDS.recentDispatchWindowMs),
    aliveWindowMs: sec(env.RELAY_AGENT_ALIVE_WINDOW_SEC, DEFAULT_THRESHOLDS.aliveWindowMs),
  };
}

/**
 * Pure derivation: agent observable facts + clock → 5-state enum.
 *
 * Precedence (top wins) per the brief's locked rule:
 *
 *   1. `closed` — a teardown DECLARATION or a POSITIVE dead probe:
 *        - `signalReceivedAt` is set (SIGHUP/SIGINT/SIGTERM fired) AND
 *          `liveness !== 'alive'` — v2.15.2: a confirmed-alive probe suppresses
 *          the signal-derived close (the signal hit the MCP-server process, not
 *          the agent; the stamp is session-scoped and cleared on re-register)
 *        - `unregisteredAt` is set (explicit unregister tool call) — NOT gated
 *        - `liveness === 'dead'` (agent_pid present, process confirmed gone)
 *   1b. `unknown` — v2.15.0: `liveness !== 'alive'` (no probe-able anchor) AND
 *        `lastSeen` older than `sessionTimeoutMs`. Replaces the old stale-age
 *        `closed` — age alone never declares death; a live probe suppresses it.
 *   2. `stale`  — was-active inside `wasActiveWindowMs` AND quiet for
 *                 >= `staleWindowMs` AND (`pendingCount > 0` OR
 *                 `lastDispatchedAt` inside `recentDispatchWindowMs`).
 *   3. `pending` — has any pending message older than `pendingWindowMs`.
 *   4. `active` — `lastSeen` within `activeWindowMs`.
 *   5. `waiting` — default catch-all when none of the above match.
 *
 * The function is total — there is no NULL / undefined return path.
 * Invalid timestamps (NaN, future-dated) are treated conservatively:
 *   - non-parseable `lastSeen` → treat as "never seen" → not active,
 *     not stale-pre-condition → routes to `waiting` (or higher if
 *     pendingCount/signal applies)
 *   - non-parseable `signalReceivedAt` → ignored (no `closed`
 *     promotion from a junk signal field)
 *   - future-dated `lastSeen` → still treated as "recent" (clock skew
 *     is the operator's problem; staying conservative on the alive
 *     side is friendlier than declaring a live agent closed).
 */
export function deriveDashboardState(
  inputs: AgentStateInputs,
  now: number,
  thresholds: AgentStateThresholds = DEFAULT_THRESHOLDS,
): DashboardAgentState {
  const {
    lastSeen,
    signalReceivedAt,
    unregisteredAt,
    pendingCount,
    lastDispatchedAt,
    liveness,
  } = inputs;

  const lastSeenMs = parseIsoOrNull(lastSeen);

  // 1. closed — an intentional teardown, BUT liveness governs the signal path.
  // v2.15.2 — a SIGHUP/SIGINT/SIGTERM hits the agent's MCP-SERVER process, not
  // the agent itself; the agent (tracked by agent_pid) can survive/relaunch. So
  // a confirmed-ALIVE probe SUPPRESSES the signal-derived close — a live agent
  // with a stale signal stamp never reads 'closed'. (The stamp is also session-
  // scoped: registerAgent clears it on the next session, so it can't outlive
  // its session and phantom a fresh no-anchor session.) An explicit
  // `unregisteredAt` is a deliberate operator delete — it is NOT gated and
  // still wins (parallels the set_status('offline') R1 boundary in getAgents).
  if (
    signalReceivedAt !== null &&
    Number.isFinite(signalReceivedAt) &&
    signalReceivedAt > 0 &&
    liveness !== "alive"
  ) {
    return "closed";
  }
  if (unregisteredAt !== null && Number.isFinite(unregisteredAt) && unregisteredAt > 0) {
    return "closed";
  }
  // 2. closed — a POSITIVE dead probe (agent_pid present, process confirmed gone).
  if (liveness === "dead") {
    return "closed";
  }
  // v2.15.0 — age NEVER produces `closed` on its own. A live process is
  // authoritative (suppresses the age rule → falls through to activity states,
  // so a rate-limited alive-but-quiet agent reads `waiting`, not closed). With
  // NO liveness data (`unknown`), an old-past-session-timeout row reads
  // `unknown`, never a stale-age `closed`.
  if (
    liveness !== "alive" &&
    lastSeenMs !== null &&
    now - lastSeenMs >= thresholds.sessionTimeoutMs
  ) {
    return "unknown";
  }

  // 2. stale — was-active recently AND quiet long enough AND has work to do.
  if (lastSeenMs !== null) {
    const ageMs = now - lastSeenMs;
    const wasActiveRecently = ageMs >= 0 && ageMs < thresholds.wasActiveWindowMs;
    const quietPastStaleWindow = ageMs >= thresholds.staleWindowMs;
    const hasPending = pendingCount > 0;
    const recentlyDispatched =
      lastDispatchedAt !== null &&
      Number.isFinite(lastDispatchedAt) &&
      now - lastDispatchedAt < thresholds.recentDispatchWindowMs;
    if (wasActiveRecently && quietPastStaleWindow && (hasPending || recentlyDispatched)) {
      return "stale";
    }
  }

  // 3. pending — any unprocessed message older than pendingWindow.
  // Note: pendingCount alone doesn't promote to `pending` — the
  // caller pre-filters by created_at so the count reflects messages
  // older than `pendingWindowMs`. v2.8 callers that don't pre-filter
  // should pass 0 for fresh-only counts; the `pending` state means
  // "operator should look".
  if (pendingCount > 0) {
    return "pending";
  }

  // 4. active — recent activity.
  if (lastSeenMs !== null && now - lastSeenMs >= 0 && now - lastSeenMs < thresholds.activeWindowMs) {
    return "active";
  }

  // 5. waiting — default catch-all.
  return "waiting";
}

function parseIsoOrNull(iso: string | null): number | null {
  if (iso === null || iso === "") return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return t;
}
