// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Doorbell PR 3 — effectiveness, re-ring and escalation (plan v3 PR 3; architect ruling
 * c04f463a). The PLANNER, driven exactly as the job drives it: every record it emits is
 * validated by the log's closed schema and folded through the ONE reducer (foldRecord), the
 * ledger is built by the ONE ledgerInput, and the next cycle plans from that state alone.
 *
 *   - 3 ineffective rings in a row (each judged at its horizon H) open ONE agent_unresponsive
 *     escalation, and ringing stops.
 *   - Twin: the current session draining ANY rung id resets the count.
 *   - The per-(id, session) re-ring cap K = 3: an id stuck while other mail drains is rung 3
 *     times, then gets ONE id_stuck escalation; the agent never escalates as unresponsive.
 *   - One extra ring per open escalation, for the FIRST new mail; then none. The extra ring's
 *     id leaving closes the episode.
 *   - Closes on a session change (the V4 rescue), never because the binding went.
 *   - V3: the operator is attribution only, never a ring target.
 *   - A ring refused by the budget is not a ring: it ticks no counter.
 *   - A3.2: nothing changes, nothing is written.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";

const C = await import("../src/doorbell-core.js");
const L = await import("../src/doorbell-log.js");
type PendingRead = import("../src/doorbell-core.js").PendingRead;
type LogRecord = import("../src/doorbell-log.js").LogRecord;
type CandidateBinding = import("../src/doorbell-core.js").CandidateBinding;

const HOST = "HOST-A";
const RS1 = "1".repeat(64);
const RS2 = "2".repeat(64);
const H = 60_000; // the smallest horizon: each step below is one H
const W = 10_000;
const bind = (agent: string): CandidateBinding => ({ binding_id: `b-${agent}`, agent_name: agent, host_id: HOST });

/** The job's loop, minus I/O: plan from the state, validate + fold every record, repeat. */
function harness(opts: { budgetPerHour?: number; operator?: string | null; bindings?: CandidateBinding[]; from?: { records: readonly LogRecord[]; intentMono: ReadonlyMap<string, number> }; ids?: () => string } = {}) {
  const state: import("../src/doorbell-log.js").LogState = { rung: new Set(), ringWalls: new Map(), lastHeaderWall: null, budgetExhausted: new Set(), tornTail: false, records: [] };
  const ringMono = new Map<string, number[]>();
  const intentMono = new Map<string, number>(opts.from?.intentMono ?? []);
  // A restart from these records: the state is rebuilt by the ONE reducer, ring times from the kept intents.
  for (const rec of opts.from?.records ?? []) {
    L.foldRecord(state, rec);
    if (rec.type === "intent") ringMono.set(rec.intent.agent_name, [...(ringMono.get(rec.intent.agent_name) ?? []), intentMono.get(rec.intent.intent_id) as number]);
  }
  let bindings = opts.bindings ?? [bind("alice")];
  const step = (t: number, reads: Record<string, PendingRead>) => {
    const p = C.planCycle({
      bindings,
      ownHostId: HOST,
      pending: (name) => {
        const r = reads[name];
        if (!r) throw new Error(`no fixture for ${name}`);
        return r;
      },
      rung: state.rung,
      ringMono,
      nowMono: t,
      budgetExhausted: state.budgetExhausted,
      windowMs: W,
      budgetPerHour: opts.budgetPerHour ?? 60,
      horizonMs: H,
      operator: opts.operator ?? null,
      ledger: C.ledgerInput(state.records, (rec) => intentMono.get(rec.intent.intent_id) as number),
      newIntentId: opts.ids ?? randomUUID,
      now: () => new Date(Date.parse("2026-10-02T08:00:00.000Z") + t).toISOString(),
    });
    for (const rec of p.records) {
      expect(L.recordFault(rec), JSON.stringify(rec)).toBeNull(); // the closed schema accepts every record
      L.foldRecord(state, rec);
      if (rec.type === "intent") {
        ringMono.set(rec.intent.agent_name, [...(ringMono.get(rec.intent.agent_name) ?? []), rec.mono_ms]);
        intentMono.set(rec.intent.intent_id, rec.mono_ms);
      }
    }
    return p;
  };
  const all = <T extends LogRecord["type"]>(type: T) => state.records.filter((r): r is Extract<LogRecord, { type: T }> => r.type === type);
  const kindsOf = (id: string) => all("intent").flatMap((r) => r.covers.message_ids.flatMap((x, i) => (x === id ? [r.covers.kinds[i]] : [])));
  const openEsc = () => {
    const last = new Map<string, Extract<LogRecord, { type: "escalation" }>>();
    for (const e of all("escalation")) last.set(e.escalation_id, e);
    return [...last.values()].filter((e) => e.state === "open");
  };
  return { step, state, intentMono, all, kindsOf, openEsc, setBindings: (b: CandidateBinding[]) => void (bindings = b) };
}
const read = (ids: string[], rs: string | null = RS1): PendingRead => ({ registered: true, reading_session: rs, ids });

