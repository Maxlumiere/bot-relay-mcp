// bot-relay-mcp — Tether for VSCode
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT

/**
 * v0.2.1 P1 — ReconnectSupervisor unit tests (T-2 classifier + T-3 supervisor).
 *
 * Pure logic: a fake timer harness + a spy connect + a real RestartPolicy
 * (neverGiveUp) on an injected fake clock. No vscode, no real wall-clock
 * timers. Per feedback_test_asserts_contract_not_proxy: the classifier
 * assertions pin the EXACT strings the MCP SDK emits, and the regression
 * tests assert the load-bearing contract (a recoverable error MUST schedule
 * a reconnect, and the loop MUST re-arm indefinitely) so reverting to the
 * v0.2.0 dead-end fails here loud.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ReconnectSupervisor,
  classifyTransportError,
  type ReconnectSupervisorDeps,
} from "./reconnect-supervisor.js";
import { RestartPolicy } from "./restart-policy.js";

class FakeClock {
  private t: number;
  constructor(start = 1_000_000) {
    this.t = start;
  }
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

/** Controllable timer harness — scheduled callbacks fire only when we say. */
class FakeTimers {
  private seq = 0;
  pending = new Map<number, { fn: () => void; ms: number }>();
  setTimer = (fn: () => void, ms: number): number => {
    const id = ++this.seq;
    this.pending.set(id, { fn, ms });
    return id;
  };
  clearTimer = (id: unknown): void => {
    this.pending.delete(id as number);
  };
  get count(): number {
    return this.pending.size;
  }
  lastMs(): number | undefined {
    const vals = [...this.pending.values()];
    return vals.length ? vals[vals.length - 1]!.ms : undefined;
  }
  /** Fire the single oldest pending timer (asserts there is exactly one when expected). */
  fireNext(): void {
    const firstKey = [...this.pending.keys()][0];
    if (firstKey === undefined) throw new Error("no pending timer to fire");
    const entry = this.pending.get(firstKey)!;
    this.pending.delete(firstKey);
    entry.fn();
  }
}

