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
