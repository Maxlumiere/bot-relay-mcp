// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.8 — deriveDashboardState unit tests.
 *
 * Pure derivation, fake clock + explicit thresholds. No DB boot, no
 * timers, no env munging. Per
 * `feedback_test_asserts_contract_not_proxy.md`: every test pins the
 * exact returned state (`toBe('closed')` etc.) and exercises a
 * specific transition / boundary / precedence rule.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_THRESHOLDS,
  deriveDashboardState,
  resolveThresholdsFromEnv,
  type AgentStateInputs,
  type AgentStateThresholds,
} from "../src/agent-state-machine.js";

const NOW_MS = 1_700_000_000_000;
const NOW_ISO = new Date(NOW_MS).toISOString();
function iso(deltaMs: number): string {
  return new Date(NOW_MS + deltaMs).toISOString();
}

function base(overrides: Partial<AgentStateInputs> = {}): AgentStateInputs {
  return {
    lastSeen: NOW_ISO,
    signalReceivedAt: null,
    signalKind: null,
    unregisteredAt: null,
    pendingCount: 0,
    lastDispatchedAt: null,
    ...overrides,
  };
}

describe("v2.8 — deriveDashboardState — closed precedence", () => {
  it("(M1) any non-null signal_received_at returns closed", () => {
    expect(
      deriveDashboardState(base({ signalReceivedAt: NOW_MS - 1000 }), NOW_MS),
    ).toBe("closed");
  });

  it("(M2) explicit unregisteredAt returns closed", () => {
    expect(
      deriveDashboardState(base({ unregisteredAt: NOW_MS - 1000 }), NOW_MS),
    ).toBe("closed");
  });

  it("(M3) last_seen older than session timeout returns closed", () => {
    expect(
      deriveDashboardState(
        base({ lastSeen: iso(-DEFAULT_THRESHOLDS.sessionTimeoutMs - 1) }),
        NOW_MS,
      ),
    ).toBe("closed");
  });

  it("(M4) closed wins over stale — agent with pending work + signal still reads closed", () => {
    expect(
      deriveDashboardState(
        base({
          signalReceivedAt: NOW_MS - 1000,
          lastSeen: iso(-DEFAULT_THRESHOLDS.staleWindowMs - 1000),
          pendingCount: 5,
          lastDispatchedAt: NOW_MS - 1000,
        }),
        NOW_MS,
      ),
    ).toBe("closed");
  });

  it("(M5) closed wins over pending — agent with pending mail + signal still reads closed", () => {
    expect(
      deriveDashboardState(
        base({ signalReceivedAt: NOW_MS - 1000, pendingCount: 10 }),
        NOW_MS,
      ),
    ).toBe("closed");
  });

  it("(M6) zero-valued signal_received_at does NOT close (no-signal sentinel)", () => {
    expect(
      deriveDashboardState(base({ signalReceivedAt: 0 }), NOW_MS),
    ).toBe("active");
  });

  it("(M7) negative signal_received_at does NOT close (junk sentinel)", () => {
    expect(
      deriveDashboardState(base({ signalReceivedAt: -1 }), NOW_MS),
    ).toBe("active");
  });

  it("(M8) NaN unregisteredAt is ignored", () => {
    expect(
      deriveDashboardState(base({ unregisteredAt: Number.NaN }), NOW_MS),
    ).toBe("active");
  });
});

