// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.7.0 external-review-flagged P1 — `get_messages`: ONLY ROWS THE CALLER
 * ACTUALLY SEES GET MARKED READ.
 *
 * Provenance (external review, 2026-05-11 — "filter-after-mark silent data loss"):
 *   Bug class (pre-fix): getMessages SELECTed pending rows (no since clause),
 *   marked them read for this session in the same call, and returned the
 *   unfiltered set; src/tools/messaging.ts then ran a JS-layer filterBySince()
 *   on the returned rows. Net effect: a message older than the caller's `since`
 *   bound was CONSUMED (read_by_session set) even though the caller never saw it
 *   in the response — it never resurfaced.
 *   Fix: getMessages stitches the `since` predicate INTO the SELECT, BEFORE the
 *   mark-as-read UPDATE, inside the same transaction. "Only rows the caller
 *   actually sees get marked read."
 *
 * THE PROPERTY IS ABOUT WHERE THE FILTER RUNS, NOT WHICH ROWS IT ADMITS. The bug
 * was a filter applied in the JS layer AFTER the SQL had already marked rows read;
 * the fix moved the filter into the SELECT before the UPDATE, in one transaction.
 * #198 changes the PREDICATE inside that SELECT (the pending drain now also admits
 * never-observed mail older than the window — undelivered mail is not history) and
 * leaves that ORDERING exactly as this P1 established it. So #198 cannot reintroduce
 * the P1 bug class by construction: there is no JS-layer post-filter to resurrect,
 * and every row the predicate admits is both returned AND marked, together. That
 * sentence is checkable against src/db.ts getMessages, not a reassurance.
 *
 * MECHANISM CHANGED IN #198, PROPERTY DID NOT. The pre-#198 test demonstrated the
 * property INDIRECTLY — an old message was excluded by a narrow window and had to
 * resurface later. Under #198 that message is DELIVERED instead of deferred, so the
 * "resurfaces later" evidence is gone. This test therefore asserts the invariant
 * DIRECTLY and window-independently: after a consuming drain, the set of messages
 * newly marked read equals the set the call returned — nothing marked that was not
 * handed over. (The old header's assertion #1, "the returned set excludes the older
 * message," was scenario SETUP for the indirect proof, never the invariant; its
 * deletion is not a weakening of the P1.)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v270-filter-after-mark-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;

const { closeDb, getDb, registerAgent } = await import("../src/db.js");
const { handleGetMessages } = await import("../src/tools/messaging.js");

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
}
beforeEach(cleanup);
afterEach(cleanup);

/** Seed a message with an explicit created_at (deep past) so `since` can trim it. */
function seedMessageAt(from: string, to: string, content: string, createdAt: string, id: string): void {
  getDb()
    .prepare(
      "INSERT INTO messages (id, from_agent, to_agent, content, priority, status, created_at) VALUES (?, ?, ?, ?, 'normal', 'pending', ?)"
    )
    .run(id, from, to, content, createdAt);
}

function parseHandlerResult(result: ReturnType<typeof handleGetMessages>): { count: number; messages: Array<{ id: string }> } {
  return JSON.parse(result.content[0].text);
}

/**
 * Drain for `agent` and AUDIT the invariant directly. Returns the set of ids the
 * call returned and the set of ids that TRANSITIONED to read-by-this-session as a
 * result of the call (read_by_session was not this session before, is after).
 * The P1 invariant is: these two sets are equal for a consuming drain, and the
 * "newly marked" set is empty for a peek. Window-independent by construction.
 */
function drainAndAudit(agent: string, sinceIso: string, peek = false): { returned: string[]; newlyMarked: string[] } {
  const db = getDb();
  const session = (db.prepare("SELECT session_id FROM agents WHERE name = ?").get(agent) as { session_id: string | null }).session_id;
  const readBefore = new Map<string, string | null>();
  for (const r of db.prepare("SELECT id, read_by_session FROM messages WHERE to_agent = ?").all(agent) as Array<{ id: string; read_by_session: string | null }>) {
    readBefore.set(r.id, r.read_by_session);
  }
  const returned = parseHandlerResult(
    handleGetMessages({ agent_name: agent, status: "pending", limit: 100, since: sinceIso, peek } as Parameters<typeof handleGetMessages>[0])
  ).messages.map((m) => m.id);
  const newlyMarked: string[] = [];
  for (const r of db.prepare("SELECT id, read_by_session FROM messages WHERE to_agent = ?").all(agent) as Array<{ id: string; read_by_session: string | null }>) {
    if (readBefore.get(r.id) !== session && r.read_by_session === session) newlyMarked.push(r.id);
  }
  return { returned: returned.sort(), newlyMarked: newlyMarked.sort() };
}

