// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Doorbell PR 6: the BOARD cases (plan §v4; architect R1 ruling 5dda2752). Mail with no way to
 * deliver it is a board case, never a ring:
 *   - no_live_window: no binding whose WINDOW is alive (dead, a sole unverifiable one, or none);
 *   - ambiguous_binding: 2 or more bindings NOT proven dead (Q4: never a guess);
 *   - session_unbound: one live window, no relay reading session (V4).
 * "Current" is per window anchor, not per name: a dead window's binding stays current by design
 * (MEASURED on the live DB at the R1 gate: 61 current bindings, 0 superseded, victra 6, victra-build
 * 5, 37 with no agent name). So the fixtures here are the states PRODUCTION produces (the B1
 * lesson): one live window beside several dead ones, nameless rows, windows on other hosts.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { randomUUID } from "crypto";

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "doorbell-pr6-")));
const DB = path.join(ROOT, "inst", "relay.db");
const STATE_DIR = path.join(ROOT, "inst", "doorbell");
const LOGP = path.join(STATE_DIR, "actuation.jsonl");
process.env.RELAY_DB_PATH = DB;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const C = await import("../src/doorbell-core.js");
const L = await import("../src/doorbell-log.js");
const db = await import("../src/db.js");
const R = await import("../src/doorbell-run.js");
const { readDoorbellStatus } = await import("../src/cli/doorbell.js");
const { getOwnHostId, processStartedAt, isUtcStartToken } = await import("../src/liveness.js");

type PendingRead = import("../src/doorbell-core.js").PendingRead;
type CandidateBinding = import("../src/doorbell-core.js").CandidateBinding;
type Verdict = "alive" | "dead" | "unverifiable";

const HOST = "HOST-A";
const RS = "1".repeat(64);
const bnd = (id: string, agent: string | null, host = HOST): CandidateBinding => ({ binding_id: id, agent_name: agent, host_id: host });
const read = (ids: string[], rs: string | null = RS): PendingRead => ({ registered: true, reading_session: rs, ids });
const board = (p: { board: import("../src/doorbell-log.js").BoardRecord[] }) => p.board.map((r) => [r.agent_name, r.case, r.state, r.binding_ids, r.dead_count, r.close_reason]);

interface World {
  bindings: CandidateBinding[];
  live: Record<string, Verdict>;
  reads: Record<string, PendingRead | "throw">;
  ownHostId?: string | null;
}
/** The job's loop minus I/O: plan, validate every record against the CLOSED schema, fold it. */
function harness(from: readonly import("../src/doorbell-log.js").LogRecord[] = []) {
  const state: import("../src/doorbell-log.js").LogState = { rung: new Set(), ringWalls: new Map(), lastHeaderWall: null, budgetExhausted: new Set(), boardOpen: new Map(), tornTail: false, records: [] };
  for (const r of from) L.foldRecord(state, r); // a RESTART: the state is rebuilt from the log alone
  const step = (w: World, t = 0) => {
    const p = C.planCycle({
      bindings: w.bindings,
      ownHostId: w.ownHostId === undefined ? HOST : w.ownHostId,
      pending: (name) => {
        const r = w.reads[name];
        if (!r || r === "throw") throw new Error(`the pending read for ${name} failed`);
        return r;
      },
      rung: state.rung,
      ringMono: new Map(),
      nowMono: t,
      budgetExhausted: state.budgetExhausted,
      liveness: (b) => {
        const v = w.live[b.binding_id];
        if (!v) throw new Error(`no liveness fixture for ${b.binding_id}`);
        return v;
      },
      // What the SSOT query (agentsWithPendingMail) finds: registered agents with pending mail.
      mailAgents: () => Object.entries(w.reads).flatMap(([k, r]) => (r !== "throw" && r.registered && r.ids.length > 0 ? [k] : [])),
      boardOpen: state.boardOpen,
      windowMs: C.DEFAULT_WINDOW_MS,
      budgetPerHour: 60,
      horizonMs: C.DEFAULT_HORIZON_MS,
      newIntentId: randomUUID,
      now: () => new Date(Date.parse("2026-10-06T04:00:00.000Z") + t).toISOString(),
    });
    for (const r of p.records) {
      expect(L.recordFault(r), JSON.stringify(r)).toBeNull();
      L.foldRecord(state, r);
    }
    return p;
  };
  return { step, state };
}

