// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Doorbell PR 2 — coalescing and the ring budget (ADR-0038 Q3 + Q4; plan v3 PR 2; A3.2).
 *
 *   Q3: a per-agent last ring with a coalescing window W (≈ 60 s, tunable within bounds):
 *       ring at once, then nothing for that agent until W has passed; what arrived in
 *       between is covered by ONE intent at the end of W. One ring per burst.
 *   Q4: a per-agent budget (≈ 6 per hour). Over it, that agent is not rung and the fact
 *       is surfaced; this bounds any loop without enumerating its causes.
 *   A3.2: the budget state is logged ONCE per state change, and again when it changes.
 *   Both survive a restart: they are rebuilt from the log, never kept only in memory.
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const C = await import("../src/doorbell-core.js");
const L = await import("../src/doorbell-log.js");
type PendingRead = import("../src/doorbell-core.js").PendingRead;
type IntentRecord = import("../src/doorbell-log.js").IntentRecord;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "doorbell-pr2-"));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const HOST = "HOST-A";
const RS = "1".repeat(64);
const W = 60_000;
const T0 = Date.parse("2026-10-02T05:00:00.000Z");
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

/**
 * A tiny driver of the pure planner across cycles: it keeps exactly the state the job
 * keeps (rung memory, ring times, budget state), as the job's loop does.
 */
function harness(opts: { windowMs?: number; budgetPerHour?: number } = {}) {
  const rung = new Set<string>();
  const ringMono = new Map<string, number[]>(); // one lifetime: mono = ms since T0
  const exhausted = new Set<string>();
  const all: Array<IntentRecord | import("../src/doorbell-log.js").BudgetRecord> = [];
  const cycle = (atMs: number, ids: string[]) => {
    const reads: Record<string, PendingRead> = { alice: { registered: true, reading_session: RS, ids } };
    const p = C.planCycle({
      bindings: [{ binding_id: "b-alice", agent_name: "alice", host_id: HOST }],
      ownHostId: HOST,
      pending: (name) => reads[name],
      rung,
      ringMono,
      nowMono: atMs - T0,
      budgetExhausted: exhausted,
      liveness: () => "alive",
      mailAgents: () => Object.entries(reads).filter(([, r]) => r && r.registered && r.ids.length > 0).map(([k]) => k),
      boardOpen: new Map(),
      windowMs: opts.windowMs ?? W,
      budgetPerHour: opts.budgetPerHour ?? 6,
      horizonMs: C.DEFAULT_HORIZON_MS,
      newIntentId: uuid,
      now: () => new Date(atMs).toISOString(),
    });
    for (const r of p.budget) {
      if (r.state === "exhausted") exhausted.add(r.agent_name);
      else exhausted.delete(r.agent_name);
      all.push(r);
    }
    for (const r of p.intents) {
      for (const id of r.covers.message_ids) rung.add(L.rungKey(r.covers.reading_session, id));
      ringMono.set(r.intent.agent_name, [...(ringMono.get(r.intent.agent_name) ?? []), r.mono_ms]);
      all.push(r);
    }
    return p;
  };
  return { cycle, all, intents: () => all.filter((r): r is IntentRecord => r.type === "intent"), budgets: () => all.filter((r) => r.type === "budget") };
}