describe("v2.7.0 externally-flagged P1 — only rows the caller sees get marked read", () => {
  it("INVARIANT (direct): after a consuming since-narrow drain, newly-marked-read == returned — nothing marked that was not handed over", () => {
    registerAgent("recipient", "tester", []);
    registerAgent("sender", "tester", []);
    const db = getDb();
    const tNow = Date.now();
    const t5min = new Date(tNow - 5 * 60 * 1000).toISOString();
    const t25min = new Date(tNow - 25 * 60 * 1000).toISOString();

    // Within window, never observed → admitted by the window.
    seedMessageAt("sender", "recipient", "new", t5min, "new-5min");
    // Aged, never observed → #198 admits it (undelivered mail is not history).
    seedMessageAt("sender", "recipient", "aged-undelivered", t25min, "old-25min");
    // Aged AND already observed by another session → the window legitimately
    // trims it, so it must be NEITHER returned NOR marked. This is the exclude
    // side of the invariant: a row the window drops is not silently consumed.
    seedMessageAt("sender", "recipient", "aged-seen", t25min, "old-seen-25min");
    db.prepare("UPDATE messages SET seq = 999, read_by_session = 'other-session' WHERE id = 'old-seen-25min'").run();

    const { returned, newlyMarked } = drainAndAudit("recipient", "15m");

    // THE INVARIANT, stated directly and independent of the window:
    expect(newlyMarked).toEqual(returned);
    // ...and, concretely: the drain admitted exactly the two undelivered rows,
    // delivered the aged-undelivered one (#198), and did NOT touch the aged-seen row.
    expect(returned).toEqual(["new-5min", "old-25min"]);
    expect(returned).not.toContain("old-seen-25min");
    // The window-trimmed observed row was not marked by this call.
    const seenRow = db.prepare("SELECT read_by_session FROM messages WHERE id = 'old-seen-25min'").get() as { read_by_session: string };
    expect(seenRow.read_by_session).toBe("other-session");
  });

  it("repeat call within the same since window correctly sees the message as already-read", () => {
    registerAgent("recipient2", "tester", []);
    registerAgent("sender2", "tester", []);
    const t5min = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    seedMessageAt("sender2", "recipient2", "new-msg", t5min, "msg-1");

    const first = parseHandlerResult(handleGetMessages({ agent_name: "recipient2", status: "pending", limit: 100, since: "15m" } as Parameters<typeof handleGetMessages>[0]));
    expect(first.count).toBe(1);
    const second = parseHandlerResult(handleGetMessages({ agent_name: "recipient2", status: "pending", limit: 100, since: "15m" } as Parameters<typeof handleGetMessages>[0]));
    expect(second.count).toBe(0);
  });

  it("peek marks NOTHING regardless of what it returns (the mark-skip branch obeys the same invariant: marked ⊆ returned, here marked = ∅)", () => {
    registerAgent("recipient4", "tester", []);
    registerAgent("sender4", "tester", []);
    const tNow = Date.now();
    const t5min = new Date(tNow - 5 * 60 * 1000).toISOString();
    const t25min = new Date(tNow - 25 * 60 * 1000).toISOString();
    seedMessageAt("sender4", "recipient4", "new", t5min, "peek-new");
    seedMessageAt("sender4", "recipient4", "aged-undelivered", t25min, "peek-old");

    const { returned, newlyMarked } = drainAndAudit("recipient4", "15m", /* peek */ true);
    // #198: peek returns both the within-window and the aged-undelivered row...
    expect(returned).toEqual(["peek-new", "peek-old"]);
    // ...but a peek is observation only — it marks NOTHING.
    expect(newlyMarked).toEqual([]);

    // Confirm nothing was consumed: a normal broad drain still sees both pending.
    const broad = parseHandlerResult(handleGetMessages({ agent_name: "recipient4", status: "pending", limit: 100, since: "all" } as Parameters<typeof handleGetMessages>[0]));
    expect(broad.count).toBe(2);
  });
});
