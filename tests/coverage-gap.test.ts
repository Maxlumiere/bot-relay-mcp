// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * reportCoverageGap (tests/_helpers/coverage-gap.ts): a row skipped because its observation is proven impossible at
 * runtime leaves ONE "coverage gaps: …" line in the log and the CI job's step summary, naming the follow-up.
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reportCoverageGap, coverageGapLine } from "./_helpers/coverage-gap.js";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "coverage-gap-"));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe("a coverage gap is visible", () => {
  it("the line names what was not evaluated, why, and the follow-up", () => {
    expect(coverageGapLine("rows X", "ps cannot show argv", "a Windows sampler")).toBe("coverage gaps: rows X NOT_EVALUATED (ps cannot show argv); follow-up: a Windows sampler");
  });
  it("on CI it is APPENDED to the job's step summary (and logged); other summary content is kept", () => {
    const summary = path.join(ROOT, "summary.md");
    fs.writeFileSync(summary, "## earlier step\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      reportCoverageGap("rows X", "why", "next", { GITHUB_STEP_SUMMARY: summary });
      expect(log).toHaveBeenCalledWith("coverage gaps: rows X NOT_EVALUATED (why); follow-up: next");
    } finally {
      log.mockRestore();
    }
    expect(fs.readFileSync(summary, "utf-8")).toBe("## earlier step\ncoverage gaps: rows X NOT_EVALUATED (why); follow-up: next\n");
  });
  it("off CI (no step summary): printed to stdout only, never throws", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(() => reportCoverageGap("r", "w", "n", {})).not.toThrow();
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });
  it("on CI, an UNWRITABLE step summary FAILS with one line (the gap can never vanish)", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(() => reportCoverageGap("r", "w", "n", { GITHUB_STEP_SUMMARY: path.join(ROOT, "no-such-dir", "s.md") })).toThrow(
        /^coverage gaps: the CI step summary could not be appended \(.+\): coverage gaps: r NOT_EVALUATED \(w\); follow-up: n$/,
      );
    } finally {
      log.mockRestore();
    }
  });
  it("the reason is SANITIZED: control characters stripped, length capped", () => {
    const line = coverageGapLine("r", `bad\u0000\u001b[31mreason\n${"x".repeat(400)}`, "n");
    expect(line).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(line.length).toBeLessThan(260);
  });
});
