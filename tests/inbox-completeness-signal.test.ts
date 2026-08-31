// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

// #inbox-subset (victra seq 961, 2026-08-31) — get_messages(pending) returns a
// priority-ordered, LIMIT-capped subset whose response was INDISTINGUISHABLE from a
// complete one. The defect is NOT the limit (a defensible design choice); it is that
// `count: messages.length` carried no has_more / total_pending signal, so the WAKE SIGNAL
// and the DRAIN COUNTED DIFFERENT SETS: peekMailboxVersion counts all pending-for-session
// mail (what the notification fires on) while a single drain returns the 20 highest-PRIORITY,
// silently dropping a newer-but-lower-priority message.
//
// The first describe REPRODUCES the raw divergence at the db layer (still true by design —
// the drain is priority+LIMIT capped). The FIX describe is the regression bar: the pending
// RESPONSE now carries has_more + total_pending, so it is structurally unable to claim a
// completeness it does not have. RED-first: these fail if the response fields are removed.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-subset-" + process.pid);
process.env.RELAY_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;

const { registerAgent, sendMessage, getMessages, peekMailboxVersion, getDb, closeDb } = await import("../src/db.js");
const { handleGetMessages } = await import("../src/tools/messaging.js");

function drainResponse(agent: string, status = "pending", limit = 20, since = "all"): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = handleGetMessages({ agent_name: agent, status, limit, since } as any);
  return JSON.parse((res.content[0] as { text: string }).text);
}

function cleanup(): void {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
}
beforeEach(cleanup);
afterEach(cleanup);

describe("REPRO defect #1 — the wake signal and the drain count DIFFERENT SETS", () => {
  it("a busy inbox: peek counts 21, a single drain returns 20, and the newest (lower-priority) message the wake fired for is ABSENT", () => {
    registerAgent("busy", "r", []);
    registerAgent("sender", "s", []);
    // 20 normal-priority messages, then the NEWEST at LOW priority — the one a fresh
    // wake fires for. Priority ordering (normal=2 < low=3) sorts it last; LIMIT 20 drops it.
    for (let i = 0; i < 20; i++) sendMessage("sender", "busy", `normal ${i}`, "normal");
    const newest = sendMessage("sender", "busy", "NEWEST — low priority — the wake fired for this", "low");

    const unread = peekMailboxVersion("busy").total_unread_count;
    const drained = getMessages("busy", "pending", 20 /* default */, /*peek*/ false, /*since*/ null);

    expect(unread, "the wake/notification counts ALL pending-for-session mail").toBe(21);
    expect(drained.length, "but a single drain is capped at the LIMIT").toBe(20);
    expect(
      drained.some((m) => m.id === newest.id),
      "the newest, lower-priority message — the one the wake fired for — is ABSENT from the drain",
    ).toBe(false);
    // And nothing about the drain's own shape signals the gap: count === drained.length,
    // with no has_more / total_pending. unread(21) > count(20), invisibly. THAT is the defect.
    expect(unread).toBeGreaterThan(drained.length);
  });

  it("CONTROL: with <= LIMIT pending, the drain returns everything and there is no gap", () => {
    registerAgent("quiet", "r", []);
    registerAgent("sender", "s", []);
    sendMessage("sender", "quiet", "only one", "normal");
    const unread = peekMailboxVersion("quiet").total_unread_count;
    const drained = getMessages("quiet", "pending", 20, false, null);
    expect(unread).toBe(1);
    expect(drained.length).toBe(1);
  });
});