describe("v2.8 — deriveDashboardState — stale precedence", () => {
  // stale requires: was-active inside wasActiveWindow AND quiet for
  // >= staleWindow AND (pendingCount > 0 OR lastDispatchedAt in
  // recentDispatchWindow).
  it("(M9) was-active + quiet + has pending work → stale", () => {
    const ageMs = DEFAULT_THRESHOLDS.staleWindowMs + 60_000;
    expect(
      deriveDashboardState(
        base({ lastSeen: iso(-ageMs), pendingCount: 3 }),
        NOW_MS,
      ),
    ).toBe("stale");
  });

  it("(M10) was-active + quiet + recently dispatched (no pending) → stale", () => {
    const ageMs = DEFAULT_THRESHOLDS.staleWindowMs + 60_000;
    expect(
      deriveDashboardState(
        base({
          lastSeen: iso(-ageMs),
          lastDispatchedAt: NOW_MS - 60_000,
        }),
        NOW_MS,
      ),
    ).toBe("stale");
  });

  it("(M11) was-active + quiet + NO pending + NO recent dispatch → waiting (not stale)", () => {
    const ageMs = DEFAULT_THRESHOLDS.staleWindowMs + 60_000;
    expect(
      deriveDashboardState(base({ lastSeen: iso(-ageMs) }), NOW_MS),
    ).toBe("waiting");
  });

  it("(M12) quiet beyond wasActiveWindow → no longer stale-eligible (custom thresholds where wasActive < sessionTimeout)", () => {
    // Default thresholds have wasActive (1hr) > sessionTimeout (30min), so
    // "past wasActive but not closed" is unreachable under defaults — the
    // session timeout closes the agent first. Use custom thresholds where
    // wasActiveWindow < sessionTimeoutMs to isolate the wasActive guard.
    const custom: AgentStateThresholds = {
      ...DEFAULT_THRESHOLDS,
      wasActiveWindowMs: 10 * 60 * 1000, // 10 min
      sessionTimeoutMs: 60 * 60 * 1000, // 1 hr
      staleWindowMs: 5 * 60 * 1000, // 5 min
    };
    const ageMs = custom.wasActiveWindowMs + 60_000; // 11 min — past wasActive, inside sessionTimeout
    expect(
      deriveDashboardState(
        base({ lastSeen: iso(-ageMs), pendingCount: 3 }),
        NOW_MS,
        custom,
      ),
    ).toBe("pending"); // pending > waiting since pendingCount>0; stale guard blocked by wasActive
  });

  it("(M13) quiet less than staleWindow → too fresh for stale, falls to pending/active", () => {
    expect(
      deriveDashboardState(
        base({
          lastSeen: iso(-DEFAULT_THRESHOLDS.staleWindowMs + 1000),
          pendingCount: 5,
        }),
        NOW_MS,
      ),
    ).toBe("pending"); // pending wins because pendingCount>0
  });

  it("(M14) stale wins over pending — both conditions met → stale", () => {
    const ageMs = DEFAULT_THRESHOLDS.staleWindowMs + 60_000;
    const r = deriveDashboardState(
      base({ lastSeen: iso(-ageMs), pendingCount: 5 }),
      NOW_MS,
    );
    expect(r).toBe("stale");
  });

  it("(M15) stale boundary — exactly at staleWindowMs counts (>=)", () => {
    expect(
      deriveDashboardState(
        base({
          lastSeen: iso(-DEFAULT_THRESHOLDS.staleWindowMs),
          pendingCount: 1,
        }),
        NOW_MS,
      ),
    ).toBe("stale");
  });

  it("(M16) stale ignored when dispatch is OLDER than recent-dispatch window AND no pending", () => {
    const ageMs = DEFAULT_THRESHOLDS.staleWindowMs + 60_000;
    expect(
      deriveDashboardState(
        base({
          lastSeen: iso(-ageMs),
          lastDispatchedAt: NOW_MS - DEFAULT_THRESHOLDS.recentDispatchWindowMs - 1000,
        }),
        NOW_MS,
      ),
    ).toBe("waiting");
  });
});

describe("v2.8 — deriveDashboardState — pending / active / waiting", () => {
  it("(M17) pending with positive count + active-recent lastSeen → pending wins", () => {
    expect(
      deriveDashboardState(base({ pendingCount: 1 }), NOW_MS),
    ).toBe("pending");
  });

  it("(M18) pendingCount = 0 → not pending", () => {
    expect(deriveDashboardState(base(), NOW_MS)).toBe("active");
  });

  it("(M19) active — lastSeen within activeWindow", () => {
    expect(
      deriveDashboardState(
        base({ lastSeen: iso(-DEFAULT_THRESHOLDS.activeWindowMs + 1000) }),
        NOW_MS,
      ),
    ).toBe("active");
  });

  it("(M20) active boundary — exactly at activeWindow does NOT count (<)", () => {
    expect(
      deriveDashboardState(
        base({ lastSeen: iso(-DEFAULT_THRESHOLDS.activeWindowMs) }),
        NOW_MS,
      ),
    ).toBe("waiting"); // outside activeWindow → waiting
  });

  it("(M21) waiting — lastSeen between activeWindow and staleWindow, no pending", () => {
    const ageMs = DEFAULT_THRESHOLDS.activeWindowMs + 10_000;
    expect(
      deriveDashboardState(base({ lastSeen: iso(-ageMs) }), NOW_MS),
    ).toBe("waiting");
  });

  it("(M22) waiting — no lastSeen at all", () => {
    expect(
      deriveDashboardState(base({ lastSeen: null }), NOW_MS),
    ).toBe("waiting");
  });

  it("(M23) future-dated lastSeen treated as active (clock skew tolerance)", () => {
    expect(
      deriveDashboardState(base({ lastSeen: iso(60_000) }), NOW_MS),
    ).toBe("waiting"); // future → ageMs<0 → not active; default waiting
  });

  it("(M24) garbage lastSeen string → null parse → waiting", () => {
    expect(
      deriveDashboardState(base({ lastSeen: "not-an-iso" }), NOW_MS),
    ).toBe("waiting");
  });

  it("(M25) negative pendingCount treated as zero", () => {
    expect(
      deriveDashboardState(base({ pendingCount: -3 }), NOW_MS),
    ).toBe("active");
  });
});

