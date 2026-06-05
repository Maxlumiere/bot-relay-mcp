// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.8 — DashboardStateBroadcaster unit tests.
 *
 * Mock clock + manual scheduler + FakeBroadcastSink. Per
 * `feedback_test_asserts_contract_not_proxy.md`: assertions pin exact
 * broadcast events fired, exact dedup behavior, exact lifecycle state.
 *
 * Per `feedback_test_path_must_match_shipped_path.md`: tests exercise
 * the actual exported class. No reimplementation of dedup logic in
 * test space.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  DashboardStateBroadcaster,
  isDisabledByEnv,
  resolveTickIntervalMs,
  type BroadcasterAgentSnapshot,
} from "../src/dashboard-state-broadcaster.js";
import {
  DEFAULT_THRESHOLDS,
  type AgentStateInputs,
} from "../src/agent-state-machine.js";
import type { DashboardEvent } from "../src/transport/websocket.js";

class ManualScheduler {
  private callbacks: { cb: () => void; ms: number; stopped: boolean }[] = [];
  setInterval(cb: () => void, ms: number): { stop: () => void } {
    const entry = { cb, ms, stopped: false };
    this.callbacks.push(entry);
    return {
      stop: () => {
        entry.stopped = true;
      },
    };
  }
  /** Fire all live callbacks. Tests use this to "advance one tick". */
  tickAll(): void {
    for (const entry of this.callbacks) {
      if (!entry.stopped) entry.cb();
    }
  }
  liveCount(): number {
    return this.callbacks.filter((c) => !c.stopped).length;
  }
  intervals(): number[] {
    return this.callbacks.map((c) => c.ms);
  }
}

class FakeClock {
  t = 1_700_000_000_000;
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

function baseInputs(over: Partial<AgentStateInputs> = {}): AgentStateInputs {
  return {
    lastSeen: new Date(1_700_000_000_000).toISOString(),
    signalReceivedAt: null,
    signalKind: null,
    unregisteredAt: null,
    pendingCount: 0,
    lastDispatchedAt: null,
    ...over,
  };
}

let scheduler: ManualScheduler;
let clock: FakeClock;
let broadcasts: DashboardEvent[];
let agents: BroadcasterAgentSnapshot[];
let broadcaster: DashboardStateBroadcaster;

beforeEach(() => {
  scheduler = new ManualScheduler();
  clock = new FakeClock();
  broadcasts = [];
  agents = [];
  broadcaster = new DashboardStateBroadcaster({
    getAgents: () => agents,
    broadcast: (e) => {
      broadcasts.push(e);
    },
    scheduler,
    tickIntervalMs: 30_000,
    thresholds: DEFAULT_THRESHOLDS,
    now: clock.now,
  });
});

describe("v2.8 — DashboardStateBroadcaster — tick + dedup", () => {
  it("(D1) first tick emits one event per agent (no prior state)", () => {
    agents = [
      { name: "a", inputs: baseInputs() },
      { name: "b", inputs: baseInputs({ pendingCount: 3 }) },
    ];
    broadcaster.tick();
    expect(broadcasts).toHaveLength(2);
    const aEvt = broadcasts.find((e) => e.entity_id === "a")!;
    const bEvt = broadcasts.find((e) => e.entity_id === "b")!;
    expect(aEvt.event).toBe("agent.status_changed");
    expect(aEvt.kind).toBe("active");
    expect(bEvt.kind).toBe("pending");
  });

  it("(D2) second tick with NO state change emits ZERO events (dedup correctness)", () => {
    agents = [{ name: "a", inputs: baseInputs() }];
    broadcaster.tick();
    expect(broadcasts).toHaveLength(1);
    broadcasts.length = 0; // clear sink
    broadcaster.tick();
    expect(
      broadcasts,
      "no state change between ticks must produce no broadcasts",
    ).toEqual([]);
  });

  it("(D3) transition active → waiting fires exactly one event", () => {
    agents = [{ name: "a", inputs: baseInputs() }];
    broadcaster.tick();
    expect(broadcasts.at(-1)!.kind).toBe("active");
    broadcasts.length = 0;
    // Move lastSeen out of the active window → waiting.
    clock.advance(DEFAULT_THRESHOLDS.activeWindowMs + 5_000);
    broadcaster.tick();
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]!.kind).toBe("waiting");
  });