/** alice: m1 rung, then judged ineffective at each horizon, three times: the escalation opens at 3H. */
function escalated(opts: Parameters<typeof harness>[0] = {}) {
  const h = harness(opts);
  for (let k = 0; k <= 3; k++) h.step(k * H, { alice: read(["m1"]), ...(opts.operator ? { [opts.operator]: read([]) } : {}) });
  return h;
}

describe("PR 3: three ineffective rings → ONE escalation, and ringing stops", () => {
  it("HARM: rings at 0, H, 2H (new, then still_pending twice); judged ineffective at H, 2H, 3H; ONE open agent_unresponsive at 3H", () => {
    const h = escalated();
    expect(h.kindsOf("m1")).toEqual(["new", "still_pending", "still_pending"]);
    expect(h.all("effect").map((e) => e.outcome)).toEqual(["ineffective", "ineffective", "ineffective"]);
    expect(h.openEsc().map((e) => [e.reason, e.message_ids, e.operator, e.close_reason])).toEqual([["agent_unresponsive", ["m1"], null, null]]);
  });
  it("HARM: after it opens, nothing more is rung (no 4th ring, no id_stuck), and A3.2: idle cycles write NOTHING", () => {
    const h = escalated();
    const before = h.state.records.length;
    for (let k = 4; k < 20; k++) expect(h.step(k * H, { alice: read(["m1"]) }).records).toEqual([]);
    expect(h.state.records.length).toBe(before);
    expect(h.all("intent")).toHaveLength(3);
  });
  it("a ring is judged only AT its horizon: one ms before it, still outstanding (no effect record)", () => {
    const h = harness();
    h.step(0, { alice: read(["m1"]) });
    expect(h.step(H - 1, { alice: read(["m1"]) }).effects).toEqual([]);
    expect(h.step(H, { alice: read(["m1"]) }).effects.map((e) => e.outcome)).toEqual(["ineffective"]);
  });
});

describe("PR 3: progress resets the count (twin)", () => {
  it("twin: the current session draining ANY ONE rung id is effective and resets the count: no escalation", () => {
    const h = harness();
    h.step(0, { alice: read(["m1", "m2"]) });
    h.step(H, { alice: read(["m1", "m2"]) }); // ineffective (1), re-ring both
    const p = h.step(H + 30_000, { alice: read(["m1"]) }); // m2 drained
    expect(p.effects.map((e) => [e.outcome, e.left])).toEqual([["effective", ["m2"]]]);
    expect(p.effects[0].intent_ids).toHaveLength(1); // the outstanding re-ring, judged effective
    for (let k = 2; k < 12; k++) h.step(k * H + 30_000, { alice: read(["m1"]) });
    expect(h.all("escalation").filter((e) => e.reason === "agent_unresponsive")).toEqual([]);
  });
  it("a drain with NO ring outstanding still resets the counter (an effective record with no intent ids)", () => {
    const h = harness();
    h.step(0, { alice: read(["m1", "m2"]) });
    h.step(H, { alice: read(["m1", "m2"]) }); // c = 1, re-ring
    h.step(2 * H, { alice: read(["m1", "m2"]) }); // c = 2, re-ring (m1, m2 now at 3 rings)
    h.step(3 * H - 1, { alice: read(["m1"]) }); // m2 drained while the 3rd ring is outstanding → effective
    expect(h.all("effect").at(-1)).toMatchObject({ outcome: "effective", left: ["m2"] });
    for (let k = 3; k < 10; k++) h.step(k * H, { alice: read(["m1"]) });
    expect(h.all("escalation").filter((e) => e.reason === "agent_unresponsive")).toEqual([]);
  });
});

