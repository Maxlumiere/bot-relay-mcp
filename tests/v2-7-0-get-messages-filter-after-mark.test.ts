// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.7.0 Hermes-flagged P1 regression — `since` filter must apply BEFORE
 * the mark-as-read mutation.
 *
 * Bug class (pre-fix):
 *   src/db.ts getMessages SELECTs pending rows (no since clause), marks
 *   them read for this session in the same call, returns the unfiltered
 *   set. The handler at src/tools/messaging.ts then runs a JS-layer
 *   filterBySince() on the returned rows. Net effect: a message older
 *   than the caller's `since` bound is consumed (read_by_session set)
 *   even though the caller never sees it in the response. The message
 *   never resurfaces in subsequent status='pending' calls from the same
 *   session because read_by_session != null.
 *
 * Fix:
 *   getMessages now accepts a sinceIso parameter and stitches
 *   `AND created_at >= ?` into the SELECT BEFORE the UPDATE inside the
 *   same transaction. Only rows the caller actually sees get marked
 *   read.
 *
 * This test demonstrates the exact failure mode by seeding messages,
 * doing a since-narrow get_messages call, then verifying:
 *   1. The returned set excludes the older message (correct behavior
 *      both before and after the fix).
 *   2. A subsequent status='pending' since='all' call DOES still see
 *      the older message — pre-fix it was consumed silently and would
 *      be MISSING from this second call. Post-fix it surfaces.
 *
 * Also walks status='all' (no mark) + peek=true (no mark) as no-op
 * controls so a future regression in the mark-skip branches surfaces.
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

const {
  closeDb,
  getDb,
  registerAgent,
  sendMessage,
} = await import("../src/db.js");
const { handleGetMessages } = await import("../src/tools/messaging.js");

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
}
beforeEach(() => {
  cleanup();
});
afterEach(cleanup);

/**
 * Helper: seed a message with a specific created_at timestamp. Direct
 * SQL because sendMessage uses Date.now() and we need a timestamp from
 * the deep past for the `since` filter to exclude.
 */
function seedMessageAt(
  from: string,
  to: string,
  content: string,
  createdAt: string,
  id: string,
): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO messages (id, from_agent, to_agent, content, priority, status, created_at) VALUES (?, ?, ?, ?, 'normal', 'pending', ?)"
  ).run(id, from, to, content, createdAt);
}

function parseHandlerResult(result: ReturnType<typeof handleGetMessages>): {
  count: number;
  messages: Array<{ id: string }>;
} {
  return JSON.parse(result.content[0].text);
}

describe("v2.7.0 Hermes P1 — get_messages since filter applies BEFORE mark-as-read", () => {
  it("message older than `since` bound is NOT consumed/marked-read by a since-narrow call", () => {
    registerAgent("recipient", "tester", []);
    registerAgent("sender", "tester", []);

    // Seed two messages: one 25 min ago, one 5 min ago. Both pending.
    const tNow = Date.now();
    const t25min = new Date(tNow - 25 * 60 * 1000).toISOString();
    const t5min = new Date(tNow - 5 * 60 * 1000).toISOString();
    seedMessageAt("sender", "recipient", "old-msg", t25min, "old-id-25min");
    seedMessageAt("sender", "recipient", "new-msg", t5min, "new-id-5min");

    // Caller: since='15m' (15 minutes). Expected: only the 5-min-old
    // message returned. The 25-min-old one is BEYOND the bound and
    // MUST NOT be marked-read.
    const narrow = parseHandlerResult(handleGetMessages({
      agent_name: "recipient",
      status: "pending",
      limit: 100,
      since: "15m",
    } as Parameters<typeof handleGetMessages>[0]));

    expect(narrow.count).toBe(1);
    expect(narrow.messages[0].id).toBe("new-id-5min");

    // The load-bearing assertion: a follow-up since='all' call MUST
    // still see the old message as pending. Pre-fix it was consumed
    // silently by the narrow call and would be ABSENT here.
    const broad = parseHandlerResult(handleGetMessages({
      agent_name: "recipient",
      status: "pending",
      limit: 100,
      since: "all",
    } as Parameters<typeof handleGetMessages>[0]));

    const broadIds = broad.messages.map((m) => m.id);
    expect(broadIds, "the 25-min-old message must still be pending after a since='15m' call").toContain("old-id-25min");
    expect(broad.count).toBe(1); // only old-id-25min — new-id-5min was correctly drained
  });

  it("repeat call within the same since window correctly sees the message as already-read", () => {
    registerAgent("recipient2", "tester", []);
    registerAgent("sender2", "tester", []);

    const tNow = Date.now();
    const t5min = new Date(tNow - 5 * 60 * 1000).toISOString();
    seedMessageAt("sender2", "recipient2", "new-msg", t5min, "msg-1");

    // First call drains it.
    const first = parseHandlerResult(handleGetMessages({
      agent_name: "recipient2",
      status: "pending",
      limit: 100,
      since: "15m",
    } as Parameters<typeof handleGetMessages>[0]));
    expect(first.count).toBe(1);

    // Second call with same session sees zero pending in the same window.
    const second = parseHandlerResult(handleGetMessages({
      agent_name: "recipient2",
      status: "pending",
      limit: 100,
      since: "15m",
    } as Parameters<typeof handleGetMessages>[0]));
    expect(second.count).toBe(0);
  });

  it("peek=true on a since-narrow pending call also does not mark older-than-bound rows", () => {
    registerAgent("recipient4", "tester", []);
    registerAgent("sender4", "tester", []);

    const tNow = Date.now();
    const t25min = new Date(tNow - 25 * 60 * 1000).toISOString();
    const t5min = new Date(tNow - 5 * 60 * 1000).toISOString();
    seedMessageAt("sender4", "recipient4", "old-msg", t25min, "peek-old");
    seedMessageAt("sender4", "recipient4", "new-msg", t5min, "peek-new");

    const peeked = parseHandlerResult(handleGetMessages({
      agent_name: "recipient4",
      status: "pending",
      limit: 100,
      since: "15m",
      peek: true,
    } as Parameters<typeof handleGetMessages>[0]));
    expect(peeked.count).toBe(1);
    expect(peeked.messages[0].id).toBe("peek-new");

    // Both messages are STILL pending in broad since='all' — peek means
    // no mutation. The old one was excluded by the since bound; the
    // new one was within the bound but peek skipped the mark.
    const broad = parseHandlerResult(handleGetMessages({
      agent_name: "recipient4",
      status: "pending",
      limit: 100,
      since: "all",
    } as Parameters<typeof handleGetMessages>[0]));
    expect(broad.count).toBe(2);
  });
});