describe("Q3: one ring per burst (the coalescing window W)", () => {
  it("10 arrivals seen in one burst → exactly ONE intent covering all 10", () => {
    const h = harness();
    const ids = Array.from({ length: 10 }, (_, i) => `m${i}`);
    h.cycle(T0, ids);
    expect(h.intents()).toHaveLength(1);
    expect(h.intents()[0].covers.message_ids).toHaveLength(10);
  });
  it("arrivals INSIDE W after a ring are held (with a reason), then covered by ONE intent once W has passed", () => {
    const h = harness();
    h.cycle(T0, ["m1"]);
    const held = h.cycle(T0 + 10_000, ["m1", "m2"]);
    expect(held.intents).toEqual([]);
    expect(held.skipped).toMatchObject([{ agent_name: "alice", why: expect.stringMatching(/coalescing/) }]);
    h.cycle(T0 + 30_000, ["m1", "m2", "m3"]);
    h.cycle(T0 + W, ["m1", "m2", "m3"]);
    expect(h.intents().map((r) => r.covers.message_ids)).toEqual([["m1"], ["m2", "m3"]]);
  });
  it("twin: arrivals W + 1 s apart → TWO intents", () => {
    const h = harness();
    h.cycle(T0, ["m1"]);
    h.cycle(T0 + W + 1000, ["m1", "m2"]);
    expect(h.intents().map((r) => r.covers.message_ids)).toEqual([["m1"], ["m2"]]);
  });
  it("the window is PER AGENT: a ring for alice never holds bob", () => {
    const rung = new Set<string>();
    const p = C.planCycle({
      bindings: [
        { binding_id: "b-alice", agent_name: "alice", host_id: HOST },
        { binding_id: "b-bob", agent_name: "bob", host_id: HOST },
      ],
      ownHostId: HOST,
      pending: (name) => ({ registered: true, reading_session: RS, ids: [`${name}-m`] }),
      rung,
      ringMono: new Map([["alice", [-1000]]]),
      nowMono: 0,
      budgetExhausted: new Set(),
      liveness: () => "alive",
      mailAgents: () => ["alice", "bob"],
      boardOpen: new Map(),
      windowMs: W,
      budgetPerHour: 6,
      horizonMs: C.DEFAULT_HORIZON_MS,
      newIntentId: uuid,
      now: () => new Date(T0).toISOString(),
    });
    expect(p.intents.map((r) => r.intent.agent_name)).toEqual(["bob"]);
  });
});

describe("Q4: the per-agent ring budget, and A3.2 (logged once per state change)", () => {
  it("6 rings in an hour are allowed; the 7th is REFUSED, with a budget record that says so", () => {
    const h = harness({ windowMs: 10_000 });
    for (let i = 0; i < 7; i++) h.cycle(T0 + i * 11_000, Array.from({ length: i + 1 }, (_, k) => `m${k}`));
    expect(h.intents()).toHaveLength(6);
    expect(h.budgets()).toMatchObject([{ type: "budget", agent_name: "alice", state: "exhausted", rings_in_hour: 6, budget_per_hour: 6 }]);
  });
  it("A3.2: a refusal repeated over consecutive cycles is logged ONCE; it is logged again (available) when the hour slides, and ringing resumes", () => {
    const h = harness({ windowMs: 10_000 });
    for (let i = 0; i < 6; i++) h.cycle(T0 + i * 11_000, [`m${i}`]);
    for (let i = 0; i < 5; i++) h.cycle(T0 + 70_000 + i * 11_000, ["m6"]); // five refused cycles
    expect(h.budgets().map((r) => (r as { state: string }).state)).toEqual(["exhausted"]);
    h.cycle(T0 + 3_600_000 + 1000, ["m6"]); // the first ring has left the hour
    expect(h.budgets().map((r) => (r as { state: string }).state)).toEqual(["exhausted", "available"]);
    expect(h.intents().map((r) => r.covers.message_ids).at(-1)).toEqual(["m6"]);
  });
  it("the budget record is a CLOSED schema (an extra key, or a free-text state, is refused)", () => {
    const good = { v: 1, type: "budget", at: "2026-10-02T05:00:00.000Z", agent_name: "alice", state: "exhausted", rings_in_hour: 6, budget_per_hour: 6 };
    expect(L.recordFault(good)).toBeNull();
    expect(L.recordFault({ ...good, note: "x" })).toMatch(/exactly/);
    expect(L.recordFault({ ...good, state: "alice is spamming" })).toMatch(/state/);
    expect(L.recordFault({ ...good, rings_in_hour: 1e9 })).toMatch(/bounded/); // #300 R2 #5: bounded
    expect(L.recordFault({ ...good, budget_per_hour: 1e9 })).toMatch(/bounded/);
  });
});

