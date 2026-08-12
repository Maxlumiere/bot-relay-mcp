// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

// PRIMARY defect (the-fixer finding 1 / victra seq 859-867+): purgeOldRecords deleted
// UNDELIVERED mail at 7 days — it destroyed conduit's never-delivered message, the case
// #198 exists for. The fix exempts UNDELIVERED obligations — mail NOT DRAINED by any
// recipient (pendingGlobalClause: resolved_at IS NULL AND read_by_session IS NULL, the
// SAME SSOT the wake detector uses as its candidate set) — from the 7d transient purge,
// holding them for a bounded operational-tier grace (default 30d, RELAY_UNDELIVERED_GRACE_DAYS,
// 0 = purge at the normal 7d), and — at ANY bound, INVARIANT, not knob-gated — emits a
// deadletter announcement when an obligation is finally dropped (the only evidence that
// survives the row's deletion; the conduit case left none). "Undelivered" is NOT DRAINED,
// not "never observed": a PEEKED-but-undrained message is exempt (it is the detector's
// diagnostic class); an earlier `seq IS NULL` predicate wrongly purged it at 7d.

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

/** Capture stderr AND report whether fn threw (needed for the atomicity/rollback
 *  case, where purge is expected to throw yet we must still inspect what — if
 *  anything — was announced before the throw). */
function captureStderrAllowThrow(fn: () => void): { out: string; threw: boolean } {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: any) => {
    chunks.push(String(chunk));
    return true;
  };
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  } finally {
    (process.stderr as any).write = orig;
  }
  return { out: chunks.join(""), threw };
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

  it("ANNOUNCES the deadletter when an obligation is dropped — recipient, age, id, undelivered", () => {
    const id = seed("sender-x", "recipient-y", "doomed", { ageDays: 40 });
    const err = captureStderr(() => purgeOldRecords(getDb()));
    expect(exists(id)).toBe(false);
    expect(err).toContain("deadletter");
    expect(err).toContain(`id=${id}`);
    expect(err).toContain("to=recipient-y");
    expect(err).toContain("from=sender-x");
    expect(err).toContain("age=40.0d");
    expect(err).toContain("undelivered (no recipient has drained it)");
    expect(err).not.toContain("never observed"); // a dropped message MAY have been peeked
  });

  it("P-LOOSE: a PEEKED-but-never-DRAINED message IS exempt — it is the detector's diagnostic class", () => {
    // read_by_session NULL = NOT DRAINED; seq set = peeked. "Peeked but never drained" is
    // the wake-path regression the detector reports on, so it MUST survive to be reported.
    // The exemption predicate IS the detector's candidate set (pendingGlobalClause), so an
    // earlier seq-based predicate that purged this at 7d silenced the detector's own class.
    const id = seed("a", "victra", "peeked but not drained", { ageDays: 10, seq: 42, readBy: null });
    purgeOldRecords(getDb());
    expect(exists(id)).toBe(true); // retained to the 30d grace, NOT purged at 7d
  });

  it("a peeked-but-never-drained message PAST the grace IS dropped (bounded) and announced", () => {
    const id = seed("a", "victra", "peeked, aged out", { ageDays: 40, seq: 42, readBy: null });
    const err = captureStderr(() => purgeOldRecords(getDb()));
    expect(exists(id)).toBe(false); // bounded — the cost is 30d, not forever
    expect(err).toContain(`id=${id}`); // announced: it is an undelivered obligation
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

  it("CONTRACT: every announced id is actually deleted; no retained or observed row is announced (dropped ⊆ deleted)", () => {
    const droppedIds = [seed("a", "b", "d1", { ageDays: 35 }), seed("a", "c", "d2", { ageDays: 50 })];
    const keptIds = [seed("a", "b", "k1", { ageDays: 10 }), seed("a", "c", "k2", { ageDays: 20 })];
    // Observed history older than 7d: deleted by the normal purge, but NOT an obligation.
    const historyId = seed("a", "b", "h1", { ageDays: 12, seq: 9, readBy: "s1" });
    const { out } = captureStderrAllowThrow(() => purgeOldRecords(getDb()));
    for (const id of droppedIds) {
      expect(exists(id)).toBe(false); // announced ⇒ actually gone
      expect(out).toContain(`id=${id}`);
    }
    for (const id of keptIds) {
      expect(exists(id)).toBe(true); // retained obligation …
      expect(out).not.toContain(`id=${id}`); // … never announced
    }
    expect(exists(historyId)).toBe(false); // observed history purged …
    expect(out).not.toContain(`id=${historyId}`); // … but not announced as an obligation
  });

  it("ATOMICITY: a failed DELETE rolls back AND emits no announcement (SELECT+DELETE in one tx, log after commit)", () => {
    // Inject a failure at the messages DELETE. If the announcement were emitted before
    // the delete (the old shape codex flagged), it would print a "dropped" line for a
    // row that survives — a lie in the artifact that outlives the row. Here the tx
    // rolls back and the log loop (after commit) never runs.
    const id = seed("a", "b", "abort-injected", { ageDays: 40 });
    getDb().exec("CREATE TEMP TRIGGER purge_abort BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT, 'injected'); END");
    const { out, threw } = captureStderrAllowThrow(() => purgeOldRecords(getDb()));
    try {
      getDb().exec("DROP TRIGGER purge_abort");
    } catch {
      /* connection may have been torn down */
    }
    expect(threw).toBe(true); // the DELETE failure propagates
    expect(exists(id)).toBe(true); // rolled back — the obligation survives
    expect(out).not.toContain("deadletter"); // and was NEVER announced as dropped
  });

  it("clamp below 7d: warns once AND the deadletter reports the EFFECTIVE grace, not the requested", () => {
    // Force DB init NOW (getDb() runs a startup purge via applySchemaSetup). With the
    // default grace that startup purge does not warn, so the warn-once budget is intact
    // for the grace=3 purge below — otherwise the init purge would spend it uncaptured.
    getDb();
    process.env.RELAY_UNDELIVERED_GRACE_DAYS = "3";
    const id = seed("a", "b", "clamped", { ageDays: 10 });
    const err1 = captureStderr(() => purgeOldRecords(getDb()));
    expect(exists(id)).toBe(false);
    // effective-grace-in-log (the sharp defect): reports 7d (applied), never 3d (requested)
    expect(err1).toContain("grace=7d");
    expect(err1).not.toContain("grace=3d");
    // silent-clamp fix: the coercion is announced …
    expect(err1).toContain("config:");
    expect(err1).toContain("below the 7d base retention");
    // … exactly once (a second purge does not re-warn)
    const id2 = seed("a", "b", "clamped-2", { ageDays: 11 });
    const err2 = captureStderr(() => purgeOldRecords(getDb()));
    expect(err2).not.toContain("config:");
    // (the second drop is still announced — only the config warning is once)
    expect(err2).toContain(`id=${id2}`);
  });

  it("invalid RELAY_UNDELIVERED_GRACE_DAYS coerces to the 30d default (behaviour)", () => {
    process.env.RELAY_UNDELIVERED_GRACE_DAYS = "banana";
    const within30 = seed("a", "b", "within-default", { ageDays: 20 }); // < 30d default → retained
    const past30 = seed("a", "b", "past-default", { ageDays: 40 }); // > 30d default → dropped
    const err = captureStderr(() => purgeOldRecords(getDb()));
    expect(exists(within30)).toBe(true);
    expect(exists(past30)).toBe(false);
    expect(err).toContain("grace=30d"); // effective = 30, not the garbage input
  });
});
