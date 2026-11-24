// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The public leak gate (layer C): the workflow's SAFETY SHAPE, its scan step's BEHAVIOUR (run for real with bash), and
 * the public scanner copy. Fixture list only (nonsense terms); the real list is a repository secret this test never sees.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WF = fs.readFileSync(path.join(REPO, ".github", "workflows", "public-leak-gate.yml"), "utf-8");
const SCAN = path.join(REPO, "tools", "public-leak-scan", "scan.mjs");
/**
 * A FIXTURE list (nonsense terms), built at run time: the canary is never written contiguously in a file of this
 * public repo, whose added lines are scanned with a list that carries it.
 */
const LIST = `${["zq", "canary", "7f3e9a1d"].join("-")}\nzorblax\n`;
const FIXTURE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "leakgate-list-")), "fixture.txt");
fs.writeFileSync(FIXTURE, LIST);

describe("the workflow's safety shape", () => {
  it("runs on pull_request_target only (opened, edited, synchronize, reopened)", () => {
    expect(WF).toMatch(/^on:\n {2}pull_request_target:\n {4}types: \[opened, edited, synchronize, reopened\]/m);
    expect(WF).not.toMatch(/^ {2}pull_request:/m);
  });

  it("checks out the BASE commit only, without persisted credentials, and ASSERTS HEAD is the base sha", () => {
    expect(WF).toContain("ref: ${{ github.event.pull_request.base.sha }}");
    expect(WF).toContain("persist-credentials: false");
    expect(WF).toContain('test "$(git rev-parse HEAD)" = "$BASE_SHA"');
    expect(WF).not.toMatch(/ref:\s*\$\{\{\s*github\.(event\.pull_request\.head|head_ref)/);
  });

  it("never interpolates untrusted PR text into a script (title, body, branch reach steps only via the API, as files)", () => {
    expect(WF).not.toMatch(/\$\{\{\s*github\.event\.pull_request\.(title|body|head\.ref|head\.label)\s*\}\}/);
    expect(WF).not.toMatch(/\$\{\{\s*github\.head_ref\s*\}\}/);
  });

  it("the secret enters only as the PUBLIC_DENYLIST env var and is read with --list-env (never an argument)", () => {
    const uses = WF.match(/secrets\.PUBLIC_DENYLIST/g) ?? [];
    expect(uses.length).toBe(1);
    expect(WF).toContain("PUBLIC_DENYLIST: ${{ secrets.PUBLIC_DENYLIST }}");
    expect(WF).toContain("--list-env PUBLIC_DENYLIST");
    expect(WF).not.toMatch(/--list\s+\S*\$\{\{/);
  });

  it("pins actions/checkout to a FULL commit sha (a privileged workflow)", () => {
    expect(WF).toMatch(/uses: actions\/checkout@[0-9a-f]{40} # v/);
    expect(WF).not.toMatch(/uses: actions\/checkout@v\d/);
  });

  it("no step may continue on error, and every commit listing paginates", () => {
    expect(WF).not.toMatch(/continue-on-error/);
    const commitCalls = WF.match(/gh api [^\n]*pulls\/\$PR_NUMBER\/commits[^\n]*/g) ?? [];
    expect(commitCalls.length).toBeGreaterThanOrEqual(2);
    for (const c of commitCalls) expect(c, c).toContain("--paginate");
  });

  it("asks for read-only permissions", () => {
    expect(WF).toMatch(/permissions:\n {2}contents: read\n {2}pull-requests: read\n/);
    expect(WF).not.toMatch(/: write/);
  });
});

/** The workflow's own "Scan" step, executed with bash against fixture metadata. */
function runScanStep(meta: Record<string, string>, env: Record<string, string>): { status: number | null; out: string } {
  const m = /- name: Scan \(prints field and term indexes only\)\n[\s\S]*?\n {8}run: \|\n([\s\S]*?)(?:\n {6}- name:|\s*$)/.exec(WF);
  expect(m, "the Scan step exists").not.toBeNull();
  const script = m![1]!.split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "leakgate-"));
  fs.mkdirSync(path.join(tmp, "leak-meta"));
  for (const [k, v] of Object.entries({ "pr-title": "", "pr-body": "", branch: "", "commit-msg": "", ...meta })) fs.writeFileSync(path.join(tmp, "leak-meta", k), v);
  const r = spawnSync("bash", ["-e", "-c", script], { cwd: REPO, encoding: "utf-8", env: { PATH: process.env.PATH ?? "", RUNNER_TEMP: tmp, ...env } });
  fs.rmSync(tmp, { recursive: true, force: true });
  return { status: r.status, out: r.stdout + r.stderr };
}

describe("the scan step, run for real (bash, fixture list)", () => {
  it("clean metadata → exit 0", () => {
    const r = runScanStep({ "pr-title": "fix(cli): a clean title", "pr-body": "an ordinary body", branch: "fix/clean", "commit-msg": "fix: clean" }, { PUBLIC_DENYLIST: LIST });
    expect(r.status, r.out).toBe(0);
  });

  it("a term in the body (and one in a commit message) → exit 1 with field + index only; the term and the text are never printed", () => {
    const r = runScanStep({ "pr-body": "thanks to Zorblax for the review", "commit-msg": "fix: zorblax said so" }, { PUBLIC_DENYLIST: LIST });
    expect(r.status).toBe(1);
    expect(r.out).toContain("FAIL field=pr-body terms=#2");
    expect(r.out).toContain("FAIL field=commit-msg terms=#2");
    expect(r.out).toContain("only the web UI removes it");
    expect(r.out.toLowerCase()).not.toContain("zorblax");
    expect(r.out).not.toContain("thanks to");
  });

  it("the secret MISSING (unset or empty) → fails CLOSED (exit 1, 'could not run'), never a pass", () => {
    for (const env of [{}, { PUBLIC_DENYLIST: "" }] as Array<Record<string, string>>) {
      const r = runScanStep({ "pr-body": "anything" }, env);
      expect(r.status, r.out).toBe(1);
      expect(r.out).toContain("could not run");
    }
  });
});

describe("the public scanner copy", () => {
  it("self-tests against a list carrying the canary (no copies file here, so no drift check)", () => {
    const r = spawnSync(process.execPath, [SCAN, "--self-test", "--list", FIXTURE], { encoding: "utf-8" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("self-test: PASS");
  });

  it("names no private location: no home path, no list location, no workspace path", () => {
    for (const f of [SCAN, path.join(REPO, "tools", "public-leak-scan", "README.md"), path.join(REPO, ".github", "workflows", "public-leak-gate.yml")]) {
      const text = fs.readFileSync(f, "utf-8");
      expect(text, f).not.toMatch(/\/Users\/|\.config\/|denylist\.txt|LLMs/);
    }
  });
});

/** A workflow step's run block, executed with bash. */
function stepScript(name: string): string {
  const m = new RegExp(`- name: ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n[\\s\\S]*?\\n {8}run: \\|\\n([\\s\\S]*?)(?:\\n {6}- name:|\\s*$)`).exec(WF);
  expect(m, `the step "${name}" exists`).not.toBeNull();
  return m![1]!.split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
}

describe("the metadata fetch step, run for real against a stub gh (completeness or fail closed)", () => {
  /** A stub `gh` answering the four reads from env: the count reported, the shas listed, the messages. */
  function runFetch(opts: { reported: string; listed: number }): { status: number | null; out: string } {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "leakgate-gh-"));
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/bin/sh\ncase "$*" in\n  *"--jq .commits"*) printf '%s\\n' "$STUB_REPORTED" ;;\n  *"/commits --jq .[].sha"*) i=0; while [ $i -lt "$STUB_LISTED" ]; do echo "sha$i"; i=$((i+1)); done ;;\n  *"/commits --jq .[].commit.message"*) echo "fix: a message" ;;\n  *) echo "a value" ;;\nesac\n`,
      { mode: 0o755 },
    );
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "leakgate-meta-"));
    const r = spawnSync("bash", ["-e", "-c", stepScript("Fetch the pull request metadata through the API (no code)")], {
      encoding: "utf-8",
      env: { PATH: `${bin}:${process.env.PATH ?? ""}`, RUNNER_TEMP: tmp, PR_NUMBER: "7", REPO: "o/r", GH_TOKEN: "x", STUB_REPORTED: opts.reported, STUB_LISTED: String(opts.listed) },
    });
    return { status: r.status, out: r.stdout + r.stderr };
  }
  it("a complete listing (3 reported, 3 listed) → exit 0", () => {
    const r = runFetch({ reported: "3", listed: 3 });
    expect(r.status, r.out).toBe(0);
  });
  it("TRUNCATED (3 reported, 2 listed) → exit 1, 'commit list truncated: failing closed'", () => {
    const r = runFetch({ reported: "3", listed: 2 });
    expect(r.status).toBe(1);
    expect(r.out).toContain("commit list truncated: failing closed");
  });
  it("ZERO commits → exit 1 (an empty listing never scans clean)", () => {
    expect(runFetch({ reported: "0", listed: 0 }).status).toBe(1);
  });
  it("MORE THAN 250 commits (the API's ceiling) → exit 1, even when the listing looks complete", () => {
    const r = runFetch({ reported: "251", listed: 251 });
    expect(r.status).toBe(1);
    expect(r.out).toContain("more than 250 commits");
  });
  it("an unreadable commit count → exit 1", () => {
    expect(runFetch({ reported: "null", listed: 1 }).status).toBe(1);
  });
});

describe("the scan step honours the scanner's caller contract (PASS = exit 0 AND exactly 'PASS')", () => {
  it("a term in the TITLE and in the BRANCH name → FAIL lines for both fields", () => {
    const r = runScanStep({ "pr-title": "zorblax approved", branch: "fix/zorblax" }, { PUBLIC_DENYLIST: LIST });
    expect(r.status).toBe(1);
    expect(r.out).toContain("FAIL field=pr-title terms=#2");
    expect(r.out).toContain("FAIL field=branch terms=#2");
  });

  /** The Scan step with a SUBSTITUTE scanner (in a temp tree): exit code + output chosen by the row. */
  function withScanner(body: string | null): { status: number | null; out: string } {
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), "leakgate-tree-"));
    fs.mkdirSync(path.join(tree, "tools", "public-leak-scan"), { recursive: true });
    if (body !== null) fs.writeFileSync(path.join(tree, "tools", "public-leak-scan", "scan.mjs"), body); // null: NO scanner at the base
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "leakgate-"));
    fs.mkdirSync(path.join(tmp, "leak-meta"));
    for (const k of ["pr-title", "pr-body", "branch", "commit-msg"]) fs.writeFileSync(path.join(tmp, "leak-meta", k), "clean");
    const r = spawnSync("bash", ["-e", "-c", stepScript("Scan (prints field and term indexes only)")], { cwd: tree, encoding: "utf-8", env: { PATH: process.env.PATH ?? "", RUNNER_TEMP: tmp, PUBLIC_DENYLIST: LIST } });
    return { status: r.status, out: r.stdout + r.stderr };
  }
  it("a scanner that exits 0 with OTHER output → 'could not run' (exit 1), never a pass", () => {
    const r = withScanner('process.stdout.write("OK\\n");\n');
    expect(r.status).toBe(1);
    expect(r.out).toContain("could not run");
  });
  it("a scanner CRASH (an uncaught exception: exit 1 without a FAIL line) → 'could not run', never read as a term", () => {
    const r = withScanner('throw new Error("boom");\n');
    expect(r.status).toBe(1);
    expect(r.out).toContain("could not run");
    expect(r.out).not.toContain("A denylisted term");
    expect(r.out, "never the irreversible-task text for a non-hit").not.toContain("tell the maintainer");
  });
  it("NO scanner at the base (node MODULE_NOT_FOUND, exit 1) → 'could not run', never a term and never the maintainer task", () => {
    const r = withScanner(null);
    expect(r.status).toBe(1);
    expect(r.out).toContain("could not run");
    expect(r.out).not.toContain("A denylisted term");
    expect(r.out).not.toContain("tell the maintainer");
  });
  it("a scanner exiting 3 → 'could not run'", () => {
    const r = withScanner("process.exit(3);\n");
    expect(r.status).toBe(1);
    expect(r.out).toContain("could not run");
  });
});