describe("PR 6: per-binding liveness decides, and only the PROVEN dead are set aside (ruling 5dda2752)", () => {
  it("PRODUCTION SHAPE: 1 live window + 5 dead current bindings → a ring candidate (ONE intent, on the live window), NOT ambiguous", () => {
    const bindings = ["d1", "d2", "d3", "live", "d4", "d5"].map((id) => bnd(id, "alice"));
    const live = Object.fromEntries(bindings.map((b) => [b.binding_id, b.binding_id === "live" ? "alive" : "dead"])) as Record<string, Verdict>;
    const p = harness().step({ bindings, live, reads: { alice: read(["m1"]) } });
    expect(p.intents.map((r) => r.intent.binding_id)).toEqual(["live"]);
    expect(p.board).toEqual([]);
  });
  it("HARM (Q4): 2 live windows → ambiguous_binding, NO intent, in EITHER row order (never the first of two)", () => {
    for (const order of [["a", "b"], ["b", "a"]]) {
      const p = harness().step({ bindings: [...order.map((id) => bnd(id, "alice")), bnd("dead", "alice")], live: { a: "alive", b: "alive", dead: "dead" }, reads: { alice: read(["m1"]) } });
      expect(p.intents, order.join()).toEqual([]);
      expect(board(p), order.join()).toEqual([["alice", "ambiguous_binding", "open", ["a", "b"], 1, null]]);
    }
  });
  it("HARM: 1 live + 1 UNVERIFIABLE → ambiguous (an anchor that cannot be shown dead is never discarded)", () => {
    const p = harness().step({ bindings: [bnd("a", "alice"), bnd("u", "alice")], live: { a: "alive", u: "unverifiable" }, reads: { alice: read(["m1"]) } });
    expect(p.intents).toEqual([]);
    expect(board(p)).toEqual([["alice", "ambiguous_binding", "open", ["a", "u"], 0, null]]);
  });
  it("HARM: every window dead → no_live_window (the deciding bindings are none; the dead are only counted)", () => {
    const p = harness().step({ bindings: ["x", "y", "z"].map((id) => bnd(id, "alice")), live: { x: "dead", y: "dead", z: "dead" }, reads: { alice: read(["m1"]) } });
    expect(p.intents).toEqual([]);
    expect(board(p)).toEqual([["alice", "no_live_window", "open", [], 3, null]]);
  });
  it("HARM: a SOLE unverifiable window (plan v3.2) → no_live_window: never a ring on an anchor that cannot be shown alive", () => {
    const p = harness().step({ bindings: [bnd("u", "alice"), bnd("d", "alice")], live: { u: "unverifiable", d: "dead" }, reads: { alice: read(["m1"]) } });
    expect(p.intents).toEqual([]);
    expect(board(p)).toEqual([["alice", "no_live_window", "open", ["u"], 1, null]]);
  });
  it("a window on ANOTHER host is never judged from here (unverifiable, never dead), and never rung", () => {
    const p = harness().step({ bindings: [bnd("here", "alice"), bnd("there", "alice", "HOST-B")], live: { here: "alive" }, reads: { alice: read(["m1"]) } });
    expect(p.intents).toEqual([]);
    expect(board(p)).toEqual([["alice", "ambiguous_binding", "open", ["here", "there"], 0, null]]);
  });
  it("bindings with NO agent name are not agents: 37 of them beside alice's one live window change nothing", () => {
    const nameless = Array.from({ length: 37 }, (_, i) => bnd(`n${i}`, null));
    const p = harness().step({ bindings: [...nameless, bnd("live", "alice")], live: { live: "alive" }, reads: { alice: read(["m1"]) } });
    expect(p.intents.map((r) => r.intent.binding_id)).toEqual(["live"]);
    expect(p.board).toEqual([]);
  });
  it("HARM: mail and NO binding at all → no_live_window (found through mailAgents: main never saw this agent)", () => {
    const p = harness().step({ bindings: [], live: {}, reads: { ghost: read(["m1"], null) } });
    expect(board(p)).toEqual([["ghost", "no_live_window", "open", [], 0, null]]);
  });
  it("HARM (V4): ONE live window and NO reading session → session_unbound, NO intent", () => {
    const p = harness().step({ bindings: [bnd("a", "alice"), bnd("d", "alice")], live: { a: "alive", d: "dead" }, reads: { alice: read(["m1"], null) } });
    expect(p.intents).toEqual([]);
    expect(board(p)).toEqual([["alice", "session_unbound", "open", ["a"], 1, null]]);
  });
  it("ruling Q6: NO pending mail → never a board case, whatever the bindings say", () => {
    const h = harness();
    expect(h.step({ bindings: [bnd("a", "alice"), bnd("b", "alice")], live: { a: "alive", b: "alive" }, reads: { alice: read([]) } }).board).toEqual([]);
    expect(h.step({ bindings: [bnd("x", "bob")], live: { x: "dead" }, reads: { bob: read([]) } }).board).toEqual([]);
  });
});

