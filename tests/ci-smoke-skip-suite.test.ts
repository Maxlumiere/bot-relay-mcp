// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The PR smoke runs the pre-publish gate WITHOUT its two suite steps (the sequential full sweep and the
 * timing bars): on a pull request the suite already runs in ci.yml's sharded "Test (Node 22)" and the bars
 * in their own job, and the sweep alone was ~20 of the smoke's ~24 minutes (MEASURED, run 41573122313).
 *
 * The skip is honoured ONLY for the CI smoke (_relay_is_ci_smoke: RELAY_SMOKE_ONLY=1 and NOT a publish)
 * AND only with RELAY_SMOKE_SKIP_SUITE=1. A publish (npm_lifecycle_event=prepublishOnly) always runs both
 * steps, whatever else is set: the publish gate is not weakened. The main/nightly smoke (RELAY_SMOKE_ONLY
 * alone) runs both too. A skipped step is recorded as SKIP in the summary, never as PASS.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { shellFunctionSource } from "./_helpers/shell-function.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATE = path.join(REPO_ROOT, "scripts", "pre-publish-check.sh");

let sandbox: string;
let binDir: string;
let ran: string;

// npx and node stand-ins: record the call, run nothing.
const RECORDER = (name: string) => `#!/usr/bin/env bash\necho "${name} $*" >> "$RAN_LOG"\n`;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "gate-skip-suite-"));
  binDir = path.join(sandbox, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "npx"), RECORDER("npx"), { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, "node"), RECORDER("node"), { mode: 0o755 });
  ran = path.join(sandbox, "ran.log");
});
afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }));

/** Run the gate's real `step` with the real suite functions; returns the output, the calls made and STEPS. */
function runSteps(env: Record<string, string>): { code: number; out: string; calls: string[]; steps: string[] } {
  const fns = ["step", "_relay_is_ci_smoke", "_relay_ci_skips_suite", "suite_sweep", "timing_bars_step"];
  const harness =
    `PROJECT_ROOT="${REPO_ROOT}"\nLIST_STEPS_MODE=0\nFAIL=0\nSTEPS=()\n` +
    fns.map((f) => shellFunctionSource(GATE, f)).join("\n") +
    `\nstep "vitest run" suite_sweep || exit 1\n` +
    `step "timing bars (serial, isolated; the exact set must run)" timing_bars_step || exit 1\n` +
    `for s in "\${STEPS[@]}"; do echo "STEPS: $s"; done\n`;
  const r = spawnSync("bash", ["-c", harness], {
    encoding: "utf8",
    env: { PATH: `${binDir}:${process.env.PATH}`, RAN_LOG: ran, RELAY_SMOKE_ONLY: "", RELAY_SMOKE_SKIP_SUITE: "", npm_lifecycle_event: "", ...env },
  });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  return {
    code: r.status ?? -1,
    out,
    calls: fs.existsSync(ran) ? fs.readFileSync(ran, "utf8").split("\n").filter(Boolean) : [],
    steps: out.split("\n").filter((l) => l.startsWith("STEPS: ")).map((l) => l.slice(7)),
  };
}

const SWEEP = /^npx vitest run --pool=forks --no-file-parallelism$/;
const BARS = /^node .*scripts\/run-timing-bars\.mjs$/;

describe("the PR smoke skips the gate's suite steps; nothing else does", () => {
  it("CI smoke + RELAY_SMOKE_SKIP_SUITE=1: neither suite step runs, both are recorded as SKIP and say where they run", () => {
    const r = runSteps({ RELAY_SMOKE_ONLY: "1", RELAY_SMOKE_SKIP_SUITE: "1" });
    expect(r.code, r.out).toBe(0);
    expect(r.calls, r.out).toEqual([]);
    expect(r.steps).toEqual(["SKIP  vitest run", "SKIP  timing bars (serial, isolated; the exact set must run)"]);
    expect(r.out).toMatch(/SKIP .*sharded "Test \(Node 22\)"/);
    expect(r.out).toMatch(/SKIP .*"Timing bars/);
  });

  for (const [name, env] of [
    ["a PUBLISH (prepublishOnly) even with both flags set", { RELAY_SMOKE_ONLY: "1", RELAY_SMOKE_SKIP_SUITE: "1", npm_lifecycle_event: "prepublishOnly" }],
    ["RELAY_SMOKE_SKIP_SUITE=1 outside the CI smoke", { RELAY_SMOKE_SKIP_SUITE: "1" }],
    ["the main/nightly CI smoke (RELAY_SMOKE_ONLY alone)", { RELAY_SMOKE_ONLY: "1" }],
    ["a plain gate run (no flags)", {}],
  ] as const) {
    it(`${name}: BOTH suite steps run and are recorded as PASS`, () => {
      const r = runSteps(env as Record<string, string>);
      expect(r.code, r.out).toBe(0);
      expect(r.calls.length, r.out).toBe(2);
      expect(r.calls[0]).toMatch(SWEEP);
      expect(r.calls[1]).toMatch(BARS);
      expect(r.steps).toEqual(["PASS  vitest run", "PASS  timing bars (serial, isolated; the exact set must run)"]);
    });
  }

  it("a failing sweep still FAILS the step (the wrapper passes the real exit status through)", () => {
    fs.writeFileSync(path.join(binDir, "npx"), `#!/usr/bin/env bash\necho "npx $*" >> "$RAN_LOG"\nexit 7\n`, { mode: 0o755 });
    const r = runSteps({ RELAY_SMOKE_ONLY: "1" });
    expect(r.code, r.out).toBe(1);
    expect(r.calls).toHaveLength(1);
  });

  it("--list-steps still lists both suite steps under their own labels (the run list is unchanged)", () => {
    const out = spawnSync("bash", [GATE, "--list-steps"], { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000 }).stdout ?? "";
    expect(out).toMatch(/^list-step: vitest run :: /m);
    expect(out).toMatch(/^list-step: timing bars \(serial, isolated; the exact set must run\) :: /m);
  });
});
