// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * INV-LIVE-01 (architect rulings 476e65f1 + fedac068): UNREADABLE IS NOT GONE.
 *
 * `processStartedAt` returned null both for "no such process" and for ANY failed `ps` read (its runner
 * swallows ETIMEDOUT: a SIGSTOP or a sleep mid-read counts against the 2 s timeout). A watch read that
 * null as "its window is gone" and exited silently (#313's D2 red). The read is now tri-state (start /
 * gone / unreadable), `gone` only by kernel fact (ESRCH), and each caller class acts on its own rule:
 *   EXIT (the watch): only gone exits; unreadable = no action.
 *   GATE (arm-time ownership, the deploy gate): unreadable blocks, NAMED (cannot_judge / cannot read).
 *   DISPLAY (the supervisor, status): unknown, never absent / dead / live; K unknown cycles in a row
 *   raise their own board case, cannot_observe(watch), never no_driver.
 * The REAL-process pin (the D2 scenario under a slow `ps`) and its twin live in doorbell-pr7-watch.
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "inv-live-01-")));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const Lv = await import("../src/liveness.js");
const O = await import("../src/watch-owner.js");
const WU = await import("../src/cli/watch-until-wake.js");
const C = await import("../src/doorbell-core.js");
const L = await import("../src/doorbell-log.js");
const W = await import("../src/watch-wake.js");

type ProcessStart = import("../src/liveness.js").ProcessStart;
const errno = (code: string) => Object.assign(new Error(code), { code });
/** A kill(pid, 0) probe: each call's answer in turn (the last repeats), every call recorded. */
function killSeq(...answers: Array<"exists" | "ESRCH" | "EPERM" | "EINVAL">) {
  const calls: number[] = [];
  const probe = (pid: number) => {
    calls.push(pid);
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (a === "exists") return;
    throw errno(a);
  };
  return { probe, calls };
}
const runner = (out: string) => () => out;
const RAW = "Thu Oct  1 07:37:33 2026";

describe("processStartedAt: start / gone / unreadable, gone ONLY by kernel fact", () => {
  it("a readable start → start (UTC form carries the suffix)", () => {
    expect(Lv.processStartedAt(4242, runner(`${RAW}  \n`), "utc", killSeq("exists").probe)).toEqual({ kind: "start", start: `${RAW} UTC` });
  });
  it("ESRCH → gone, decided BEFORE ps is trusted (ps is never run)", () => {
    let ran = 0;
    const r = Lv.processStartedAt(4242, () => (ran++, `${RAW}\n`), "utc", killSeq("ESRCH").probe);
    expect(r).toEqual({ kind: "gone" });
    expect(ran).toBe(0);
  });
  it("HARM (the D2 root cause): ps fails or times out (empty output) for a pid that still EXISTS → unreadable, never gone", () => {
    const r = Lv.processStartedAt(4242, runner(""), "utc", killSeq("exists").probe);
    expect(r.kind).toBe("unreadable");
  });
  it("EPERM (another user's live process) + no ps output → unreadable", () => {
    expect(Lv.processStartedAt(4242, runner(""), "utc", killSeq("EPERM").probe).kind).toBe("unreadable");
  });
  it("a kill probe that cannot say (EINVAL) + no ps output → unreadable (never gone without ESRCH)", () => {
    expect(Lv.processStartedAt(4242, runner(""), "utc", killSeq("EINVAL").probe).kind).toBe("unreadable");
  });
  it("the process ENDS between the probe and the read → gone (the kernel is asked again after an empty read)", () => {
    const k = killSeq("exists", "ESRCH");
    expect(Lv.processStartedAt(4242, runner(""), "utc", k.probe)).toEqual({ kind: "gone" });
    expect(k.calls).toEqual([4242, 4242]);
  });
  it("a non-positive or non-integer pid is never signalled (kill(0) / kill(-n) probe process GROUPS) → unreadable", () => {
    const k = killSeq("exists");
    for (const pid of [0, -1, -4242, 1.5, Number.NaN]) expect(Lv.processStartedAt(pid, runner(`${RAW}\n`), "utc", k.probe).kind).toBe("unreadable");
    expect(k.calls).toEqual([]);
  });
  it("the REAL process table: this process → start; a pid that does not exist → gone", () => {
    expect(Lv.processStartedAt(process.pid).kind).toBe("start");
    let dead = 999_999;
    while (dead > 1000 && Lv.isPidAlive(dead)) dead--;
    expect(Lv.processStartedAt(dead)).toEqual({ kind: "gone" });
  });
  it("anchorState: same / gone (ESRCH, or ANOTHER start on the pid) / unknown (unreadable)", () => {
    expect(Lv.anchorState({ kind: "start", start: "A" }, "A")).toBe("same");
    expect(Lv.anchorState({ kind: "start", start: "B" }, "A")).toBe("gone");
    expect(Lv.anchorState({ kind: "gone" }, "A")).toBe("gone");
    expect(Lv.anchorState({ kind: "unreadable", why: "x" }, "A")).toBe("unknown");
  });
});

