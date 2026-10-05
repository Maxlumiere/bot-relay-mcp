// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Doorbell PR 3 — the JOB on a real relay DB, one `--once` LIFETIME at a time with a fake
 * clock (a test seam the command line cannot reach). Each lifetime starts by compacting the
 * log, so everything PR 3 needs must survive a restart AND a compaction:
 *   - (ruling c04f463a, added test 2) a restart at counter = 2, then ONE more ineffective
 *     ring, opens the escalation: not three more;
 *   - V1: the whole escalation path leaves the relay DB logically unchanged (no relay message);
 *   - V3: --operator is attribution on the escalation record only;
 *   - Q1: across a restart, an IMPLAUSIBLE wall age restarts the horizon from now (fail safe);
 *   - the command line: --horizon-s is bounded and never shorter than the window.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "doorbell-pr3-job-")));
const DB = path.join(ROOT, "inst", "relay.db");
const LOGP = path.join(ROOT, "inst", "doorbell", "actuation.jsonl");
process.env.RELAY_DB_PATH = DB;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const db = await import("../src/db.js");
const L = await import("../src/doorbell-log.js");
const { runDoorbell } = await import("../src/doorbell-run.js");
const { getOwnHostId, processStartedAt } = await import("../src/liveness.js");

const HOST = getOwnHostId();
const T = Date.parse("2026-10-02T08:00:00.000Z");
const STEP = 61_000; // just over the smallest horizon (60 s)
const recs = () => (fs.existsSync(LOGP) ? fs.readFileSync(LOGP, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const ofType = (t: string) => recs().filter((r) => r.type === t);
const send = () => db.sendMessage("p3-sender", "p3-alice", "x", "normal").id;

function fakeClock(wall: number, mono = 1_000_000) {
  const c = { wall, mono, wallMs: () => c.wall, monoMs: () => c.mono };
  return c;
}
async function job(argv: string[], opts: import("../src/doorbell-run.js").DoorbellOptions = {}): Promise<{ code: number; stderr: string }> {
  let stderr = "";
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((ch: unknown) => ((stderr += String(ch)), true));
  try {
    return { code: await runDoorbell(argv, opts), stderr };
  } finally {
    spy.mockRestore();
  }
}
/** One LIFETIME at a given wall time: the smallest horizon, a short window. */
const lifetime = (wall: number, extra: string[] = []) => job(["--once", "--window-s", "10", "--horizon-s", "60", ...extra], { clock: fakeClock(wall) });
/** The relay DB's logical content (V1: the doorbell never changes it). */
const relaySnapshot = () =>
  JSON.stringify([
    db.getDb().prepare("SELECT * FROM messages ORDER BY id").all(),
    db.getDb().prepare("SELECT * FROM agents ORDER BY name").all(),
    db.getDb().prepare("SELECT * FROM agent_bindings ORDER BY binding_id").all(),
  ]);

beforeEach(() => {
  db.closeDb();
  fs.rmSync(path.join(ROOT, "inst"), { recursive: true, force: true });
  fs.mkdirSync(path.join(ROOT, "inst"), { recursive: true });
  process.env.RELAY_DB_PATH = DB;
  db.getDb();
  db.registerAgent("p3-sender", "s", []);
  db.registerAgent("p3-alice", "r", []);
  if (!HOST) return; // no host identity: the job suites that need a binding are skipped
  db.upsertAgentBinding(db.getDb(), {
    hostId: HOST as string,
    windowPid: process.pid,
    windowPidStart: processStartedAt(process.pid) as string,
    agentName: "p3-alice",
    agentClass: null,
    conversationId: "conv-p3",
    conversationTitle: null,
    cwd: ROOT,
    boundVia: "launch-intent",
  });
});

describe.skipIf(!HOST)("PR 3 job: the counter survives restarts and compactions", () => {
  it("HARM (ruling c04f463a test 2): a restart at counter = 2, then ONE more ineffective ring → the escalation opens (not three more)", async () => {
    send();
    for (let k = 0; k < 3; k++) expect((await lifetime(T + k * STEP)).code).toBe(0); // ring, re-ring, re-ring
    expect(ofType("effect").map((e) => e.outcome)).toEqual(["ineffective", "ineffective"]); // counter = 2 at this restart
    expect(ofType("escalation")).toEqual([]);
    const r = await lifetime(T + 3 * STEP); // the 3rd ring is judged: counter = 3
    expect(r.code).toBe(0);
    expect(ofType("escalation").map((e) => [e.reason, e.state])).toEqual([["agent_unresponsive", "open"]]);
    expect(r.stderr).toMatch(/escalation open \(agent_unresponsive\) for p3-alice/);
    for (let k = 4; k < 8; k++) await lifetime(T + k * STEP); // and nothing more is rung
    expect(ofType("intent")).toHaveLength(3);
    expect(ofType("escalation")).toHaveLength(1);
  });

  it("D2 (review 2fda069b): the LAST RESET's intent is dropped by a real compaction, yet the counter stays exact: no early escalation", async () => {
    // Budget 1 (rule (b) keeps only the newest intent) and lifetimes 2 h apart (rule (a)
    // keeps nothing), so a real start-up compaction reaches the last-reset keep rule.
    const TWO_H = 7_200_000;
    const life = (k: number) => lifetime(T + k * TWO_H, ["--budget-per-hour", "1"]);
    const x = send();
    const z = send();
    await life(0); // A {x, z}
    db.resolveMessages("p3-alice", [z]);
    await life(1); // progress (z): reset; x re-rung (2)
    await life(2); // ineffective (1); x re-rung (3)
    const y = send();
    await life(3); // ineffective (2); x at the cap → id_stuck; B {y}
    const B = ofType("intent").find((r) => r.covers.message_ids.includes(y))?.intent.intent_id;
    db.resolveMessages("p3-alice", [y]);
    send();
    await life(4); // progress (y): THE LAST RESET, judging B; C {w}
    await life(5); // compaction drops B; C is judged ineffective: the counter is 1, not 3
    expect(ofType("intent").some((r) => r.intent.intent_id === B)).toBe(false); // precondition: B was dropped
    expect(ofType("effect").filter((e) => e.outcome === "effective").map((e) => e.left)).toContainEqual([y]); // the reset survived
    expect(ofType("escalation").filter((e) => e.reason === "agent_unresponsive")).toEqual([]);
    expect(x).not.toBe(y);
  });

  it("twin: the agent drains between restarts → the counter resets (an effective record); no escalation", async () => {
    const m1 = send();
    await lifetime(T);
    await lifetime(T + STEP); // counter = 1, re-ring
    db.resolveMessages("p3-alice", [m1]);
    send();
    await lifetime(T + 2 * STEP); // progress: effective, counter = 0; the new id rings
    for (let k = 3; k < 5; k++) await lifetime(T + k * STEP);
    expect(ofType("effect").map((e) => e.outcome)).toEqual(["ineffective", "effective", "ineffective", "ineffective"]);
    expect(ofType("escalation")).toEqual([]);
  });
});

describe.skipIf(!HOST)("PR 3 job: B1 (review 2fda069b): a closed window is a HOLD, never a session change", () => {
  const sessionOf = () => (db.getDb().prepare("SELECT session_id FROM agents WHERE name = 'p3-alice'").get() as { session_id: string | null }).session_id;
  /** A new window binding on the SAME anchor, reusing the start token the fixture stored (no second `ps`). */
  const bindWindow = (conversationId: string, windowPidStart: string) =>
    db.upsertAgentBinding(db.getDb(), {
      hostId: HOST as string,
      windowPid: process.pid,
      windowPidStart,
      agentName: "p3-alice",
      agentClass: null,
      conversationId,
      conversationTitle: null,
      cwd: ROOT,
      boundVia: "launch-intent",
    });

  it("HARM: escalate; the window closes (binding gone + markAgentOffline) → the escalation STAYS OPEN and the rings stay UNJUDGED; a new session → closed session_changed + the rescue ring", async () => {
    send();
    for (let k = 0; k < 4; k++) await lifetime(T + k * STEP); // escalation open at the 4th start
    send();
    await lifetime(T + 4 * STEP); // the one extra ring (new mail), now outstanding
    const extra = ofType("intent").find((r) => r.intent.during_escalation)?.intent.intent_id;
    expect(extra).toBeTruthy();
    // The window closes, as production does it: its binding is gone (fixture: superseded) AND
    // the relay's own close path NULLs the session (markAgentOffline, the real function).
    const anchorStart = (db.getDb().prepare("SELECT window_pid_start FROM agent_bindings WHERE agent_name = 'p3-alice' AND superseded_at IS NULL").get() as { window_pid_start: string }).window_pid_start;
    db.getDb().prepare("UPDATE agent_bindings SET superseded_at = ? WHERE agent_name = 'p3-alice' AND superseded_at IS NULL").run(new Date().toISOString());
    expect(db.markAgentOffline("p3-alice", sessionOf() as string).changed).toBe(true);
    expect(sessionOf()).toBeNull(); // precondition: unbound
    const before = recs().filter((r) => r.type !== "header").length;
    for (let k = 5; k < 10; k++) expect((await lifetime(T + k * STEP)).code).toBe(0); // well past every horizon
    expect(recs().filter((r) => r.type !== "header").length).toBe(before); // A3.2: nothing judged, written or closed
    expect(ofType("escalation").map((e) => e.state)).toEqual(["open"]);
    expect(ofType("effect").some((e) => e.intent_ids.includes(extra))).toBe(false);
    // A NEW session in a new window: the V4 rescue.
    db.registerAgent("p3-alice", "r", []);
    expect(sessionOf()).toBeTruthy();
    bindWindow("conv-p3-new", anchorStart);
    await lifetime(T + 10 * STEP);
    expect(ofType("escalation").map((e) => [e.state, e.close_reason])).toEqual([["open", null], ["closed", "session_changed"]]);
    expect(ofType("effect").filter((e) => e.outcome === "session_changed").map((e) => e.intent_ids)).toEqual([[extra]]);
    const rescue = ofType("intent").at(-1);
    expect([rescue.intent.during_escalation, rescue.covers.kinds.every((k: string) => k === "new"), rescue.covers.message_ids.length]).toEqual([false, true, 2]);
  });
});

describe.skipIf(!HOST)("PR 3 job: Codex R2 F1, a REAL crash between the 3rd ineffective record and the escalation", () => {
  it("HARM: the binding superseded by the PRODUCTION path (the window rebound to another agent; alice's session untouched), the escalation's append fails (the job stops) → the next start opens it", async () => {
    send();
    for (let k = 0; k < 3; k++) await lifetime(T + k * STEP); // rings 1..3
    // The window is rebound to another agent through the production upsert: alice's binding is superseded, her session is not cleared.
    db.registerAgent("p3-other", "r", []);
    const start = (db.getDb().prepare("SELECT window_pid_start FROM agent_bindings WHERE agent_name = 'p3-alice' AND superseded_at IS NULL").get() as { window_pid_start: string }).window_pid_start;
    db.upsertAgentBinding(db.getDb(), { hostId: HOST as string, windowPid: process.pid, windowPidStart: start, agentName: "p3-other", agentClass: null, conversationId: "conv-p3-other", conversationTitle: null, cwd: ROOT, boundVia: "launch-intent" });
    expect((db.getDb().prepare("SELECT COUNT(*) AS n FROM agent_bindings WHERE agent_name = 'p3-alice' AND superseded_at IS NULL").get() as { n: number }).n).toBe(0); // precondition: superseded
    expect((db.getDb().prepare("SELECT session_id FROM agents WHERE name = 'p3-alice'").get() as { session_id: string | null }).session_id).toBeTruthy(); // precondition: session live
    // THE CRASH: the escalation's write fails, after the 3rd ineffective record is durable.
    const io = { ...L.realLogIo, writeSync: (fd: number, buf: Buffer, off: number, len: number) => (buf.toString("utf-8").includes('"type":"escalation"') ? 0 : fs.writeSync(fd, buf, off, len)) };
    const crashed = await job(["--once", "--window-s", "10", "--horizon-s", "60"], { clock: fakeClock(T + 3 * STEP), logIo: io });
    expect(crashed.code).toBe(1); // a write that did not complete stops the job
    expect(ofType("effect").map((e) => e.outcome)).toEqual(["ineffective", "ineffective", "ineffective"]);
    expect(ofType("escalation")).toEqual([]); // precondition: the crash lost the escalation
    await lifetime(T + 4 * STEP); // the next start reconciles
    expect(ofType("escalation").map((e) => [e.reason, e.state])).toEqual([["agent_unresponsive", "open"]]);
    expect(ofType("intent").filter((r) => r.intent.agent_name === "p3-alice")).toHaveLength(3); // never rung again (no binding)
  });
});

describe.skipIf(!HOST)("PR 3 job: V1 and V3", () => {
  it("HARM (V1): ringing, judging, escalating and closing leave the relay DB logically UNCHANGED: no relay message, no row touched", async () => {
    const m1 = send();
    const before = relaySnapshot();
    for (let k = 0; k < 6; k++) await lifetime(T + k * STEP, ["--operator", "p3-ops"]);
    expect(ofType("escalation").map((e) => e.state)).toEqual(["open"]); // precondition: the path ran
    expect(relaySnapshot()).toBe(before);
    db.resolveMessages("p3-alice", [m1]);
    const afterResolve = relaySnapshot();
    await lifetime(T + 6 * STEP, ["--operator", "p3-ops"]);
    expect(ofType("escalation").map((e) => [e.state, e.close_reason])).toEqual([["open", null], ["closed", "progress"]]);
    expect(relaySnapshot()).toBe(afterResolve);
  });

  it("V3: --operator is written ONLY as the escalation's attribution; the operator is never rung", async () => {
    db.registerAgent("p3-ops", "o", []);
    send();
    for (let k = 0; k < 4; k++) await lifetime(T + k * STEP, ["--operator", "p3-ops"]);
    expect(ofType("escalation").map((e) => e.operator)).toEqual(["p3-ops"]);
    expect(ofType("intent").map((r) => r.intent.agent_name)).toEqual(["p3-alice", "p3-alice", "p3-alice"]);
  });
});

describe.skipIf(!HOST)("PR 3 job: the horizon across a restart (ruling c04f463a Q1)", () => {
  it("HARM (fail safe): an IMPLAUSIBLE wall age (the clock went back) restarts the horizon from now: no ineffective judgement yet", async () => {
    send();
    await lifetime(T);
    await lifetime(T - 600_000); // 10 min BEFORE the ring: implausible
    expect(ofType("effect")).toEqual([]);
  });
  it("HARM (fail safe): the restarted horizon judges the ring ONE H after this start (never later, as a future placement would)", async () => {
    send();
    await lifetime(T);
    const clock = fakeClock(T - 600_000); // this start is 10 min BEFORE the ring
    const r = await job(["--interval-ms", "1000", "--window-s", "10", "--horizon-s", "60"], {
      clock,
      beforeCycle: (n) => {
        if (n === 1) {
          clock.mono += 61_000;
          clock.wall += 61_000;
        }
        if (n === 2) process.emit("SIGTERM");
      },
    });
    expect(r.code).toBe(0);
    expect(ofType("effect").map((e) => e.outcome)).toEqual(["ineffective"]);
  }, 30_000);
  it("twin: a plausible wall age past H → judged ineffective at this start", async () => {
    send();
    await lifetime(T);
    await lifetime(T + STEP);
    expect(ofType("effect").map((e) => e.outcome)).toEqual(["ineffective"]);
  });
});

describe("PR 3 job: the command line", () => {
  it("--horizon-s out of bounds, not an integer, or shorter than --window-s → usage error (exit 2), nothing logged", async () => {
    for (const argv of [["--horizon-s", "59"], ["--horizon-s", "3601"], ["--horizon-s", "90.5"], ["--window-s", "300", "--horizon-s", "120"], ["--operator", "not a name!"]]) {
      const r = await job(["--once", ...argv]);
      expect([r.code, argv]).toEqual([2, argv]);
    }
    expect(fs.existsSync(LOGP)).toBe(false);
  });
});
