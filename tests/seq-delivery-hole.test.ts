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