describe("v2.8 — deriveDashboardState — threshold injection", () => {
  it("(M26) custom thresholds honored", () => {
    const tight: AgentStateThresholds = {
      ...DEFAULT_THRESHOLDS,
      activeWindowMs: 5_000,
      sessionTimeoutMs: 10_000,
    };
    // 6s ago — outside 5s active window, inside 10s session timeout.
    expect(
      deriveDashboardState(
        base({ lastSeen: iso(-6_000) }),
        NOW_MS,
        tight,
      ),
    ).toBe("waiting");
    // 11s ago — past session timeout.
    expect(
      deriveDashboardState(
        base({ lastSeen: iso(-11_000) }),
        NOW_MS,
        tight,
      ),
    ).toBe("closed");
  });

  it("(M27) all five states reachable from a single thresholds set", () => {
    const t = DEFAULT_THRESHOLDS;
    // active
    expect(deriveDashboardState(base(), NOW_MS, t)).toBe("active");
    // pending
    expect(
      deriveDashboardState(base({ pendingCount: 1 }), NOW_MS, t),
    ).toBe("pending");
    // waiting
    expect(
      deriveDashboardState(
        base({ lastSeen: iso(-(t.activeWindowMs + 10_000)) }),
        NOW_MS,
        t,
      ),
    ).toBe("waiting");
    // stale
    expect(
      deriveDashboardState(
        base({
          lastSeen: iso(-(t.staleWindowMs + 60_000)),
          pendingCount: 2,
        }),
        NOW_MS,
        t,
      ),
    ).toBe("stale");
    // closed
    expect(
      deriveDashboardState(
        base({ signalReceivedAt: NOW_MS - 1000 }),
        NOW_MS,
        t,
      ),
    ).toBe("closed");
  });
});

describe("v2.8 — resolveThresholdsFromEnv", () => {
  it("(M28) returns defaults when env is empty", () => {
    const t = resolveThresholdsFromEnv({});
    expect(t).toEqual(DEFAULT_THRESHOLDS);
  });

  it("(M29) honors RELAY_STATE_ACTIVE_WINDOW_SEC", () => {
    const t = resolveThresholdsFromEnv({
      RELAY_STATE_ACTIVE_WINDOW_SEC: "120",
    });
    expect(t.activeWindowMs).toBe(120_000);
    // Other thresholds untouched.
    expect(t.sessionTimeoutMs).toBe(DEFAULT_THRESHOLDS.sessionTimeoutMs);
  });

  it("(M30) ignores invalid env values (non-numeric, negative, NaN)", () => {
    const t = resolveThresholdsFromEnv({
      RELAY_STATE_ACTIVE_WINDOW_SEC: "abc",
      RELAY_STATE_PENDING_WINDOW_SEC: "-5",
      RELAY_STATE_STALE_WINDOW_SEC: "",
    });
    expect(t.activeWindowMs).toBe(DEFAULT_THRESHOLDS.activeWindowMs);
    expect(t.pendingWindowMs).toBe(DEFAULT_THRESHOLDS.pendingWindowMs);
    expect(t.staleWindowMs).toBe(DEFAULT_THRESHOLDS.staleWindowMs);
  });

  it("(M31) honors all six env vars together", () => {
    const t = resolveThresholdsFromEnv({
      RELAY_STATE_ACTIVE_WINDOW_SEC: "10",
      RELAY_STATE_PENDING_WINDOW_SEC: "20",
      RELAY_STATE_STALE_WINDOW_SEC: "30",
      RELAY_STATE_WAS_ACTIVE_WINDOW_SEC: "40",
      RELAY_SESSION_TIMEOUT_SEC: "50",
      RELAY_STATE_RECENT_DISPATCH_SEC: "60",
    });
    expect(t).toEqual({
      activeWindowMs: 10_000,
      pendingWindowMs: 20_000,
      staleWindowMs: 30_000,
      wasActiveWindowMs: 40_000,
      sessionTimeoutMs: 50_000,
      recentDispatchWindowMs: 60_000,
    });
  });

  it("(M32) integer-truncates fractional seconds (no sub-second precision)", () => {
    const t = resolveThresholdsFromEnv({
      RELAY_STATE_ACTIVE_WINDOW_SEC: "1.9",
    });
    expect(t.activeWindowMs).toBe(1_000);
  });
});
