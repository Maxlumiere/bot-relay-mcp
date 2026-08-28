// bot-relay-mcp — Tether (VS Code extension)
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0026 item 1 / M3 — wake-decision observability (SHAPE T).
 *
 * The gate-emission tests RED on current code: WakeGate.consider() computed a structured
 * route.reason and DISCARDED it (`if (route.action === "suppress") return false`), so a decline
 * was unobservable. These pin that the decision now reaches a durable sink WITH its inputs, so a
 * reader can falsify the routing — including the load-bearing case that `state` is the FULL
 * observed state (a decline on `unknown` is its own bucket, never folded into busy).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { WakeGate } from "./inbox-subscription.js";
import type { WakeInboxView } from "./catch-up-wake.js";
import {
  appendWakeLogRecord,
  writeActivationRecord,
  readWakeLog,
  defaultWakeLogPath,
  makeDroppingDecisionSink,
  type WakeDecisionRecord,
} from "./wake-decline-log.js";

const view = (pending_count: number, last_message_at: string | null): WakeInboxView => ({
  pending_count,
  last_message_at,
});

describe("M3 — WakeGate.consider() records every decision with its INPUTS", () => {
  it("SUPPRESS emits a structured decline record carrying the inputs, not just the reason (RED before wiring)", () => {
    const records: WakeDecisionRecord[] = [];
    const gate = new WakeGate(() => {}, {
      now: () => Date.parse("2026-08-27T12:00:00.000Z"),
      recordDecision: (r) => records.push(r),
    });
    // pending mail + busy + hook-covered => routeWake suppresses ("PostToolUse owns delivery").
    const woke = gate.consider(view(3, "2026-08-27T11:59:00.000Z"), "builder-1", true, {
      state: "busy",
      busyCoveredByHook: true,
    });
    expect(woke).toBe(false); // suppressed
    expect(records).toHaveLength(1);
    const r = records[0];
    expect(r.kind).toBe("decision");
    expect(r.v).toBe(1); // versioned from record one (lesson 4)
    expect(r.action).toBe("suppress");
    expect(r.woke, "suppressed => no wake fired (actual outcome)").toBe(false);
    expect(r.reason).toMatch(/hook-covered/);
    expect(r.agentName).toBe("builder-1");
    expect(r.pending_count).toBe(3);
    expect(r.last_message_at).toBe("2026-08-27T11:59:00.000Z"); // the WATERMARK
    expect(r.state).toBe("busy");
    expect(r.busyCoveredByHook).toBe(true);
    expect(r.injectionOutstanding).toBe(false);
    expect(r.decided_at).toBe("2026-08-27T12:00:00.000Z");
  });

  it("a DECLINE taken on state='unknown' records state:'unknown' — its own bucket, never folded into busy", () => {
    const records: WakeDecisionRecord[] = [];
    let t = 1000;
    const gate = new WakeGate(() => {}, { recordDecision: (r) => records.push(r), now: () => t });
    // First consider: fresh mail + idle => INJECT, which sets an outstanding injection.
    gate.consider(view(1, "2026-08-27T11:00:00.000Z"), "b3", true, { state: "idle", busyCoveredByHook: false });
    // Second consider with state UNKNOWN while an injection is outstanding => SUPPRESS
    // ("an injection is already outstanding"). The recorded state must be "unknown", NOT collapsed.
    t = 2000;
    const woke = gate.consider(view(2, "2026-08-27T11:05:00.000Z"), "b3", true, {
      state: "unknown",
      busyCoveredByHook: false,
    });
    expect(woke).toBe(false);
    const declines = records.filter((r) => r.action === "suppress");
    expect(declines).toHaveLength(1);
    expect(declines[0].state, "decline-on-unknown must not be folded into busy").toBe("unknown");
    expect(declines[0].reason).toMatch(/outstanding/);
  });

  it("an INJECT decision is recorded too (the delivery side of the 'was it ever delivered' question)", () => {
    const records: WakeDecisionRecord[] = [];
    const gate = new WakeGate(() => {}, { recordDecision: (r) => records.push(r), now: () => 0 });
    gate.consider(view(1, "2026-08-27T11:00:00.000Z"), "b4", true, { state: "idle", busyCoveredByHook: false });
    expect(records).toHaveLength(1);
    expect(records[0].action).toBe("inject");
    expect(records[0].woke, "autoInject on + fresh mail + idle => actually woke").toBe(true);
    expect(records[0].state).toBe("idle");
  });

  it("ENUMERATION (lesson 1): every route decision wake-routing can emit is CAPTURED + versioned — none silently dropped", () => {
    const records: WakeDecisionRecord[] = [];
    const gate = new WakeGate(() => {}, { recordDecision: (r) => records.push(r), now: () => 1000 });
    gate.consider(view(0, null), "a", true, { state: "idle", busyCoveredByHook: false }); // suppress "no pending mail"
    gate.consider(view(1, "t1"), "a", true, { state: "busy", busyCoveredByHook: true }); // suppress "hook-covered"
    gate.consider(view(2, "t2"), "a", true, { state: "idle", busyCoveredByHook: false }); // INJECT (sets outstanding)
    gate.consider(view(3, "t3"), "a", true, { state: "idle", busyCoveredByHook: false }); // suppress "already outstanding"
    expect(records.every((r) => r.v === 1), "every record versioned").toBe(true);
    const reasons = records.map((r) => r.reason);
    expect(reasons).toContain("no pending mail");
    expect(reasons.some((r) => /hook-covered/.test(r)), "busy+hook-covered captured").toBe(true);
    expect(reasons.some((r) => /Tether owns this wake/.test(r)), "inject captured").toBe(true);
    expect(reasons.some((r) => /already outstanding/.test(r)), "injection-outstanding captured").toBe(true);
  });

  it("P2: records the ACTUAL outcome, not just the proposal — autoInjectInbox=false (the DEFAULT) => action:'inject' but woke:false", () => {
    // routeWake PROPOSES inject (pending + idle + no outstanding); decideWake DISPOSES: shouldWake is
    // false when autoInjectInbox is off. The record must show the GAP (proposed inject, no wake fired),
    // never claim a delivery that did not happen — that would invert the very defect M3 measures.
    const records: WakeDecisionRecord[] = [];
    const gate = new WakeGate(() => {}, { recordDecision: (r) => records.push(r), now: () => 1000 });
    const woke = gate.consider(view(2, "2026-08-27T11:00:00.000Z"), "a", false /* autoInjectInbox OFF */, {
      state: "idle",
      busyCoveredByHook: false,
    });
    expect(woke, "no wake actually fired (autoInject off)").toBe(false);
    expect(records).toHaveLength(1);
    expect(records[0].action, "routeWake PROPOSED inject").toBe("inject");
    expect(records[0].woke, "but decideWake refused — the gap is the finding").toBe(false);
  });
});