describe("PR 3: the per-(id, session) re-ring cap K (ruling c04f463a Q2)", () => {
  it("HARM: an agent draining OTHER mail steadily while m1 stays pending → m1 rung K = 3 times, then ONE id_stuck; never agent_unresponsive", () => {
    const h = harness({ operator: "ops-desk" });
    for (let k = 0; k < 20; k++) h.step(k * H, { alice: read(["m1", `n${String(k).padStart(2, "0")}`]) }); // n(k-1) drained each step
    expect(h.kindsOf("m1")).toEqual(["new", "still_pending", "still_pending"]);
    const stuck = h.all("escalation").filter((e) => e.reason === "id_stuck");
    expect(stuck.map((e) => [e.message_ids, e.state, e.operator])).toEqual([[["m1"], "open", "ops-desk"]]);
    expect(h.all("escalation").filter((e) => e.reason === "agent_unresponsive")).toEqual([]);
  });
  it("id_stuck closes when m1 finally leaves pending (progress), once", () => {
    const h = harness();
    for (let k = 0; k < 6; k++) h.step(k * H, { alice: read(["m1", `n${k}`]) });
    expect(h.openEsc().map((e) => e.reason)).toEqual(["id_stuck"]);
    h.step(6 * H, { alice: read([]) });
    expect(h.openEsc()).toEqual([]);
    expect(h.all("escalation").filter((e) => e.state === "closed").map((e) => [e.reason, e.close_reason])).toEqual([["id_stuck", "progress"]]);
  });
});

describe("PR 3: one extra ring per open escalation, for the FIRST new mail (ruling c04f463a Q4)", () => {
  it("HARM: the first new id rings ONCE (kind new, during_escalation); a second new id does not", () => {
    const h = escalated();
    const extra = h.step(3 * H + 20_000, { alice: read(["m1", "m9"]) });
    expect(extra.intents.map((r) => [r.intent.during_escalation, r.covers.message_ids, r.covers.kinds])).toEqual([[true, ["m9"], ["new"]]]);
    expect(h.step(3 * H + 40_000, { alice: read(["m1", "m9", "m10"]) }).intents).toEqual([]);
  });
  it("HARM: the extra ring ineffective → an effect record, NO more rings, no second escalation", () => {
    const h = escalated();
    h.step(3 * H + 20_000, { alice: read(["m1", "m9"]) });
    const judged = h.step(4 * H + 20_000, { alice: read(["m1", "m9", "m10"]) });
    expect(judged.effects.map((e) => e.outcome)).toEqual(["ineffective"]);
    expect(judged.intents).toEqual([]);
    for (let k = 5; k < 12; k++) expect(h.step(k * H, { alice: read(["m1", "m9", "m10"]) }).intents).toEqual([]);
    expect(h.all("escalation")).toHaveLength(1);
  });
  it("HARM: the extra ring's id (NOT in the escalation's message_ids) leaving closes the episode; ringing resumes", () => {
    const h = escalated();
    h.step(3 * H + 20_000, { alice: read(["m1", "m9"]) });
    expect(h.openEsc()[0].message_ids).toEqual(["m1"]); // m9 is not in the open record
    h.step(3 * H + 40_000, { alice: read(["m1"]) }); // m9 drained
    expect(h.all("escalation").filter((e) => e.reason === "agent_unresponsive").map((e) => [e.state, e.close_reason])).toEqual([["open", null], ["closed", "progress"]]);
    // Ringing resumes, and m1, already rung K times and still pending, is not re-rung: its ONE id_stuck instead.
    expect(h.openEsc().map((e) => [e.reason, e.message_ids])).toEqual([["id_stuck", ["m1"]]]);
    const after = h.step(4 * H + 40_000, { alice: read(["m1", "m11"]) });
    expect(after.intents.map((r) => [r.intent.during_escalation, r.covers.message_ids])).toEqual([[false, ["m11"]]]);
  });
});

