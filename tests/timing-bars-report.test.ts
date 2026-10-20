// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The timing-bars gate's REPORT (scripts/timing-bars-report.mjs, printed by scripts/run-timing-bars.mjs): a FINAL
 * NOT_EVALUATED is reported as itself and never as FAIL, and it still fails the gate (it blocks the merge).
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error -- a plain .mjs module with JSDoc types, no declaration file
import { timingBarsReport, FINAL_NOT_EVALUATED, FIXTURE_FAULT } from "../scripts/timing-bars-report.mjs";

type Result = { title: string; status: string; failureMessages?: string[] };
const EXPECTED = ["A/A CONTROL", "CEILING, a freeze"];
const passed = (title: string): Result => ({ title, status: "passed" });
const failed = (title: string, message: string): Result => ({ title, status: "failed", failureMessages: [message] });
// The message as vitest's JSON reporter carries it: the error's name, the message, then the stack.
const finalNe = `Error: NOT_EVALUATED, FINAL ((d) unknown token, token-only): 3 attempts, none evaluated. A runner or instrument problem, NOT a code defect: this blocks the merge and is escalated. #1: AVAILABILITY same-run A/A noise 40.0 ms > 25 ms\n    at expectEvaluated (tests/pr-b-failed-auth.test.ts:600:11)`;

describe("the timing-bars report: a FINAL NOT_EVALUATED is never called FAIL, and still fails the gate", () => {
  it("every expected test passed: ok, a PASS line", () => {
    const r = timingBarsReport([passed("A/A CONTROL: x"), passed("CEILING, a freeze: y")], EXPECTED);
    expect(r.ok).toBe(true);
    expect(r.lines.at(-1)).toMatch(/^timing bars: PASS/);
  });
  it("a FINAL NOT_EVALUATED: not ok (the gate fails), reported as NOT_EVALUATED, and no line calls it FAIL", () => {
    const r = timingBarsReport([failed("A/A CONTROL: x", finalNe), passed("CEILING, a freeze: y")], EXPECTED);
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toMatch(/NOT_EVALUATED \(final, after every allowed attempt\).*NOT a code failure.*A\/A CONTROL: x/);
    for (const line of r.lines) expect(line, "no line labels it a failure").not.toMatch(/\bFAIL\b/);
    expect(r.lines[0]).toMatch(/failed 0, not evaluated 1/);
  });
  it("an evaluated FAIL: not ok, reported as FAIL (never as NOT_EVALUATED)", () => {
    const r = timingBarsReport([failed("A/A CONTROL: x", "AssertionError: A/A: AVAILABILITY median paired d 80.0 ms >= the 50 ms effect size: expected 'FAIL' not to be 'FAIL'"), passed("CEILING, a freeze: y")], EXPECTED);
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toMatch(/timing bars: FAIL, failed: A\/A CONTROL: x/);
    expect(r.lines.join("\n")).not.toMatch(/NOT_EVALUATED \(final/);
  });
  it("one of each: both lines, each test under its own label", () => {
    const r = timingBarsReport([failed("A/A CONTROL: x", finalNe), failed("CEILING, a freeze: y", "AssertionError: boom")], EXPECTED);
    expect(r.ok).toBe(false);
    const text = r.lines.join("\n");
    expect(text).toMatch(/FAIL, failed: CEILING, a freeze: y\n/);
    expect(text).toMatch(/NOT_EVALUATED \(final[^\n]*A\/A CONTROL: x$/m);
  });
  it("a missing or an unexpected test still fails the gate (the exact-set rule is unchanged)", () => {
    expect(timingBarsReport([passed("A/A CONTROL: x")], EXPECTED).ok).toBe(false);
    expect(timingBarsReport([passed("A/A CONTROL: x"), passed("CEILING, a freeze: y"), passed("something new")], EXPECTED).ok).toBe(false);
  });
  it("a FIXTURE_FAULT (a planted stall that did not land): not ok, reported as FIXTURE_FAULT, never as FAIL or NOT_EVALUATED", () => {
    const fault = "Error: FIXTURE_FAULT (ceiling: whole process stopped 600 ms (attempt 1 only), auth round 5): the planted 600 ms whole-process stop did not land as planted (each of the next two must be >= 550 ms): the planting thread across its own SIGSTOP 602.4 ms; sentinel 176.4 ms, load worker 356.8 ms, main ticker 498.9 ms, histogram 498.9 ms, /health 517.6 ms. NOT a failure of the code: the fixture is broken, so this attempt is not re-run.\n    at stalledAttempt (tests/pr-b-failed-auth.test.ts:1700:11)";
    const r = timingBarsReport([failed("A/A CONTROL: x", fault), passed("CEILING, a freeze: y")], EXPECTED);
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toMatch(/failed 0, not evaluated 0, fixture faults 1/);
    expect(r.lines.join("\n")).toMatch(/timing bars: FIXTURE_FAULT \(a planted stall did not land as planted\).*NOT a code failure.*A\/A CONTROL: x/);
    for (const line of r.lines) expect(line, "no line labels it a failure of the code").not.toMatch(/\bFAIL\b|NOT_EVALUATED \(final/);
    expect(FIXTURE_FAULT.test(fault)).toBe(true);
    expect(FIXTURE_FAULT.test("AssertionError: expected the fixture to land"), "a mention is not the thrown fault").toBe(false);
  });
  it("the matcher keys on the EXACT message expectEvaluated throws, not on any mention of NOT_EVALUATED", () => {
    expect(FINAL_NOT_EVALUATED.test(finalNe)).toBe(true);
    expect(FINAL_NOT_EVALUATED.test("AssertionError: injected A/A noise must read NOT_EVALUATED (never red): expected 'PASS' to be 'NOT_EVALUATED'")).toBe(false);
  });
});