describe("GATE: arm-time ownership refuses an unreadable start as cannot_judge (fail closed, NAMED)", () => {
  // self 300 → shell 200 → window 100 → launchd 1
  const table = () =>
    new Map(
      [
        { pid: 300, ppid: 200, startedAt: "S300", command: "node" },
        { pid: 200, ppid: 100, startedAt: "S200", command: "zsh" },
        { pid: 100, ppid: 1, startedAt: "S100", command: "claude" },
      ].map((e) => [e.pid, e]),
    );
  const st = (start: string): ProcessStart => ({ kind: "start", start });
  const bnd = { binding_id: "b1", agent_name: "bob", host_id: "H", window_pid: 100, window_pid_start: "S100" };
  const deps = (o: Partial<import("../src/watch-owner.js").OwnerDeps> = {}): import("../src/watch-owner.js").OwnerDeps => ({
    table,
    startNow: (pid) => st(`S${pid}`),
    sameProcess: (pid, stored) => stored === `S${pid}`,
    liveness: () => "alive",
    ...o,
  });
  it("the control: every start readable → owned", () => {
    expect(O.resolveOwnership(300, [bnd], "H", deps())).toEqual({ ok: true, window: { pid: 100, start: "S100" } });
  });
  it("HARM: the window hop's start is UNREADABLE now → cannot_judge, never no_bound_ancestor", () => {
    const r = O.resolveOwnership(300, [bnd], "H", deps({ startNow: (pid) => (pid === 100 ? { kind: "unreadable", why: "ps timed out" } : st(`S${pid}`)) }));
    expect(r).toEqual({ ok: false, why: "cannot_judge" });
  });
  it("HARM: the binding's stored token cannot be compared (its read is unreadable) → cannot_judge", () => {
    expect(O.resolveOwnership(300, [bnd], "H", deps({ sameProcess: () => "unreadable" }))).toEqual({ ok: false, why: "cannot_judge" });
  });
  it("HARM (P2): an EMPTY process snapshot is a failed read → cannot_judge, never reparented", () => {
    expect(O.resolveOwnership(300, [bnd], "H", deps({ table: () => new Map() }))).toEqual({ ok: false, why: "cannot_judge" });
  });
  it("a hop that is GONE (ESRCH) is no longer that process → skipped, as before (no_bound_ancestor)", () => {
    expect(O.resolveOwnership(300, [bnd], "H", deps({ startNow: (pid) => (pid === 100 ? { kind: "gone" } : st(`S${pid}`)) }))).toEqual({ ok: false, why: "no_bound_ancestor" });
  });
  it("cannot_judge has its own refusal text", () => {
    expect(O.REFUSAL_TEXT.cannot_judge).toMatch(/cannot be read/);
  });
});

