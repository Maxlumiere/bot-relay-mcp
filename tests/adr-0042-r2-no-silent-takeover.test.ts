// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0042 R2 — no SILENT takeover of a live-anchored row.
 *
 * MEASURED 24 Sep: a process carrying an agent's name, but not the window that
 * holds its row, took over or rewrote that row while the holding window was alive.
 *   - victra: some other process's hook re-registered her row while her window
 *     (connector running since the day before) was alive but QUIET. The collision
 *     check keys on last_seen, which observation does not bump, so a live quiet
 *     window reads STALE and the register was let through.
 *   - architect: a new window's connector stamped its anchor at startup over the
 *     row of a still-open old window. setAgentLivenessAnchor had no anchor check,
 *     so the row ended up with window N's anchor and window N-1's session.
 *
 * The rule (ADR-0036's approved claim rule): a register or anchor stamp from a
 * process whose anchor is NOT the row's stored anchor, while that stored anchor is
 * ALIVE (anchorLivenessVerdict), is REFUSED LOUDLY, naming the route. The declared
 * takeover route (force + expected_session_id, ADR-0012) stays open.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const DIR = path.join(os.tmpdir(), "bot-relay-adr0042-r2-" + process.pid);
process.env.RELAY_DB_PATH = path.join(DIR, "relay.db");
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;

const db = await import("../src/db.js");
const { handleRegisterAgent } = await import("../src/tools/identity.js");
const { handleReportLiveness } = await import("../src/tools/status.js");
const { getOwnHostId, processStartedAt } = await import("../src/liveness.js");

const NAME = "r2-agent";
const DEAD_PID = 2_147_483_646;
const DEAD_START = "Mon Sep 15 10:00:00 2026";
/** A process that is really alive on this host and is NOT us: the test runner's parent. */
const HOLDER = () => ({ pid: process.ppid, start: processStartedAt(process.ppid) ?? "" });
/** "Another window": a live process that is not the holder. */
const INTRUDER = () => ({ pid: process.pid, start: processStartedAt(process.pid) ?? "" });

function parse(r: { content: { text: string }[] }) {
  return JSON.parse(r.content[0].text);
}
function cleanup() {
  db.closeDb();
  fs.rmSync(DIR, { recursive: true, force: true });
}
beforeEach(() => cleanup());
afterEach(() => cleanup());

/** Registered, anchored to `anchor`, and QUIET (last_seen aged, so the last_seen test calls it stale). */
function quietRowAnchoredTo(anchor: { pid: number; start: string }): { token: string; session: string } {
  const r = parse(handleRegisterAgent({ name: NAME, role: "r", capabilities: [] } as never));
  db.getDb()
    .prepare("UPDATE agents SET agent_pid = ?, agent_pid_start = ?, host_id = ?, last_seen = ? WHERE name = ?")
    .run(anchor.pid, anchor.start, getOwnHostId(), "2000-01-01T00:00:00.000Z", NAME);
  return { token: r.agent_token, session: db.getAgentSessionId(NAME)! };
}
function row() {
  return db.getDb().prepare("SELECT session_id, agent_pid, agent_pid_start FROM agents WHERE name = ?").get(NAME) as {
    session_id: string | null;
    agent_pid: number | null;
    agent_pid_start: string | null;
  };
}

describe("ADR-0042 R2 — PRECONDITIONS (else every refusal is vacuous)", () => {
  it("the holder is a live process on this host with a readable start, distinct from the intruder", () => {
    expect(getOwnHostId()).toBeTruthy();
    expect(HOLDER().start).not.toBe("");
    expect(INTRUDER().start).not.toBe("");
    expect(HOLDER().pid).not.toBe(INTRUDER().pid);
  });
});

describe("ADR-0042 R2 — an anchor stamp never overwrites a LIVE foreign anchor", () => {
  it("HARM (architect case): stamping another window's anchor over a live holder is refused; the row is unchanged", () => {
    quietRowAnchoredTo(HOLDER());
    const before = row();
    expect(() => db.setAgentLivenessAnchor(NAME, INTRUDER().pid, INTRUDER().start)).toThrow(/live window/i);
    expect(row()).toEqual(before);
  });

  it("report_liveness from another window over a live holder: refused loudly, with the route", () => {
    const { token } = quietRowAnchoredTo(HOLDER());
    const before = row();
    const r = parse(
      handleReportLiveness({ agent_name: NAME, agent_pid: INTRUDER().pid, agent_pid_start: INTRUDER().start, agent_token: token } as never),
    );
    expect(r.success).toBe(false);
    expect(r.error_code).toBe("NAME_COLLISION_ACTIVE");
    expect(r.error).toMatch(/release-binding|close/i);
    expect(row()).toEqual(before);
  });

  it("TWIN: the holder re-stamping its OWN anchor is fine", () => {
    quietRowAnchoredTo(HOLDER());
    expect(db.setAgentLivenessAnchor(NAME, HOLDER().pid, HOLDER().start)).toBe(true);
  });

  it("TWIN: a DEAD stored anchor may be replaced (relaunch)", () => {
    quietRowAnchoredTo({ pid: DEAD_PID, start: DEAD_START });
    expect(db.setAgentLivenessAnchor(NAME, INTRUDER().pid, INTRUDER().start)).toBe(true);
    expect(row().agent_pid).toBe(INTRUDER().pid);
  });
});

describe("ADR-0042 R2 — a register never silently takes a row whose window is alive", () => {
  it("HARM (victra case): a QUIET live holder, a register from another window → NAME_COLLISION_ACTIVE, session untouched", () => {
    const { token, session } = quietRowAnchoredTo(HOLDER());
    expect(db.isNameActivelyHeld(db.getDb().prepare("SELECT * FROM agents WHERE name = ?").get(NAME) as never),
      "precondition: the last_seen test calls this row STALE — the door").toBe(false);
    const r = parse(
      handleRegisterAgent({
        name: NAME, role: "r", capabilities: [], agent_token: token,
        agent_pid: INTRUDER().pid, agent_pid_start: INTRUDER().start, host_id: getOwnHostId()!,
      } as never),
    );
    expect(r.success).toBe(false);
    expect(r.error_code).toBe("NAME_COLLISION_ACTIVE");
    expect(r.error).toMatch(/live window/i);
    expect(row().session_id, "the live window keeps its session").toBe(session);
  });

  it("a register that states NO anchor, over a live holder, is refused too (it cannot prove it is that window)", () => {
    const { token, session } = quietRowAnchoredTo(HOLDER());
    const r = parse(handleRegisterAgent({ name: NAME, role: "r", capabilities: [], agent_token: token } as never));
    expect(r.error_code).toBe("NAME_COLLISION_ACTIVE");
    expect(row().session_id).toBe(session);
  });

  it("TWIN: the holding window re-registering (same anchor) succeeds", () => {
    const { token } = quietRowAnchoredTo(HOLDER());
    const r = parse(
      handleRegisterAgent({
        name: NAME, role: "r", capabilities: [], agent_token: token,
        agent_pid: HOLDER().pid, agent_pid_start: HOLDER().start, host_id: getOwnHostId()!,
      } as never),
    );
    expect(r.success, JSON.stringify(r)).toBe(true);
  });

  it("TWIN: a DEAD holder → a relaunch registers (this is the normal restart)", () => {
    const { token } = quietRowAnchoredTo({ pid: DEAD_PID, start: DEAD_START });
    const r = parse(
      handleRegisterAgent({
        name: NAME, role: "r", capabilities: [], agent_token: token,
        agent_pid: INTRUDER().pid, agent_pid_start: INTRUDER().start, host_id: getOwnHostId()!,
      } as never),
    );
    expect(r.success, JSON.stringify(r)).toBe(true);
  });

  it("TWIN: the DECLARED takeover route (force + expected_session_id) stays open", () => {
    const { token, session } = quietRowAnchoredTo(HOLDER());
    const r = parse(
      handleRegisterAgent({
        name: NAME, role: "r", capabilities: [], agent_token: token, force: true, expected_session_id: session,
        agent_pid: INTRUDER().pid, agent_pid_start: INTRUDER().start, host_id: getOwnHostId()!,
      } as never),
    );
    expect(r.success, JSON.stringify(r)).toBe(true);
  });
});
