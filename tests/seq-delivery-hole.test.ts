// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * #198 — never-observed mail aged past the get_messages `since` window must still
 * be delivered by a pending drain (and get a seq).
 *
 * The defect: seq is assigned only on FIRST OBSERVATION, and the pending SELECT
 * that performs that observation was gated by `AND created_at >= ?` (the `since`
 * window, default '24h'). So a message older than the window that was never
 * drained was filtered out on every default drain — never returned, never seq'd:
 * silent non-delivery, recoverable only by an explicit since='all'. Live victim:
 * conduit's 6.4-day message. Fix: gate the window on ALREADY-OBSERVED rows only —
 * `AND (seq IS NULL OR created_at >= ?)` — so undelivered mail is always eligible.
 *
 * These two cases are the acceptance bar (victra): the POSITIVE control proves the
 * fix delivers the aged undelivered message; the NEGATIVE control proves the fix
 * did NOT do it by disabling the window — an already-OBSERVED old message must
 * still be trimmed by `since`. Without the negative, the positive could pass with
 * the window gone entirely, i.e. by breaking the constraint instead of the defect.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-seqhole-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;

const { registerAgent, sendMessage, getMessages, getDb, closeDb } = await import(
  "../src/db.js"
);
const { handleGetMessagesSummary, handleGetMessages } = await import("../src/tools/messaging.js");
const { sampleGetMessagesConsistency, _resetProbeCounterForTests, _probeDivergenceCountForTests } =
  await import("../src/transport/consistency-probe.js");

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
}
beforeEach(cleanup);
afterEach(cleanup);

const hoursAgoIso = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();
const SINCE_24H = () => hoursAgoIso(24); // the default-path window the tool applies
// getMessages signature: (agentName, status, limit, peek=false, sinceIso=null, lane, ack).
// `since` is the 5th positional arg — peek MUST be passed explicitly before it.
const drainPending = (agent: string, sinceIso: string | null) =>
  getMessages(agent, "pending", 20, false, sinceIso);

describe("#198 — never-observed mail aged past `since` is still delivered", () => {
  it("POSITIVE CONTROL: a never-observed message 48h old IS returned by a default (since='24h') pending drain, and gets a seq stamped", () => {
    registerAgent("sender", "role", []);
    registerAgent("recipient", "role", []);
    const db = getDb();
    db.prepare("UPDATE agents SET session_id = ? WHERE name = ?").run("sess-1", "recipient");

    const msg = sendMessage("sender", "recipient", "aged undelivered mail", "normal");
    // Age it past the window; it has never been observed (fresh send → seq NULL).
    db.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(hoursAgoIso(48), msg.id);
    const before = db
      .prepare("SELECT seq, read_by_session, resolved_at FROM messages WHERE id = ?")
      .get(msg.id) as { seq: number | null; read_by_session: string | null; resolved_at: string | null };
    expect(before.seq).toBeNull(); // never observed
    expect(before.read_by_session).toBeNull();
    expect(before.resolved_at).toBeNull();

    // Default-path drain: an explicit 24h window, exactly what the tool applies.
    const drained = drainPending("recipient", SINCE_24H());

    // The aged, never-observed message is delivered despite being older than 24h...
    expect(drained.map((m) => m.id)).toContain(msg.id);
    // ...and first observation stamped a seq on it (it is now delivered/observed).
    const got = drained.find((m) => m.id === msg.id);
    expect(got?.seq).not.toBeNull();
    const persisted = db.prepare("SELECT seq FROM messages WHERE id = ?").get(msg.id) as { seq: number | null };
    expect(persisted.seq).not.toBeNull();
  });

  it("NEGATIVE CONTROL: an ALREADY-OBSERVED 48h-old message re-pending for a fresh session is STILL trimmed by `since` (the window is not disabled)", () => {
    registerAgent("sender", "role", []);
    registerAgent("recipient", "role", []);
    const db = getDb();
    db.prepare("UPDATE agents SET session_id = ? WHERE name = ?").run("sess-1", "recipient");

    const msg = sendMessage("sender", "recipient", "already seen, now old", "normal");
    // Observe it once (session 1): this stamps a seq + read_by_session='sess-1'.
    const firstDrain = getMessages("recipient", "pending", 20);
    expect(firstDrain.map((m) => m.id)).toContain(msg.id);
    const afterObserve = db.prepare("SELECT seq FROM messages WHERE id = ?").get(msg.id) as { seq: number | null };
    expect(afterObserve.seq).not.toBeNull(); // now OBSERVED

    // Fresh terminal (session 2) → the message re-pends (read by a different session).
    db.prepare("UPDATE agents SET session_id = ? WHERE name = ?").run("sess-2", "recipient");
    // Age it past the window.
    db.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(hoursAgoIso(48), msg.id);

    // A default (since='24h') pending drain must NOT return it — it is observed
    // history older than the window, which the window legitimately trims.
    const windowed = drainPending("recipient", SINCE_24H());
    expect(windowed.map((m) => m.id)).not.toContain(msg.id);

    // Control-within-control: it is trimmed by the WINDOW, not gone — an explicit
    // since='all' (null) drain re-surfaces it. Proves the negative isn't "the row
    // vanished," it's "the window still bounds observed mail."
    db.prepare("UPDATE agents SET session_id = ? WHERE name = ?").run("sess-2b", "recipient");
    const unwindowed = drainPending("recipient", null);
    expect(unwindowed.map((m) => m.id)).toContain(msg.id);
  });
});

