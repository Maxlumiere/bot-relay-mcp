// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * NEGATIVE CONTROLS for the Sentinel runtime degradation predicate.
 *
 * THE POINT OF THE FILE: a guard that cannot be shown to say NO is not a guard,
 * it is a constant. The focused suites passed 83/83 while the guard was broken
 * three separate ways, because every test asserted it says YES when the path
 * works and none asserted it says NO when the path is dead.
 *
 * THREE ATTEMPTS, ALL THE SAME ERROR. Each closed a route and left the bad
 * state reachable (codex, #121):
 *   1. `!filename` counted as marker proof — one anonymous fs.watch event
 *      suppressed the degraded announcement forever.
 *   2. The proof LATCHED for the process lifetime — a marker that worked once
 *      masked a writer that died later.
 *   3. Consumed per-window, it STILL masked: a marker for message A hid an
 *      unmarked message B arriving in the same 30s window.
 *
 * All three treated "a marker fired at some point" as evidence about a
 * DIFFERENT delivery. The fix was to stop asking that question entirely, so
 * there is now no evidence flag to go stale — hence this file tests the
 * predicate that replaced it.
 *
 * WHY THE PREDICATE IS SOUND: watcher callbacks invoke check() IMMEDIATELY, so
 * a marked delivery has already moved prevUnread before the fallback tick runs.
 * An unread count that rises across the fallback's OWN check() is therefore, by
 * construction, a delivery no callback observed.
 */
import { describe, it, expect } from "vitest";
import { fallbackObservedMissedDelivery, makeFallbackTick } from "../src/cli/watch.js";

describe("the fallback poll discovering new mail IS the degradation", () => {
  it("a rise across the fallback's own check() means the marker missed it", () => {
    expect(fallbackObservedMissedDelivery(0, 1)).toBe(true);
    expect(fallbackObservedMissedDelivery(3, 9)).toBe(true);
  });

  it("no rise is NOT degradation (positive control — must not cry wolf)", () => {
    // Without this the suite would pass against a predicate hardwired to true,
    // which would announce DEGRADED on every healthy tick and train everyone
    // to ignore the warning — the same silence, achieved by noise.
    expect(fallbackObservedMissedDelivery(5, 5)).toBe(false);
  });

  it("a FALLING count is not degradation (mail was read, not delivered)", () => {
    expect(fallbackObservedMissedDelivery(9, 2)).toBe(false);
  });

  it("an unestablished baseline is never degradation", () => {
    // First observation and post-epoch-reset both null out prevUnread. Treating
    // that as a rise would announce DEGRADED on every startup.
    expect(fallbackObservedMissedDelivery(null, 4)).toBe(false);
    expect(fallbackObservedMissedDelivery(3, null)).toBe(false);
    expect(fallbackObservedMissedDelivery(null, null)).toBe(false);
  });
});

describe("DEFECT 3 — a good marker must not mask a later unmarked delivery", () => {
  it("codex's exact repro: message A marked, writer dies, message B unmarked, SAME window", () => {
    // Timeline, all inside one 30s fallback window:
    //   marker for A fires  → callback check() observes A, prevUnread 0 → 1
    //   the marker writer then DIES
    //   message B lands with NO marker      → nothing observes it
    //   fallback tick: before = 1, check() → 2
    // Under the old evidence flag, A's marker made consume() return true and
    // the announcement was suppressed. B was found by the poll, silently.
    const beforeFallbackTick = 1; // A, already observed by A's own callback
    const afterFallbackTick = 2; // B, discovered only by the poll
    expect(fallbackObservedMissedDelivery(beforeFallbackTick, afterFallbackTick)).toBe(true);
  });

  it("a healthy marker path leaves the fallback nothing to find", () => {
    // The other half of the same contract: when markers work, the callback's
    // check() has already advanced prevUnread, so the tick sees no rise and
    // stays quiet. This is what makes the predicate specific rather than a
    // permanent alarm.
    const observedByCallback = 7;
    expect(fallbackObservedMissedDelivery(observedByCallback, observedByCallback)).toBe(false);
  });

  it("repeated unmarked deliveries each announce — no state to go stale", () => {
    // The defect-2 scenario, now structurally impossible: there is no flag to
    // latch, so window after window the answer stays honest.
    for (const [before, after] of [
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
    ]) {
      expect(fallbackObservedMissedDelivery(before, after)).toBe(true);
    }
  });
});

describe("CALL SHAPE — the real fallback tick, not a re-implementation of it", () => {
  // The predicate is trivially correct; all three historical defects lived in
  // the WIRING. These controls drive makeFallbackTick — the exact closure
  // setInterval runs in production — so a wiring regression fails here instead
  // of surviving behind a green predicate suite (the #123 lesson: tests that
  // exercise the convenient shape rather than the real call shape miss the
  // real call site's bug).

  /** Codex's repro as world-state: A marked+observed, writer dies, B unmarked. */
  function codexScenario() {
    let unread = 1; // message A, already observed by its own marker callback
    let prev: number | null = 1;
    let fired = 0;
    return {
      deps: {
        readPrevUnread: () => prev,
        check: () => {
          prev = unread; // real check(): reads the DB, advances the baseline
        },
        onMissedDelivery: () => {
          fired++;
        },
      },
      deliverUnmarked: () => {
        unread += 1; // lands in the DB; no marker, so no callback observes it
      },
      fired: () => fired,
    };
  }

  it("codex's repro through the REAL tick: the unmarked delivery is announced", () => {
    const world = codexScenario();
    const tick = makeFallbackTick(world.deps);
    world.deliverUnmarked(); // message B, same window, no marker
    tick();
    expect(world.fired()).toBe(1);
  });

  it("healthy path through the REAL tick: callback observed everything → silent", () => {
    const world = codexScenario();
    const tick = makeFallbackTick(world.deps);
    tick(); // nothing new since the callback's own check()
    expect(world.fired()).toBe(0);
  });

  it("ORDER control: a tick that checks BEFORE capturing the baseline is blind forever", () => {
    // The plausible one-line refactor mistake: swap check() ahead of the
    // baseline capture. Built here deliberately to prove these controls can
    // tell the difference — the swapped tick stays silent on the exact
    // scenario the real tick announces. If someone swaps the real wiring,
    // the first test in this block fails; this one documents the failure
    // mode that makes that assertion load-bearing.
    const world = codexScenario();
    const swappedTick = (): void => {
      world.deps.check();
      const before = world.deps.readPrevUnread(); // too late — already advanced
      if (fallbackObservedMissedDelivery(before, world.deps.readPrevUnread())) {
        world.deps.onMissedDelivery();
      }
    };
    world.deliverUnmarked();
    swappedTick();
    expect(world.fired()).toBe(0); // the defect: a missed delivery, silently absorbed
  });
});
