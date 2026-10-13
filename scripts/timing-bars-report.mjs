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
 */

/** The message tests/pr-b-failed-auth.test.ts's expectEvaluated throws for a FINAL NOT_EVALUATED. */
export const FINAL_NOT_EVALUATED = /(?:^|\n)\s*(?:\w*Error: )?NOT_EVALUATED, FINAL \(/;

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
  const failed = ran.filter((t) => t.status === "failed" && !notEvaluated.includes(t.title)).map((t) => t.title);
  const lines = [`timing bars: ran ${ran.length} (expected exactly ${expected.length}), failed ${failed.length}, not evaluated ${notEvaluated.length}`];
  if (missing.length) lines.push(`timing bars: FAIL, did not run: ${missing.join(" | ")}`);
  if (failed.length) lines.push(`timing bars: FAIL, failed: ${failed.join(" | ")}`);
  if (notEvaluated.length) {
    lines.push(`timing bars: NOT_EVALUATED (final, after every allowed attempt): a runner or instrument problem, NOT a code failure; this blocks the merge and must be escalated: ${notEvaluated.join(" | ")}`);
  }
  if (unexpected.length) lines.push(`timing bars: FAIL, ran but not in EXPECTED (update the list): ${unexpected.join(" | ")}`);
  const ok = !missing.length && !failed.length && !notEvaluated.length && !unexpected.length && ran.length === expected.length;
  if (ok) lines.push("timing bars: PASS (the exact expected set ran and passed)");
  return { ok, lines };
}
