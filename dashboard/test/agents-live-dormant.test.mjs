// bot-relay-mcp Kanban board — LIVE / DORMANT grouping of the agents lane.
// SPDX-License-Identifier: MIT
//
// THE COMPLAINT THIS FIXES (victra, measured): 32 agents on the board, all
// rendered as one undifferentiated grid, so rows that have been gone since
// August read exactly as current as the ones working now.
//
// WHAT IT GROUPS ON, AND WHY NOT THE OBVIOUS THING. The first spec said LIVE =
// "seen in the last 7 days". That is a `last_seen`-AGE rule, and src/types.ts
// records that v2.19.0 REMOVED exactly that rule because it LIED: presence is
// derived from the liveness VERDICT, and "last_seen is pure telemetry ... a live
// agent NEVER reads offline". Building the age rule would have reintroduced a
// known-false signal on the surface Maxime trusts most — the same false-all-clear
// class as the empty-lane defect fixed in #274. So the grouping keys on the
// VERDICT-DERIVED status the snapshot already carries:
//
//     status "online"            -> LIVE
//     status "offline"/"unknown" -> DORMANT
//
// That choice also settles a privacy question rather than raising one: the board
// push may carry "name, derived status and a needs-resume flag" (ADR-0036 §4),
// because folder paths and titles are internal content and the July audit's top
// finding was that class. Grouping on the EXISTING status means no new field, no
// additive-key question under §8a D10, and NO per-agent timestamp leaving the
// machine. The conservative option and the correct one are the same option.
//
// NOTHING IS HIDDEN OR DROPPED. Every agent still renders; DORMANT is separated
// and carries its COUNT, so the board still mirrors the relay exactly — it just
// stops making 32 rows look equally current when only a few are.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderBoard } from "../lib/render.js";

const NOW = Date.parse("2026-09-17T10:00:00.000Z");
const FRESH = new Date(NOW - 5_000).toISOString();

/** A snapshot whose banner will read "ok", so empty-state logic is not in play. */
function boardWith(agents) {
  return renderBoard({
    latest: { received_at: FRESH, snapshot: { agents, pending_on_human: [] } },
    lastRejection: null,
    nowMs: NOW,
  });
}

/**
 * THE AGENTS LANE ONLY. Every assertion in this file scopes through here.
 *
 * WHY, and it is not tidiness: the stylesheet is INLINED into the page, and this
 * feature's own CSS contains both words — a comment reading "LIVE / DORMANT lane
 * headings", plus the classes `.lane-dormant` / `.grid-dormant`. A document-wide
 * match therefore anchors on the STYLESHEET instead of the lane.
 *
 * That broke this file in BOTH directions at once:
 *   - the two ABSENCE bars FAILED (`doesNotMatch(html, /DORMANT/i)` matched
 *     `.lane-dormant` in the CSS) on a renderer that was behaving correctly, and
 *   - several PRESENCE bars PASSED off the CSS comment whether or not grouping
 *     worked at all — green for a reason unrelated to their names.
 *
 * Fixing only the two visible failures would have left the silent ones green and
 * meaningless. Scoping is what makes every bar here mean what it says.
 */
function agentsLane(html) {
  const start = html.indexOf("<h2>Agents</h2>");
  const end = html.indexOf("<h2>Pending on a human</h2>");
  // Fail LOUDLY if the lane cannot be located: a markup change must break this
  // helper, never silently hand back an empty slice that satisfies every
  // absence assertion in the file.
  assert.ok(start !== -1, "could not locate the agents lane heading — markup changed?");
  assert.ok(end > start, "could not locate the lane end (pending heading) — markup changed?");
  return html.slice(start, end);
}

const online = (name) => ({ name, role: "builder", status: "online", agent_status: "idle", cli_profile: null, terminal_title_ref: null, class: "unclassified" });
const offline = (name) => ({ name, role: "builder", status: "offline", agent_status: "offline", cli_profile: null, terminal_title_ref: null, class: "unclassified" });
const unknown = (name) => ({ name, role: "builder", status: "unknown", agent_status: "unknown", cli_profile: null, terminal_title_ref: null, class: "unclassified" });

