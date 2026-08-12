// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

// PRIMARY defect (the-fixer finding 1 / victra seq 859-861): purgeOldRecords deleted
// UNDELIVERED mail at 7 days — it destroyed conduit's never-delivered message, the
// case #198 exists for. The fix exempts NEVER-OBSERVED obligations (`seq IS NULL` =
// never drained NOR peeked, unresolved+unread) from the 7d transient purge, holding
// them for a bounded operational-tier grace (default 30d, RELAY_UNDELIVERED_GRACE_DAYS,
// 0 = purge at the normal 7d), and — at ANY bound, INVARIANT, not knob-gated — emits a
// deadletter announcement when an obligation is finally dropped (the only evidence that
// survives the row's deletion; the conduit case left none).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-purge-test-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_UNDELIVERED_GRACE_DAYS;

const { registerAgent, sendMessage, purgeOldRecords, getDb, closeDb } = await import("../src/db.js");

const DAY = 24 * 60 * 60 * 1000;

/** Register a sender if absent (sendMessage rejects unregistered senders since v2.1.3).
 *  Recipients are intentionally left unregistered — undelivered mail to a dark/absent
 *  recipient is exactly the case under test. */
function ensureAgent(name: string): void {
  if (!getDb().prepare("SELECT 1 FROM agents WHERE name = ?").get(name)) {
    registerAgent(name, "tester", ["test"]);
  }
}

/** Insert a message, then force its age + observation state directly (sendMessage
 *  always creates a fresh, never-observed row at `now`). Returns the row id. */
function seed(
  from: string,
  to: string,
  content: string,
  opts: { ageDays: number; seq?: number | null; readBy?: string | null; resolvedAt?: string | null },
): string {
  const { ageDays, seq = null, readBy = null, resolvedAt = null } = opts;
  ensureAgent(from);
  sendMessage(from, to, content, "normal");
  const { id } = getDb().prepare("SELECT id FROM messages ORDER BY rowid DESC LIMIT 1").get() as { id: string };
  const createdAt = new Date(Date.now() - ageDays * DAY).toISOString();
  getDb()
    .prepare("UPDATE messages SET created_at = ?, seq = ?, read_by_session = ?, resolved_at = ? WHERE id = ?")
    .run(createdAt, seq, readBy, resolvedAt, id);
  return id;
}

function exists(id: string): boolean {
  return !!getDb().prepare("SELECT 1 FROM messages WHERE id = ?").get(id);
}

/** Capture stderr (where log.warn writes) around a synchronous call. */
function captureStderr(fn: () => void): string {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: any) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    (process.stderr as any).write = orig;
  }
  return chunks.join("");
}

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
}

beforeEach(cleanup);
afterEach(() => {
  delete process.env.RELAY_UNDELIVERED_GRACE_DAYS;
  cleanup();
});

describe("undelivered-mail purge exclusion (PRIMARY defect)", () => {
  it("RETAINS a never-observed obligation aged into [7d, 30d] — the core fix", () => {
    const id = seed("a", "b", "undelivered obligation", { ageDays: 10 });
    purgeOldRecords(getDb());
    expect(exists(id)).toBe(true);
  });

  it("MOTIVATING CASE: a conduit-like message crosses the old 7d cliff and survives", () => {
    // Conduit's message was deleted at the 7d cliff while its recipient was still
    // dark. Here it has aged to 8d — PAST that cliff (so this bites: unmodified
    // db.ts deletes it) — and survives, because the 30d grace (~5x a multi-day
    // outage) holds it until the recipient returns. A bound that would not have
    // saved the motivating message would be theatre.
    const id = seed("relay", "conduit", "the message #198 exists for", { ageDays: 8 });
    purgeOldRecords(getDb());
    expect(exists(id)).toBe(true);
  });

  it("DROPS a never-observed obligation past the 30d grace — bounded, not infinite", () => {
    const id = seed("a", "b", "aged out obligation", { ageDays: 35 });
    purgeOldRecords(getDb());
    expect(exists(id)).toBe(false);
  });

  it("ANNOUNCES the deadletter when an obligation is dropped — recipient, age, id, never-observed", () => {
    const id = seed("sender-x", "recipient-y", "doomed", { ageDays: 40 });
    const err = captureStderr(() => purgeOldRecords(getDb()));
    expect(exists(id)).toBe(false);
    expect(err).toContain("deadletter");
    expect(err).toContain(`id=${id}`);
    expect(err).toContain("to=recipient-y");
    expect(err).toContain("from=sender-x");
    expect(err).toContain("age=40.0d");
    expect(err).toContain("never delivered, never observed");
  });

  it("P-TIGHT: a PEEKED (seq-set, unread) message is NOT exempt — purges at 7d (bounds the orchestrator artifact)", () => {
    // seq set = observed via peek. A peeked message is not an undelivered obligation,
    // so it purges on the normal 7d schedule — this is what keeps victra's 141 peeked
    // rows from being retained forever.
    const id = seed("a", "victra", "peeked but not drained", { ageDays: 10, seq: 42, readBy: null });
    purgeOldRecords(getDb());
    expect(exists(id)).toBe(false);
  });

  it("a DELIVERED (drained) message older than 7d purges normally — transient history unchanged", () => {
    const id = seed("a", "b", "delivered history", { ageDays: 10, seq: 42, readBy: "sess-1" });
    purgeOldRecords(getDb());
    expect(exists(id)).toBe(false);
  });

  it("a RESOLVED (acked) but never-drained message is fulfilled, not an obligation — purges at 7d", () => {
    const id = seed("a", "b", "resolved obligation", {
      ageDays: 10,
      resolvedAt: new Date(Date.now() - 9 * DAY).toISOString(),
    });
    purgeOldRecords(getDb());
    expect(exists(id)).toBe(false);
  });

  it("a fresh never-observed message (<7d) is untouched (not in the purge scope)", () => {
    const id = seed("a", "b", "fresh", { ageDays: 3 });
    purgeOldRecords(getDb());
    expect(exists(id)).toBe(true);
  });

  it("grace=0 removes the EXTENSION (purge at 7d) but the announcement STILL fires — the invariant", () => {
    process.env.RELAY_UNDELIVERED_GRACE_DAYS = "0";
    const id = seed("a", "b", "grace-zero obligation", { ageDays: 10 });
    const err = captureStderr(() => purgeOldRecords(getDb()));
    // extension disabled → dropped at the normal 7d …
    expect(exists(id)).toBe(false);
    // … but the drop is NOT silent (grace=0 is not an exemption lever).
    expect(err).toContain("deadletter");
    expect(err).toContain(`id=${id}`);
    expect(err).toContain("grace=7d");
  });

  it("a custom grace via RELAY_UNDELIVERED_GRACE_DAYS bounds retention at that horizon", () => {
    process.env.RELAY_UNDELIVERED_GRACE_DAYS = "14";
    const kept = seed("a", "b", "within 14d", { ageDays: 10 });
    const dropped = seed("a", "b", "past 14d", { ageDays: 20 });
    const err = captureStderr(() => purgeOldRecords(getDb()));
    expect(exists(kept)).toBe(true);
    expect(exists(dropped)).toBe(false);
    expect(err).toContain(`id=${dropped}`);
    expect(err).not.toContain(`id=${kept}`);
  });
});
