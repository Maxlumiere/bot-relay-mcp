// bot-relay-mcp — Tether for VSCode
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT

/**
 * v0.2 — RestartPolicy unit tests.
 *
 * Pure logic, fake clock. No vscode deps, no timers. Each test
 * advances a controlled `now` and asserts the decision shape +
 * delay against the contract in the v0.2 brief (backoff
 * 1s→2s→4s→8s→16s capped at 30s, 5/hr hard cap).
 *
 * Per `feedback_test_asserts_contract_not_proxy.md`: assertions
 * pin exact delayMs values (not "≤30s") and exact decision kinds
 * — drift in the curve or the cap surfaces here loud.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { RestartPolicy } from "./restart-policy.js";

class FakeClock {
  private t: number;
  constructor(start = 0) {
    this.t = start;
  }
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
  set(ms: number): void {
    this.t = ms;
  }
}

let clock: FakeClock;
let policy: RestartPolicy;

beforeEach(() => {
  clock = new FakeClock(1_000_000); // arbitrary non-zero start
  policy = new RestartPolicy({ now: clock.now });
});

describe("RestartPolicy — backoff curve", () => {
  it("(R1) attempt 1 returns the configured initial delay (default 1000 ms)", () => {
    const d = policy.recordCrash();
    expect(d.kind).toBe("restart");
    if (d.kind !== "restart") return; // narrow for TS
    expect(d.delayMs).toBe(1000);
    expect(d.attempt).toBe(1);
  });

  it("(R2) attempts 2-5 follow the documented 1→2→4→8→16 second curve", () => {
    const want = [1000, 2000, 4000, 8000, 16000];
    for (let i = 0; i < want.length; i += 1) {
      const d = policy.recordCrash();
      expect(d.kind, `attempt ${i + 1} should restart`).toBe("restart");
      if (d.kind !== "restart") return;
      expect(d.delayMs, `attempt ${i + 1} delay`).toBe(want[i]);
      expect(d.attempt).toBe(i + 1);
      // advance just past delay so the next crash is a fresh event,
      // but stay well inside the hour window.
      clock.advance(want[i]! + 1);
    }
  });

  it("(R3) custom configuration: 500ms initial × 3 backoff clamped at 4000ms", () => {
    const p = new RestartPolicy({
      now: clock.now,
      initialDelayMs: 500,
      backoffFactor: 3,
      maxDelayMs: 4000,
      maxRestartsPerWindow: 10,
    });
    // 500 → 1500 → 4000 (clamped from 4500) → 4000 → 4000
    const want = [500, 1500, 4000, 4000, 4000];
    for (let i = 0; i < want.length; i += 1) {
      const d = p.recordCrash();
      if (d.kind !== "restart") throw new Error("unexpected give_up");
      expect(d.delayMs, `custom attempt ${i + 1}`).toBe(want[i]);
      clock.advance(100); // tiny — keep all crashes inside window
    }
  });

  it("(R4) recordSuccess resets the backoff curve to attempt 1 on next crash", () => {
    policy.recordCrash(); // attempt 1 → 1000ms
    policy.recordCrash(); // attempt 2 → 2000ms
    expect(policy.getConsecutiveAttempts()).toBe(2);
    policy.recordSuccess();
    expect(policy.getConsecutiveAttempts()).toBe(0);
    const d = policy.recordCrash(); // back to attempt 1 → 1000ms
    if (d.kind !== "restart") throw new Error("unexpected give_up");
    expect(d.delayMs).toBe(1000);
    expect(d.attempt).toBe(1);
  });

  it("(R5) recordSuccess does NOT clear the hour-window crash history", () => {
    // 4 crashes, then success, then 2 more crashes — 6 crashes inside
    // the hour total. The 6th hits the 5/hr cap.
    for (let i = 0; i < 4; i += 1) {
      policy.recordCrash();
      clock.advance(100);
    }
    policy.recordSuccess();
    clock.advance(60_000);
    const fifth = policy.recordCrash();
    expect(fifth.kind).toBe("restart"); // 5th still within budget
    clock.advance(60_000);
    const sixth = policy.recordCrash();
    expect(sixth.kind).toBe("give_up");
    if (sixth.kind === "give_up") {
      expect(sixth.recentCrashes).toBe(6);
    }
  });
});

describe("RestartPolicy — rate cap", () => {
  it("(R6) sixth crash within the hour returns give_up with explanatory reason", () => {
    // 5 crashes spaced 60s apart — all within the hour window
    for (let i = 0; i < 5; i += 1) {
      const d = policy.recordCrash();
      expect(d.kind, `crash ${i + 1} should still restart`).toBe("restart");
      clock.advance(60_000);
    }
    const sixth = policy.recordCrash();
    expect(sixth.kind).toBe("give_up");
    if (sixth.kind === "give_up") {
      expect(sixth.reason).toMatch(/5 restarts/);
      expect(sixth.reason).toMatch(/60 minute/);
      expect(sixth.recentCrashes).toBe(6);
    }
  });

  it("(R7) crashes that age out of the rolling window do NOT count toward the cap", () => {
    // 4 crashes at t0, then a quiet 59min59s window, then 2 more crashes.
    // Original 4 crashes age out only AFTER t0 + windowMs (60min). At
    // t0 + 59min59s the rolling-hour count is 4. Add a 5th here → 5,
    // restart OK. Advance another 30s (past t0+60min) → first 4 age
    // out, leaving only the 5th from minute 59. Add a 6th → count is
    // 2 (5th + 6th), restart OK.
    for (let i = 0; i < 4; i += 1) {
      policy.recordCrash();
      clock.advance(100);
    }
    clock.advance(59 * 60 * 1000); // jump 59min after the last of the 4
    const fifth = policy.recordCrash();
    expect(fifth.kind).toBe("restart");
    expect(policy.getRecentCrashCount()).toBe(5);

    clock.advance(2 * 60 * 1000); // 2 more min → past the t0+60min boundary
    const sixth = policy.recordCrash();
    expect(sixth.kind, "6th crash after aging should restart, not give up").toBe("restart");
    expect(policy.getRecentCrashCount()).toBe(2);
  });

  it("(R8) custom maxRestartsPerWindow honored", () => {
    const p = new RestartPolicy({
      now: clock.now,
      maxRestartsPerWindow: 2,
      windowMs: 60_000,
    });
    expect(p.recordCrash().kind).toBe("restart");
    clock.advance(1000);
    expect(p.recordCrash().kind).toBe("restart");
    clock.advance(1000);
    const third = p.recordCrash();
    expect(third.kind).toBe("give_up");
  });

  it("(R9) custom windowMs honored — short window ages crashes out fast", () => {
    const p = new RestartPolicy({
      now: clock.now,
      maxRestartsPerWindow: 2,
      windowMs: 5000, // 5 second window
    });
    expect(p.recordCrash().kind).toBe("restart");
    expect(p.recordCrash().kind).toBe("restart");
    expect(p.recordCrash().kind).toBe("give_up");
    clock.advance(6000); // window expired
    expect(p.recordCrash().kind, "after window aged out, restart again allowed").toBe("restart");
  });
});

describe("RestartPolicy — construction guards", () => {
  it("(R10) rejects non-positive max restarts", () => {
    expect(() => new RestartPolicy({ maxRestartsPerWindow: 0 })).toThrow(/>= 1/);
    expect(() => new RestartPolicy({ maxRestartsPerWindow: -1 })).toThrow(/>= 1/);
  });

  it("(R11) rejects non-positive window", () => {
    expect(() => new RestartPolicy({ windowMs: 0 })).toThrow(/> 0/);
    expect(() => new RestartPolicy({ windowMs: -1 })).toThrow(/> 0/);
  });

  it("(R12) rejects negative initial delay", () => {
    expect(() => new RestartPolicy({ initialDelayMs: -1 })).toThrow(/>= 0/);
  });

  it("(R13) rejects maxDelay < initialDelay (would clamp upward, nonsense)", () => {
    expect(
      () => new RestartPolicy({ initialDelayMs: 1000, maxDelayMs: 500 }),
    ).toThrow(/>= initialDelayMs/);
  });

  it("(R14) rejects backoff factor < 1 (would shrink, nonsense)", () => {
    expect(() => new RestartPolicy({ backoffFactor: 0.5 })).toThrow(/>= 1/);
  });
});

describe("RestartPolicy — introspection", () => {
  it("(R15) getRecentCrashCount trims expired entries on read", () => {
    policy.recordCrash();
    clock.advance(60_000);
    expect(policy.getRecentCrashCount()).toBe(1);
    clock.advance(60 * 60 * 1000); // past hour
    expect(policy.getRecentCrashCount()).toBe(0);
  });

  it("(R16) getConsecutiveAttempts reflects consecutive crashes ignoring window", () => {
    policy.recordCrash();
    policy.recordCrash();
    policy.recordCrash();
    expect(policy.getConsecutiveAttempts()).toBe(3);
    clock.advance(2 * 60 * 60 * 1000); // 2 hours — window ages out
    expect(policy.getRecentCrashCount()).toBe(0);
    // consecutive counter unchanged — it only resets on success
    expect(policy.getConsecutiveAttempts()).toBe(3);
  });
});
