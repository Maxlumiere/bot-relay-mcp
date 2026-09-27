// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0046 sharpening for #284 — EVERY mailbox surface reports the same canonical
 * pending count (ADR-0045 R1: the #53 predicate, no window), one behavioural test
 * per surface.
 *
 * Fixture (one agent, on its current session): a fresh undelivered message; an
 * unresolved message a PRIOR session read 3 days ago (it re-pends, and a 24h window
 * would hide it); a resolved one; one this session already drained. Canonical
 * pending = 2, computed here independently from pendingForSessionClause.
 *
 * standup carries NO pending count (windowed traffic statistics only, i.e.
 * history); the last test pins that, so a pending figure cannot appear there
 * without this file being updated.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const DIR = path.join(os.tmpdir(), "bot-relay-adr0046-surfaces-" + process.pid);
process.env.RELAY_DB_PATH = path.join(DIR, "relay.db");
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;

const db = await import("../src/db.js");
const { handleGetMessages, handleGetMessagesSummary } = await import("../src/tools/messaging.js");
const { handlePeekInboxVersion } = await import("../src/tools/peek-inbox-version.js");
const { handleGetStandup } = await import("../src/tools/standup.js");
const { readResource } = await import("../src/mcp-resources.js");
const { inboxUriFor } = await import("../src/mcp-subscriptions.js");
const { GetMessagesSchema, GetMessagesSummarySchema } = await import("../src/types.js");

const R = "a46-surfaces";
const text = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);
const resource = (uri: string) => {
  const r = readResource(uri) as { text?: string; contents?: Array<{ text: string }> };
  return JSON.parse(r.text ?? r.contents?.[0]?.text ?? "{}");
};

function canonical(): number {
  const d = db.getDb();
  const s = (d.prepare("SELECT session_id FROM agents WHERE name = ?").get(R) as { session_id: string | null }).session_id;
  const pc = db.pendingForSessionClause(s ?? "");
  return (d.prepare(`SELECT COUNT(*) AS c FROM messages WHERE to_agent = ? AND ${pc.sql}`).get(R, ...pc.params) as { c: number }).c;
}

beforeAll(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
  db.registerAgent("a46-s-sender", "s", []);
  db.registerAgent(R, "r", []);
  const S = (db.getDb().prepare("SELECT session_id FROM agents WHERE name = ?").get(R) as { session_id: string }).session_id;
  const send = (c: string) => db.sendMessage("a46-s-sender", R, c, "normal").id;
  send("fresh undelivered");
  const prior = send("read by a prior session, 3 days ago");
  const resolved = send("resolved");
  const mine = send("read by this session");
  const d = db.getDb();
  d.prepare("UPDATE messages SET created_at = ?, read_by_session = 'prior', status = 'read' WHERE id = ?").run(
    new Date(Date.now() - 3 * 86_400_000).toISOString(),
    prior,
  );
  db.resolveMessages(R, [resolved]);
  d.prepare("UPDATE messages SET read_by_session = ?, status = 'read' WHERE id = ?").run(S, mine);
});
afterAll(() => {
  db.closeDb();
  fs.rmSync(DIR, { recursive: true, force: true });
});

describe("ADR-0046 — every mailbox surface reports the canonical pending count", () => {
  it("PRECONDITION: the canonical count is 2", () => {
    expect(canonical()).toBe(2);
  });

  it("get_messages: total_pending is canonical, with no window and with a 1h window", () => {
    const all = text(handleGetMessages(GetMessagesSchema.parse({ agent_name: R, status: "pending", peek: true }) as never));
    expect(all.total_pending).toBe(canonical());
    const win = text(handleGetMessages(GetMessagesSchema.parse({ agent_name: R, status: "pending", peek: true, since: "1h" }) as never));
    expect(win.total_pending).toBe(canonical());
    expect(win.hidden_by_since).toBe(1);
  });

  it("get_messages_summary: total_pending is canonical, with no window and with a 1h window", () => {
    const all = text(handleGetMessagesSummary(GetMessagesSummarySchema.parse({ agent_name: R, status: "pending" }) as never));
    expect(all.total_pending).toBe(canonical());
    const win = text(handleGetMessagesSummary(GetMessagesSummarySchema.parse({ agent_name: R, status: "pending", since: "1h" }) as never));
    expect(win.total_pending).toBe(canonical());
  });

  it("peek_inbox_version: total_unread_count (the wake signal) is canonical", () => {
    expect(text(handlePeekInboxVersion({ agent_name: R } as never)).total_unread_count).toBe(canonical());
  });

  it("relay://inbox/<agent>: pending_count is canonical", () => {
    expect(resource(inboxUriFor(R)).pending_count).toBe(canonical());
  });

  it("the dashboard snapshot: pending_count (the display count) is canonical", () => {
    const row = db.getDashboardAgentSnapshots(60_000).find((r) => r.name === R)!;
    expect(row.pending_count).toBe(canonical());
  });

  it("the board summary: pending_count and unread_count are canonical", () => {
    const row = db.getInboxSummary().find((r) => r.agent_name === R)!;
    expect(row.pending_count).toBe(canonical());
    expect(row.unread_count).toBe(canonical());
  });

  it("relay://current-state: the agent's pending_count is canonical", () => {
    const agents = resource("relay://current-state").agents as Array<{ name: string; pending_count: number }>;
    expect(agents.find((a) => a.name === R)!.pending_count).toBe(canonical());
  });

  it("standup carries NO pending count (windowed traffic statistics only)", () => {
    const s = JSON.stringify(text(handleGetStandup({ since: "1h" } as never)));
    expect(s).not.toMatch(/"(total_)?pending(_count)?"\s*:/);
  });
});
