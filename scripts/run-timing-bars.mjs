#!/usr/bin/env node
// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The PR-B timing bars, as their own serial gate step (CI both test jobs + scripts/pre-publish-check.sh).
 *
 * Codex R1 #4 (MEASURED): vitest exits 0 when `-t` matches ZERO tests, so a renamed or removed BARS suite would
 * pass this gate having measured nothing. This runner asserts the EXACT set that must run and pass: every name in
 * EXPECTED, nothing skipped, nothing failed. A rename fails here loudly; update EXPECTED in the same commit.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { timingBarsReport } from "./timing-bars-report.mjs";

// The repo root from this script's own PHYSICAL location: never the caller's cwd (a release-guard requirement).
const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const FILE = "tests/pr-b-failed-auth.test.ts";
const EXPECTED = [
  "A/A CONTROL",
  "(b) 20 wrong-token register_agent, (c) 20 wrong-token get_messages, (d) 20 unknown tokens with 51 agents",
  "unknown-provenance rows",
  "NEGATIVE CONTROL",
  "CEILING, a freeze",
  "CEILING, a host stall",
  "CEILING, the load worker is not a sentinel",
  "CEILING, a busy load worker",
  "CEILING, a missing sentinel stream",
];

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "timing-bars-")), "report.json");
const r = spawnSync(
  "npx",
  ["vitest", "run", FILE, "-t", "BARS", "--silent=false", "--reporter=verbose", "--reporter=json", `--outputFile.json=${out}`],
  { cwd: ROOT, stdio: "inherit", env: { ...process.env, RELAY_TIMING_BARS: "1" }, shell: process.platform === "win32" },
);
let report;
try {
  report = JSON.parse(fs.readFileSync(out, "utf-8"));
} catch (err) {
  console.error(`timing bars: FAIL, no vitest JSON report (${err.message}); vitest exit ${r.status}`);
  process.exit(1);
}
// A FINAL NOT_EVALUATED is reported as itself (never "FAIL") and still fails the gate (timing-bars-report.mjs).
const { ok, lines } = timingBarsReport(report.testResults.flatMap((f) => f.assertionResults), EXPECTED);
for (const line of lines) (ok ? console.log : console.error)(line);
if (!ok || r.status !== 0) {
  if (ok) console.error(`timing bars: FAIL, vitest exited ${r.status} though every expected test passed`);
  process.exit(1);
}