describe("PR 3: the escalation's lifecycle", () => {
  it("HARM (V4): a changed reading session closes it (session_changed), and the new session's mail is rung (the rescue)", () => {
    const h = escalated();
    const p = h.step(4 * H, { alice: read(["m1"], RS2) });
    expect(p.escalations.map((e) => [e.state, e.close_reason, e.reading_session])).toEqual([["closed", "session_changed", RS1]]);
    expect(p.intents.map((r) => [r.covers.reading_session, r.covers.message_ids, r.covers.kinds])).toEqual([[RS2, ["m1"], ["new"]]]);
  });
  it("HARM (V4): rings still outstanding when the session changes are recorded session_changed, never judged ineffective later", () => {
    const h = harness();
    const first = h.step(0, { alice: read(["m1"]) }).intents[0].intent.intent_id;
    const p = h.step(10_000, { alice: read(["m1"], RS2) });
    expect(p.effects.map((e) => [e.outcome, e.reading_session, e.intent_ids])).toEqual([["session_changed", RS1, [first]]]);
    for (let k = 1; k < 5; k++) h.step(k * H, { alice: read(["m1"], RS2) });
    expect(h.all("effect").filter((e) => e.reading_session === RS1).map((e) => e.outcome)).toEqual(["session_changed"]);
  });
  it("HARM (B1, review 2fda069b): the window CLOSES (binding gone AND session NULL, as production does it) → a HOLD: still open, rings unjudged, nothing written; a NEW session then closes it session_changed and rescues", () => {
    const h = escalated();
    const extra = h.step(3 * H + 20_000, { alice: read(["m1", "m9"]) }).intents[0].intent.intent_id; // outstanding
    h.setBindings([]);
    for (let k = 4; k < 12; k++) expect(h.step(k * H, { alice: read(["m1", "m9"], null) }).records, `t=${k}H`).toEqual([]);
    expect(h.openEsc()).toHaveLength(1);
    expect(h.all("effect").some((e) => e.intent_ids.includes(extra))).toBe(false); // well past its horizon, still unjudged
    h.setBindings([bind("alice")]); // a new window, a new session
    const p = h.step(12 * H, { alice: read(["m1", "m9"], RS2) });
    expect(p.escalations.map((e) => [e.state, e.close_reason, e.reading_session])).toEqual([["closed", "session_changed", RS1]]);
    expect(p.effects.map((e) => [e.outcome, e.intent_ids])).toEqual([["session_changed", [extra]]]);
    expect(p.intents.map((r) => [r.covers.reading_session, r.covers.message_ids, r.covers.kinds, r.intent.during_escalation])).toEqual([[RS2, ["m1", "m9"], ["new", "new"], false]]);
  });
  it("twin: a binding gone while the SAME session stays bound (not a production state, kept as the mechanism pin) → still judged, and a drain closes it on progress", () => {
    const h = escalated();
    h.setBindings([]);
    for (let k = 4; k < 8; k++) expect(h.step(k * H, { alice: read(["m1"]) }).records).toEqual([]);
    const p = h.step(8 * H, { alice: read([]) });
    expect(p.escalations.map((e) => [e.state, e.close_reason])).toEqual([["closed", "progress"]]);
    expect(p.intents).toEqual([]);
  });
  it("HARM (B1): an unbound session is never judged at its horizon, and never swept to session_changed, however long it lasts", () => {
    const h = harness();
    h.step(0, { alice: read(["m1"]) });
    for (let k = 1; k < 30; k++) expect(h.step(k * H, { alice: read(["m1"], null) }).records).toEqual([]);
    expect(h.all("effect")).toEqual([]);
  });
});

describe("PR 3: V3, the operator agent: attribution only", () => {
  it("HARM: the operator is NEVER an intent target or destination because of an escalation (it is bound, with no mail)", () => {
    const h = escalated({ operator: "ops-desk", bindings: [bind("alice"), bind("ops-desk")] });
    expect(h.openEsc().map((e) => e.operator)).toEqual(["ops-desk"]);
    for (let k = 4; k < 10; k++) h.step(k * H, { alice: read(["m1"]), "ops-desk": read([]) });
    expect(h.all("intent").map((r) => r.intent.agent_name)).toEqual(["alice", "alice", "alice"]);
    // The only place the operator's name appears is the escalation's attribution.
    for (const r of h.state.records) if (r.type !== "escalation") expect(JSON.stringify(r)).not.toContain("ops-desk");
  });
  it("twin: no operator configured → operator null on every escalation record", () => {
    expect(escalated().all("escalation").map((e) => e.operator)).toEqual([null]);
  });
});