describe("EXIT: a running watch's window is GONE only by kernel fact", () => {
  const win = { pid: 100, start: "S100" };
  const bs = [{ binding_id: "b1", agent_name: "bob", host_id: "H", window_pid: 100, window_pid_start: "S100" }];
  const deps = (r: ProcessStart) => ({ liveness: () => "alive" as const, startNow: () => r });
  it("HARM (the D2 path): the window's start UNREADABLE → never window_gone; the binding checks still run (owner)", () => {
    expect(O.stillOwner(win, bs, "H", deps({ kind: "unreadable", why: "ps timed out" }), new Set())).toEqual({ ok: true });
  });
  it("the twin: ESRCH → window_gone; another start on the pid → window_gone", () => {
    expect(O.stillOwner(win, bs, "H", deps({ kind: "gone" }), new Set())).toEqual({ ok: false, why: "window_gone" });
    expect(O.stillOwner(win, bs, "H", deps({ kind: "start", start: "S-OTHER" }), new Set())).toEqual({ ok: false, why: "window_gone" });
  });
});

describe("the birth anchor (architect fedac068 (a)): captured ONCE, never adopted later", () => {
  const seq = (...rs: ProcessStart[]) => {
    let i = 0;
    const read = () => rs[Math.min(i++, rs.length - 1)];
    return { read, reads: () => i };
  };
  const U: ProcessStart = { kind: "unreadable", why: "ps timed out" };
  it("unreadable twice, then readable → captured (immediate retries)", () => {
    const s = seq(U, U, { kind: "start", start: "P" });
    expect(WU.captureBirthStart(42, s.read)).toBe("P");
    expect(s.reads()).toBe(3);
  });
  it("never readable → null after 1 + BIRTH_START_RETRIES reads (bounded)", () => {
    const s = seq(U);
    expect(WU.captureBirthStart(42, s.read)).toBeNull();
    expect(s.reads()).toBe(1 + WU.BIRTH_START_RETRIES);
    expect(WU.BIRTH_START_RETRIES).toBe(3);
  });
  it("gone at birth → null at once (no retries)", () => {
    const s = seq({ kind: "gone" });
    expect(WU.captureBirthStart(42, s.read)).toBeNull();
    expect(s.reads()).toBe(1);
  });
  const parent = (start: string | null) => ({ pid: 42, start, parent: true });
  const read = (r: ProcessStart) => () => r;
  it("HARM: the parent's start UNREADABLE, still our parent → NOT gone (stay dormant)", () => {
    expect(WU.anchorGone(parent("P"), read(U), 42)).toBe(false);
    expect(WU.anchorGone(parent(null), read(U), 42)).toBe(false);
  });
  it("the twin: REPARENTED (our ppid is no longer it) → gone, even with an unreadable start (POSIX)", () => {
    expect(WU.anchorGone(parent(null), read(U), 1)).toBe(true);
    expect(WU.anchorGone(parent("P"), read(U), 1)).toBe(true);
  });
  it("ESRCH → gone; another start on the pid → gone only when a start was captured at birth", () => {
    expect(WU.anchorGone(parent(null), read({ kind: "gone" }), 42)).toBe(true);
    expect(WU.anchorGone(parent("P"), read({ kind: "start", start: "IMPOSTOR" }), 42)).toBe(true);
    // never captured: a start read now is NEVER adopted (an impostor's would make the watch immortal), nor compared
    expect(WU.anchorGone(parent(null), read({ kind: "start", start: "IMPOSTOR" }), 42)).toBe(false);
  });
  it("the WINDOW anchor: unreadable → not gone; ESRCH or another start → gone (no reparent rule)", () => {
    const w = { pid: 100, start: "S100" };
    expect(WU.anchorGone(w, read(U), 1)).toBe(false);
    expect(WU.anchorGone(w, read({ kind: "gone" }), 1)).toBe(true);
    expect(WU.anchorGone(w, read({ kind: "start", start: "S-OTHER" }), 1)).toBe(true);
    expect(WU.anchorGone(w, read({ kind: "start", start: "S100" }), 1)).toBe(false);
  });
});

