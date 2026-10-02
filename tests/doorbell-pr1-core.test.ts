// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Doorbell PR 1 — the pure decision (src/doorbell-core.ts) and the write-ahead log
 * (src/doorbell-log.ts). Plan v3 PR 1 red tests: the V4 trigger keyed (reading session,
 * id), the rescue twin, the NULL session, the id-set (never a count), host identity,
 * the CLOSED intent schema (C3), rung memory rebuilt from the log, and WAL recovery.
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const C = await import("../src/doorbell-core.js");
const L = await import("../src/doorbell-log.js");
type PendingRead = import("../src/doorbell-core.js").PendingRead;

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "doorbell-pr1-core-"));
/** Open-check-close (the job holds the handle; a test opens it per step). */
const prep = (dir: string) => {
  const o = L.openLog(dir);
  L.closeLog(o.handle);
  return { logPath: o.handle.path, recoveredBytes: o.recoveredBytes };
};
const append = (logPath: string, rec: unknown) => {
  const o = L.openLog(path.dirname(logPath));
  try {
    L.appendRecord(o.handle, rec as never);
  } finally {
    L.closeLog(o.handle);
  }
};
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const HOST = "HOST-A";
const RS1 = "1".repeat(64);
const RS2 = "2".repeat(64);
const bind = (agent: string | null, host = HOST, id = `b-${agent}`) => ({ binding_id: id, agent_name: agent, host_id: host });
let n = 0;
const ids = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
function plan(over: Partial<Parameters<typeof C.planCycle>[0]> & { reads?: Record<string, PendingRead> } = {}) {
  const reads = over.reads ?? { alice: { registered: true, reading_session: RS1, ids: ["m1"] } };
  return C.planCycle({
    bindings: [bind("alice")],
    ownHostId: HOST,
    pending: (name) => {
      const r = reads[name];
      if (!r) throw new Error(`no fixture for ${name}`);
      return r;
    },
    rung: new Set(),
    ringMono: new Map(),
    nowMono: 0,
    budgetExhausted: new Set(),
    windowMs: C.DEFAULT_WINDOW_MS,
    budgetPerHour: C.DEFAULT_BUDGET_PER_HOUR,
    newIntentId: ids,
    now: () => "2026-10-02T04:00:00.000Z",
    ...over,
  });
}

describe("planCycle: the V4 trigger", () => {
  it("twin: a first sighting emits exactly ONE intent covering the new ids; the record is valid", () => {
    const p = plan({ reads: { alice: { registered: true, reading_session: RS1, ids: ["m1", "m2"] } } });
    expect(p.intents).toHaveLength(1);
    expect(p.intents[0]).toMatchObject({ intent: { agent_name: "alice", binding_id: "b-alice", reason: "new_mail" }, covers: { reading_session: RS1, message_ids: ["m1", "m2"] } });
    expect(L.recordFault(p.intents[0])).toBeNull();
  });
  it("twin: an unchanged set (every id already rung for this session) emits nothing", () => {
    expect(plan({ rung: new Set([L.rungKey(RS1, "m1")]) }).intents).toEqual([]);
  });
  it("HARM (V4 rescue twin): the SAME id re-pended to a NEW reading session DOES ring", () => {
    const p = plan({ rung: new Set([L.rungKey(RS1, "m1")]), reads: { alice: { registered: true, reading_session: RS2, ids: ["m1"] } } });
    expect(p.intents.map((r) => r.covers)).toEqual([{ reading_session: RS2, message_ids: ["m1"] }]);
  });
  it("HARM (V4): a NULL / unbound reading session is NEVER a target, and says why", () => {
    const p = plan({ reads: { alice: { registered: true, reading_session: null, ids: ["m1"] } } });
    expect(p.intents).toEqual([]);
    expect(p.skipped).toMatchObject([{ agent_name: "alice", why: expect.stringMatching(/no bound reading session/) }]);
  });
  it("HARM (A2.2): a resolve plus an arrival at an UNCHANGED count still rings for the new id (an id-set, never a count)", () => {
    const p = plan({ rung: new Set([L.rungKey(RS1, "m1")]), reads: { alice: { registered: true, reading_session: RS1, ids: ["m2"] } } });
    expect(p.intents.map((r) => r.covers.message_ids)).toEqual([["m2"]]);
  });
  it("only the NEW ids are covered, never the already-rung ones", () => {
    const p = plan({ rung: new Set([L.rungKey(RS1, "m1")]), reads: { alice: { registered: true, reading_session: RS1, ids: ["m1", "m3"] } } });
    expect(p.intents.map((r) => r.covers.message_ids)).toEqual([["m3"]]);
  });
  it("message_ids is a SET: the same ids in any scan order give the same record (the drain order has no same-ms tie-break)", () => {
    const a = plan({ reads: { alice: { registered: true, reading_session: RS1, ids: ["m2", "m1", "m3"] } } });
    const b = plan({ reads: { alice: { registered: true, reading_session: RS1, ids: ["m3", "m2", "m1"] } } });
    expect(a.intents[0].covers).toEqual(b.intents[0].covers);
    expect(a.intents[0].covers.message_ids).toEqual(["m1", "m2", "m3"]);
  });
  it("one intent per agent per cycle, even with two bindings for the same name", () => {
    const p = plan({ bindings: [bind("alice", HOST, "b1"), bind("alice", HOST, "b2")] });
    expect(p.intents).toHaveLength(1);
  });
  it("an unregistered agent, a nameless binding, and a failing read are skipped with a reason, never rung", () => {
    const p = plan({
      bindings: [bind("ghost"), bind(null), bind("broken")],
      reads: { ghost: { registered: false, reading_session: null, ids: [] } },
    });
    expect(p.intents).toEqual([]);
    expect(p.skipped.map((s) => s.why)).toEqual([expect.stringMatching(/not registered/), expect.stringMatching(/names no agent/), expect.stringMatching(/cannot be read/)]);
  });
});