describe("PR 3: a refused ring is not a ring (ruling c04f463a)", () => {
  it("HARM: a budget-refused re-ring ticks NO counter and no per-id count; it rings once the budget allows", () => {
    const h = harness({ budgetPerHour: 1 });
    h.step(0, { alice: read(["m1"]) });
    for (let k = 1; k < 60; k++) h.step(k * H, { alice: read(["m1"]) }); // 59 minutes: the budget refuses every re-ring
    expect(h.all("effect").map((e) => e.outcome)).toEqual(["ineffective"]); // the ONE ring, judged once
    expect(h.kindsOf("m1")).toEqual(["new"]);
    expect(h.all("escalation")).toEqual([]);
    h.step(60 * H + 1, { alice: read(["m1"]) }); // the hour has slid
    expect(h.kindsOf("m1")).toEqual(["new", "still_pending"]);
  });
});

describe("PR 3: a W-held re-ring is not a ring either (D1)", () => {
  it("twin: a re-ring due while W holds (new mail rang just before) writes nothing, ticks nothing, and rides the NEXT ring once W passes", () => {
    const h = harness();
    h.step(0, { alice: read(["m1"]) });
    h.step(H - 5_000, { alice: read(["m1", "m2"]) }); // m2 rings: W now holds alice until H + 5 s
    const held = h.step(H, { alice: read(["m1", "m2"]) }); // m1's ring judged ineffective; its re-ring is HELD by W
    expect(held.intents).toEqual([]);
    expect(held.skipped.map((x) => x.why)).toEqual([expect.stringMatching(/^coalescing/)]);
    expect(h.kindsOf("m1")).toEqual(["new"]); // no per-id tick for the held re-ring
    expect(h.all("effect").map((e) => e.outcome)).toEqual(["ineffective"]); // only the ring that was MADE is judged
    const after = h.step(H + 5_000, { alice: read(["m1", "m2"]) });
    expect(after.intents.map((r) => [r.covers.message_ids, r.covers.kinds])).toEqual([[["m1"], ["still_pending"]]]);
  });
});

describe("PR 3: the horizon tunable (ruling c04f463a Q1)", () => {
  it("H is bounded (1..60 min), an integer, and NEVER shorter than W (rejected loudly)", () => {
    const ok = { windowMs: W, budgetPerHour: 6, horizonMs: C.DEFAULT_HORIZON_MS };
    expect(C.tunablesFault(ok)).toBeNull();
    expect(C.DEFAULT_HORIZON_MS).toBe(900_000);
    expect(C.tunablesFault({ ...ok, horizonMs: 59_999 })).toMatch(/horizon must be/);
    expect(C.tunablesFault({ ...ok, horizonMs: 3_600_001 })).toMatch(/horizon must be/);
    expect(C.tunablesFault({ ...ok, horizonMs: 90_000.5 })).toMatch(/horizon must be/);
    expect(C.tunablesFault({ windowMs: 300_000, budgetPerHour: 6, horizonMs: 120_000 })).toMatch(/at least the coalescing window/);
    expect(C.tunablesFault({ windowMs: 120_000, budgetPerHour: 6, horizonMs: 120_000 })).toBeNull(); // H = W is allowed
  });
});

describe("PR 3: the log keeps what the ledger needs across a compaction (selectLedgerKeep)", () => {
  it("open escalations and the current session's counter are kept; a closed escalation is dropped", () => {
    const h = escalated();
    h.step(4 * H, { alice: read(["m1"], RS2) }); // closes it (session_changed); RS2 rings m1
    h.step(5 * H, { alice: read(["m1"], RS2) }); // RS2: ineffective (1)
    const keptIntents = new Set(h.all("intent").filter((r) => r.covers.reading_session === RS2).map((r) => r.intent.intent_id));
    const kept = L.selectLedgerKeep(h.state.records, keptIntents, () => RS2);
    expect([...kept].filter((r) => r.type === "escalation")).toEqual([]);
    expect([...kept].filter((r) => r.type === "effect" && r.reading_session === RS2).map((r) => (r as { outcome: string }).outcome)).toEqual(["ineffective"]);
  });
  it("an OPEN escalation is kept, with every effect record that judged a kept intent", () => {
    const h = escalated();
    const keptIntents = new Set(h.all("intent").map((r) => r.intent.intent_id));
    const kept = L.selectLedgerKeep(h.state.records, keptIntents, () => RS1);
    expect([...kept].filter((r) => r.type === "escalation").map((r) => (r as { state: string }).state)).toEqual(["open"]);
    expect([...kept].filter((r) => r.type === "effect")).toHaveLength(3);
  });
});

