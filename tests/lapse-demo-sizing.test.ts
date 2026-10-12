// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The occupancy instrument's own known-bad (the lapse demo) must LAPSE on every runner speed.
 *
 * THE DEFECT (CI, #316's macOS run): the lapse demo read busy 0.8148 against the 0.8 floor, so the instrument's
 * negative control passed as "loaded". The demo forced a FIXED 300 ms idle against a RATIO floor: its busy is
 * (D + C) / (D + C + 300), with D the pool phase and C one compare, so a runner slow enough that D + C > 1200 ms
 * cannot lapse. MEASURED locally with the real bcrypt pool: D 388-461 ms, C 69-95 ms, busy 0.61-0.65, the formula
 * exact to 3 decimals; 0.8148 means D + C was about 1320 ms on that runner (inferred, not measured there).
 *
 * THE SEAM: compares are SIMULATED (a timer of `c` ms, no CPU), so a slow runner is reproduced without inducing
 * load. The pool shape is the design's: SCAN_BURST chains side by side, each comparing the 4 rows one after another.
 */
import { describe, it, expect } from "vitest";
import { performance } from "perf_hooks";
import { LAPSE_MAX_BUSY, OCCUPANCY_FLOOR, lapseReport, lapsedPool, occupancy, type PoolOccupancy, type PoolWork } from "./_helpers/pool-occupancy.js";

const SCAN_BURST = 3; // src/auth-throttle.ts (the design constant the real control uses)
const ROWS = 4;

const simulatedCompare = (c: number) => () => new Promise<boolean>((r) => setTimeout(() => r(false), c));
const poolControl = (c: number): PoolWork => (track) =>
  Promise.all(
    Array.from({ length: SCAN_BURST }, async () => {
      for (let i = 0; i < ROWS; i++) await track(simulatedCompare(c));
    }),
  );

/** One window, as measureWindow opens and closes it: from the pool's start to the end of its work. */
async function busyOf(work: PoolWork): Promise<PoolOccupancy> {
  const spans: Array<[number, number]> = [];
  const track = async <T,>(p: () => Promise<T>): Promise<T> => {
    const start = performance.now();
    try {
      return await p();
    } finally {
      spans.push([start, performance.now()]);
    }
  };
  const t0 = performance.now();
  await work(track);
  const t1 = performance.now();
  return occupancy(spans, t0, t1);
}

// 20 ms: a fast host; 90 ms: the M2 measured above; 300 and 600 ms: runners 3x and 6x slower than it.
const SPEEDS = [20, 90, 300, 600];

describe("the lapse demo lapses at every runner speed (architect ruling 1850c978)", () => {
  for (const c of SPEEDS) {
    it(`a ${c} ms compare: the lapse demo reads busy <= ${LAPSE_MAX_BUSY} (floor ${OCCUPANCY_FLOOR} minus its margin)`, async () => {
      const lapsed = lapsedPool(poolControl(c), simulatedCompare(c));
      const reading = await busyOf(lapsed);
      expect(reading.busy, lapseReport(reading, lapsed.stats)).toBeLessThanOrEqual(LAPSE_MAX_BUSY);
    }, 20_000);

    it(`TWIN, a ${c} ms compare: the same pool work WITHOUT the lapse reads busy >= the floor (still accepted as loaded)`, async () => {
      const { busy } = await busyOf(poolControl(c));
      expect(busy).toBeGreaterThanOrEqual(OCCUPANCY_FLOOR);
    }, 20_000);
  }
});

describe("the lapse report names the window the occupancy was computed over (Codex #320 P3)", () => {
  it("a measured window LONGER than the demo (requests outlasted it): the report's window is t1 - t0, not the demo's run", async () => {
    const lapsed = lapsedPool(poolControl(20), simulatedCompare(20));
    const spans: Array<[number, number]> = [];
    const t0 = performance.now();
    await lapsed(async (p) => {
      const start = performance.now();
      try {
        return await p();
      } finally {
        spans.push([start, performance.now()]);
      }
    });
    const t1 = performance.now() + 5_000; // the window closed 5 s after the demo ended
    const reading = occupancy(spans, t0, t1);
    expect(reading.window).toBe(t1 - t0);
    expect(lapseReport(reading, lapsed.stats)).toContain(`window ${(t1 - t0).toFixed(0)} ms`);
    expect(lapseReport(reading, lapsed.stats)).toContain(`demo ${lapsed.stats.demo.toFixed(0)} ms`);
  });
});
