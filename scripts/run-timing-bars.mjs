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

// The repo root from this script's own PHYSICAL location: never the caller's cwd (a release-guard requirement).
const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const FILE = "tests/pr-b-failed-auth.test.ts";
const EXPECTED = [
  "A/A CONTROL",
  "(b) 20 wrong-token register_agent, (c) 20 wrong-token get_messages, (d) 20 unknown tokens with 51 agents",
  "unknown-provenance rows",
  "NEGATIVE CONTROL",
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
const results = report.testResults.flatMap((f) => f.assertionResults);
const ran = results.filter((t) => t.status === "passed" || t.status === "failed");
const missing = EXPECTED.filter((e) => !ran.some((t) => t.title.startsWith(e)));
const failed = ran.filter((t) => t.status !== "passed").map((t) => t.title);
const unexpected = ran.filter((t) => !EXPECTED.some((e) => t.title.startsWith(e))).map((t) => t.title);
console.log(`timing bars: ran ${ran.length} (expected exactly ${EXPECTED.length}), failed ${failed.length}`);
if (missing.length || failed.length || unexpected.length || ran.length !== EXPECTED.length || r.status !== 0) {
  if (missing.length) console.error(`timing bars: FAIL, did not run: ${missing.join(" | ")}`);
  if (failed.length) console.error(`timing bars: FAIL, failed: ${failed.join(" | ")}`);
  if (unexpected.length) console.error(`timing bars: FAIL, ran but not in EXPECTED (update the list): ${unexpected.join(" | ")}`);
  process.exit(1);
}
console.log("timing bars: PASS (the exact expected set ran and passed)");