/** Direct-insert a NEVER-OBSERVED (seq NULL) message with an explicit created_at. */
function seedNeverObserved(to: string, id: string, hoursAgo: number): void {
  getDb()
    .prepare(
      "INSERT INTO messages (id, from_agent, to_agent, content, priority, status, created_at) VALUES (?, 'sender', ?, 'x', 'normal', 'pending', ?)"
    )
    .run(id, to, hoursAgoIso(hoursAgo));
}

/**
 * #198 — the cheap getMessagesSummary PREVIEW must agree with the mutating drain
 * (GetMessagesSummarySchema's contract). Both now route the window through the
 * shared pendingSinceClause helper, so aged never-observed mail previews exactly
 * as it drains. codex #199 review flagged that the preview kept the stale window.
 */
describe("#198 — getMessagesSummary pending preview agrees with the drain", () => {
  it("previews an aged never-observed message on a default since='24h' summary; keeps an old OBSERVED message window-trimmed", () => {
    registerAgent("sender", "role", []);
    registerAgent("recipient", "role", []);
    const db = getDb();
    db.prepare("UPDATE agents SET session_id = 'sess-1' WHERE name = 'recipient'").run();
    seedNeverObserved("recipient", "aged-unseen", 48); // delivery-hole class
    // Aged AND observed by another session → the window legitimately trims it.
    db.prepare(
      "INSERT INTO messages (id, from_agent, to_agent, content, priority, status, seq, read_by_session, created_at) VALUES ('aged-seen', 'sender', 'recipient', 'x', 'normal', 'pending', 999, 'other-session', ?)"
    ).run(hoursAgoIso(48));

    const summary = JSON.parse(
      handleGetMessagesSummary({ agent_name: "recipient", status: "pending", limit: 100, since: "24h" } as Parameters<typeof handleGetMessagesSummary>[0]).content[0].text
    );
    const previewed = summary.summaries.map((s: { id: string }) => s.id);
    expect(previewed).toContain("aged-unseen"); // agrees with the drain (delivered)
    expect(previewed).not.toContain("aged-seen"); // agrees with the drain (trimmed)

    // Cross-check the preview against the mutating drain: same pending set.
    const drained = drainPending("recipient", SINCE_24H()).map((m) => m.id);
    expect(drained).toContain("aged-unseen");
    expect(drained).not.toContain("aged-seen");
  });
});

/**
 * #198 — the consistency probe must be built on the SAME pendingSinceClause helper
 * as the drain, or it goes blind to the exact divergence it exists to catch (a
 * probe that duplicates the predicate it checks drifts from it). Proven live:
 * inject an aged never-observed row, show the probe REPORTS when a drain drops it
 * and is SILENT when the drain returns it; and that the stale created_at-only
 * superset would never have contained the row to report on.
 */
