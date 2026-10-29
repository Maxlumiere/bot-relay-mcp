// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The --full gate (load-smoke, chaos, cross-version) is ENFORCED for a publish, not opt-in:
 *  - package.json's prepublishOnly passes --full, and the gate forces it under prepublishOnly anyway;
 *  - a failing --full step stops the gate (non-zero exit) before anything after it;
 *  - a passing run prints one verdict block (commit, --full, the tested tarball), and writes no record;
 *  - .github/workflows/full-gate.yml runs it weekly on main, with write access only in a job that runs no
 *    repo code (the commit status release/full-gate + the gate-rot issue).
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync, spawnSync } from "child_process";
import { shellFunctionSource } from "./_helpers/shell-function.js";

const ROOT = path.resolve(__dirname, "..");
const GATE = path.join(ROOT, "scripts", "pre-publish-check.sh");
const SOURCE = fs.readFileSync(GATE, "utf8");
const FULL_STEPS = ["load-smoke (--full)", "chaos (--full)", "cross-version (--full)"];

function listSteps(args: string[], env: NodeJS.ProcessEnv = {}): string[] {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("npm_")));
  const out = execFileSync("bash", [GATE, ...args, "--list-steps"], { cwd: ROOT, encoding: "utf-8", timeout: 120_000, env: { ...clean, ...env } });
  return out.split("\n").filter((l) => l.startsWith("list-step: ")).map((l) => l.slice("list-step: ".length).split(" :: ")[0]);
}

describe("a publish always runs the --full steps", () => {
  it("package.json's prepublishOnly runs the gate with --full", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    expect(pkg.scripts.prepublishOnly).toBe("bash scripts/pre-publish-check.sh --full");
  });

  it.skipIf(process.platform === "win32")("in PUBLISH mode (prepublishOnly) the run list includes load-smoke, chaos and cross-version, even without --full", () => {
    const steps = listSteps([], { npm_lifecycle_event: "prepublishOnly" });
    for (const s of FULL_STEPS) expect(steps, s).toContain(s);
    expect(steps.at(-1)).toBe("re-pack identity (the uploaded tarball is the tested one)");
  });

  it.skipIf(process.platform === "win32")("TWIN: a dev run without --full lists none of them; with --full, all of them", () => {
    expect(listSteps([]).filter((s) => FULL_STEPS.includes(s))).toEqual([]);
    expect(listSteps(["--full"]).filter((s) => FULL_STEPS.includes(s))).toEqual(FULL_STEPS);
  });
});

/** The gate's own --full block and step() function, run with a stand-in `node` that fails one suite (the block
 * runs each suite as `node "$PROJECT_ROOT/scripts/full-suite-check.mjs" <file> <minimum>`). */
function runFullBlock(failing: string | null): { status: number | null; out: string; ran: string[] } {
  const lines = SOURCE.split("\n");
  const start = lines.findIndex((l) => l === 'if [ "$FULL_MODE" = "1" ]; then');
  const end = lines.findIndex((l, i) => i > start && l === "fi");
  expect(start, "the --full block").toBeGreaterThan(-1);
  const block = lines.slice(start, end + 1).join("\n");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "full-block-"));
  const log = path.join(dir, "ran.log");
  fs.mkdirSync(path.join(dir, "bin"));
  fs.writeFileSync(
    path.join(dir, "bin", "node"),
    `#!/bin/sh\nfor a in "$@"; do case "$a" in tests/*) echo "$a" >> "${log}";; esac; done\n` +
      (failing ? `for a in "$@"; do [ "$a" = "${failing}" ] && exit 1; done\n` : "") +
      "exit 0\n",
    { mode: 0o755 },
  );
  const script = `set -u\nFAIL=0\nSTEPS=()\nLIST_STEPS_MODE=0\nFULL_MODE=1\nPROJECT_ROOT=${JSON.stringify(ROOT)}\n${shellFunctionSource(GATE, "step")}\n${block}\necho REACHED_THE_END\n`;
  const r = spawnSync("bash", ["-c", script], { env: { ...process.env, PATH: `${path.join(dir, "bin")}:${process.env.PATH}` }, encoding: "utf8", timeout: 60_000 });
  const ran = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
  return { status: r.status, out: `${r.stdout}${r.stderr}`, ran };
}

describe.skipIf(process.platform === "win32")("a failing --full step stops the gate", () => {
  it("RED: chaos failing exits non-zero, and nothing after it runs", () => {
    const r = runFullBlock("tests/chaos.test.ts");
    expect(r.status).toBe(1);
    expect(r.out).not.toContain("REACHED_THE_END");
    expect(r.ran).toEqual(["tests/load-smoke.test.ts", "tests/chaos.test.ts"]);
  });

  it("RED: the last one failing also exits non-zero", () => {
    const r = runFullBlock("tests/cross-version.test.ts");
    expect(r.status).toBe(1);
    expect(r.out).not.toContain("REACHED_THE_END");
  });

  it("TWIN: all three passing runs all three and carries on", () => {
    const r = runFullBlock(null);
    expect(r.status).toBe(0);
    expect(r.out).toContain("REACHED_THE_END");
    expect(r.ran).toEqual(["tests/load-smoke.test.ts", "tests/chaos.test.ts", "tests/cross-version.test.ts"]);
  });
});

