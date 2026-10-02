// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Doorbell PR 0b (V4; architect ruling ab740fe3 Q1) — `pendingMetadata` reports the
 * READING SESSION it used, as an opaque digest, so a consumer keyed on
 * (id, reading session) takes the key from the SAME snapshot as the ids and never
 * re-reads `agents.session_id` (V4: the reading session is defined ONCE).
 *
 *   - SSOT: the digest is of the EXACT key the pending predicate used, pinned to the
 *     key a real drain WROTE (`messages.read_by_session`), not to a re-read.
 *   - Unbound (NULL or empty session) → null, never a digest of the `?? ""` fallback,
 *     which would make every unbound session look like one session.
 *   - A re-registration (a new session) changes the digest: the V4 rescue input.
 *   - Opaque: the raw session id never appears.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const ROOT = path.join(os.tmpdir(), `bot-relay-pr0b-${process.pid}`);
const DB = path.join(ROOT, "relay.db");
process.env.RELAY_DB_PATH = DB;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;

const db = await import("../src/db.js");
const { handleGetMessages } = await import("../src/tools/messaging.js");
const { GetMessagesSchema } = await import("../src/types.js");

const R = "pr0b-rcpt";
const sessionOf = (name: string): string | null =>
  (db.getDb().prepare("SELECT session_id FROM agents WHERE name = ?").get(name) as { session_id: string | null }).session_id;
const setSession = (name: string, s: string | null): void => void db.getDb().prepare("UPDATE agents SET session_id = ? WHERE name = ?").run(s, name);
/** A real drain (get_messages pending, NOT a peek), exactly as the dispatcher parses it. */
const drain = (name: string): string[] => {
  const input = GetMessagesSchema.parse({ agent_name: name, status: "pending", peek: false, limit: 100, since: "all" });
  return JSON.parse(handleGetMessages(input as never).content[0].text).messages.map((m: { id: string }) => m.id);
};

beforeEach(() => {
  db.closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  process.env.RELAY_DB_PATH = DB;
  db.getDb();
  db.registerAgent("pr0b-sender", "s", []);
  db.registerAgent(R, "r", []);
});
afterEach(() => {
  db.closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("PR 0b: pendingMetadata reports the reading session it used (V4, ab740fe3 Q1)", () => {
  it("SSOT: the digest is of the key a real DRAIN wrote (messages.read_by_session), and the drained id left that session's set", () => {
    const m1 = db.sendMessage("pr0b-sender", R, "x", "normal").id;
    expect(drain(R)).toEqual([m1]);
    const drainKey = (db.getDb().prepare("SELECT read_by_session FROM messages WHERE id = ?").get(m1) as { read_by_session: string }).read_by_session;
    expect(drainKey).toBeTruthy(); // precondition: the drain stamped a key
    const meta = db.pendingMetadata(db.getDb(), R);
    expect(meta.reading_session).toBe(db.readingSessionDigest(drainKey));
    expect(meta.messages.map((m) => m.id)).not.toContain(m1);
  });

  it("opaque: a 64-hex digest; the raw session id never appears", () => {
    const meta = db.pendingMetadata(db.getDb(), R);
    expect(meta.reading_session).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(meta)).not.toContain(sessionOf(R) as string);
  });

  it("unbound (NULL session) → null, with session_bound false; two unbound agents are NOT one session", () => {
    db.registerAgent("pr0b-other", "r", []);
    setSession(R, null);
    setSession("pr0b-other", null);
    db.sendMessage("pr0b-sender", R, "x", "normal");
    const a = db.pendingMetadata(db.getDb(), R);
    const b = db.pendingMetadata(db.getDb(), "pr0b-other");
    expect([a.session_bound, a.reading_session]).toEqual([false, null]);
    expect(b.reading_session).toBeNull();
    expect(a.count).toBe(1); // precondition: the unbound set is non-empty (the "" fallback was used for the ids)
  });

  it("an EMPTY session string is unbound too → null (never the digest of the fallback key)", () => {
    setSession(R, "");
    const meta = db.pendingMetadata(db.getDb(), R);
    expect([meta.session_bound, meta.reading_session]).toEqual([false, null]);
  });

  it("a re-registration (a NEW session) changes the digest, and the old session's reads re-pend: the V4 rescue input", () => {
    const m1 = db.sendMessage("pr0b-sender", R, "x", "normal").id;
    drain(R);
    const before = db.pendingMetadata(db.getDb(), R);
    expect(before.messages.map((m) => m.id)).not.toContain(m1);
    setSession(R, "a-later-window-session");
    const after = db.pendingMetadata(db.getDb(), R);
    expect(after.reading_session).not.toBe(before.reading_session);
    expect(after.reading_session).toBe(db.readingSessionDigest("a-later-window-session"));
    expect(after.messages.map((m) => m.id)).toContain(m1);
  });

  it("twin: the same session twice → the same digest (stable equality is all rung memory needs)", () => {
    expect(db.pendingMetadata(db.getDb(), R).reading_session).toBe(db.pendingMetadata(db.getDb(), R).reading_session);
  });

  it("an unregistered agent → null (no row, no session), registered false", () => {
    const meta = db.pendingMetadata(db.getDb(), "pr0b-nobody");
    expect([meta.registered, meta.reading_session]).toEqual([false, null]);
  });
});
