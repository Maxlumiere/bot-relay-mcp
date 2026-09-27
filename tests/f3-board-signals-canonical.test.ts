// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * F3 (relay design review, 24 Sep) — every "is mail waiting?" signal reads the
 * CANONICAL predicate, never the legacy `status` column.
 *
 * MEASURED in the review: the stale PostToolUse hook flips `status = 'read'` on
 * every run (its sqlite fallback, `UPDATE messages SET status = 'read' WHERE id = :id
 * AND status = 'pending'`) without any drain, read_by_session or resolve. Every
 * surface that counted `status = 'pending'` therefore dropped the mail: the board
 * showed an agent as QUIET while its mail was still waiting. That is a false quiet,
 * the silence-as-failure class.
 *
 * The fixture below does exactly what that hook does, and nothing else. After it,
 * the mail is unresolved and was never drained, so every surface must still count it.
 *
 * Surfaces, each pinned:
 *   - getInboxSummary().pending_count (dashboard snapshot badge and sort; the board);
 *   - getDashboardAgentSnapshots() pendingCount (the dashboard's `pending` state);
 *   - relay://inbox/<agent> pending_count (Tether's per-agent inbox subscription);
 *   - relay://current-state per-agent pending_count.
 * The wake-coverage detector already used pendingGlobalClause (verified, and pinned
 * here too, since the review asked whether it under-reports).
 *
 * Each surface also has its innocent twin: a real MODEL drain, and a resolve, take
 * the mail off the count.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const DIR = path.join(os.tmpdir(), "bot-relay-f3-" + process.pid);
process.env.RELAY_DB_PATH = path.join(DIR, "relay.db");
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;

const db = await import("../src/db.js");
const { readResource } = await import("../src/mcp-resources.js");
const { inboxUriFor } = await import("../src/mcp-subscriptions.js");

function cleanup() {
  db.closeDb();
  fs.rmSync(DIR, { recursive: true, force: true });
}
beforeEach(() => cleanup());
afterEach(() => cleanup());

/** Exactly what hooks/post-tool-use-check.sh (pre-#273) does to a message. Nothing more. */
function staleHookFlip(id: string): void {
  db.getDb().prepare("UPDATE messages SET status = 'read' WHERE id = ? AND status = 'pending'").run(id);
}

function seed(): string {
  db.registerAgent("f3-sender", "r", []);
  db.registerAgent("f3-rec", "r", []);
  const id = db.sendMessage("f3-sender", "f3-rec", "still waiting", "normal").id;
  // Backdate so the dashboard's pending window (older-than filter) includes it.
  db.getDb().prepare("UPDATE messages SET created_at = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", id);
  return id;
}

function inboxSummary() {
  return db.getInboxSummary().find((r) => r.agent_name === "f3-rec")!;
}
function dashPending(): number {
  return db.getDashboardAgentSnapshots(60_000).find((r) => r.name === "f3-rec")!.inputs.pendingCount;
}
function inboxResource(): number {
  const r = readResource(inboxUriFor("f3-rec")) as { text?: string; contents?: Array<{ text: string }> };
  const text = r.text ?? r.contents?.[0]?.text ?? "";
  return JSON.parse(text).pending_count;
}
function currentState(): number {
  const r = readResource("relay://current-state") as { text?: string; contents?: Array<{ text: string }> };
  const text = r.text ?? r.contents?.[0]?.text ?? "";
  return (JSON.parse(text).agents as Array<{ name: string; pending_count: number }>).find((a) => a.name === "f3-rec")!
    .pending_count;
}

describe("F3 — after the stale hook flips status, the mail is STILL pending on every surface", () => {
  it("PRECONDITION: the flip really happened, and nothing else did", () => {
    const id = seed();
    staleHookFlip(id);
    const m = db.getDb().prepare("SELECT status, read_by_session, resolved_at FROM messages WHERE id = ?").get(id) as Record<string, unknown>;
    expect(m).toEqual({ status: "read", read_by_session: null, resolved_at: null });
  });

  it("getInboxSummary().pending_count (the board)", () => {
    staleHookFlip(seed());
    expect(inboxSummary().pending_count).toBe(1);
    expect(inboxSummary().unread_count).toBe(1);
  });

  it("getDashboardAgentSnapshots() pendingCount (the dashboard's pending state)", () => {
    staleHookFlip(seed());
    expect(dashPending()).toBe(1);
  });

  it("relay://inbox/<agent> pending_count (Tether's inbox subscription)", () => {
    staleHookFlip(seed());
    expect(inboxResource()).toBe(1);
  });

  it("relay://current-state per-agent pending_count", () => {
    staleHookFlip(seed());
    expect(currentState()).toBe(1);
  });

  it("the wake-coverage detector's candidate set already uses the canonical predicate (verified, pinned)", async () => {
    const { pendingGlobalClause } = db;
    const id = seed();
    staleHookFlip(id);
    const n = (db.getDb().prepare(`SELECT COUNT(*) AS c FROM messages WHERE to_agent = 'f3-rec' AND ${pendingGlobalClause().sql}`).get() as { c: number }).c;
    expect(n).toBe(1);
  });
});

describe("F3 — innocent twins: a real model drain, and a resolve, DO take the mail off", () => {
  it("after the recipient's own drain (get_messages, bound session) every surface reads 0", () => {
    seed();
    db.getMessages("f3-rec", "pending", 20);
    expect(inboxSummary().pending_count).toBe(0);
    expect(dashPending()).toBe(0);
    expect(inboxResource()).toBe(0);
    expect(currentState()).toBe(0);
  });

  it("after a resolve every surface reads 0", () => {
    const id = seed();
    db.resolveMessages("f3-rec", [id]);
    expect(inboxSummary().pending_count).toBe(0);
    expect(dashPending()).toBe(0);
    expect(inboxResource()).toBe(0);
    expect(currentState()).toBe(0);
  });
});

/**
 * Round-2 audit — the per-agent surfaces must count what THIS agent's drain would
 * return: pendingForSessionClause keyed on that agent's own agents.session_id. The
 * "never drained by ANY session" form reads 0 after a re-registration (drained by
 * session S1, the agent now on S2), while the drain re-pends the mail: a false
 * quiet in exactly the case F3 exists to fix.
 */
describe("F3 round 2 — after a re-registration, every per-agent surface counts what the drain returns", () => {
  function reRegistered(): string {
    const id = seed();
    db.getMessages("f3-rec", "pending", 20); // drained by the first session
    const before = db.getDb().prepare("SELECT session_id FROM agents WHERE name = 'f3-rec'").get() as { session_id: string };
    db.getDb().prepare("UPDATE agents SET session_id = ? WHERE name = 'f3-rec'").run("second-session-after-reregister");
    const m = db.getDb().prepare("SELECT read_by_session, resolved_at FROM messages WHERE id = ?").get(id) as Record<string, unknown>;
    expect(m, "precondition: drained by the FIRST session, unresolved").toEqual({ read_by_session: before.session_id, resolved_at: null });
    return id;
  }
  /** What the drain would return right now (peek: no mark). */
  const drainWould = () => db.getMessages("f3-rec", "pending", 100, true).length;

  it("PRECONDITION: the drain re-pends it to the new session", () => {
    reRegistered();
    expect(drainWould()).toBe(1);
  });
  it("getInboxSummary() pending_count and unread_count", () => {
    reRegistered();
    expect(inboxSummary().pending_count).toBe(drainWould());
    expect(inboxSummary().unread_count).toBe(drainWould());
  });
  it("getDashboardAgentSnapshots() pendingCount", () => {
    reRegistered();
    expect(dashPending()).toBe(1);
  });
  it("relay://current-state per-agent pending_count", () => {
    reRegistered();
    expect(currentState()).toBe(drainWould());
  });
  it("relay://inbox/<agent> (already per-session; pinned)", () => {
    reRegistered();
    expect(inboxResource()).toBe(drainWould());
  });
  it("INNOCENT TWIN: drained by the CURRENT session → 0 on every surface", () => {
    reRegistered();
    db.getMessages("f3-rec", "pending", 20);
    expect(drainWould()).toBe(0);
    expect(inboxSummary().pending_count).toBe(0);
    expect(inboxSummary().unread_count).toBe(0);
    expect(dashPending()).toBe(0);
    expect(currentState()).toBe(0);
    expect(inboxResource()).toBe(0);
  });
  it("a NULL session: every unresolved message counts, matching the drain", () => {
    seed();
    db.getMessages("f3-rec", "pending", 20);
    db.getDb().prepare("UPDATE agents SET session_id = NULL WHERE name = 'f3-rec'").run();
    expect(inboxSummary().pending_count).toBe(drainWould());
    expect(currentState()).toBe(drainWould());
    expect(dashPending()).toBe(drainWould());
  });
});

/**
 * Round-3 audit (#283) + ADR-0046: a never-drained message younger than the
 * dashboard's pendingWindowMs showed 0 while the drain returned it. The fixtures
 * above all backdate their mail, so they missed it. TWO counts, kept apart:
 *   - the DISPLAY count (the board's getInboxSummary pending_count, and the
 *     snapshot's canonical pending_count) is canonical: it equals the drain,
 *     whatever the message's age;
 *   - the snapshot's inputs.pendingCount is the AGE-FILTERED state input to
 *     deriveDashboardState ("pending = older than the window", by design), never
 *     displayed as "pending".
 */
describe("F3 round 3 — the displayed pending count does not depend on message age", () => {
  function fresh30s(): number {
    db.registerAgent("f3-sender", "r", []);
    db.registerAgent("f3-rec", "r", []);
    const id = db.sendMessage("f3-sender", "f3-rec", "arrived 30 seconds ago", "normal").id;
    db.getDb().prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 30_000).toISOString(), id);
    const drainWould = db.getMessages("f3-rec", "pending", 100, true).length;
    expect(drainWould, "precondition: the drain returns it").toBe(1);
    return drainWould;
  }
  const snapshot = () => db.getDashboardAgentSnapshots(60_000).find((r) => r.name === "f3-rec")!;

  it("HARM: a 30-second-old never-drained message counts 1 on the display counts, and 1 in the drain", () => {
    const drainWould = fresh30s();
    expect(snapshot().pending_count, "the snapshot's canonical count").toBe(drainWould);
    expect(inboxSummary().pending_count, "the board's displayed count").toBe(drainWould);
  });

  it("INNOCENT TWIN: the STATE input stays age-filtered by design (30s < the 60s window → 0)", () => {
    fresh30s();
    expect(snapshot().inputs.pendingCount).toBe(0);
  });

  it("aged mail: the canonical count and the state input agree", () => {
    staleHookFlip(seed());
    expect(snapshot().pending_count).toBe(1);
    expect(snapshot().inputs.pendingCount).toBe(1);
  });
});
