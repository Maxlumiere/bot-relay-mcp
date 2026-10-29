// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * scripts/full-suite-check.mjs: a --full step passes only when its suite's tests RAN AND PASSED. vitest
 * itself exits 0 for a suite whose tests are all skipped, so the exit code is not the gate.
 *
 * Every row runs the REAL checker, which runs REAL vitest (a nested run, under the real base config,
 * tripwire and run guard) on a tiny fixture suite in tests/fixtures/full-suite/.
 */
import { describe, it, expect } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { spawnNestedRun } from "./_setup/operator-tripwire.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = path.join(REPO, "scripts", "full-suite-check.mjs");
const CONFIG = "tests/fixtures/full-suite/vitest.config.ts";
const fixture = (name: string) => `tests/fixtures/full-suite/${name}.fixture.ts`;

/** The checker, as the gate runs it, with this worker's vitest and relay-test variables removed. */
async function check(...args: string[]): Promise<{ code: number | null; out: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("RELAY_TEST_") || k.startsWith("VITEST") || ["RELAY_HOME", "RELAY_DB_PATH", "RELAY_CONFIG_PATH", "RELAY_INSTANCE_ID"].includes(k)) delete env[k];
  const child = spawnNestedRun(process.execPath, [CHECK, ...args], { cwd: REPO, env });
  let out = "";
  child.stdout?.on("data", (d) => (out += d));
  child.stderr?.on("data", (d) => (out += d));
  const code = await new Promise<number | null>((r) => child.on("close", r));
  return { code, out };
}

describe.skipIf(process.platform === "win32")("full-suite-check: the tests must have RUN and PASSED", () => {
  it("TWIN: a suite whose tests all pass, at least the expected count, is accepted", async () => {
    const r = await check(fixture("pass"), "3", "--config", CONFIG);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`full-suite-check: ${fixture("pass")}: 3 passed (expected at least 3), 0 failed, 0 skipped`);
  }, 60_000);

  it("RED: a failing assertion is refused", async () => {
    const r = await check(fixture("fail"), "2", "--config", CONFIG);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/REFUSED: .*fail\.fixture\.ts: vitest exited 1; 1 failed/);
  }, 60_000);

  it("RED: a FULLY SKIPPED suite is refused, though vitest itself exits 0", async () => {
    const r = await check(fixture("skipped"), "3", "--config", CONFIG);
    expect(r.code).toBe(1);
    expect(r.out).not.toMatch(/vitest exited/);  // vitest was happy: only the report shows the problem
    expect(r.out).toMatch(/REFUSED: .*skipped\.fixture\.ts: 3 did not run .*; 0 passed, fewer than the 3 expected/);
  }, 60_000);

  it("RED: enough tests passing does not excuse one skipped and one todo", async () => {
    const r = await check(fixture("partial"), "3", "--config", CONFIG);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/REFUSED: .*partial\.fixture\.ts: 2 did not run \(skipped, todo or pending\)/);
  }, 60_000);

  it("RED: fewer passing tests than expected is refused (a test lost)", async () => {
    const r = await check(fixture("pass"), "4", "--config", CONFIG);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/REFUSED: .*3 passed, fewer than the 4 expected/);
  }, 60_000);

  it("RED: a file that fails to collect is refused", async () => {
    const r = await check(fixture("collect-error"), "1", "--config", CONFIG);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/REFUSED: .*collect-error\.fixture\.ts: vitest exited 1; a file-level failure/);
  }, 60_000);

  it("RED: a readable report that lacks the named file is refused (the file was not collected)", async () => {
    // vitest filters by substring: this prefix runs pass.fixture.ts, so the report is readable and complete,
    // but it holds no entry for the path the checker was asked about.
    const r = await check("tests/fixtures/full-suite/pass", "1", "--config", CONFIG);
    expect(r.code).toBe(1);
    expect(r.out).toContain("REFUSED: tests/fixtures/full-suite/pass: expected exactly one report entry for this file, found 0");
  }, 60_000);

  it("refuses a missing or non-positive minimum", async () => {
    for (const bad of [[fixture("pass")], [fixture("pass"), "0"], [fixture("pass"), "x"]]) {
      const r = await check(...bad, "--config", CONFIG);
      expect(r.code, bad.join(" ")).toBe(1);
      expect(r.out).toContain("REFUSED: usage:");
    }
  }, 60_000);
});
