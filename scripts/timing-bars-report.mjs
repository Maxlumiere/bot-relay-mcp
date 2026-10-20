// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The timing-bars gate's REPORT, pure (scripts/run-timing-bars.mjs prints it; tests/timing-bars-report.test.ts pins it).
 *
 * A test that ended in a FINAL NOT_EVALUATED (three unevaluated attempts: a runner or instrument problem) is reported
 * as NOT_EVALUATED, never as FAIL, because no code defect was measured. It still fails the gate (a nonzero exit): it
 * blocks the merge and is escalated.
 *
 * A test that threw a FIXTURE_FAULT (a planted stall that did not land as planted: tests/pr-b-failed-auth.test.ts,
 * hostStallPlantFault / freezePlantFault) is reported as FIXTURE_FAULT, never as FAIL: the fixture is broken, no code
 * defect was measured. It also fails the gate, loudly, and is never re-run.
 */

/** The message tests/pr-b-failed-auth.test.ts's expectEvaluated throws for a FINAL NOT_EVALUATED. */
export const FINAL_NOT_EVALUATED = /(?:^|\n)\s*(?:\w*Error: )?NOT_EVALUATED, FINAL \(/;
/** The message hostStallPlantFault / freezePlantFault build, thrown by the test. */
export const FIXTURE_FAULT = /(?:^|\n)\s*(?:\w*Error: )?FIXTURE_FAULT \(/;

/**
 * @param {Array<{ title: string; status: string; failureMessages?: string[] }>} results vitest JSON assertionResults
 * @param {string[]} expected the title prefixes that must run and pass
 * @returns {{ ok: boolean; lines: string[] }}
 */
export function timingBarsReport(results, expected) {
  const ran = results.filter((t) => t.status === "passed" || t.status === "failed");
  const missing = expected.filter((e) => !ran.some((t) => t.title.startsWith(e)));
  const unexpected = ran.filter((t) => !expected.some((e) => t.title.startsWith(e))).map((t) => t.title);
  const notEvaluated = ran.filter((t) => t.status === "failed" && (t.failureMessages ?? []).some((m) => FINAL_NOT_EVALUATED.test(m))).map((t) => t.title);
  const fixtureFaults = ran.filter((t) => t.status === "failed" && !notEvaluated.includes(t.title) && (t.failureMessages ?? []).some((m) => FIXTURE_FAULT.test(m))).map((t) => t.title);
  const failed = ran.filter((t) => t.status === "failed" && !notEvaluated.includes(t.title) && !fixtureFaults.includes(t.title)).map((t) => t.title);
  const lines = [`timing bars: ran ${ran.length} (expected exactly ${expected.length}), failed ${failed.length}, not evaluated ${notEvaluated.length}, fixture faults ${fixtureFaults.length}`];
  if (missing.length) lines.push(`timing bars: FAIL, did not run: ${missing.join(" | ")}`);
  if (failed.length) lines.push(`timing bars: FAIL, failed: ${failed.join(" | ")}`);
  if (notEvaluated.length) {
    lines.push(`timing bars: NOT_EVALUATED (final, after every allowed attempt): a runner or instrument problem, NOT a code failure; this blocks the merge and must be escalated: ${notEvaluated.join(" | ")}`);
  }
  if (fixtureFaults.length) {
    lines.push(`timing bars: FIXTURE_FAULT (a planted stall did not land as planted): the test fixture is broken, NOT a code failure; never re-run; this blocks the merge: ${fixtureFaults.join(" | ")}`);
  }
  if (unexpected.length) lines.push(`timing bars: FAIL, ran but not in EXPECTED (update the list): ${unexpected.join(" | ")}`);
  const ok = !missing.length && !failed.length && !notEvaluated.length && !fixtureFaults.length && !unexpected.length && ran.length === expected.length;
  if (ok) lines.push("timing bars: PASS (the exact expected set ran and passed)");
  return { ok, lines };
}