describe("DISPLAY: the supervisor never reports an unobservable watch as absent; K cycles → cannot_observe(watch)", () => {
  type Fit = import("../src/doorbell-core.js").WatchFit;
  const RS = "1".repeat(64);
  const HOST = "HOST-A";
  function harness() {
    const state: import("../src/doorbell-log.js").LogState = { rung: new Set(), ringWalls: new Map(), lastHeaderWall: null, budgetExhausted: new Set(), boardOpen: new Map(), tornTail: false, records: [] };
    let ticks: ReadonlyMap<string, number> = new Map();
    const step = (fit: Fit["status"], opts: { readThrows?: boolean } = {}) => {
      const p = C.planCycle({
        bindings: [{ binding_id: "w1", agent_name: "alice", host_id: HOST }],
        ownHostId: HOST,
        pending: () => {
          if (opts.readThrows) throw new Error("the pending read failed");
          return { registered: true, reading_session: RS, ids: ["m1"] };
        },
        rung: state.rung,
        ringMono: new Map(),
        nowMono: 0,
        budgetExhausted: state.budgetExhausted,
        liveness: () => "alive",
        mailAgents: () => ["alice"],
        boardOpen: state.boardOpen,
        watchFit: () => ({ status: fit, undeliveredAfterWake: false }),
        watchUnknownTicks: ticks,
        windowMs: C.DEFAULT_WINDOW_MS,
        budgetPerHour: 60,
        horizonMs: C.DEFAULT_HORIZON_MS,
        newIntentId: randomUUID,
        now: () => "2026-10-12T04:00:00.000Z",
      });
      for (const r of p.records) {
        expect(L.recordFault(r), JSON.stringify(r)).toBeNull();
        L.foldRecord(state, r);
      }
      ticks = p.watchUnknownTicks;
      return p;
    };
    const open = () => [...state.boardOpen.values()].map((r) => `${r.case}${r.why ? `(${r.why})` : ""}`);
    return { step, open };
  }
  const K = C.CANNOT_OBSERVE_AFTER_TICKS;
  it("K is the ruled provisional 5", () => expect(K).toBe(5));
  it("HARM: an UNKNOWN watch is never boarded no_driver(watch_absent), and forms no intent", () => {
    const h = harness();
    for (let i = 0; i < K + 2; i++) {
      const p = h.step("unknown");
      expect(p.board.some((r) => r.case === "no_driver")).toBe(false);
      expect(p.intents).toEqual([]);
    }
  });
  it("below K the board is HELD (nothing opens); at the K-th consecutive cycle cannot_observe(watch) opens ONCE", () => {
    const h = harness();
    for (let i = 1; i < K; i++) {
      expect(h.step("unknown").board, `cycle ${i}`).toEqual([]);
      expect(h.open()).toEqual([]);
    }
    const p = h.step("unknown");
    expect(p.board.map((r) => [r.case, r.state, r.why])).toEqual([["cannot_observe", "open", "watch"]]);
    expect(h.open()).toEqual(["cannot_observe(watch)"]);
    expect(h.step("unknown").board).toEqual([]); // unchanged: written once per state change
  });
  it("an OPEN no_driver case is HELD (not closed as resolved) while the watch reads unknown below K", () => {
    const h = harness();
    h.step("absent");
    expect(h.open()).toEqual(["no_driver(watch_absent)"]);
    for (let i = 1; i < K; i++) expect(h.step("unknown").board).toEqual([]);
    expect(h.open()).toEqual(["no_driver(watch_absent)"]);
    const p = h.step("unknown"); // the K-th: the case MOVES (closed, then the new one opened)
    expect(p.board.map((r) => [r.case, r.state])).toEqual([["no_driver", "closed"], ["cannot_observe", "open"]]);
  });
  it("RECOVERY clears it: the watch observed live again → cannot_observe closes (resolved); the count restarts", () => {
    const h = harness();
    for (let i = 0; i < K; i++) h.step("unknown");
    expect(h.open()).toEqual(["cannot_observe(watch)"]);
    const p = h.step("live");
    expect(p.board.map((r) => [r.case, r.state, r.close_reason])).toEqual([["cannot_observe", "closed", "resolved"]]);
    expect(p.watchUnknownTicks.has("alice")).toBe(false);
    for (let i = 1; i < K; i++) expect(h.step("unknown").board).toEqual([]); // counting from zero again
  });
  it("an interruption resets the run: K-1 unknown, one live, K-1 unknown → still nothing (CONSECUTIVE cycles)", () => {
    const h = harness();
    for (let i = 1; i < K; i++) h.step("unknown");
    h.step("live");
    for (let i = 1; i < K; i++) expect(h.step("unknown").board).toEqual([]);
    expect(h.open()).toEqual([]);
  });
  it("a cycle that could not evaluate the agent (a HOLD) keeps its count, neither resetting nor advancing it", () => {
    const h = harness();
    for (let i = 1; i < K; i++) h.step("unknown");
    expect(h.step("unknown", { readThrows: true }).watchUnknownTicks.get("alice")).toBe(K - 1);
    expect(h.step("unknown").board.map((r) => r.case)).toEqual(["cannot_observe"]);
  });
});