describe("planCycle: candidates are THIS host's bindings, positively", () => {
  it("HARM: a binding on ANOTHER host is never a candidate", () => {
    const p = plan({ bindings: [bind("alice", "HOST-B")] });
    expect(p.intents).toEqual([]);
    expect(p.skipped[0].why).toMatch(/another host/);
  });
  it("HARM: an UNKNOWN own host → no candidate at all (never `IS`-matched against a null host)", () => {
    const p = plan({ ownHostId: null });
    expect(p.intents).toEqual([]);
    expect(p.skipped[0].why).toMatch(/identity is unknown/);
  });
});

describe("the log: a CLOSED schema (C3), content-free", () => {
  const good = () => plan().intents[0];
  it("HARM (C3): a free-text reason is refused by the writer, and nothing is written", () => {
    const { logPath } = prep(path.join(ROOT, "c3-reason"));
    const bad = { ...good(), intent: { ...good().intent, reason: "alice has 3 urgent messages from bob" } };
    expect(() => append(logPath, bad as never)).toThrow(/reason must be one of/);
    expect(fs.readFileSync(logPath, "utf-8")).toBe("");
  });
  it("HARM (C3): an EXTRA field (in the intent, in covers, or on the record) is refused", () => {
    const { logPath } = prep(path.join(ROOT, "c3-extra"));
    const g = good();
    for (const bad of [
      { ...g, intent: { ...g.intent, content: "hi" } },
      { ...g, covers: { ...g.covers, from: "bob" } },
      { ...g, subject: "x" },
    ]) {
      expect(() => append(logPath, bad as never)).toThrow(/refusing to log/);
    }
    expect(fs.readFileSync(logPath, "utf-8")).toBe("");
  });
  it("twin: a valid intent is written as ONE line and read back into rung memory", () => {
    const { logPath } = prep(path.join(ROOT, "ok"));
    append(logPath, good());
    expect(fs.readFileSync(logPath, "utf-8").split("\n").filter(Boolean)).toHaveLength(1);
    expect([...L.readRungMemory(logPath).rung]).toEqual([L.rungKey(RS1, "m1")]);
  });
  it("the log is 0600 in a 0700 state dir; an existing world-readable log is REFUSED, never repaired", () => {
    const dir = path.join(ROOT, "modes");
    const { logPath } = prep(dir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(logPath).mode & 0o777).toBe(0o600);
    fs.chmodSync(logPath, 0o644);
    expect(() => prep(dir)).toThrow(/must be private \(0600\)/);
  });
});

describe("rung memory and WAL recovery", () => {
  const line = (rs: string, idsList: string[]) =>
    JSON.stringify({ v: 1, type: "intent", at: "2026-10-02T04:00:00.000Z", mono_ms: 0, intent: { intent_id: ids(), agent_name: "alice", binding_id: "b", reason: "new_mail" }, covers: { reading_session: rs, message_ids: idsList } });
  it("memory is keyed (reading session, id): the same id under two sessions is two keys", () => {
    const dir = path.join(ROOT, "mem");
    const { logPath } = prep(dir);
    fs.appendFileSync(logPath, line(RS1, ["m1"]) + "\n" + line(RS2, ["m1"]) + "\n");
    expect(L.readRungMemory(logPath).rung).toEqual(new Set([L.rungKey(RS1, "m1"), L.rungKey(RS2, "m1")]));
  });
  it("a TORN tail (unterminated last line, a crash mid-write) is truncated on prepare and never counted as rung", () => {
    const dir = path.join(ROOT, "torn");
    const { logPath } = prep(dir);
    fs.appendFileSync(logPath, line(RS1, ["m1"]) + "\n" + line(RS1, ["m2"]).slice(0, 40));
    expect(L.readRungMemory(logPath)).toMatchObject({ tornTail: true });
    expect(L.readRungMemory(logPath).rung).toEqual(new Set([L.rungKey(RS1, "m1")]));
    const again = prep(dir);
    expect(again.recoveredBytes).toBe(40);
    append(logPath, plan({ reads: { alice: { registered: true, reading_session: RS1, ids: ["m3"] } } }).intents[0]);
    expect(L.readRungMemory(logPath)).toMatchObject({ tornTail: false }); // the next append started on a clean line
    expect(L.readRungMemory(logPath).rung).toEqual(new Set([L.rungKey(RS1, "m1"), L.rungKey(RS1, "m3")]));
  });
  it("HARM: an invalid COMPLETE line anywhere (even the last) is refused: no cycle on a memory it cannot trust", () => {
    const dir = path.join(ROOT, "corrupt");
    const { logPath } = prep(dir);
    fs.appendFileSync(logPath, line(RS1, ["m1"]) + "\n" + '{"v":1,"type":"intent"}\n');
    expect(() => L.readRungMemory(logPath)).toThrow(/line 2 is not a valid doorbell record/);
  });
});
