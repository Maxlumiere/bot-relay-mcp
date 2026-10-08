// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The pool-loaded control's OCCUPANCY instrument (tests/pr-b-failed-auth.test.ts), and its own known-bad, the
 * lapse demo. Here so the demo's sizing can be tested on its own, with simulated compares, without a daemon.
 */
import { performance } from "perf_hooks";

/**
 * A pool-loaded control round is VALID only when its pool work ran inside its window: every design compare in it,
 * and a compare in flight for at least this fraction of it. Otherwise the control was not loaded, and the round is
 * an INSTRUMENT FAULT (never a bar verdict). The lapse demo (a forced idle mid-pool) must read at most LAPSE_MAX_BUSY.
 */
export const OCCUPANCY_FLOOR = 0.8;
/** The lapse demo's self-check: it must read at least this far BELOW the floor, or the known-bad never lapsed. */
export const LAPSE_MAX_BUSY = OCCUPANCY_FLOOR - 0.1;

/** How much of a pool-loaded control's window its pool work actually occupied. */
export interface PoolOccupancy {
  /** Compares that started and finished inside the window. */
  inWindow: number;
  /** Compares that had FINISHED when the reading was taken (inside the window or not). */
  total: number;
  /** Fraction of the window with at least one control compare in flight. */
  busy: number;
}

/**
 * The control's pool work, instrumented: `track` wraps each compare, so measure() knows when the pool was busy.
 * MEASURED on main (294fdfc, local M2): the control's window was 35-63 ms while its 12 compares finished 390-457 ms
 * after it opened; with the old window this occupancy check reads "0/0 in-window, busy 0.00" in every round. The
 * "pool-loaded" control measured an unloaded loop. The auth arm's compares run inside its requests, so its
 * window spans them; on a noisy 3-core runner the longer window alone catches more delay, which inflated the gap
 * (CI 26803c9: control per-round eld 11.5/57.7/6.7/54.8/185.2, BIMODAL by whether the pool overlapped).
 */
export type PoolWork = (track: <T>(p: () => Promise<T>) => Promise<T>) => Promise<unknown>;

/** The pool's occupancy of the window [t0, t1]: compares inside it, and the fraction with one in flight. */
export function occupancy(spans: Array<[number, number]>, t0: number, t1: number): PoolOccupancy {
  const inWindow = spans.filter(([a, b]) => a >= t0 && b <= t1).length;
  const clipped = spans.map(([a, b]) => [Math.max(a, t0), Math.min(b, t1)] as [number, number]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let busyMs = 0;
  let cur: [number, number] | null = null;
  for (const [a, b] of clipped) {
    if (cur && a <= cur[1]) cur[1] = Math.max(cur[1], b);
    else {
      if (cur) busyMs += cur[1] - cur[0];
      cur = [a, b];
    }
  }
  if (cur) busyMs += cur[1] - cur[0];
  return { inWindow, total: spans.length, busy: t1 > t0 ? busyMs / (t1 - t0) : 0 };
}

/**
 * THE LAPSE DEMO's ruled constant (architect 1850c978): the forced idle is this RATIO of the pool's own busy time
 * measured in the same call, never an absolute number of ms. The floor is a ratio, so the idle must be one too:
 * a fixed 300 ms idle read busy 0.8148 on a slow CI runner (the known-bad passed as "loaded"). 1.0 → busy ≈ 0.5.
 */
export const LAPSE_RATIO = 1.0;

/** What one lapse demo did, so a demo that failed to lapse names its own cause. */
export interface LapseStats {
  /** The pool phase (the control's own work), ms. */
  d: number;
  /** The slowest single compare in that phase, ms (queueing included: it only lengthens the idle). */
  c: number;
  /** The forced idle, ms: max(300, LAPSE_RATIO x (d + c)). */
  idle: number;
  /**
   * The compare AFTER the idle, ms. Nothing sizes the idle from it (it has not run yet), so one far slower than the
   * pool phase is what can still keep the demo from lapsing: the report names it.
   */
  last: number;
  /** The whole demo, pool start to its last compare's end (measureWindow's window), ms. */
  window: number;
}

/**
 * THE LAPSE DEMO (the occupancy check's own known-bad): `poolControl`, then a forced idle sized from that same
 * call's busy time (LAPSE_RATIO), then one more compare. The window spans the idle, so busy ≈ 1 / (1 + LAPSE_RATIO)
 * at ANY runner speed, and the check must read it as an INSTRUMENT FAULT. `stats` is filled by each run.
 */
export function lapsedPool(poolControl: PoolWork, oneCompare: () => Promise<unknown>): PoolWork & { stats: LapseStats } {
  const stats: LapseStats = { d: 0, c: 0, idle: 0, last: 0, window: 0 };
  const work: PoolWork = async (track) => {
    let c = 0;
    const timed = async <T,>(p: () => Promise<T>): Promise<T> => {
      const start = performance.now();
      try {
        return await track(p);
      } finally {
        c = Math.max(c, performance.now() - start);
      }
    };
    const t0 = performance.now();
    await poolControl(timed);
    stats.d = performance.now() - t0;
    stats.c = c;
    stats.idle = Math.max(300, LAPSE_RATIO * (stats.d + stats.c));
    await new Promise((r) => setTimeout(r, stats.idle));
    const t1 = performance.now();
    await track(oneCompare);
    stats.last = performance.now() - t1;
    stats.window = performance.now() - t0;
  };
  return Object.assign(work, { stats });
}

/** The self-check's message: what the demo did, so "did not lapse" names its own cause. */
export const lapseReport = (busy: number, s: LapseStats): string =>
  `control did not lapse: busy ${busy.toFixed(3)} (D ${s.d.toFixed(0)} ms, C ${s.c.toFixed(0)} ms, idle ${s.idle.toFixed(0)} ms, last compare ${s.last.toFixed(0)} ms, window ${s.window.toFixed(0)} ms)`;