describe("the board record schema: cannot_observe carries why=watch; the enum lookup is own-key only", () => {
  const rec = (o: Record<string, unknown>) => ({ v: 1, type: "board", at: "2026-10-12T04:00:00.000Z", board_id: randomUUID(), agent_name: "alice", case: "cannot_observe", state: "open", binding_ids: ["w1"], dead_count: 0, pending_count: 1, close_reason: null, why: "watch", ...o });
  it("valid with why=watch; refused without why, with no_driver's why, or with free text", () => {
    expect(L.recordFault(rec({}))).toBeNull();
    const { why: _drop, ...noWhy } = rec({});
    expect(L.recordFault(noWhy)).toMatch(/why/);
    expect(L.recordFault(rec({ why: "watch_absent" }))).toMatch(/why must be one of watch/);
    expect(L.recordFault(rec({ why: "the ps timed out" }))).toMatch(/why must be one of watch/);
  });
  it("no_driver keeps its own enum; a case with no why refuses one", () => {
    expect(L.recordFault(rec({ case: "no_driver", why: "watch_absent" }))).toBeNull();
    expect(L.recordFault(rec({ case: "no_driver", why: "watch" }))).toMatch(/why must be one of watch_absent, watch_stale/);
    expect(L.recordFault(rec({ case: "session_unbound" }))).toMatch(/why only on/);
  });
  it("HARM: a hostile case naming a prototype key ('constructor', '__proto__') is refused, never a crash", () => {
    for (const c of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(() => L.recordFault(rec({ case: c }))).not.toThrow();
      expect(L.recordFault(rec({ case: c }))).not.toBeNull();
    }
  });
});

describe("DISPLAY: dormant watches whose process cannot be judged are counted apart, never alive", () => {
  it("live / gone / unknown are three different counts", () => {
    const agentDir = path.join(ROOT, "agent");
    fs.mkdirSync(path.join(agentDir, W.DORMANT_DIR), { recursive: true });
    for (const [pid, start] of [[11, "A"], [12, "B"], [13, null]] as const) fs.writeFileSync(path.join(agentDir, W.DORMANT_DIR, `${pid}.json`), JSON.stringify({ v: 1, pid, proc_start: start, reason: "r", at: "2026-10-12T04:00:00.000Z" }));
    const verdict: Record<number, "live" | "gone" | "unknown"> = { 11: "live", 12: "gone", 13: "unknown" };
    expect(W.countLiveDormant(agentDir, (pid) => verdict[pid])).toEqual({ live: 1, unknown: 1 });
  });
});
