// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The operator tripwire's RUN GUARD (a vitest globalSetup, listed FIRST by tests/_setup/vitest-tripwire-base.mjs).
 *
 * Setup creates the run's private directory (its HOME and its violations directory). Teardown is the
 * CATCH-PROOF backstop: every refusal anywhere in the run (the test workers, their node children) left
 * its own file under violations/, and none is ever consumed, so if ANY exists the teardown THROWS and
 * the run fails, even when every test passed because one caught the error. MEASURED on vitest 5.0.0 and
 * 5.0.3: a throwing globalSetup teardown makes the run exit 1 ("error during close").
 *
 * It fails CLOSED: a violations directory that is missing or unreadable at teardown is itself a failure.
 * On a failure the run directory is KEPT (the evidence); on success it is removed.
 *
 * It also runs the LIVE-RELAY GUARD (tests/_setup/live-relay-guard.mjs): a read-only snapshot of every live
 * relay DB a daemon holds, before the run, compared after it; anything new from outside the pre-run fleet
 * fails the run. Its verdict (CLEAN, offenders, or NOT_EVALUATED with the reason) is printed every run.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureNamesIn, guardAfter, guardBefore } from "./live-relay-guard.mjs";

const TESTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runDirOf(project) {
  const dir = project?.config?.env?.RELAY_TEST_TRIPWIRE_RUN_DIR;
  if (typeof dir !== "string" || !path.isAbsolute(dir)) {
    throw new Error("operator tripwire: RELAY_TEST_TRIPWIRE_RUN_DIR is missing from this run's env: the config does not extend tests/_setup/vitest-tripwire-base.mjs");
  }
  return dir;
}

/** Every recorded violation under `dir` (one file each, any depth). Throws when `dir` cannot be read. */
export function collectViolations(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.push({ file: full, text: fs.readFileSync(full, "utf-8").trim() });
    }
  };
  walk(dir);
  return out;
}

export default function setup(project) {
  const runDir = runDirOf(project);
  const env = project?.config?.env ?? {};
  let roots = [];
  try {
    roots = JSON.parse(env.RELAY_TEST_OPERATOR_ROOTS ?? "[]");
  } catch {
    roots = [];
  }
  const live = guardBefore(roots);
  const violations = path.join(runDir, "violations");
  fs.mkdirSync(path.join(runDir, "home"), { recursive: true, mode: 0o700 });
  // On Windows the base puts TEMP inside the private home: it must exist before any worker uses it.
  const temp = project?.config?.env?.TEMP;
  if (typeof temp === "string" && path.isAbsolute(temp)) fs.mkdirSync(temp, { recursive: true, mode: 0o700 });
  fs.mkdirSync(violations, { recursive: true, mode: 0o700 });
  return () => {
    const verdict = guardAfter(live, { fixtureNames: fixtureNamesIn(TESTS_DIR), nonce: env.RELAY_TEST_RUN_NONCE ?? "" });
    process.stdout.write(`${verdict.lines.join("\n")}\n`);
    if (verdict.fail) {
      throw new Error(`OPERATOR_TRIPWIRE: the LIVE relay changed in ways the pre-run fleet does not explain (see the live-relay guard lines above). Run directory kept: ${runDir}\n  ${verdict.lines.join("\n  ")}`);
    }
    let found;
    try {
      found = collectViolations(violations);
    } catch (err) {
      throw new Error(`OPERATOR_TRIPWIRE: the run's violations directory ${violations} could not be read (${err instanceof Error ? err.message : String(err)}): failing closed. Run directory kept: ${runDir}`);
    }
    if (found.length) {
      throw new Error(
        `OPERATOR_TRIPWIRE: ${found.length} operator-tripwire violation(s) in this run (refused, never delivered; a test may have caught the error). Run directory kept: ${runDir}\n  ${found.map((v) => v.text).join("\n  ")}`,
      );
    }
    fs.rmSync(runDir, { recursive: true, force: true });
  };
}
