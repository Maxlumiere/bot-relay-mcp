// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0045 — the action queue is never windowed by default, and a window that
 * hides pending mail says so.
 *
 *   R1 canonical pending = the #53 predicate with NO window.
 *   R2 get_messages(status='pending') defaults to since='all'; history reads
 *      (all / history / read / resolved) keep the 24h default. The description
 *      states the status-dependent default.
 *   R3 total_pending is ALWAYS the canonical unwindowed count, and when a window
 *      hides pending mail the response carries hidden_by_since: N (replacing the
 *      narrow-window hint).
 *   R5 drift guard: any internal pending read that passes `since` surfaces
 *      hidden_by_since (tests/adr-0045-hidden-by-since-guard.test.ts).
 *
 * The harm: unresolved mail that a PRIOR session read more than 24h ago re-pends
 * (#53), but get_messages' 24h default window never returned it and the count
 * dropped it too, so it vanished with no count and no hint. Unfinished work that
 * silently leaves the queue.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const DIR = path.join(os.tmpdir(), "bot-relay-adr0045-" + process.pid);
process.env.RELAY_DB_PATH = path.join(DIR, "relay.db");
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const db = await import("../src/db.js");
const { handleGetMessages, handleGetMessagesSummary } = await import("../src/tools/messaging.js");
const { GetMessagesSchema, GetMessagesSummarySchema } = await import("../src/types.js");

const R = "a45-rcpt";
const THREE_DAYS_AGO = new Date(Date.now() - 3 * 86_400_000).toISOString();

function cleanup() {
  db.closeDb();
  fs.rmSync(DIR, { recursive: true, force: true });
}
beforeEach(() => cleanup());
afterEach(() => cleanup());

/** One aged message a PRIOR session read (re-pends; the 24h window hides it) + one fresh undelivered. */
function seed(): { aged: string; fresh: string } {
  db.registerAgent("a45-sender", "s", []);
  db.registerAgent(R, "r", []);
  const aged = db.sendMessage("a45-sender", R, "aged, read by a prior session, never resolved", "normal").id;
  const fresh = db.sendMessage("a45-sender", R, "fresh", "normal").id;
  db.getDb()
    .prepare("UPDATE messages SET created_at = ?, read_by_session = 'prior-session', status = 'read' WHERE id = ?")
    .run(THREE_DAYS_AGO, aged);
  return { aged, fresh };
}

function get(args: Record<string, unknown>) {
  const input = GetMessagesSchema.parse({ agent_name: R, limit: 100, peek: true, ...args });
  return JSON.parse(handleGetMessages(input as never).content[0].text);
}
function summary(args: Record<string, unknown>) {
  const input = GetMessagesSummarySchema.parse({ agent_name: R, limit: 100, ...args });
  return JSON.parse(handleGetMessagesSummary(input as never).content[0].text);
}
const ids = (r: { messages?: Array<{ id: string }>; summaries?: Array<{ id: string }> }) =>
  (r.messages ?? r.summaries ?? []).map((m) => m.id).sort();

describe("ADR-0045 R2 — pending defaults to NO window; history keeps 24h", () => {
  it("HARM: get_messages(pending) with no `since` returns the aged re-pended message", () => {
    const { aged, fresh } = seed();
    const r = get({ status: "pending" });
    expect(ids(r)).toEqual([aged, fresh].sort());
    expect(r.since, "the response states the window it applied").toBe("all");
    expect(r.since_bound).toBeNull();
  });

  it("get_messages_summary(pending) with no `since` agrees with the drain", () => {
    const { aged, fresh } = seed();
    expect(ids(summary({ status: "pending" }))).toEqual([aged, fresh].sort());
  });

  it("INNOCENT TWIN: a HISTORY read with no `since` keeps the 24h default", () => {
    const { aged, fresh } = seed();
    const r = get({ status: "all" });
    expect(ids(r)).toEqual([fresh]);
    expect(r.since).toBe("24h");
    expect(r.since_bound).not.toBeNull();
    expect(ids(summary({ status: "all" }))).toEqual([fresh]);
    void aged;
  });

  it("an explicit `since` is still honoured on pending", () => {
    const { fresh } = seed();
    expect(ids(get({ status: "pending", since: "1h" }))).toEqual([fresh]);
  });

  it("the since description states the status-dependent default", () => {
    for (const schema of [GetMessagesSchema, GetMessagesSummarySchema]) {
      const d = (schema.shape.since as { description?: string }).description ?? "";
      expect(d).toMatch(/pending[^.]*'all'/i);
      expect(d).toMatch(/'24h'/);
    }
  });
});

describe("ADR-0045 R3 — total_pending is unwindowed; a hiding window says hidden_by_since", () => {
  it("HARM: since='1h' hides the aged message → total_pending 2, hidden_by_since 1", () => {
    seed();
    const r = get({ status: "pending", since: "1h" });
    expect(r.count).toBe(1);
    expect(r.total_pending, "the canonical, unwindowed count").toBe(2);
    expect(r.hidden_by_since).toBe(1);
  });

  it("the summary surfaces hidden_by_since too", () => {
    seed();
    const r = summary({ status: "pending", since: "1h" });
    expect(r.count).toBe(1);
    expect(r.hidden_by_since).toBe(1);
  });

  it("a window that hides nothing carries no hidden_by_since", () => {
    seed();
    const r = get({ status: "pending" });
    expect(r.total_pending).toBe(2);
    expect(r).not.toHaveProperty("hidden_by_since");
  });

  it("the narrow-window hint is replaced: zero returned under a window that hides mail → hidden_by_since, no hint", () => {
    const { fresh } = seed();
    db.resolveMessages(R, [fresh]);
    const r = get({ status: "pending", since: "1h" });
    expect(r.count).toBe(0);
    expect(r.hidden_by_since).toBe(1);
    expect(r).not.toHaveProperty("hint");
  });

  it("the LIMIT signal is unchanged: has_more still means the page was truncated", () => {
    seed();
    const input = GetMessagesSchema.parse({ agent_name: R, limit: 1, peek: true, status: "pending" });
    const r = JSON.parse(handleGetMessages(input as never).content[0].text);
    expect(r.count).toBe(1);
    expect(r.has_more).toBe(true);
    expect(r.total_pending).toBe(2);
  });
});

describe("ADR-0045 — release note", () => {
  it("the CHANGELOG tells existing callers that received-but-never-acked mail resurfaces once, and one ack clears it", () => {
    const top = fs.readFileSync(path.join(REPO, "CHANGELOG.md"), "utf-8").split(/\n## /)[1] ?? "";
    expect(top).toMatch(/resurface/i);
    expect(top).toMatch(/one ack/i);
  });
});