// A real property worth guarding: the db getMessages layer delivers EVERY un-drained message
// across polls and never silently drops the newest. (This began as a control for a second
// "lost the older" observation that was later retracted — the reporter's own direct-SQLite
// `ORDER BY created_at DESC LIMIT 1` had asked for a single row — but the property stands.)
describe("the db layer delivers every un-drained message across polls (no silent loss)", () => {
  it("2 messages, newest is NOT absent from a default-limit drain", () => {
    registerAgent("pair", "r", []);
    registerAgent("sender", "s", []);
    const older = sendMessage("sender", "pair", "older", "normal");
    const newer = sendMessage("sender", "pair", "newer", "normal");
    const drained = getMessages("pair", "pending", 20, false, null);
    expect(drained.some((m) => m.id === older.id)).toBe(true);
    expect(
      drained.some((m) => m.id === newer.id),
      "the newest is present with few pending — #1b is NOT the db-layer priority/LIMIT path",
    ).toBe(true);
  });

  it("two arrived between polls: a limit-1 drain takes one, the older survives to the next drain (db layer does not lose it)", () => {
    registerAgent("poller", "r", []);
    registerAgent("sender", "s", []);
    const older = sendMessage("sender", "poller", "15:12 older", "normal");
    const newer = sendMessage("sender", "poller", "15:37 newer", "high"); // higher priority sorts first
    const first = getMessages("poller", "pending", 1, false, null);
    expect(first.length).toBe(1);
    expect(first[0].id, "limit 1 returns the higher-priority message first").toBe(newer.id);
    const second = getMessages("poller", "pending", 20, false, null);
    expect(
      second.some((m) => m.id === older.id),
      "the older un-drained message is still delivered on the next poll — the db layer does NOT silently lose it",
    ).toBe(true);
  });
});

// THE FIX (#1a): the drain RESPONSE is structurally unable to claim a completeness it does
// not have — has_more is ALWAYS present, and total_pending equals the wake's count. These
// FAIL without the fix (the fields do not exist), so they are the regression bar.
describe("FIX #1a — the drain response cannot look complete when it is a subset", () => {
  it("the wake count and the drain: response says count=20, has_more=true, total_pending=21", () => {
    registerAgent("busy2", "r", []);
    registerAgent("sender", "s", []);
    for (let i = 0; i < 20; i++) sendMessage("sender", "busy2", `n${i}`, "normal");
    sendMessage("sender", "busy2", "newest low", "low");
    const r = drainResponse("busy2", "pending", 20, "all");
    expect(r.count, "the drain returned the 20 highest-priority").toBe(20);
    expect(r.has_more, "has_more must be present and TRUE when the drain truncated").toBe(true);
    expect(
      r.total_pending,
      "total_pending must equal the wake's total_unread_count (21) — same set, no divergence",
    ).toBe(21);
    // sanity: the drain's total_pending agrees with the wake signal's own count on a fresh peek
    // (both derive from pendingForSessionClause; the count is pre-drain).
  });

  it("a small-limit poll announces there is more: a limit-1 drain of a 2-message inbox reports has_more=true, total_pending=2", () => {
    // A caller who deliberately reads a slice (small limit) is now TOLD another message waits,
    // rather than believing one row is the whole inbox — the same completeness signal, at the
    // other end of the limit range from the busy-inbox case above.
    registerAgent("orch", "r", []);
    registerAgent("sender", "s", []);
    sendMessage("sender", "orch", "15:12 older", "normal");
    sendMessage("sender", "orch", "15:37 newer", "high");
    const r = drainResponse("orch", "pending", 1, "all");
    expect(r.count).toBe(1);
    expect(r.has_more, "a limit-1 poll must announce there is more").toBe(true);
    expect(r.total_pending).toBe(2);
  });

  it("has_more is ALWAYS present, even when nothing is truncated (absence made impossible)", () => {
    registerAgent("quiet2", "r", []);
    registerAgent("sender", "s", []);
    sendMessage("sender", "quiet2", "one", "normal");
    const r = drainResponse("quiet2", "pending", 20, "all");
    expect(Object.prototype.hasOwnProperty.call(r, "has_more"), "the field exists on every pending response").toBe(true);
    expect(r.has_more).toBe(false);
    expect(r.total_pending).toBe(1);
  });
});
