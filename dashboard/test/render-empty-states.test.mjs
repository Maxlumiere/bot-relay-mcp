// bot-relay-mcp Kanban board (Vercel) — empty states must not claim what the board cannot know.
// Run: npm test   (from the dashboard/ directory)
//
// Measured on the live board (2026-09-15 16:40 SGT): with no snapshot, the banner said
// "Waiting for the first snapshot" while the PENDING ON A HUMAN lane said "Nothing is
// blocked on a human right now". Silence presented as health, on the lane Maxime trusts
// most. An empty-state all-clear is only true when a FRESH, VALID snapshot carries an
// EMPTY list. Waiting, stale, rejected, or a snapshot without the list → Unknown.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderBoard } from "../lib/render.js";

const NOW = Date.parse("2026-09-15T08:40:00.000Z");
const PENDING_ALL_CLEAR = "Nothing is blocked on a human right now";
const AGENTS_ALL_CLEAR = "No agents registered right now";

function snapshotAt(receivedAt, overrides = {}) {
  return {
    received_at: receivedAt,
    snapshot: {
      schema: "kanban.v1",
      generated_at: receivedAt,
      agents: [],
      pending_on_human: [],
      task_detail_available: false,
      note: "",
      ...overrides,
    },
  };
}

// The lane's own section: from its heading to the next section, so a banner or CSS
// string can never satisfy (or break) an assertion about the lane.
function lane(html, heading) {
  const start = html.indexOf(`<h2>${heading}</h2>`);
  assert.ok(start >= 0, `lane "${heading}" is rendered`);
  const rest = html.slice(start + heading.length + 9);
  const end = rest.search(/<h2>|<section class="note">|<footer>/);
  return end >= 0 ? rest.slice(0, end) : rest;
}

const FRESH = "2026-09-15T08:39:40.000Z"; // 20s old → banner "ok"
const STALE = "2026-09-15T08:00:00.000Z"; // 40min old → banner "stale"

// --- harm: every state where the board cannot know the lane is empty ---

test("no snapshot: the pending lane says Unknown, never the all-clear", () => {
  const pending = lane(renderBoard({ latest: null, lastRejection: null, nowMs: NOW }), "Pending on a human");
  assert.ok(!pending.includes(PENDING_ALL_CLEAR), "no all-clear without a snapshot");
  assert.match(pending, /Unknown/);
  assert.match(pending, /no snapshot/i);
});

test("stale snapshot with an empty list: Unknown, never the all-clear", () => {
  const html = renderBoard({ latest: snapshotAt(STALE), lastRejection: null, nowMs: NOW });
  const pending = lane(html, "Pending on a human");
  assert.ok(!pending.includes(PENDING_ALL_CLEAR), "a stale empty list is not a current all-clear");
  assert.match(pending, /Unknown/);
});

test("rejected push (newer than the last good snapshot): Unknown, never the all-clear", () => {
  const html = renderBoard({
    latest: snapshotAt(FRESH),
    lastRejection: { at: "2026-09-15T08:39:55.000Z", reason: "signature mismatch" },
    nowMs: NOW,
  });
  const pending = lane(html, "Pending on a human");
  assert.ok(!pending.includes(PENDING_ALL_CLEAR), "a board frozen by a rejection cannot claim all-clear");
  assert.match(pending, /Unknown/);
});

test("fresh snapshot WITHOUT a pending_on_human list: Unknown, never the all-clear", () => {
  const latest = snapshotAt(FRESH);
  delete latest.snapshot.pending_on_human;
  const pending = lane(renderBoard({ latest, lastRejection: null, nowMs: NOW }), "Pending on a human");
  assert.ok(!pending.includes(PENDING_ALL_CLEAR), "a missing list is not an empty list");
  assert.match(pending, /Unknown/);
});

test("fresh snapshot whose pending_on_human is not an array: Unknown, never the all-clear", () => {
  const pending = lane(
    renderBoard({ latest: snapshotAt(FRESH, { pending_on_human: { items: [] } }), lastRejection: null, nowMs: NOW }),
    "Pending on a human",
  );
  assert.ok(!pending.includes(PENDING_ALL_CLEAR));
  assert.match(pending, /Unknown/);
});

// --- sweep: the agents lane had the same pattern ("right now" from an old or partial snapshot) ---

test("stale snapshot with no agents: the agents lane does not claim none are registered right now", () => {
  const agents = lane(renderBoard({ latest: snapshotAt(STALE), lastRejection: null, nowMs: NOW }), "Agents");
  assert.ok(!agents.includes(AGENTS_ALL_CLEAR));
  assert.match(agents, /Unknown/);
});

test("rejected push with no agents: the agents lane does not claim none are registered right now", () => {
  const agents = lane(
    renderBoard({
      latest: snapshotAt(FRESH),
      lastRejection: { at: "2026-09-15T08:39:55.000Z", reason: "signature mismatch" },
      nowMs: NOW,
    }),
    "Agents",
  );
  assert.ok(!agents.includes(AGENTS_ALL_CLEAR));
  assert.match(agents, /Unknown/);
});

test("fresh snapshot WITHOUT an agents list: the agents lane says Unknown", () => {
  const latest = snapshotAt(FRESH);
  delete latest.snapshot.agents;
  const agents = lane(renderBoard({ latest, lastRejection: null, nowMs: NOW }), "Agents");
  assert.ok(!agents.includes(AGENTS_ALL_CLEAR), "a missing list is not an empty list");
  assert.match(agents, /Unknown/);
});

// --- innocent twins: what the board DOES know must still be said plainly ---

test("fresh valid snapshot with an EMPTY pending list: the all-clear is shown", () => {
  const pending = lane(renderBoard({ latest: snapshotAt(FRESH), lastRejection: null, nowMs: NOW }), "Pending on a human");
  assert.ok(pending.includes(PENDING_ALL_CLEAR));
  assert.ok(!/Unknown/.test(pending));
});

test("fresh valid snapshot with no agents: 'No agents registered right now' is shown", () => {
  const agents = lane(renderBoard({ latest: snapshotAt(FRESH), lastRejection: null, nowMs: NOW }), "Agents");
  assert.ok(agents.includes(AGENTS_ALL_CLEAR));
  assert.ok(!/Unknown/.test(agents));
});

test("stale snapshot WITH pending items: the items are still shown (the last good data is not hidden)", () => {
  const latest = snapshotAt(STALE, {
    pending_on_human: [
      { to_agent: "maxime", from_agent: "victra", disposition: "obligation",
        content_preview: "approve the deploy", created_at: "2026-09-15T07:00:00.000Z", deadline: null, overdue: false },
    ],
  });
  const pending = lane(renderBoard({ latest, lastRejection: null, nowMs: NOW }), "Pending on a human");
  assert.ok(pending.includes("approve the deploy"));
  assert.ok(!pending.includes(PENDING_ALL_CLEAR));
});

test("no snapshot: the agents lane keeps its true empty state", () => {
  const agents = lane(renderBoard({ latest: null, lastRejection: null, nowMs: NOW }), "Agents");
  assert.ok(!agents.includes(AGENTS_ALL_CLEAR));
  assert.match(agents, /No snapshot yet/);
});
