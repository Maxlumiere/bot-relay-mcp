// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Doorbell PR 3: effectiveness per reading session (A2.3 as corrected by V4; plan v3 PR 3).
 * A ring was EFFECTIVE when a rung id LEFT the current reading session's pending set (read by
 * that session, or resolved), with the reading session UNCHANGED. A changed session is the V4
 * rescue path, never effectiveness. Never `read_at`, never `last_drain_at`, never a count.
 *
 * Every harm case runs on a REAL relay DB, through the job's ONE pending read
 * (pendingReadOf → pendingMetadata) and the ONE judgement (ringEffect), with real drains
 * (get_messages, not a peek) and real resolves.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";

const ROOT = path.join(os.tmpdir(), `bot-relay-pr3-effect-${process.pid}`);
const DB = path.join(ROOT, "relay.db");
process.env.RELAY_DB_PATH = DB;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;

const db = await import("../src/db.js");
const C = await import("../src/doorbell-core.js");
const R = await import("../src/doorbell-run.js");
const { handleGetMessages } = await import("../src/tools/messaging.js");
const { GetMessagesSchema } = await import("../src/types.js");

const A = "pr3-rcpt";
const S = "pr3-sender";
const setSession = (s: string | null): void => void db.getDb().prepare("UPDATE agents SET session_id = ? WHERE name = ?").run(s, A);
/** A real drain (get_messages pending, NOT a peek), as the dispatcher parses it. */
const drain = (): string[] => {
  const input = GetMessagesSchema.parse({ agent_name: A, status: "pending", peek: false, limit: 100, since: "all" });
  return JSON.parse(handleGetMessages(input as never).content[0].text).messages.map((m: { id: string }) => m.id);
};
const send = (): string => db.sendMessage(S, A, "x", "normal").id;
const read = () => R.pendingReadOf(db, db.getDb(), A);
/** Ring the given ids for the CURRENT reading session, exactly as an intent's `covers` would. */
const ring = (ids: string[]) => {
  const rs = read().reading_session;
  if (!rs) throw new Error("fixture: no bound reading session to ring for");
  return { reading_session: rs, message_ids: [...ids].sort() };
};
/**
 * THE judgement, twice: the pure ringEffect, AND the planner (the production path) judging an
 * outstanding ring for these ids on the real pending read. They must agree; the planner's is
 * returned.
 */
const judge = (covers: { reading_session: string; message_ids: string[] }) => {
  const pure = C.ringEffect(covers, read());
  const ring = {
    v: 1 as const, type: "intent" as const, at: "2026-10-02T08:00:00.000Z", mono_ms: 0,
    intent: { intent_id: randomUUID(), agent_name: A, binding_id: "b", during_escalation: false },
    covers: { ...covers, kinds: covers.message_ids.map(() => "new" as const) },
  };
  const p = C.planCycle({
    bindings: [], ownHostId: "HOST-A", pending: (n) => R.pendingReadOf(db, db.getDb(), n), rung: new Set(), ringMono: new Map(), nowMono: 1,
    budgetExhausted: new Set(), liveness: () => "alive", mailAgents: () => db.agentsWithPendingMail(db.getDb()), boardOpen: new Map(), windowMs: C.DEFAULT_WINDOW_MS, budgetPerHour: 6, horizonMs: C.DEFAULT_HORIZON_MS,
    ledger: C.ledgerInput([ring], () => 0), newIntentId: randomUUID, now: () => "2026-10-02T08:00:01.000Z",
  });
  const e = p.effects[0];
  // B1: unbound is a HOLD: the planner judges NOTHING (no effect, no close). PR 6: this fixture has
  // mail and NO window (bindings: []), which is a no_live_window BOARD case, its only record.
  if (read().reading_session === null) {
    expect(p.records.filter((r) => r.type !== "board")).toEqual([]);
    expect(p.board.map((r) => [r.case, r.state])).toEqual([["no_live_window", "open"]]);
  }
  const planned = !e ? { outcome: read().reading_session === null ? "unbound" : "still_pending" } : e.outcome === "effective" ? { outcome: "effective", left: e.left } : { outcome: e.outcome };
  expect(planned).toEqual(pure);
  return planned;
};
const readAt = (id: string) => (db.getDb().prepare("SELECT read_at FROM messages WHERE id = ?").get(id) as { read_at: string | null }).read_at;
const lastDrainAt = () => (db.getDb().prepare("SELECT last_drain_at FROM agents WHERE name = ?").get(A) as { last_drain_at: string | null }).last_drain_at;