/** Drain the microtask queue so the async fire()/connect() chain settles. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// T-2 — error classifier
// ---------------------------------------------------------------------------

describe("classifyTransportError (T-2)", () => {
  it("(C1) the SDK dead-session 404 string is recoverable", () => {
    // streamableHttp.js: _startOrAuthSse → "Failed to open SSE stream: Not Found"
    expect(classifyTransportError("transport error: Failed to open SSE stream: Not Found")).toBe(
      "recoverable",
    );
  });

  it("(C2) the SDK give-up string is recoverable", () => {
    // streamableHttp.js:143 — "Maximum reconnection attempts (N) exceeded."
    expect(
      classifyTransportError("transport error: Maximum reconnection attempts (3) exceeded."),
    ).toBe("recoverable");
  });

  it("(C3) an SSE stream disconnect is recoverable", () => {
    expect(classifyTransportError("transport error: SSE stream disconnected: Error: socket hang up")).toBe(
      "recoverable",
    );
  });

  it("(C4) a refused/failed connection to a down daemon is recoverable", () => {
    expect(classifyTransportError("transport error: fetch failed (ECONNREFUSED 127.0.0.1:3777)")).toBe(
      "recoverable",
    );
  });

  it("(C5) auth failures (401/403/Unauthorized/Forbidden) are unrecoverable", () => {
    expect(classifyTransportError("transport error: HTTP 401 Unauthorized")).toBe("unrecoverable");
    expect(classifyTransportError("transport error: 403 Forbidden")).toBe("unrecoverable");
    expect(classifyTransportError("Unauthorized: bad token")).toBe("unrecoverable");
  });
});

// ---------------------------------------------------------------------------
// T-3 — supervisor behavior
// ---------------------------------------------------------------------------

describe("ReconnectSupervisor (T-3)", () => {
  let clock: FakeClock;
  let timers: FakeTimers;
  let connect: ReturnType<typeof vi.fn>;
  let onReconnecting: ReturnType<typeof vi.fn>;
  let onReconnected: ReturnType<typeof vi.fn>;
  let onUnrecoverable: ReturnType<typeof vi.fn>;
  let sup: ReconnectSupervisor;

  function build(connectImpl: () => Promise<boolean>): ReconnectSupervisor {
    connect = vi.fn(connectImpl);
    onReconnecting = vi.fn();
    onReconnected = vi.fn();
    onUnrecoverable = vi.fn();
    const deps: ReconnectSupervisorDeps = {
      policy: new RestartPolicy({ neverGiveUp: true, now: clock.now }),
      connect: connect as unknown as () => Promise<boolean>,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      log: () => {},
      onReconnecting,
      onReconnected,
      onUnrecoverable,
    };
    return new ReconnectSupervisor(deps);
  }

  beforeEach(() => {
    clock = new FakeClock();
    timers = new FakeTimers();
  });

  it("(S1) a recoverable error schedules a reconnect at the first backoff delay, without connecting synchronously", () => {
    sup = build(async () => true);
    sup.handleError("transport error: Failed to open SSE stream: Not Found");
    expect(timers.count).toBe(1);
    expect(timers.lastMs()).toBe(1000); // RestartPolicy attempt 1
    expect(onReconnecting).toHaveBeenCalledWith(1, 1000);
    expect(connect).not.toHaveBeenCalled(); // fires on the timer, not inline
  });

  it("(S2) firing the timer connects once; a healthy result resets backoff + clears the reconnecting UI", async () => {
    sup = build(async () => true);
    sup.handleError("transport error: Not Found");
    timers.fireNext();
    await flush();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(onReconnected).toHaveBeenCalledTimes(1);
    // backoff reset → the NEXT failure schedules attempt 1 (1000) again, not 2000.
    sup.handleError("transport error: Not Found");
    expect(timers.lastMs()).toBe(1000);
  });

  it("(S3) REGRESSION — an unhealthy result re-arms indefinitely with growing backoff (never gives up)", async () => {
    sup = build(async () => false); // daemon stays down
    sup.handleError("transport error: Not Found");
    const want = [1000, 2000, 4000, 8000, 16000, 30000, 30000]; // curve then 30s clamp
    for (let i = 0; i < want.length; i += 1) {
      expect(timers.count, `attempt ${i + 1} should be scheduled`).toBe(1);
      expect(timers.lastMs(), `attempt ${i + 1} delay`).toBe(want[i]);
      clock.advance(want[i]! + 1);
      timers.fireNext();
      await flush();
    }
    // 30+ consecutive failures and still scheduling — no permanent give-up.
    for (let i = 0; i < 25; i += 1) {
      clock.advance(31_000);
      timers.fireNext();
      await flush();
    }
    expect(timers.count).toBe(1);
    expect(timers.lastMs()).toBe(30000);
    expect(onReconnected).not.toHaveBeenCalled();
  });

  it("(S4) single-flight — two rapid recoverable errors schedule only one reconnect", () => {
    sup = build(async () => true);
    sup.handleError("transport error: Not Found");
    sup.handleError("transport error: Maximum reconnection attempts (3) exceeded.");
    expect(timers.count).toBe(1);
    expect(onReconnecting).toHaveBeenCalledTimes(1);
  });

  it("(S5) an unrecoverable error paints the dead-end and schedules NOTHING", () => {
    sup = build(async () => true);
    sup.handleError("transport error: 401 Unauthorized");
    expect(onUnrecoverable).toHaveBeenCalledTimes(1);
    expect(timers.count).toBe(0);
    expect(onReconnecting).not.toHaveBeenCalled();
  });

  it("(S6) dispose cancels the pending timer and a late fire is a no-op", async () => {
    sup = build(async () => true);
    sup.handleError("transport error: Not Found");
    expect(timers.count).toBe(1);
    sup.dispose();
    expect(timers.count).toBe(0); // clearTimer was called
  });

  it("(S7) generation guard — a fire superseded by cancel() does not connect", async () => {
    // Hold the timer ref before cancel so we can fire it post-cancel.
    sup = build(async () => true);
    sup.handleError("transport error: Not Found");
    const stale = [...timers.pending.values()][0]!;
    sup.cancel(); // bumps generation + clears pending
    stale.fn(); // simulate the already-scheduled callback firing late
    await flush();
    expect(connect).not.toHaveBeenCalled();
  });

  it("(S8) manual reconnect resets the backoff curve", async () => {
    sup = build(async () => false);
    sup.handleError("transport error: Not Found"); // attempt 1 → 1000
    clock.advance(1001);
    timers.fireNext();
    await flush(); // unhealthy → attempt 2 scheduled at 2000
    expect(timers.lastMs()).toBe(2000);
    sup.notifyManualReconnect(); // operator forces fresh attempt → reset
    sup.handleError("transport error: Not Found");
    expect(timers.lastMs()).toBe(1000); // back to attempt 1
  });
});