describe("PR 6, A3.2: logged ONCE per state change, from the LOG", () => {
  const dead = { bindings: [bnd("x", "alice")], live: { x: "dead" as Verdict } };
  it("HARM: the same case over 5 cycles → ONE open record; a RESTART from the log → nothing new", () => {
    const h = harness();
    const records = [0, 1, 2, 3, 4].flatMap((k) => h.step({ ...dead, reads: { alice: read(["m1"]) } }, k * 1000).board);
    expect(records.map((r) => [r.case, r.state])).toEqual([["no_live_window", "open"]]);
    const restarted = harness(h.state.records);
    expect(restarted.step({ ...dead, reads: { alice: read(["m1", "m2"]) } }).records).toEqual([]);
  });
  it("HARM (the not-evaluated HOLD): a failed pending read neither closes nor re-opens the case, and is listed in notEvaluated (never silent)", () => {
    const h = harness();
    h.step({ ...dead, reads: { alice: read(["m1"]) } });
    const held = h.step({ ...dead, reads: { alice: "throw" } });
    expect(held.board).toEqual([]);
    expect(held.notEvaluated).toEqual(["alice"]);
    expect(h.step({ ...dead, reads: { alice: read(["m1"]) } }).board).toEqual([]); // still the same case: no re-open
    expect([...h.state.boardOpen.keys()]).toEqual(["alice"]);
  });
  it("an UNKNOWN own host holds every case (no close, no open) and names them", () => {
    const h = harness();
    h.step({ ...dead, reads: { alice: read(["m1"]) } });
    const held = h.step({ ...dead, ownHostId: null, reads: { alice: read([]) } });
    expect(held.board).toEqual([]);
    expect(held.notEvaluated).toEqual(["alice"]);
  });
  it("transitions: X → Y closes X (resolved) and opens Y in the same cycle; the live session then resolves it and the agent RINGS (the twin)", () => {
    const h = harness();
    h.step({ ...dead, reads: { alice: read(["m1"]) } }); // no_live_window
    const reopened = h.step({ bindings: [bnd("x", "alice"), bnd("w", "alice")], live: { x: "dead", w: "alive" }, reads: { alice: read(["m1"], null) } }); // a window, no session
    expect(board(reopened)).toEqual([
      ["alice", "no_live_window", "closed", [], 1, "resolved"],
      ["alice", "session_unbound", "open", ["w"], 1, null],
    ]);
    const bound = h.step({ bindings: [bnd("x", "alice"), bnd("w", "alice")], live: { x: "dead", w: "alive" }, reads: { alice: read(["m1"]) } }); // re-registered: a session
    expect(board(bound)).toEqual([["alice", "session_unbound", "closed", ["w"], 1, "resolved"]]);
    expect(bound.intents.map((r) => r.intent.binding_id)).toEqual(["w"]);
  });
  it("the mail drained → the case closes no_mail", () => {
    const h = harness();
    h.step({ ...dead, reads: { alice: read(["m1"]) } });
    expect(board(h.step({ ...dead, reads: { alice: read([]) } }))).toEqual([["alice", "no_live_window", "closed", [], 1, "no_mail"]]);
    expect(h.state.boardOpen.size).toBe(0);
  });
});