beforeEach(() => {
  db.closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  process.env.RELAY_DB_PATH = DB;
  db.getDb();
  db.registerAgent(S, "s", []);
  db.registerAgent(A, "r", []);
});
afterEach(() => {
  db.closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("PR 3: effectiveness on a real DB (V4)", () => {
  it("HARM (V4): an id read by the CURRENT session is effective, although read_at was stamped EARLIER by a previous session", () => {
    setSession("pr3-session-old");
    const m1 = send();
    expect(drain()).toEqual([m1]);
    const stampedByOld = readAt(m1);
    expect(stampedByOld).toBeTruthy(); // precondition: the previous session stamped read_at
    setSession("pr3-session-new");
    expect(read().ids).toContain(m1); // precondition: re-pended for the new session
    const covers = ring([m1]);
    expect(judge(covers)).toEqual({ outcome: "still_pending" });
    expect(drain()).toEqual([m1]); // the CURRENT session reads it
    expect(readAt(m1)).toBe(stampedByOld); // precondition: read_at did NOT advance (stamped once)
    expect(judge(covers)).toEqual({ outcome: "effective", left: [m1] });
  });

  it("HARM (V4): read_at AND last_drain_at advanced, but the id is STILL pending for the current session → NOT effective", () => {
    setSession("pr3-session-current");
    const m1 = send();
    const covers = ring([m1]);
    const drainBefore = lastDrainAt();
    expect(readAt(m1)).toBeNull();
    // Another session of the same agent (an ADR-0042 child, an old window) drains it.
    setSession("pr3-session-other");
    expect(drain()).toEqual([m1]);
    setSession("pr3-session-current");
    expect(readAt(m1)).toBeTruthy(); // precondition: read_at advanced
    expect(lastDrainAt()).not.toBe(drainBefore); // precondition: last_drain_at advanced
    expect(read().ids).toContain(m1); // precondition: still pending for the current session
    expect(judge(covers)).toEqual({ outcome: "still_pending" });
  });

  it("HARM (plan v3 PR 3): the same id ABSENT only because the reading session changed → session_changed, NEVER effective", () => {
    setSession("pr3-session-2");
    const m1 = send();
    drain(); // session 2 read it earlier
    setSession("pr3-session-1");
    expect(read().ids).toContain(m1); // precondition: re-pended for session 1
    const covers = ring([m1]);
    setSession("pr3-session-2");
    expect(read().ids).not.toContain(m1); // precondition: absent from session 2's set
    expect(judge(covers)).toEqual({ outcome: "session_changed" });
  });

  it("HARM (B1, review 2fda069b): an unbound session now (NULL) → `unbound`: NEITHER effective NOR session_changed, and nothing is written", () => {
    setSession("pr3-session-a");
    const m1 = send();
    const covers = ring([m1]);
    setSession(null);
    expect(read().reading_session).toBeNull();
    expect(judge(covers)).toEqual({ outcome: "unbound" });
  });

  it("HARM (A2.2): the rung id drained and a NEW id arrived at an UNCHANGED count → effective (never a count)", () => {
    setSession("pr3-session-c");
    const m1 = send();
    const covers = ring([m1]);
    drain();
    const m2 = send();
    expect(read().ids).toEqual([m2]); // precondition: the count is unchanged (1 → 1)
    expect(judge(covers)).toEqual({ outcome: "effective", left: [m1] });
  });

  it("a RESOLVED rung id has left the set too → effective", () => {
    setSession("pr3-session-r");
    const m1 = send();
    const covers = ring([m1]);
    expect(db.resolveMessages(A, [m1]).resolved_count).toBe(1);
    expect(judge(covers)).toEqual({ outcome: "effective", left: [m1] });
  });

  it("twin: the current session's drain of ANY ONE rung id is effective (left lists only it)", () => {
    setSession("pr3-session-t");
    const m1 = send();
    const m2 = send();
    const covers = ring([m1, m2]);
    db.resolveMessages(A, [m2]);
    expect(judge(covers)).toEqual({ outcome: "effective", left: [m2] });
  });

  it("twin: nothing happened → still_pending", () => {
    setSession("pr3-session-n");
    const m1 = send();
    const covers = ring([m1]);
    send(); // new mail is not an effect of the ring
    expect(judge(covers)).toEqual({ outcome: "still_pending" });
  });
});

describe("STALE-PREMISE PIN (ruling 97ced827): relay message ids are RANDOM v4 UUIDs", () => {
  it("every id the relay mints for a message is a v4 UUID, and they are not in time order", () => {
    // The intent cap and the escalation witness take the FIRST MAX ids in canonical order; that is an
    // UNBIASED sample only while ids are random. If this test ever fails (UUIDv7, sequential,
    // federation-minted ids), revisit the cap's ordering in src/doorbell-core.ts (the ruling says so).
    setSession("pr3-session-v4");
    const sent = Array.from({ length: 50 }, () => send());
    for (const id of sent) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect([...sent].sort()).not.toEqual(sent); // 50 sends in time order are NOT in canonical order (p of a false red ≈ 1/50!)
  });
});

describe("PR 3: ringEffect is pure and canonical", () => {
  const RS = "a".repeat(64);
  it("left is a canonical SET: unique and sorted, whatever order the ids came in", () => {
    expect(C.ringEffect({ reading_session: RS, message_ids: ["m3", "m1", "m2"] }, { reading_session: RS, ids: ["m2"] })).toEqual({ outcome: "effective", left: ["m1", "m3"] });
  });
  it("a session change wins over any absence", () => {
    expect(C.ringEffect({ reading_session: RS, message_ids: ["m1"] }, { reading_session: "b".repeat(64), ids: [] })).toEqual({ outcome: "session_changed" });
  });
});
