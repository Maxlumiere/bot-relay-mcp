// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0042 R1 — only the window that HOLDS the row may end its session.
 *
 * MEASURED 24 Sep (architect + victra-build, live audit log): a connector that
 * shared the row's session id but did NOT belong to the window holding the row
 * ended that session on its own signal. In the architect case the OLD window's
 * connector ended a session the NEW window (anchor 41408, still running) depended
 * on. The session compare-and-swap matched, because both connectors had captured the
 * same session id. So the CAS on session_id protected nothing.
 *
 * The ruling: a connector may end a session only if the row's stored anchor
 * (host_id + pid + start) is its OWN parent's, AND that anchor is POSITIVELY DEAD.
 * Foreign, alive or unverifiable → write nothing. The costs are asymmetric: a
 * dead-anchor session left set is harmless (read-time derivation shows it dead),
 * while unbinding a live window is the harm.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const DIR = path.join(os.tmpdir(), "bot-relay-adr0042-r1-" + process.pid);
process.env.RELAY_DB_PATH = path.join(DIR, "relay.db");
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;

const db = await import("../src/db.js");
const stdio = await import("../src/transport/stdio.js");
const { getOwnHostId, processStartedAt } = await import("../src/liveness.js");

const NAME = "r1-agent";
const DEAD_PID = 2_147_483_646;
const DEAD_START = "Mon Sep 15 10:00:00 2026";

function cleanup() {
  stdio._setDetectedAgentProcessForTests(null);
  db.closeDb();
  fs.rmSync(DIR, { recursive: true, force: true });
}
beforeEach(() => cleanup());
afterEach(() => cleanup());

/** The row, registered (session set) and anchored to `anchor`. Returns the session. */
function rowAnchoredTo(anchor: { pid: number; start: string; host?: string | null }): string {
  db.registerAgent(NAME, "r", []);
  db.getDb()
    .prepare("UPDATE agents SET agent_pid = ?, agent_pid_start = ?, host_id = ? WHERE name = ?")
    .run(anchor.pid, anchor.start, anchor.host === undefined ? getOwnHostId() : anchor.host, NAME);
  return db.getAgentSessionId(NAME)!;
}

function sessionNow(): string | null {
  return db.getAgentSessionId(NAME);
}

const LIVE = () => ({ pid: process.pid, start: processStartedAt(process.pid) ?? "" });

describe("ADR-0042 R1 — ending requires MY anchor on the row, and that anchor dead", () => {
  it("PRECONDITION: this host has an id and our own start time is readable (else every case is vacuous)", () => {
    expect(getOwnHostId()).toBeTruthy();
    expect(LIVE().start).not.toBe("");
  });

  it("ARCHITECT CASE: the row belongs to ANOTHER, live window → the old connector writes NOTHING", () => {
    const sid = rowAnchoredTo(LIVE()); // the new window holds the row, alive
    stdio._setDetectedAgentProcessForTests({ pid: DEAD_PID, startedAt: DEAD_START }); // my (old, dying) parent
    stdio.performAutoUnregister(NAME, sid, "SIGHUP");
    expect(sessionNow(), "the live window's session must survive a foreign connector's signal").toBe(sid);
  });

  it("the row is MINE but my parent is still ALIVE → write nothing (not positively dead)", () => {
    const sid = rowAnchoredTo(LIVE());
    stdio._setDetectedAgentProcessForTests({ pid: process.pid, startedAt: LIVE().start });
    stdio.performAutoUnregister(NAME, sid, "SIGINT");
    expect(sessionNow()).toBe(sid);
  });

  it("no detected parent → I cannot prove the row is mine → write nothing", () => {
    const sid = rowAnchoredTo({ pid: DEAD_PID, start: DEAD_START });
    stdio._setDetectedAgentProcessForTests(null);
    stdio.performAutoUnregister(NAME, sid, "SIGTERM");
    expect(sessionNow()).toBe(sid);
  });

  it("the row's anchor is on ANOTHER host (unverifiable) → write nothing, even if the pid matches", () => {
    const sid = rowAnchoredTo({ pid: DEAD_PID, start: DEAD_START, host: "some-other-host" });
    stdio._setDetectedAgentProcessForTests({ pid: DEAD_PID, startedAt: DEAD_START });
    stdio.performAutoUnregister(NAME, sid, "SIGHUP");
    expect(sessionNow()).toBe(sid);
  });

  it("INNOCENT TWIN: the row is MINE and my anchor is positively DEAD → the session ends", () => {
    const sid = rowAnchoredTo({ pid: DEAD_PID, start: DEAD_START });
    stdio._setDetectedAgentProcessForTests({ pid: DEAD_PID, startedAt: DEAD_START });
    stdio.performAutoUnregister(NAME, sid, "SIGHUP");
    expect(sessionNow()).toBeNull();
  });
});