describe("M3 — wake-decision-log sink (durable NDJSON, fail-independent of the wake path)", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-log-"));
    file = defaultWakeLogPath(dir);
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("append + read round-trips records as NDJSON", () => {
    const rec: WakeDecisionRecord = {
      kind: "decision",
      v: 1,
      agentName: "a",
      decided_at: "2026-08-27T12:00:00.000Z",
      action: "suppress",
      reason: "busy + hook-covered — PostToolUse owns delivery",
      woke: false,
      last_message_at: "2026-08-27T11:00:00.000Z",
      pending_count: 5,
      state: "busy",
      busyCoveredByHook: true,
      injectionOutstanding: false,
    };
    appendWakeLogRecord(file, rec);
    appendWakeLogRecord(file, { ...rec, action: "inject", state: "idle" });
    const back = readWakeLog(file);
    expect(back).toHaveLength(2);
    expect(back[0]).toEqual(rec);
    expect(back[1]).toMatchObject({ action: "inject", state: "idle" });
  });

  it("P1b: a FAILING append does not vanish — the loss is stamped (droppedSince) into the next record that writes", () => {
    const written: WakeDecisionRecord[] = [];
    let failNext = false;
    const append = (r: WakeDecisionRecord): void => {
      if (failNext) throw new Error("EACCES (simulated)");
      written.push(r);
    };
    const sink = makeDroppingDecisionSink(append);
    const base = (id: string): WakeDecisionRecord => ({
      kind: "decision", v: 1, agentName: id, decided_at: "t", action: "suppress", reason: "r",
      woke: false, last_message_at: null, pending_count: 0, state: "idle",
      busyCoveredByHook: false, injectionOutstanding: false,
    });
    sink(base("ok1")); // writes
    failNext = true;
    sink(base("lost1")); // fails at the fs layer — but the loss is NOT silent
    sink(base("lost2")); // fails again
    failNext = false;
    sink(base("ok2")); // writes, and STAMPS the two prior losses so a reader can see them
    expect(written.map((r) => r.agentName)).toEqual(["ok1", "ok2"]);
    expect(written[0].droppedSince, "no loss before the first record").toBeUndefined();
    expect(written[1].droppedSince, "two lost records survive into the artifact").toBe(2);
  });

  it("activation record is written at activation — presence is the norm so absence is a signal", () => {
    writeActivationRecord(file, Date.parse("2026-08-27T09:00:00.000Z"));
    const back = readWakeLog(file);
    expect(back).toHaveLength(1);
    expect(back[0]).toEqual({ kind: "activation", at: "2026-08-27T09:00:00.000Z", v: 1 });
  });

  it("a missing log reads as [] (the reader tells missing from empty by file existence, not this return)", () => {
    expect(readWakeLog(path.join(dir, "nope.ndjson"))).toEqual([]);
  });

  it("readWakeLog SKIPS unversioned / wrong-version / bad-state / missing-woke / torn records — never coerces them", () => {
    const valid = JSON.stringify({ kind: "activation", at: "2026-08-27T09:00:00.000Z", v: 1 });
    const noVersion = JSON.stringify({
      kind: "decision", agentName: "a", decided_at: "x", action: "suppress", reason: "r", woke: false,
      last_message_at: null, pending_count: 0, state: "idle", busyCoveredByHook: false, injectionOutstanding: false,
    }); // NO v — must NOT be assumed v1
    const wrongVersion = JSON.stringify({ kind: "activation", at: "x", v: 2 });
    const badState = JSON.stringify({
      kind: "decision", v: 1, agentName: "a", decided_at: "x", action: "suppress", reason: "r", woke: false,
      last_message_at: null, pending_count: 0, state: "sleepy", busyCoveredByHook: false, injectionOutstanding: false,
    }); // state outside the closed tri-state
    const noWoke = JSON.stringify({
      kind: "decision", v: 1, agentName: "a", decided_at: "x", action: "inject", reason: "r",
      last_message_at: null, pending_count: 1, state: "idle", busyCoveredByHook: false, injectionOutstanding: false,
    }); // NO woke — the ACTUAL-outcome field is required; a proposal-only record is incomplete (P2)
    const torn = '{"kind":"decision","v":1,"agentN';
    fs.writeFileSync(file, [valid, noVersion, wrongVersion, badState, noWoke, torn].join("\n") + "\n");
    const back = readWakeLog(file);
    expect(back, "only the valid v:1 record survives").toHaveLength(1);
    expect(back[0]).toMatchObject({ kind: "activation", v: 1 });
  });

  it("E2E producer→sink→reader (lesson 5): WakeGate.consider() -> real fs sink -> readWakeLog yields the versioned record", () => {
    const gate = new WakeGate(() => {}, {
      now: () => Date.parse("2026-08-27T12:00:00.000Z"),
      recordDecision: (r) => appendWakeLogRecord(file, r), // the REAL fs sink, not a mock
    });
    gate.consider(view(3, "2026-08-27T11:59:00.000Z"), "builder-1", true, { state: "busy", busyCoveredByHook: true });
    const back = readWakeLog(file);
    const decisions = back.filter((r): r is WakeDecisionRecord => r.kind === "decision");
    expect(decisions, "the real producer's record must survive validation end-to-end").toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      v: 1,
      kind: "decision",
      action: "suppress",
      agentName: "builder-1",
      state: "busy",
    });
    expect(decisions[0].reason).toMatch(/hook-covered/);
  });
});