describe("#198 — consistency probe on the shared helper cannot go blind", () => {
  const prevEnabled = process.env.RELAY_CONSISTENCY_PROBE;
  const prevRate = process.env.RELAY_CONSISTENCY_PROBE_RATE;
  beforeEach(() => {
    process.env.RELAY_CONSISTENCY_PROBE = "1";
    process.env.RELAY_CONSISTENCY_PROBE_RATE = "1"; // probe every call
    _resetProbeCounterForTests();
  });
  afterEach(() => {
    if (prevEnabled === undefined) delete process.env.RELAY_CONSISTENCY_PROBE;
    else process.env.RELAY_CONSISTENCY_PROBE = prevEnabled;
    if (prevRate === undefined) delete process.env.RELAY_CONSISTENCY_PROBE_RATE;
    else process.env.RELAY_CONSISTENCY_PROBE_RATE = prevRate;
  });

  it("REPORTS when a drain drops an aged never-observed row, and is SILENT when the drain returns it", () => {
    registerAgent("sender", "role", []);
    registerAgent("recipient", "role", []);
    seedNeverObserved("recipient", "aged-unseen", 48);
    const since = SINCE_24H();

    // Simulate a broken drain that dropped the aged row (the pre-#198 bug).
    _resetProbeCounterForTests();
    sampleGetMessagesConsistency({ agentName: "recipient", status: "pending", limit: 100, peek: false, mcpResult: [], sinceIso: since });
    expect(_probeDivergenceCountForTests(), "probe must REPORT the dropped aged row").toBe(1);

    // The fixed drain returns the aged row → probe silent (superset agrees).
    _resetProbeCounterForTests();
    sampleGetMessagesConsistency({
      agentName: "recipient", status: "pending", limit: 100, peek: false,
      mcpResult: [{ id: "aged-unseen" } as unknown as import("../src/types.js").MessageRecord], sinceIso: since,
    });
    expect(_probeDivergenceCountForTests(), "probe must be SILENT when drain and superset agree").toBe(0);
  });

  it("the STALE created_at-only superset would have been BLIND — the aged row was never in it", () => {
    registerAgent("sender", "role", []);
    registerAgent("recipient", "role", []);
    seedNeverObserved("recipient", "aged-unseen", 48);
    const db = getDb();
    const since = hoursAgoIso(24);
    // The shared-helper superset INCLUDES the aged never-observed row...
    const withHelper = (db
      .prepare("SELECT id FROM messages WHERE to_agent = 'recipient' AND resolved_at IS NULL AND read_by_session IS NULL AND (seq IS NULL OR created_at >= ?)")
      .all(since) as Array<{ id: string }>).map((r) => r.id);
    expect(withHelper).toContain("aged-unseen");
    // ...the STALE created_at-only superset EXCLUDES it — a probe built on that
    // copy reports agreement while the drain drops the row (the guard-wiring lesson).
    const stale = (db
      .prepare("SELECT id FROM messages WHERE to_agent = 'recipient' AND resolved_at IS NULL AND read_by_session IS NULL AND created_at >= ?")
      .all(since) as Array<{ id: string }>).map((r) => r.id);
    expect(stale).not.toContain("aged-unseen");
  });
});

/**
 * #198 — the get_messages `since` HINT's firing condition observably narrowed: the
 * hint fires only when a pending drain returns 0. Post-#198 an aged never-observed
 * message is RETURNED (count > 0), so the hint no longer fires for it — which is
 * why the tool description + hint text no longer claim `since` hides "older pending
 * messages" in general (codex #199 doc hold). It hides only already-SEEN history.
 */
describe("#198 — the `since` hint no longer claims to hide never-observed mail", () => {
  it("an aged never-observed message is RETURNED by handleGetMessages(since='15m'); no hint fires (count > 0)", () => {
    registerAgent("sender", "role", []);
    registerAgent("recipient", "role", []);
    getDb().prepare("UPDATE agents SET session_id = 'sess-1' WHERE name = 'recipient'").run();
    seedNeverObserved("recipient", "aged-unseen", 1); // 1h old > 15m window, never observed

    const res = JSON.parse(
      handleGetMessages({ agent_name: "recipient", status: "pending", limit: 100, since: "15m" } as Parameters<typeof handleGetMessages>[0]).content[0].text
    );
    const ids = (res.messages ?? []).map((m: { id: string }) => m.id);
    expect(ids).toContain("aged-unseen"); // never-observed mail is delivered, not hidden
    expect(res.hint).toBeUndefined(); // count > 0 → the "hides older pending" hint does not fire
  });
});