/** Deterministic v4 ids, so two runs of the same steps emit byte-identical records. */
const counter = (start: number) => {
  let n = start;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
};

describe("PR 3: a compaction changes NO later decision (D-2 (b) + intentKeepRule + selectLedgerKeep)", () => {
  /**
   * Run `before` steps, then a RESTART that compacts against the pending reads `atRestart`
   * (taken in one snapshot) with EVERY intent older than the budget hour and a budget of 1
   * (so rules (a) and (b) keep as little as possible). Then `after` steps from BOTH the full
   * log and the compacted one: the emitted records must be identical.
   */
  function invariant(before: (h: ReturnType<typeof harness>) => void, atRestart: Record<string, PendingRead>, after: Array<[number, Record<string, PendingRead>]>) {
    const h = harness({ ids: counter(0) });
    before(h);
    const records = [...h.state.records];
    const pendingNow = new Map(Object.entries(atRestart).map(([a, r]) => [a, { rs: r.reading_session, ids: new Set(r.ids) }]));
    const keepIntent = C.intentKeepRule(records, pendingNow, { lastHeaderWall: null, startWall: Date.parse("2026-10-09T00:00:00.000Z"), budgetPerHour: 1 });
    const keptIntentIds = new Set(records.filter((r) => r.type === "intent" && keepIntent(r)).map((r) => (r as { intent: { intent_id: string } }).intent.intent_id));
    const ledgerKept = L.selectLedgerKeep(records, keptIntentIds, (a) => pendingNow.get(a)?.rs);
    const compacted = records.filter((r) => (r.type === "intent" ? keptIntentIds.has(r.intent.intent_id) : r.type === "effect" || r.type === "escalation" ? ledgerKept.has(r) : true));
    expect(compacted.length).toBeLessThan(records.length + 1);
    const full = harness({ from: { records, intentMono: h.intentMono }, ids: counter(1000) });
    const comp = harness({ from: { records: compacted, intentMono: h.intentMono }, ids: counter(1000) });
    for (const [t, reads] of after) expect(comp.step(t, reads).records, `at t=${t}`).toEqual(full.step(t, reads).records);
    return { dropped: records.length - compacted.length, full };
  }
  const later = (reads: Record<string, PendingRead>, from = 10): Array<[number, Record<string, PendingRead>]> => Array.from({ length: 8 }, (_, k) => [(from + k) * H, reads]);

  it("HARM (PR 3 rule (e)): progress made while the job was DOWN (counter 2, all drained) is still recorded after the compaction: no false escalation later", () => {
    const r = invariant(
      (h) => {
        for (let k = 0; k < 3; k++) h.step(k * H, { alice: read(["m1"]) }); // counter = 2, the 3rd ring outstanding
        h.step(3 * H - 1, { alice: read(["m1"]) });
      },
      { alice: read([]) }, // drained during the downtime
      [[10 * H, { alice: read([]) }], ...later({ alice: read(["m5"]) }, 11)],
    );
    // The first cycle after the restart records the downtime's progress: the counter resets
    // (so m5's later escalation takes three NEW ineffective rings, not one).
    expect(r.full.all("effect").find((e) => e.at === new Date(Date.parse("2026-10-02T08:00:00.000Z") + 10 * H).toISOString())).toMatchObject({ outcome: "effective", left: ["m1"] });
    expect(r.full.all("effect").filter((e) => e.outcome === "ineffective" && e.at > "2026-10-02T08:10").length).toBe(3);
  });
  it("the last RESET survives although every intent it judged was dropped (the counter is exact, not an overcount)", () => {
    // m1 stuck (capped, id_stuck) while other mail drains: its last ring is judged INEFFECTIVE
    // and kept (m1 pending); the later resets come from intents the compaction DROPS.
    const step = (k: number) => [`n${k}`];
    const r = invariant(
      (h) => {
        for (let k = 0; k < 7; k++) h.step(k * H, { alice: read(["m1", ...step(k)]) });
        h.step(7 * H - 1, { alice: read(["m1"]) }); // n6 drained: the last reset
        h.step(7 * H, { alice: read(["m1", "n7"]) }); // n7 rung, outstanding
      },
      { alice: read(["m1", "n7"]) },
      later({ alice: read(["m1", "n7"]) }),
    );
    expect(r.dropped).toBeGreaterThan(0); // precondition: the compaction dropped something
  });
  it("an OPEN agent_unresponsive (extra ring spent) and an id_stuck survive: still no rings, the same closes later", () => {
    invariant(
      (h) => {
        for (let k = 0; k <= 3; k++) h.step(k * H, { alice: read(["m1"]) });
        h.step(3 * H + 20_000, { alice: read(["m1", "m9"]) }); // the extra ring
      },
      { alice: read(["m1", "m9"]) },
      [...later({ alice: read(["m1", "m9", "m10"]) }), [30 * H, { alice: read(["m1", "m10"]) }], [31 * H, { alice: read(["m10"]) }]],
    );
  });
  it("a session changed during the downtime: the rescue is the same from the compacted log", () => {
    invariant(
      (h) => {
        for (let k = 0; k < 3; k++) h.step(k * H, { alice: read(["m1"]) });
      },
      { alice: read(["m1"], RS2) },
      later({ alice: read(["m1"], RS2) }),
    );
  });
  it("HARM (rule (c)): TWO rings outstanding for the old session (only the last is in the last N): both are recorded session_changed", () => {
    const r = invariant(
      (h) => {
        h.step(0, { alice: read(["m1"]) });
        h.step(20_000, { alice: read(["m1", "m2"]) }); // a second ring, both outstanding
      },
      { alice: read(["m1", "m2"], RS2) },
      later({ alice: read(["m1", "m2"], RS2) }),
    );
    expect(r.full.all("effect").filter((e) => e.outcome === "session_changed").map((e) => e.intent_ids.length)).toEqual([2]);
  });
  it("HARM (rule (e)): a stuck id drained while the job was DOWN, its rings all judged and none the last: its id_stuck still CLOSES", () => {
    const r = invariant(
      (h) => {
        for (let k = 0; k < 6; k++) h.step(k * H, { alice: read(["m1", `n${k}`]) }); // m1 capped at 3H: id_stuck
      },
      { alice: read(["n5"]) }, // m1 drained in the downtime
      later({ alice: read(["n5"]) }),
    );
    // (n5, never drained after the restart, earns its OWN id_stuck later: not what this pins.)
    expect(r.full.all("escalation").filter((e) => e.message_ids[0] === "m1").map((e) => [e.reason, e.state, e.close_reason])).toEqual([["id_stuck", "open", null], ["id_stuck", "closed", "progress"]]);
  });
});

