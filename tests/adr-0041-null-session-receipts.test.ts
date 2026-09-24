// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0041 — receipts report EFFECTS, and agent-level axes are never gated on a session.
 *
 * MEASURED by architect, 24 Sep: `get_messages(pending, ack=true)` replied
 * `acked: true, resolved_count: 1` while the DB kept resolved_at, read_at and
 * read_by_session all NULL, the next drain returned the same message, and
 * last_drain_at stayed frozen. Two causes:
 *   - db.ts getMessages gates the WHOLE mark block on `currentSession`, so a NULL
 *     agents.session_id (force-mint and rotate clear it by design) skips the
 *     read-mark, the resolve, read_at and last_drain_at alike;
 *   - the handler built `acked` / `resolved_count` from the REQUEST
 *     (`ack && status==='pending'`, `messages.length`), not from what changed.
 *
 * R1: a receipt reports the effect. R2: resolved_at (RESOLVED) and read_at +
 * last_drain_at (DELIVERED) are agent-level and stamped whenever the model drain
 * returned rows; only read_by_session needs a session. R3: a NULL session is the
 * honest "unbound" state: the drain still delivers and says `session_unbound`,
 * naming the remedy.
 *
 * R4: the NULL-session fixture also covers the ADR-0037 innocent twin, "the MODEL's
 * drain marks delivery", which passes on session-bearing fixtures and failed live on
 * victra's NULL-session row.
 *
 * The NULL session is produced by the REAL path that produced it live: a force
 * mint (`relay mint-token --force` → mintAgentToken), not by a raw UPDATE.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-adr0041-" + process.pid);
process.env.RELAY_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;

const { handleGetMessages } = await import("../src/tools/messaging.js");
const { closeDb, getDb, registerAgent, sendMessage, mintAgentToken } = await import("../src/db.js");