describe("tunables: bounded, rejected loudly", () => {
  it("W and the budget are validated against their bounds", () => {
    const H = C.DEFAULT_HORIZON_MS;
    expect(C.tunablesFault({ windowMs: W, budgetPerHour: 6, horizonMs: H })).toBeNull();
    for (const bad of [{ windowMs: 1000, budgetPerHour: 6, horizonMs: H }, { windowMs: 3_600_000, budgetPerHour: 6, horizonMs: H }, { windowMs: W, budgetPerHour: 0, horizonMs: H }, { windowMs: W, budgetPerHour: 1000, horizonMs: H }, { windowMs: W, budgetPerHour: 2.5, horizonMs: H }]) {
      expect(C.tunablesFault(bad), JSON.stringify(bad)).toMatch(/must be/);
    }
  });
  const entry = path.join(REPO_ROOT, "dist", "doorbell.js");
  const runJob = (args: string[]) =>
    spawnSync(process.execPath, [entry, ...args], {
      encoding: "utf-8",
      env: { PATH: process.env.PATH ?? "", HOME: ROOT, RELAY_DB_PATH: path.join(ROOT, "no-such-dir", "relay.db") },
    });
  it("#301 R1: out-of-bounds or NON-INTEGER flags are refused with the SPECIFIC validation error (exit 2)", () => {
    const rows: Array<[string[], RegExp]> = [
      [["--window-s", "1"], /--window-s must be an integer number of seconds in 10\.\.600/],
      [["--window-s", "10.5"], /--window-s must be an integer number of seconds/],
      [["--window-s", "60.001"], /--window-s must be an integer number of seconds/],
      [["--window-s", "abc"], /--window-s must be an integer number of seconds/],
      [["--budget-per-hour", "0"], /the ring budget must be an integer in 1\.\.60 per hour/],
      [["--budget-per-hour", "2.5"], /the ring budget must be an integer/],
    ];
    for (const [args, why] of rows) {
      const r = runJob(["--once", ...args]);
      expect([args.join(" "), r.status, r.stderr]).toEqual([args.join(" "), 2, expect.stringMatching(why)]);
    }
  });
  it("twin: in-bounds integer flags PARSE (no early return): the run proceeds to the resolver and fails there, not on usage", () => {
    const r = runJob(["--once", "--window-s", "60", "--budget-per-hour", "6"]);
    expect([r.status, r.stderr]).toEqual([1, expect.stringMatching(/DOORBELL_FAILED: no relay DB/)]);
  });
});

describe("restart: the window and the budget are rebuilt from the log", () => {
  it("ring times per agent and the budget state come back from the log", () => {
    const o = L.openLog(path.join(ROOT, "restart"));
    const h = harness({ windowMs: 10_000 });
    for (let i = 0; i < 7; i++) h.cycle(T0 + i * 11_000, [`m${i}`]);
    for (const r of h.all) L.appendRecord(o.handle, r);
    L.closeLog(o.handle);
    const s = L.readLogState(o.handle.path);
    expect(s.ringWalls.get("alice")).toEqual(h.intents().map((r) => Date.parse(r.at)));
    expect([...s.budgetExhausted]).toEqual(["alice"]);
  });
  it("HARM: a restart INSIDE W does not ring again for mail that arrived after the last ring", () => {
    const o = L.openLog(path.join(ROOT, "restart-w"));
    const h = harness();
    h.cycle(T0, ["m1"]);
    for (const r of h.all) L.appendRecord(o.handle, r);
    L.closeLog(o.handle);
    const s = L.readLogState(o.handle.path);
    const p = C.planCycle({
      bindings: [{ binding_id: "b-alice", agent_name: "alice", host_id: HOST }],
      ownHostId: HOST,
      pending: () => ({ registered: true, reading_session: RS, ids: ["m1", "m2"] }),
      rung: s.rung,
      // A RESTART: the log's rings are a previous lifetime's, placed by the ruling-622689ba rule.
      ringMono: C.effectiveRingMono(s.ringWalls, s.lastHeaderWall, T0 + 5000),
      nowMono: 0,
      budgetExhausted: s.budgetExhausted,
      liveness: () => "alive",
      mailAgents: () => ["alice"],
      boardOpen: s.boardOpen,
      windowMs: W,
      budgetPerHour: 6,
      horizonMs: C.DEFAULT_HORIZON_MS,
      newIntentId: uuid,
      now: () => new Date(T0 + 5000).toISOString(),
    });
    expect(p.intents).toEqual([]);
  });
});