describe("PR 3: selectLedgerKeep keeps the LAST RESET (crafted records; reachability through the job is ASSUMED, not shown)", () => {
  it("an ineffective judgement of a KEPT intent, then a reset whose intents were all DROPPED → the counter stays 0 after the compaction", () => {
    const at = "2026-10-02T08:00:00.000Z";
    const intent = (id: string, ids: string[]) => ({ v: 1 as const, type: "intent" as const, at, mono_ms: 0, intent: { intent_id: id, agent_name: "alice", binding_id: "b", during_escalation: false }, covers: { reading_session: RS1, message_ids: ids, kinds: ids.map(() => "new" as const) } });
    const effect = (outcome: "effective" | "ineffective", intent_ids: string[], left: string[]) => ({ v: 1 as const, type: "effect" as const, at, agent_name: "alice", reading_session: RS1, outcome, intent_ids, left });
    const A = "00000000-0000-4000-8000-00000000000a";
    const B = "00000000-0000-4000-8000-00000000000b";
    const records: LogRecord[] = [intent(A, ["x"]), effect("ineffective", [A], []), intent(B, ["y"]), effect("effective", [B], ["y"])];
    for (const r of records) expect(L.recordFault(r)).toBeNull();
    const counter = (rs: readonly LogRecord[]) => C.deriveLedger(rs.filter((r): r is import("../src/doorbell-core.js").LedgerRecord => r.type !== "header" && r.type !== "budget" && r.type !== "clock"), RS1, () => 0).ledger.counter;
    const kept = L.selectLedgerKeep(records, new Set([A]), () => RS1);
    const compacted = records.filter((r) => (r.type === "intent" ? r.intent.intent_id === A : kept.has(r)));
    expect(counter(records)).toBe(0);
    expect(counter(compacted)).toBe(0);
  });
});