function parse(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

type Row = { resolved_at: string | null; read_at: string | null; read_by_session: string | null; status: string };
function row(id: string): Row {
  return getDb().prepare("SELECT resolved_at, read_at, read_by_session, status FROM messages WHERE id = ?").get(id) as Row;
}
function lastDrainAt(name: string): string | null {
  return (getDb().prepare("SELECT last_drain_at FROM agents WHERE name = ?").get(name) as { last_drain_at: string | null })
    .last_drain_at;
}
function sessionOf(name: string): string | null {
  return (getDb().prepare("SELECT session_id FROM agents WHERE name = ?").get(name) as { session_id: string | null }).session_id;
}

/** An agent whose session was cleared by a force mint, exactly as happened live. */
function nullSessionAgent(name: string): void {
  registerAgent(name, "r", []);
  mintAgentToken(name, "r", [], { force: true });
  expect(sessionOf(name), "precondition: the force mint cleared the session").toBeNull();
}

function cleanup() {
  closeDb();
  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
}
beforeEach(() => cleanup());
afterEach(() => cleanup());

describe("ADR-0041 R1 — an ack receipt reports what the DB did", () => {
  it("HARM: ack with a NULL session must not claim an ack the DB did not make", () => {
    registerAgent("sender", "r", []);
    nullSessionAgent("nulls");
    const id = sendMessage("sender", "nulls", "handle me", "normal").id;

    const r = parse(handleGetMessages({ agent_name: "nulls", status: "pending", limit: 20, ack: true } as never));

    expect(r.count).toBe(1);
    // Either the ack took effect and the DB shows it, or the receipt must not say it did.
    const resolved = row(id).resolved_at !== null;
    expect(r.acked === true, "acked must mirror the DB, never the request").toBe(resolved);
    expect(r.resolved_count ?? 0).toBe(resolved ? 1 : 0);
  });

  it("INNOCENT TWIN: with a session, acked + resolved_count carry the real count", () => {
    registerAgent("sender", "r", []);
    registerAgent("bound", "r", []);
    const ids = [1, 2, 3].map((i) => sendMessage("sender", "bound", `m${i}`, "normal").id);

    const r = parse(handleGetMessages({ agent_name: "bound", status: "pending", limit: 20, ack: true } as never));

    expect(r.acked).toBe(true);
    expect(r.resolved_count).toBe(3);
    for (const id of ids) expect(row(id).resolved_at).not.toBeNull();
  });
});

describe("ADR-0041 R2 — agent-level axes are stamped with a NULL session", () => {
  it("ack with a NULL session RESOLVES: the next drain does not return the mail again", () => {
    registerAgent("sender", "r", []);
    nullSessionAgent("nulls");
    const id = sendMessage("sender", "nulls", "handle me", "normal").id;

    const r = parse(handleGetMessages({ agent_name: "nulls", status: "pending", limit: 20, ack: true } as never));
    expect(r.acked).toBe(true);
    expect(r.resolved_count).toBe(1);
    expect(row(id).resolved_at).not.toBeNull();

    const again = parse(handleGetMessages({ agent_name: "nulls", status: "pending", limit: 20 } as never));
    expect(again.count, "an acked message must not come back").toBe(0);
  });

  it("a drain with a NULL session stamps read_at and last_drain_at (DELIVERED is agent-level)", () => {
    registerAgent("sender", "r", []);
    nullSessionAgent("nulls");
    const id = sendMessage("sender", "nulls", "deliver me", "normal").id;
    const before = lastDrainAt("nulls");

    parse(handleGetMessages({ agent_name: "nulls", status: "pending", limit: 20 } as never));

    expect(row(id).read_at, "read_at is the agent-level delivery marker").not.toBeNull();
    expect(lastDrainAt("nulls")).not.toBeNull();
    expect(lastDrainAt("nulls")).not.toBe(before);
  });

  it("read_by_session is NOT invented: with no session there is no per-session read to record", () => {
    registerAgent("sender", "r", []);
    nullSessionAgent("nulls");
    const id = sendMessage("sender", "nulls", "x", "normal").id;
    parse(handleGetMessages({ agent_name: "nulls", status: "pending", limit: 20 } as never));
    expect(row(id).read_by_session).toBeNull();
  });

  it("a PEEK with a NULL session stamps nothing (observation is not delivery)", () => {
    registerAgent("sender", "r", []);
    nullSessionAgent("nulls");
    const id = sendMessage("sender", "nulls", "x", "normal").id;
    parse(handleGetMessages({ agent_name: "nulls", status: "pending", limit: 20, peek: true } as never));
    expect(row(id).read_at).toBeNull();
    expect(row(id).resolved_at).toBeNull();
    expect(lastDrainAt("nulls")).toBeNull();
  });
});

describe("ADR-0041 R3 — a NULL session is reported, with the remedy", () => {
  it("the drain returns a session_unbound warning that names the remedy", () => {
    registerAgent("sender", "r", []);
    nullSessionAgent("nulls");
    sendMessage("sender", "nulls", "x", "normal");
    const r = parse(handleGetMessages({ agent_name: "nulls", status: "pending", limit: 20 } as never));
    expect(r.warning?.code).toBe("session_unbound");
    expect(r.warning?.message).toMatch(/register/i);
    expect(r.warning?.message).toMatch(/resolve_messages|ack/i);
  });

  it("a bound session gets no warning (the innocent twin of the warning)", () => {
    registerAgent("sender", "r", []);
    registerAgent("bound", "r", []);
    sendMessage("sender", "bound", "x", "normal");
    const r = parse(handleGetMessages({ agent_name: "bound", status: "pending", limit: 20 } as never));
    expect(r.warning).toBeUndefined();
  });
});

describe("ADR-0041 R4 — the ADR-0037 innocent twin holds for a NULL-session agent", () => {
  it("the MODEL's drain marks delivery (read_at + last_drain_at) even when the session is NULL", () => {
    registerAgent("sender", "r", []);
    nullSessionAgent("victra-like");
    const ids = [1, 2].map((i) => sendMessage("sender", "victra-like", `m${i}`, "high").id);
    parse(handleGetMessages({ agent_name: "victra-like", status: "pending", limit: 20 } as never));
    for (const id of ids) expect(row(id).read_at).not.toBeNull();
    expect(lastDrainAt("victra-like")).not.toBeNull();
  });
});