describe("PR 6: the board record (CLOSED schema) and compaction", () => {
  const rec = (over: Record<string, unknown> = {}) => ({
    v: 1, type: "board", at: "2026-10-06T04:00:00.000Z", board_id: randomUUID(), agent_name: "alice", case: "ambiguous_binding", state: "open", binding_ids: ["a", "b"], dead_count: 0, pending_count: 1, close_reason: null, ...over,
  });
  it("valid; an extra key, free text, an open record with a close reason or no mail, or a wrong binding count per case is refused", () => {
    expect(L.recordFault(rec())).toBeNull();
    expect(L.recordFault({ ...rec(), note: "x" })).toMatch(/exactly/);
    expect(L.recordFault(rec({ case: "nobody home" }))).toMatch(/case must be one of/);
    expect(L.recordFault(rec({ close_reason: "resolved" }))).toMatch(/close_reason/);
    expect(L.recordFault(rec({ pending_count: 0 }))).toMatch(/close_reason is null while open \(with pending mail\)/);
    expect(L.recordFault(rec({ binding_ids: ["a"] }))).toMatch(/at least 2/);
    expect(L.recordFault(rec({ case: "session_unbound", binding_ids: [] }))).toMatch(/exactly 1/);
    expect(L.recordFault(rec({ binding_ids: ["b", "a"] }))).toMatch(/sorted/);
  });
  it("HARM: a compaction KEEPS an open case and drops a closed one; the reopened state still holds the open case", () => {
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(STATE_DIR), { recursive: true });
    const { handle } = L.openLog(STATE_DIR);
    const a = rec({ agent_name: "alice" });
    const b = rec({ agent_name: "bob", case: "no_live_window", binding_ids: [] });
    for (const r of [a, b, { ...b, state: "closed", close_reason: "no_mail", pending_count: 0 }]) L.appendRecord(handle, r as never);
    const out = L.compactLog(handle, () => false);
    try {
      expect(out.state.records.filter((r) => r.type === "board")).toEqual([a]);
      expect([...out.state.boardOpen.keys()]).toEqual(["alice"]);
    } finally {
      L.closeLog(out.handle);
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// The real window anchor, and the real job.
const OWN = getOwnHostId();
const T = Date.parse("2026-10-06T04:00:00.000Z");
/** A pid that has EXITED (a child that ran and was reaped): its window is dead by kernel fact. */
const deadPid = (): number => spawnSync(process.execPath, ["-e", ""]).pid as number;
const bindWindow = (agent: string, pid: number, start: string, conv: string) =>
  db.upsertAgentBinding(db.getDb(), { hostId: OWN as string, windowPid: pid, windowPidStart: start, agentName: agent, agentClass: null, conversationId: conv, conversationTitle: null, cwd: ROOT, boundVia: "launch-intent" });
const recs = () => (fs.existsSync(LOGP) ? fs.readFileSync(LOGP, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
async function lifetime(wall: number): Promise<number> {
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const c = { wall, mono: 1_000_000, wallMs: () => c.wall, monoMs: () => c.mono };
    return await R.runDoorbell(["--once", "--window-s", "10", "--horizon-s", "60"], { clock: c });
  } finally {
    spy.mockRestore();
  }
}

describe.skipIf(!OWN)("PR 6: liveness is the WINDOW anchor's kernel fact (bindingLiveness)", () => {
  beforeEach(() => {
    db.closeDb();
    fs.rmSync(path.join(ROOT, "inst"), { recursive: true, force: true });
    fs.mkdirSync(path.join(ROOT, "inst"), { recursive: true });
    db.getDb();
    db.registerAgent("p6-alice", "r", []);
  });
  it("HARM: NULLing agents.agent_status AND agents.session_id leaves a live window ALIVE (never read from the agent row)", () => {
    const b = { host_id: OWN as string, agent_name: "p6-alice", window_pid: process.pid, window_pid_start: processStartedAt(process.pid) as string };
    expect(R.bindingLiveness(b, OWN)).toBe("alive");
    db.getDb().prepare("UPDATE agents SET agent_status = 'offline', session_id = NULL WHERE name = 'p6-alice'").run();
    expect(R.bindingLiveness(b, OWN)).toBe("alive");
  });
  it("an exited window pid is DEAD; no pid is UNVERIFIABLE; another host is UNVERIFIABLE", () => {
    expect(R.bindingLiveness({ host_id: OWN as string, window_pid: deadPid(), window_pid_start: processStartedAt(process.pid) as string }, OWN)).toBe("dead");
    expect(R.bindingLiveness({ host_id: OWN as string, window_pid: null, window_pid_start: null }, OWN)).toBe("unverifiable");
    expect(R.bindingLiveness({ host_id: "another-host", window_pid: process.pid, window_pid_start: processStartedAt(process.pid) as string }, OWN)).toBe("unverifiable");
  });
  it("plan v3.2's row: a LEGACY-form start token on a live window reads ALIVE today (during the transition), compared by form, never as raw strings", () => {
    const legacy = processStartedAt(process.pid, undefined, "legacy") as string;
    const utc = processStartedAt(process.pid) as string;
    expect([isUtcStartToken(legacy), isUtcStartToken(utc)]).toEqual([false, true]); // precondition: two different spellings
    expect(legacy).not.toBe(utc);
    expect(R.bindingLiveness({ host_id: OWN as string, window_pid: process.pid, window_pid_start: legacy }, OWN)).toBe("alive");
  });
});

describe.skipIf(!OWN)("PR 6: the real JOB on production-shaped bindings, and `relay doorbell status`", () => {
  beforeEach(() => {
    db.closeDb();
    fs.rmSync(path.join(ROOT, "inst"), { recursive: true, force: true });
    fs.mkdirSync(path.join(ROOT, "inst"), { recursive: true });
    process.env.RELAY_DB_PATH = DB;
    db.getDb();
    db.registerAgent("p6-sender", "s", []);
    db.registerAgent("p6-alice", "r", []);
  });
  const send = () => db.sendMessage("p6-sender", "p6-alice", "x", "normal").id;

  it("1 live window + 2 dead → RUNG on the live one; then a 2nd live window → ambiguous (no new intent); then only dead → no_live_window", async () => {
    const start = processStartedAt(process.pid) as string;
    bindWindow("p6-alice", deadPid(), start, "conv-dead-1");
    bindWindow("p6-alice", deadPid(), start, "conv-dead-2");
    bindWindow("p6-alice", process.pid, start, "conv-live");
    send();
    expect(await lifetime(T)).toBe(0);
    expect(recs().filter((r) => r.type === "intent").length).toBe(1);
    expect(recs().filter((r) => r.type === "board")).toEqual([]);
    // A SECOND live window for the same name (the parent process: alive by kernel fact).
    bindWindow("p6-alice", process.ppid, processStartedAt(process.ppid) as string, "conv-live-2");
    send();
    expect(await lifetime(T + 61_000)).toBe(0);
    expect(recs().filter((r) => r.type === "intent").length).toBe(1); // nothing rung: Q4 refuses
    expect(recs().filter((r) => r.type === "board").map((r) => [r.case, r.state, r.binding_ids.length, r.dead_count])).toEqual([["ambiguous_binding", "open", 2, 2]]);
  });

  it("the status verb lists the OPEN case with the LIVE pending count beside the snapshot at open, and the last cycle's not_evaluated", async () => {
    bindWindow("p6-alice", deadPid(), processStartedAt(process.pid) as string, "conv-dead");
    send();
    expect(await lifetime(T)).toBe(0);
    send();
    send(); // two more since the case opened
    const st = await readDoorbellStatus(DB, null, T + 1000);
    expect(st.board.live).toEqual({ ok: true });
    expect(st.board.items.map((i) => [i.agent, i.case, i.pending_count_at_open, i.pending_count, i.dead_count])).toEqual([["p6-alice", "no_live_window", 1, 3, 1]]);
    expect(st.not_evaluated).toEqual({ count: 0, names: [] });
    // drained: the next cycle closes it, and the verb lists nothing (closed cases are history)
    db.resolveMessages("p6-alice", (db.getDb().prepare("SELECT id FROM messages WHERE to_agent = 'p6-alice'").all() as Array<{ id: string }>).map((r) => r.id));
    expect(await lifetime(T + 61_000)).toBe(0);
    expect((await readDoorbellStatus(DB, null, T + 62_000)).board).toMatchObject({ open: 0, items: [] });
  });
});
