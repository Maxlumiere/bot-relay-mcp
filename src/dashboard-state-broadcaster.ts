// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.8 — Dashboard-state decay broadcaster.
 *
 * Periodically computes `deriveDashboardState` for every registered
 * agent and fires `broadcastDashboardEvent({ event: 'agent.status_changed', kind: <new state> })`
 * when the derived state CHANGES between ticks. Pure time-based decay:
 * even when no mutation fires, transitions like `active → waiting →
 * stale → closed` need to surface on the dashboard wire.
 *
 * Architectural calls locked during the v2.8 dashboard state-machine
 * design review:
 *   - HTTP daemon process only (stdio skips it).
 *   - `setInterval` at `RELAY_DECAY_TICK_MS` (default 30s).
 *   - O(N) per tick where N = registered agents; tiny.
 *   - In-process Map<agentName, prevState> for dedup. Lost on restart;
 *     first-tick-after-restart emits a fresh event for every agent.
 *   - Opt-out via `RELAY_DECAY_TICK_DISABLED=1` (test rigs, smoke).
 *
 * The broadcaster takes its dependencies via constructor injection so
 * unit tests inject a fake clock + fake getAgents + fake broadcastFn
 * without monkey-patching globals. The HTTP-side wiring at
 * `src/transport/http.ts` constructs the real instance with the live
 * dependencies.
 */

import {
  deriveDashboardState,
  resolveThresholdsFromEnv,
  type AgentStateInputs,
  type AgentStateThresholds,
  type DashboardAgentState,
} from "./agent-state-machine.js";
import type { DashboardEvent } from "./transport/websocket.js";

/**
 * Per-agent snapshot the broadcaster needs to derive state. Sourced
 * from the agents table + a pre-computed pending count. Caller is
 * responsible for the COUNT query (broadcaster stays pure-ish — no DB
 * handle here, just data in).
 */
export interface BroadcasterAgentSnapshot {
  /** Agent name — used as entity_id on the broadcast event. */
  name: string;
  /** Observable facts for deriveDashboardState. */
  inputs: AgentStateInputs;
}

export type AgentSnapshotsProvider = () => BroadcasterAgentSnapshot[];
export type BroadcastFn = (evt: DashboardEvent) => void;

export interface BroadcasterDeps {
  /** Snapshot provider — typically reads from `agents` table + pending-message counts. */
  getAgents: AgentSnapshotsProvider;
  /** Broadcast sink — typically `broadcastDashboardEvent` from websocket.ts. */
  broadcast: BroadcastFn;
  /**
   * Tick interval in ms. Defaults to `RELAY_DECAY_TICK_MS` env (30000).
   * Must be > 0.
   */
  tickIntervalMs?: number;
  /** Thresholds — defaults to env-resolved. */
  thresholds?: AgentStateThresholds;
  /** Clock for transition timestamps. Defaults to Date.now. */
  now?: () => number;
  /**
   * Timer factory. Tests inject a fake to drive ticks without
   * `vi.useFakeTimers()` global pollution.
   */
  scheduler?: {
    setInterval: (cb: () => void, ms: number) => { stop: () => void };
  };
}

/** Default scheduler — real setInterval. */
export function realIntervalScheduler(): NonNullable<BroadcasterDeps["scheduler"]> {
  return {
    setInterval(cb, ms) {
      const handle = setInterval(cb, ms);
      return {
        stop: () => clearInterval(handle),
      };
    },
  };
}

/** Resolve the decay tick interval from env + defaults. */
export function resolveTickIntervalMs(
  env: Record<string, string | undefined> = process.env as Record<
    string,
    string | undefined
  >,
): number {
  const raw = env.RELAY_DECAY_TICK_MS;
  if (raw === undefined || raw === "") return 30_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 30_000;
  return Math.floor(n);
}

/** Is the broadcaster disabled via env? */
export function isDisabledByEnv(
  env: Record<string, string | undefined> = process.env as Record<
    string,
    string | undefined
  >,
): boolean {
  return env.RELAY_DECAY_TICK_DISABLED === "1";
}

export class DashboardStateBroadcaster {
  private readonly deps: Required<
    Omit<BroadcasterDeps, "scheduler" | "tickIntervalMs" | "thresholds" | "now">
  > & {
    scheduler: NonNullable<BroadcasterDeps["scheduler"]>;
    tickIntervalMs: number;
    thresholds: AgentStateThresholds;
    now: () => number;
  };
  /**
   * Last broadcasted state per agent. Used to dedup: only fire a
   * broadcast when the derived state actually changes between ticks.
   */
  private readonly lastBroadcastedState: Map<string, DashboardAgentState> = new Map();
  private handle: { stop: () => void } | null = null;

  constructor(deps: BroadcasterDeps) {
    this.deps = {
      getAgents: deps.getAgents,
      broadcast: deps.broadcast,
      scheduler: deps.scheduler ?? realIntervalScheduler(),
      tickIntervalMs: deps.tickIntervalMs ?? resolveTickIntervalMs(),
      thresholds: deps.thresholds ?? resolveThresholdsFromEnv(),
      now: deps.now ?? (() => Date.now()),
    };
    if (this.deps.tickIntervalMs <= 0) {
      throw new Error(
        `DashboardStateBroadcaster.tickIntervalMs must be > 0, got ${this.deps.tickIntervalMs}`,
      );
    }
  }

  /**
   * Start the periodic tick. No-op if already started. Returns this
   * for fluent chaining at the http.ts wire-up site.
   */
  start(): this {
    if (this.handle !== null) return this;
    this.handle = this.deps.scheduler.setInterval(
      () => this.tick(),
      this.deps.tickIntervalMs,
    );
    return this;
  }

  /** Stop the tick + clear the dedup state. Idempotent. */
  stop(): void {
    if (this.handle !== null) {
      this.handle.stop();
      this.handle = null;
    }
    this.lastBroadcastedState.clear();
  }

  /**
   * Public entrypoint for tests to drive a single tick without timer
   * scheduling. Production callers should `start()` instead.
   */
  tick(): void {
    const now = this.deps.now();
    const snapshots = this.deps.getAgents();
    for (const snap of snapshots) {
      const next = deriveDashboardState(snap.inputs, now, this.deps.thresholds);
      const prev = this.lastBroadcastedState.get(snap.name);
      if (prev === next) {
        // No transition — skip the broadcast. The dedup keeps the
        // dashboard wire quiet during steady-state.
        continue;
      }
      this.lastBroadcastedState.set(snap.name, next);
      try {
        this.deps.broadcast({
          event: "agent.status_changed",
          entity_id: snap.name,
          ts: new Date(now).toISOString(),
          kind: next,
        });
      } catch {
        // broadcast() is already swallow-and-log via broadcastDashboardEvent;
        // this catch is a defense-in-depth no-op for fake sinks that throw.
      }
    }
  }

  /** Test introspection — return a snapshot of the dedup map. */
  getLastBroadcastedState(): Map<string, DashboardAgentState> {
    return new Map(this.lastBroadcastedState);
  }

  /** Test introspection — running state. */
  isRunning(): boolean {
    return this.handle !== null;
  }
}
