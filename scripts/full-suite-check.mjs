#!/usr/bin/env node
// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Run ONE --full suite and require that its tests actually RAN AND PASSED, not just that vitest exited 0.
 *
 *   node scripts/full-suite-check.mjs <test file> <minimum passed> [--config <vitest config>]
 *
 * vitest exits 0 for a suite whose tests are all skipped (`describe.skip`, `it.skip`, `it.todo`) or that
 * collected nothing, so the exit code alone is not a gate. This reads vitest's JSON report and refuses
 * unless, for the named file: vitest exited 0; the file was collected and reported; no test failed; NONE was
 * skipped or todo; no file-level failure (a hook or collection error); and at least <minimum passed> tests
 * passed. The minimum is the suite's current test count (a floor: adding tests never breaks it; losing or
 * skipping one does). The default config is vitest.full.config.ts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function refuse(why) {
  process.stderr.write(`full-suite-check: REFUSED: ${why}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
const ci = args.indexOf("--config");
const config = ci >= 0 ? args[ci + 1] : "vitest.full.config.ts";
const positional = ci >= 0 ? args.filter((_, i) => i !== ci && i !== ci + 1) : args;
const [file, minArg] = positional;
const min = Number(minArg);
if (!file || !Number.isInteger(min) || min < 1 || !config) {
  refuse("usage: full-suite-check.mjs <test file> <minimum passed, >= 1> [--config <vitest config>]");
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "full-suite-check-"));
const report = path.join(work, "report.json");
const vitest = spawnSync(
  process.execPath,
  [path.join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", "--config", path.resolve(ROOT, config), file, "--reporter=default", "--reporter=json", `--outputFile.json=${report}`],
  { cwd: ROOT, stdio: "inherit" },
);

let json;
try {
  json = JSON.parse(fs.readFileSync(report, "utf-8"));
} catch (err) {
  refuse(`${file}: vitest wrote no readable JSON report (exit ${vitest.status}): ${err.message}`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

const target = path.resolve(ROOT, file);
const results = (json.testResults ?? []).filter((r) => path.resolve(r.name) === target);
if (results.length !== 1) refuse(`${file}: expected exactly one report entry for this file, found ${results.length} (nothing collected?)`);
const [result] = results;
const assertions = result.assertionResults ?? [];
const count = (s) => assertions.filter((a) => a.status === s).length;
const passed = count("passed");
const failed = count("failed");
const notRun = assertions.length - passed - failed; // skipped, pending, todo, disabled
const problems = [];
if (vitest.status !== 0) problems.push(`vitest exited ${vitest.status}`);
if (typeof result.message === "string" && result.message.trim()) problems.push(`a file-level failure: ${result.message.trim().split("\n")[0].slice(0, 200)}`);
if (failed) problems.push(`${failed} failed`);
if (notRun) problems.push(`${notRun} did not run (skipped, todo or pending): ${assertions.filter((a) => a.status !== "passed" && a.status !== "failed").map((a) => a.title).slice(0, 5).join("; ")}`);
if (passed < min) problems.push(`${passed} passed, fewer than the ${min} expected`);
if (problems.length) refuse(`${file}: ${problems.join("; ")}`);
process.stdout.write(`full-suite-check: ${file}: ${passed} passed (expected at least ${min}), 0 failed, 0 skipped\n`);