  it("(D4) transition waiting → closed via signal fires exactly one event", () => {
    agents = [{ name: "a", inputs: baseInputs() }];
    broadcaster.tick(); // active
    clock.advance(DEFAULT_THRESHOLDS.activeWindowMs + 5_000);
    broadcaster.tick(); // waiting
    broadcasts.length = 0;
    // Operator-typed SIGHUP triggers stdio handler → DB column populated.
    agents = [
      { name: "a", inputs: baseInputs({ signalReceivedAt: clock.now() - 1000 }) },
    ];
    broadcaster.tick();
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]!.kind).toBe("closed");
  });

  it("(D5) ts timestamp on broadcast equals clock.now() at tick", () => {
    agents = [{ name: "a", inputs: baseInputs() }];
    const tBefore = clock.now();
    broadcaster.tick();
    expect(broadcasts[0]!.ts).toBe(new Date(tBefore).toISOString());
  });

  it("(D6) entity_id equals agent name (rate-limit coalesce key)", () => {
    agents = [
      { name: "victra-build", inputs: baseInputs() },
      { name: "pod.alpha", inputs: baseInputs({ pendingCount: 1 }) },
    ];
    broadcaster.tick();
    const names = broadcasts.map((b) => b.entity_id).sort();
    expect(names).toEqual(["pod.alpha", "victra-build"]);
  });

  it("(D7) event field is always 'agent.status_changed' (stable wire format)", () => {
    agents = [{ name: "a", inputs: baseInputs() }];
    broadcaster.tick();
    expect(broadcasts[0]!.event).toBe("agent.status_changed");
  });

  it("(D8) sink-thrown errors do NOT take down the tick (defense-in-depth)", () => {
    const throwingBroadcaster = new DashboardStateBroadcaster({
      getAgents: () => [
        { name: "a", inputs: baseInputs() },
        { name: "b", inputs: baseInputs() },
      ],
      broadcast: () => {
        throw new Error("sink down");
      },
      scheduler,
      tickIntervalMs: 30_000,
      thresholds: DEFAULT_THRESHOLDS,
      now: clock.now,
    });
    // Must not throw — the catch in tick() swallows.
    expect(() => throwingBroadcaster.tick()).not.toThrow();
  });

  it("(D9) all five state transitions surface across the dedup map", () => {
    agents = [{ name: "rotator", inputs: baseInputs() }];
    broadcaster.tick(); // active
    agents = [{ name: "rotator", inputs: baseInputs({ pendingCount: 5 }) }];
    broadcaster.tick(); // pending
    agents = [
      {
        name: "rotator",
        inputs: baseInputs({
          lastSeen: new Date(clock.now() - DEFAULT_THRESHOLDS.activeWindowMs - 10_000).toISOString(),
        }),
      },
    ];
    broadcaster.tick(); // waiting
    agents = [
      {
        name: "rotator",
        inputs: baseInputs({
          lastSeen: new Date(clock.now() - DEFAULT_THRESHOLDS.staleWindowMs - 60_000).toISOString(),
          pendingCount: 2,
        }),
      },
    ];
    broadcaster.tick(); // stale
    agents = [
      {
        name: "rotator",
        inputs: baseInputs({ signalReceivedAt: clock.now() - 1000 }),
      },
    ];
    broadcaster.tick(); // closed

    const kinds = broadcasts.map((b) => b.kind);
    expect(kinds).toEqual(["active", "pending", "waiting", "stale", "closed"]);
  });
});

describe("v2.8 — DashboardStateBroadcaster — lifecycle", () => {
  it("(D10) start() registers an interval with the scheduler", () => {
    expect(scheduler.liveCount()).toBe(0);
    broadcaster.start();
    expect(scheduler.liveCount()).toBe(1);
    expect(scheduler.intervals()).toEqual([30_000]);
  });

  it("(D11) start() is idempotent — second call is a no-op", () => {
    broadcaster.start();
    broadcaster.start();
    expect(scheduler.liveCount()).toBe(1);
  });

  it("(D12) stop() unregisters the interval + clears dedup state", () => {
    agents = [{ name: "a", inputs: baseInputs() }];
    broadcaster.start();
    broadcaster.tick();
    expect(broadcaster.getLastBroadcastedState().size).toBe(1);
    broadcaster.stop();
    expect(scheduler.liveCount()).toBe(0);
    expect(broadcaster.getLastBroadcastedState().size).toBe(0);
    expect(broadcaster.isRunning()).toBe(false);
  });

  it("(D13) stop() is idempotent — second call is a no-op", () => {
    broadcaster.start();
    broadcaster.stop();
    broadcaster.stop();
    expect(scheduler.liveCount()).toBe(0);
  });

  it("(D14) scheduler.tickAll fires the broadcaster's tick", () => {
    agents = [{ name: "a", inputs: baseInputs() }];
    broadcaster.start();
    scheduler.tickAll();
    expect(broadcasts).toHaveLength(1);
  });

  it("(D15) constructor rejects non-positive tickIntervalMs", () => {
    expect(
      () =>
        new DashboardStateBroadcaster({
          getAgents: () => [],
          broadcast: () => {},
          tickIntervalMs: 0,
          scheduler,
          now: clock.now,
        }),
    ).toThrow(/> 0/);
  });
});

describe("v2.8 — DashboardStateBroadcaster — env resolution", () => {
  it("(D16) resolveTickIntervalMs defaults to 30_000", () => {
    expect(resolveTickIntervalMs({})).toBe(30_000);
  });

  it("(D17) resolveTickIntervalMs honors RELAY_DECAY_TICK_MS", () => {
    expect(resolveTickIntervalMs({ RELAY_DECAY_TICK_MS: "5000" })).toBe(5000);
  });

  it("(D18) resolveTickIntervalMs falls back on invalid values", () => {
    expect(resolveTickIntervalMs({ RELAY_DECAY_TICK_MS: "" })).toBe(30_000);
    expect(resolveTickIntervalMs({ RELAY_DECAY_TICK_MS: "abc" })).toBe(30_000);
    expect(resolveTickIntervalMs({ RELAY_DECAY_TICK_MS: "0" })).toBe(30_000);
    expect(resolveTickIntervalMs({ RELAY_DECAY_TICK_MS: "-5" })).toBe(30_000);
  });

  it("(D19) isDisabledByEnv returns true only on exact '1' value", () => {
    expect(isDisabledByEnv({})).toBe(false);
    expect(isDisabledByEnv({ RELAY_DECAY_TICK_DISABLED: "1" })).toBe(true);
    expect(isDisabledByEnv({ RELAY_DECAY_TICK_DISABLED: "true" })).toBe(false);
    expect(isDisabledByEnv({ RELAY_DECAY_TICK_DISABLED: "" })).toBe(false);
  });
});
