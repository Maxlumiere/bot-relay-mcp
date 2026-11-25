// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * A COVERAGE GAP, made visible: a row whose observation is proven impossible AT RUNTIME (its probe failed) is skipped
 * by name, and this prints ONE "coverage gaps: …" line to the log and, on CI, appends it to the job's step summary
 * ($GITHUB_STEP_SUMMARY), so the gap stands out from ordinary skips, with its follow-up named. Never throws: reporting a
 * gap must not change any row's outcome.
 */
import fs from "node:fs";

export function coverageGapLine(what: string, reason: string, followUp: string): string {
  return `coverage gaps: ${what} NOT_EVALUATED (${reason}); follow-up: ${followUp}`;
}

export function reportCoverageGap(what: string, reason: string, followUp: string, env: NodeJS.ProcessEnv = process.env): string {
  const line = coverageGapLine(what, reason, followUp);
  console.log(line);
  const summary = env.GITHUB_STEP_SUMMARY;
  if (summary) {
    try {
      fs.appendFileSync(summary, `${line}\n`);
    } catch {
      /* the log line above still carries it */
    }
  }
  return line;
}
