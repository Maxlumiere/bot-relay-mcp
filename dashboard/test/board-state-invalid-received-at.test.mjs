// bot-relay-mcp Kanban board — regression: an unparseable receipt time is not freshness.
// SPDX-License-Identifier: MIT
//
// FOUND BY AUDIT (codex-5-5, PR #274 round 1, reproduced at 86c8cb7):
//   latest = { received_at: "not-a-date", snapshot: { agents: [], pending_on_human: [] } }
// rendered banner data-level="ok" and the text "Nothing is blocked on a human
// right now" — a false ALL-CLEAR reached through the TIMESTAMP rather than the
// empty list. That is the same defect #274 exists to kill, entering by the one
// door the PR's own tests did not watch.
//
// THE MECHANISM, worth stating because it is not obvious:
//   Date.parse("not-a-date")        -> NaN
//   Math.max(0, nowMs - NaN)        -> NaN   (NOT 0 — Math.max propagates NaN)
//   NaN > staleMs                   -> false (every comparison with NaN is false)
// so the `stale` branch was SKIPPED and control fell through to `ok`. Invalid
// input produced a FRESHER verdict than a genuinely old snapshot.
//
// The rule being pinned: an unparseable receipt time cannot prove a snapshot
// fresh. Never `ok`. This file pins BOTH layers — computeBanner (the source) and
// renderBoard (what a human actually sees) — because fixing only the banner
// would leave the next consumer of `level` free to reintroduce the all-clear.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeBanner } from "../lib/board-state.js";
import { renderBoard } from "../lib/render.js";

const NOW = Date.parse("2026-09-16T10:00:00.000Z");
const EMPTY_SNAPSHOT = { agents: [], pending_on_human: [] };

/** Every shape whose parsed time is not a finite number. */
const NON_FINITE_RECEIVED_AT = [
  ["a non-date string", "not-a-date"],
  ["an empty-ish string", "   "],
  ["a truncated ISO fragment", "2026-13-45T99:99:99Z"],
  ["a number", 1758016800000],
  ["a boolean", true],
  ["an object", {}],
  ["an array", []],
  ["null", null],
  ["NaN itself", NaN],
];

describe("#274 regression — an unparseable received_at is never 'ok'", () => {
  for (const [label, value] of NON_FINITE_RECEIVED_AT) {
    it(`computeBanner refuses to call ${label} fresh`, () => {
      const banner = computeBanner({
        latest: { received_at: value, snapshot: EMPTY_SNAPSHOT },
        lastRejection: null,
        nowMs: NOW,
      });
      assert.notEqual(banner.level, "ok", `level was "${banner.level}" for received_at=${JSON.stringify(value)}`);
      // ageMs must not escape as NaN either — a NaN age is the same defect
      // wearing a different hat, and fmtAge would render it as "NaNs".
      if ("ageMs" in banner) {
        assert.ok(Number.isFinite(banner.ageMs), `ageMs escaped as ${banner.ageMs}`);
      }
    });

    it(`renderBoard shows no all-clear for ${label}`, () => {
      const html = renderBoard({
        latest: { received_at: value, snapshot: EMPTY_SNAPSHOT },
        lastRejection: null,
        nowMs: NOW,
      });
      assert.doesNotMatch(html, /Nothing is blocked on a human right now/);
      assert.doesNotMatch(html, /data-level="ok"/);
      assert.match(html, /Unknown/);
    });
  }

  it("a MISSING received_at is still 'waiting' (the pre-existing guard, unbroken)", () => {
    const banner = computeBanner({
      latest: { snapshot: EMPTY_SNAPSHOT },
      lastRejection: null,
      nowMs: NOW,
    });
    assert.equal(banner.level, "waiting");
  });

  it("the INNOCENT TWIN: a valid, recent received_at still reads 'ok'", () => {
    // Without this, the fix could be 'always return waiting' and every test above
    // would still pass. This is the bar that keeps the refusal honest.
    const banner = computeBanner({
      latest: { received_at: new Date(NOW - 5_000).toISOString(), snapshot: EMPTY_SNAPSHOT },
      lastRejection: null,
      nowMs: NOW,
    });
    assert.equal(banner.level, "ok");
    assert.ok(Number.isFinite(banner.ageMs));
  });

  it("the OTHER innocent twin: a valid but OLD received_at still reads 'stale'", () => {
    const banner = computeBanner({
      latest: { received_at: new Date(NOW - 10 * 60_000).toISOString(), snapshot: EMPTY_SNAPSHOT },
      lastRejection: null,
      nowMs: NOW,
    });
    assert.equal(banner.level, "stale");
  });
});