describe.skipIf(process.platform === "win32")("the verdict block a passing run prints", () => {
  function verdict(vars: Record<string, string>, dirty = false): string {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "verdict-"));
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...a], { cwd: repo, encoding: "utf8" }).trim();
    git("init", "-q");
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    git("add", "a.txt");
    git("commit", "-q", "-m", "a");
    if (dirty) fs.writeFileSync(path.join(repo, "a.txt"), "changed\n");
    const sha = git("rev-parse", "HEAD");
    const assigns = Object.entries({ PROJECT_ROOT: repo, ...vars }).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join("\n");
    const out = execFileSync("bash", ["-c", `set -u\n${assigns}\n${shellFunctionSource(GATE, "release_verdict")}\nrelease_verdict\n`], { encoding: "utf8" });
    return out.replace(sha, "<SHA>");
  }

  it("names the commit, the --full verdict and the tested tarball", () => {
    const out = verdict({ FULL_MODE: "1", tested_pack_name: "bot-relay-mcp-4.0.0.tgz", tested_pack_integrity: "sha512-abc" });
    expect(out).toContain("=== RELEASE GATE VERDICT ===");
    expect(out).toContain("  commit     <SHA>\n");
    expect(out).toContain("  full gate  PASS (load-smoke, chaos, cross-version: each ran its expected tests, none failed or skipped)");
    expect(out).toContain("  tarball    bot-relay-mcp-4.0.0.tgz sha512-abc");
  });

  it("says NOT RUN without --full, and flags uncommitted changes", () => {
    const out = verdict({ FULL_MODE: "0", tested_pack_name: "", tested_pack_integrity: "" }, true);
    expect(out).toContain("  full gate  NOT RUN (no --full: not a publish)");
    expect(out).toContain("<SHA> (uncommitted changes)");
    expect(out).toContain("  tarball    none (no tested pack)");
  });

  it("is printed only by a real passing run (never by --list-steps) and writes no file", () => {
    const listOut = execFileSync("bash", [GATE, "--full", "--list-steps"], { cwd: ROOT, encoding: "utf-8", timeout: 120_000 });
    expect(listOut).not.toContain("RELEASE GATE VERDICT");
    const body = shellFunctionSource(GATE, "release_verdict");
    expect(body.replace(/2>\/dev\/null/g, "")).not.toMatch(/>\s*[^&\s]|\btee\b|\bcp\b|\bmv\b|\bmkdir\b/);  // prints only
    expect(SOURCE).toMatch(/if \[ "\$FAIL" -eq 0 \]; then\n\s+if \[ "\$LIST_STEPS_MODE" != "1" \]; then release_verdict; fi/);
  });
});

describe("the weekly full-gate workflow", () => {
  const wf = fs.readFileSync(path.join(ROOT, ".github", "workflows", "full-gate.yml"), "utf8");
  // Each job's own text: from its key under `jobs:` to the next job key (or the end).
  const job = (name: string): string => {
    const m = new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z-]*:\\n|$)`).exec(wf);
    expect(m, `job ${name}`).not.toBeNull();
    return m![1];
  };

  it("runs weekly and on demand, read-only by default", () => {
    expect(wf).toMatch(/\non:\n  schedule:\n    - cron: '[^']+'/);
    expect(wf).toMatch(/\n  workflow_dispatch: \{\}/);
    expect(wf).toMatch(/\npermissions:\n  contents: read\n\n/);  // exactly contents: read, nothing more
  });

  it("the gate job runs the gate WITH --full on main, with no write permission", () => {
    const gate = job("gate");
    expect(gate).toContain("run: bash scripts/pre-publish-check.sh --full");
    expect(gate).toMatch(/ref: main/);
    expect(gate).toMatch(/persist-credentials: false/);
    expect(gate).not.toMatch(/permissions:/);  // inherits contents: read
  });

  it("the report job alone can write (statuses, issues) and runs no repo code", () => {
    const report = job("report");
    expect(report).toMatch(/permissions:\n      contents: read\n      statuses: write\n      issues: write\n/);
    expect(report).not.toMatch(/actions\/checkout|scripts\/|npm |node /);
    expect(report).toContain('context="release/full-gate"');
    expect(report).toMatch(/statuses\/\$\{SHA\}/);  // the exact SHA the gate job checked out
    expect(report).toMatch(/--label gate-rot/);
    expect(report).toMatch(/if: always\(\) && needs\.gate\.result != 'success'/);  // the issue on failure, whatever the status step did
  });

  it("reporting cannot vanish: the report job always runs, the status needs a SHA, the issue does not", () => {
    const report = job("report");
    expect(report).toMatch(/^    needs: gate\n(?:    #[^\n]*\n)*    if: always\(\)\n/m);  // not conditioned on the SHA
    const status = /- name: Commit status[^\n]*\n        if: ([^\n]+)/.exec(report);
    expect(status?.[1]).toBe("needs.gate.outputs.sha != ''");
    expect(report).toContain("UNAVAILABLE: the gate job failed before recording the commit");  // stated in the issue
  });
});

describe("each --full step requires its suite's tests to have run", () => {
  it("every --full step runs the suite check with that suite's current test count as its minimum", () => {
    const lines = SOURCE.split("\n").filter((l) => /^  step "[a-z-]+ \(--full\)"/.test(l));
    expect(lines).toEqual([
      '  step "load-smoke (--full)" node "$PROJECT_ROOT/scripts/full-suite-check.mjs" tests/load-smoke.test.ts 3 || exit 1',
      '  step "chaos (--full)" node "$PROJECT_ROOT/scripts/full-suite-check.mjs" tests/chaos.test.ts 6 || exit 1',
      '  step "cross-version (--full)" node "$PROJECT_ROOT/scripts/full-suite-check.mjs" tests/cross-version.test.ts 7 || exit 1',
    ]);
  });
});