describe("board — agents lane groups LIVE before DORMANT", () => {
  it("renders a LIVE section and a DORMANT section", () => {
    const lane = agentsLane(boardWith([online("alpha"), offline("beta")]));
    assert.match(lane, /\bLIVE\b/);
    assert.match(lane, /DORMANT/i);
  });

  it("LIVE comes FIRST — the point is that current rows are read first", () => {
    const lane = agentsLane(boardWith([offline("beta"), online("alpha")]));
    assert.ok(lane.search(/\bLIVE\b/) < lane.search(/DORMANT/i), "LIVE section must precede DORMANT");
  });

  it("DORMANT carries its COUNT, so nothing looks quietly missing", () => {
    const lane = agentsLane(boardWith([online("alpha"), offline("b1"), offline("b2"), unknown("b3")]));
    // The count sits in a nested element, so the window between the word and the
    // number spans a tag boundary — an earlier `[^<]*` form could not match it
    // and failed on a renderer that was emitting the count correctly.
    //
    // Still a REAL bar: bounded to ~80 chars, so it cannot be satisfied by an
    // unrelated "3" elsewhere in the lane. Loosening it to "a 3 appears
    // somewhere" would pass on any snapshot containing three of anything.
    assert.match(lane, /DORMANT[\s\S]{0,80}?\b3\b/i, "the dormant count (3) must be visible beside the heading");
    // And the LIVE count too, so the pair cannot drift apart.
    assert.match(lane, /\bLIVE\b[\s\S]{0,80}?\b1\b/i, "the live count (1) must be visible beside the heading");
  });

  it("NOTHING IS DROPPED: every agent still appears somewhere", () => {
    const names = ["alpha", "beta", "gamma", "delta"];
    const lane = agentsLane(boardWith([online("alpha"), offline("beta"), unknown("gamma"), online("delta")]));
    for (const n of names) assert.match(lane, new RegExp(n), `${n} must still render`);
  });

  it("'unknown' is DORMANT, not LIVE — unknown is not a claim of presence", () => {
    const lane = agentsLane(boardWith([unknown("ghost")]));
    const live = lane.search(/\bLIVE\b/);
    const dormant = lane.search(/DORMANT/i);
    const ghost = lane.indexOf("ghost");
    assert.ok(dormant !== -1 && ghost > dormant, "an unknown-status agent belongs in DORMANT");
    assert.ok(live === -1 || ghost > live, "ghost must not sit in the LIVE section");
  });

  // THESE TWO WENT FROM VACUOUS TO WRONG WITHOUT EVER BEING CORRECT — recorded
  // because it is the most useful thing this file taught. Before the feature they
  // asserted the absence of strings nothing emitted, so they held trivially.
  // After it, they matched the feature's own INLINED CSS and failed on a correct
  // renderer. Neither state ever tested the lane. Scoped, they finally do.
  it("an all-LIVE fleet does not print an empty DORMANT section", () => {
    const lane = agentsLane(boardWith([online("alpha"), online("beta")]));
    assert.doesNotMatch(lane, /DORMANT/i, "no dormant agents means no dormant section");
  });

  it("an all-DORMANT fleet still renders them, and does not claim anything is live", () => {
    const lane = agentsLane(boardWith([offline("beta"), unknown("gamma")]));
    assert.match(lane, /beta/);
    assert.match(lane, /gamma/);
    assert.doesNotMatch(lane, /\bLIVE\b/, "no live agents means no live section");
  });

  it("the empty-lane behaviour from #274 is UNCHANGED (no all-clear without a fresh snapshot)", () => {
    // Regression guard: grouping must not reintroduce the false all-clear.
    const html = renderBoard({
      latest: { received_at: "not-a-date", snapshot: { agents: [], pending_on_human: [] } },
      lastRejection: null,
      nowMs: NOW,
    });
    assert.doesNotMatch(html, /No agents registered right now/);
    assert.match(html, /Unknown/);
  });
});
