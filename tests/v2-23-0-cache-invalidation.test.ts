// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.23.x — the four session/anchor writers (setAgentLivenessAnchor,
 * markAgentOffline, closeAgentSession ×2) now invalidate BOTH probe caches
 * UNCONDITIONALLY, not only on r.changes>0/===1.
 *
 * THE HARM, written from the harm. A CAS-loser write (r.changes === 0) means a
 * concurrent rebind ALREADY moved the session/anchor. The old unbraced `if` left
 * `_negativeProbeCache` intact on that path, so a stale NEGATIVE entry — set when
 * the row was genuinely dead — kept labelling the now-FRESH, LIVE, anchored row
 * `dead` until the ~5s TTL. This exercises the shipped computeLivenessVerdict +
 * markAgentOffline: after the loser write, the live row must read ALIVE, not the
 * cached dead. (Guard: revert any of the four sites to the guarded `if` and this
 * goes red — the loser write no longer clears the negative entry.)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { _resetOwnHostIdForTests, processStartedAt } from "../src/liveness.js";

const TEST_ROOT = path.join(os.tmpdir(), "bot-relay-cacheinval-" + process.pid);
const TEST_DB_PATH = path.join(TEST_ROOT, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;

const OWN = "cacheinval-own-host-guid";
const LIVE_PID = process.pid; // this vitest process — alive
const DEAD_PID = 2_147_483_646; // far above any real pid — dead
const LIVE_START = processStartedAt(LIVE_PID);

beforeEach(async () => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  const { closeDb } = await import("../src/db.js");
  closeDb();
  process.env.RELAY_DB_PATH = TEST_DB_PATH;
  _resetOwnHostIdForTests(OWN); // pin getOwnHostId() so computeLivenessVerdict probes same-host
});
afterEach(async () => {
  _resetOwnHostIdForTests();
  const { closeDb } = await import("../src/db.js");
  closeDb();
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("v2.23.x — session/anchor writers invalidate the NEGATIVE probe cache on a CAS miss", () => {
  it("loser CAS-write (changes===0) after a rebind → the fresh live row reads ALIVE, not stale-dead", async () => {
    const { initializeDb, getDb, registerAgent, markAgentOffline, computeLivenessVerdict } = await import("../src/db.js");
    await initializeDb();
    registerAgent("loser", "builder", []);

    const S_OLD = "sess-OLD-dead";
    const S_NEW = "sess-NEW-live";

    // 1. The prior (dead) session: dead anchor + old session_id, same host.
    getDb()
      .prepare("UPDATE agents SET session_id = ?, agent_pid = ?, agent_pid_start = NULL, host_id = ? WHERE name = ?")
      .run(S_OLD, DEAD_PID, OWN, "loser");

    // 2. Probe it → dead → this POPULATES the negative probe cache for "loser".
    const deadRow = { name: "loser", host_id: OWN, agent_pid: DEAD_PID, agent_pid_start: null };
    expect(computeLivenessVerdict(deadRow)).toBe("dead");

    // 3. A concurrent rebind lands: a NEW live session + a live anchor.
    getDb()
      .prepare("UPDATE agents SET session_id = ?, agent_pid = ?, agent_pid_start = ? WHERE name = ?")
      .run(S_NEW, LIVE_PID, LIVE_START, "loser");

    // 4. The prior terminal's offline write arrives with the STALE session_id →
    //    CAS `WHERE session_id = S_OLD` misses (session is now S_NEW) → changes===0.
    const res = markAgentOffline("loser", S_OLD);
    expect(res.changed, "the offline write is a CAS loser").toBe(false);

    // 5. THE FIX: that loser write cleared the negative cache, so a re-probe of the
    //    now-live row reads ALIVE. Without the unconditional clear, the stale
    //    negative entry (step 2) would still label this anchored row `dead`.
    const liveRow = { name: "loser", host_id: OWN, agent_pid: LIVE_PID, agent_pid_start: LIVE_START };
    expect(computeLivenessVerdict(liveRow)).toBe("alive");
  });

  it("sanity: the live-anchor row is genuinely alive absent any stale cache", async () => {
    const { initializeDb, getDb, registerAgent, computeLivenessVerdict } = await import("../src/db.js");
    await initializeDb();
    registerAgent("fresh", "builder", []);
    getDb()
      .prepare("UPDATE agents SET session_id = ?, agent_pid = ?, agent_pid_start = ?, host_id = ? WHERE name = ?")
      .run("s", LIVE_PID, LIVE_START, OWN, "fresh");
    expect(computeLivenessVerdict({ name: "fresh", host_id: OWN, agent_pid: LIVE_PID, agent_pid_start: LIVE_START })).toBe("alive");
  });
});
