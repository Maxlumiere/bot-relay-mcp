// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.23.x #140 — the FIVE session/anchor writers now evict BOTH probe caches
 * UNCONDITIONALLY. Written FROM THE HARM, one case per shipped writer/branch,
 * each independently revertible-to-red.
 *
 * THE HARM (codex's reproduction, generalised to all five). A dead anchor
 * populates the negative probe cache. A concurrent rebind lands a fresh session
 * + a LIVE anchor. The prior terminal's teardown then fires with the STALE
 * session_id → its CAS `WHERE … AND session_id = <old>` matches 0 rows
 * (r.changes === 0). If eviction is gated on r.changes (the braced fifth site,
 * or the four unbraced ones), the stale NEGATIVE entry SURVIVES and labels the
 * now-fresh, live, anchored row `dead` until the ~5s TTL. Unconditional eviction
 * — a CAS loser must not retain a verdict about a binding it failed to mutate —
 * fixes it: after the loser write, the live row reads ALIVE.
 *
 * REVERT-TO-RED. Re-gate ANY of the four CAS writers' evictions behind
 * `if (r.changes === 1) { … }` and THAT writer's case below goes red — the loser
 * write no longer clears the negative entry, so the live row reads `dead`. Each
 * case drives a DISTINCT shipped writer, so the five are independently covered.
 *
 * setAgentLivenessAnchor is the exception documented in its own case: its WHERE
 * is name-only (no session CAS), so r.changes === 0 ⇔ the row is absent ⇔ no
 * verdict is ever computed on it. Its braced form therefore has no observable
 * failing case; the case below proves the WINNER-path eviction fires, and the
 * probe-cache guard (tests/v2-23-0-probe-cache-guard.test.ts) enforces its
 * top-level eviction structurally.
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
const LIVE_PID = process.pid; // this vitest process — genuinely alive
const DEAD_PID = 2_147_483_646; // far above any real pid — genuinely dead
const LIVE_START = processStartedAt(LIVE_PID);
const S_OLD = "sess-OLD-dead";
const S_NEW = "sess-NEW-live";

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

/**
 * Seed the harm's precondition for `name`: a dead anchor under S_OLD, PROBED to
 * dead (populating the negative cache), then a concurrent rebind to a fresh live
 * session + anchor under S_NEW. Leaves the row live-but-negative-cached, exactly
 * as it is when a stale teardown arrives.
 */
async function seedDeadCachedThenRebind(name: string) {
  const db = await import("../src/db.js");
  db.registerAgent(name, "builder", []);
  // 1. Prior dead session: dead anchor + old session_id, same host.
  db.getDb()
    .prepare("UPDATE agents SET session_id = ?, agent_pid = ?, agent_pid_start = NULL, host_id = ? WHERE name = ?")
    .run(S_OLD, DEAD_PID, OWN, name);
  // 2. Probe it → dead → POPULATES the negative probe cache for `name`.
  expect(db.computeLivenessVerdict({ name, host_id: OWN, agent_pid: DEAD_PID, agent_pid_start: null })).toBe("dead");
  // 3. Concurrent rebind lands: NEW live session + a live anchor.
  db.getDb()
    .prepare("UPDATE agents SET session_id = ?, agent_pid = ?, agent_pid_start = ? WHERE name = ?")
    .run(S_NEW, LIVE_PID, LIVE_START, name);
}

const liveRow = (name: string) => ({ name, host_id: OWN, agent_pid: LIVE_PID, agent_pid_start: LIVE_START });

// The FOUR CAS writers/branches. Each returns { changed }; each is a CAS loser
// when called with S_OLD after the rebind. label → the shipped writer call.
const CAS_WRITERS: Array<{ label: string; run: (db: typeof import("../src/db.js"), name: string) => { changed: boolean } }> = [
  { label: "markAgentOffline", run: (db, name) => db.markAgentOffline(name, S_OLD) },
  { label: "closeAgentSession (null branch)", run: (db, name) => db.closeAgentSession(name, S_OLD, null) },
  { label: "closeAgentSession (signal branch)", run: (db, name) => db.closeAgentSession(name, S_OLD, "SIGTERM") },
  { label: "endAgentSessionOnSignal", run: (db, name) => db.endAgentSessionOnSignal(name, S_OLD, "SIGTERM") },
];

describe("#140 — the five session/anchor writers evict the negative probe cache on a CAS miss", () => {
  for (const { label, run } of CAS_WRITERS) {
    it(`${label}: CAS-loser write (changes===0) after a rebind → the fresh live row reads ALIVE, not stale-dead`, async () => {
      const db = await import("../src/db.js");
      await db.initializeDb();
      const name = "loser";
      await seedDeadCachedThenRebind(name);

      // The stale teardown fires with the OLD session → CAS `AND session_id = S_OLD`
      // misses (session is now S_NEW) → changes===0, a loser.
      const res = run(db, name);
      expect(res.changed, "the teardown is a CAS loser").toBe(false);

      // THE FIX: that loser write cleared the negative cache unconditionally, so a
      // re-probe of the now-live row reads ALIVE. Braced (changes-gated) eviction
      // would leave the stale negative entry and this would read `dead`.
      expect(db.computeLivenessVerdict(liveRow(name))).toBe("alive");
    });
  }

  it("setAgentLivenessAnchor: stamping a live anchor over a dead-cached row evicts the negative entry → reads ALIVE (winner-path; see header re: no CAS)", async () => {
    const db = await import("../src/db.js");
    await db.initializeDb();
    const name = "anchored";
    db.registerAgent(name, "builder", []);
    // Dead anchor, same host → probe → dead → negative cache populated.
    db.getDb()
      .prepare("UPDATE agents SET session_id = ?, agent_pid = ?, agent_pid_start = NULL, host_id = ? WHERE name = ?")
      .run("s", DEAD_PID, OWN, name);
    expect(db.computeLivenessVerdict({ name, host_id: OWN, agent_pid: DEAD_PID, agent_pid_start: null })).toBe("dead");
    // The shipped writer stamps a LIVE anchor; its unconditional eviction drops
    // the stale negative so the freshly-anchored row reads alive.
    expect(db.setAgentLivenessAnchor(name, LIVE_PID, LIVE_START)).toBe(true);
    expect(db.computeLivenessVerdict(liveRow(name))).toBe("alive");
  });

  it("sanity: a live-anchor row is genuinely alive absent any stale cache", async () => {
    const db = await import("../src/db.js");
    await db.initializeDb();
    db.registerAgent("fresh", "builder", []);
    db.getDb()
      .prepare("UPDATE agents SET session_id = ?, agent_pid = ?, agent_pid_start = ?, host_id = ? WHERE name = ?")
      .run("s", LIVE_PID, LIVE_START, OWN, "fresh");
    expect(db.computeLivenessVerdict(liveRow("fresh"))).toBe("alive");
  });
});
