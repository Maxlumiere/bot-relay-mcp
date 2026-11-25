// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * A COVERAGE GAP, made visible: a row whose observation is proven impossible AT RUNTIME (its probe failed, or its
 * observer never witnessed the target) is skipped by name, and this prints ONE "coverage gaps: …" line to the log
 * and, on CI, appends it to the job's step summary ($GITHUB_STEP_SUMMARY), so the gap stands out from ordinary
 * skips, with its follow-up named. On CI a FAILED append THROWS one line (the gap must not vanish: the job fails);
 * off CI (no step summary) the line goes to stdout only.
 */
import fs from "node:fs";
import { sanitizeDiagnostic } from "./argv-sampler.js";

export function coverageGapLine(what: string, reason: string, followUp: string): string {
  return `coverage gaps: ${what} NOT_EVALUATED (${sanitizeDiagnostic(reason)}); follow-up: ${followUp}`;
}

export function reportCoverageGap(what: string, reason: string, followUp: string, env: NodeJS.ProcessEnv = process.env): string {
  const line = coverageGapLine(what, reason, followUp);
  console.log(line);
  const summary = env.GITHUB_STEP_SUMMARY;
  if (summary) {
    try {
      fs.appendFileSync(summary, `${line}\n`);
    } catch (err) {
      throw new Error(`coverage gaps: the CI step summary could not be appended (${sanitizeDiagnostic((err as Error).message)}): ${line}`);
    }
  }
  return line;
}
