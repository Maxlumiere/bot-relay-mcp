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
const WF_FILE = fs.readFileSync(path.join(REPO, ".github", "workflows", "public-leak-gate.yml"), "utf-8");
/**
 * THE MUTANTS, checkable from git objects: tests/fixtures/public-leak-gate-mutants.json holds each workflow mutation as
 * an exact {find, replace} diff. `LEAK_GATE_MUTANT=<name> npx vitest run tests/public-leak-gate.test.ts` runs this whole
 * file against the MUTATED workflow, and must go RED; without the variable it runs against the real file.
 */
const MUTANTS = JSON.parse(fs.readFileSync(path.join(REPO, "tests", "fixtures", "public-leak-gate-mutants.json"), "utf-8")) as Array<{ name: string; find: string; replace: string }>;
const MUTANT = process.env.LEAK_GATE_MUTANT ?? null;
const WF = ((): string => {
  if (MUTANT === null) return WF_FILE;
  const m = MUTANTS.find((x) => x.name === MUTANT);
  if (!m || WF_FILE.split(m.find).length !== 2) throw new Error(`LEAK_GATE_MUTANT: unknown or inapplicable mutant ${MUTANT}`);
  return WF_FILE.replace(m.find, () => m.replace);
})();
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

  it("never interpolates untrusted PR text into a script (title and body via the API, the branch via the event file; as files)", () => {
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

  it("no step may continue on error; the commits come from ONE compare response addressed by the event's own shas", () => {
    expect(WF).not.toMatch(/continue-on-error/);
    expect(WF).toContain('gh api "repos/$REPO/compare/$base...$head" > "$meta/compare.json"');
    expect(WF).not.toMatch(/pulls\/\$PR_NUMBER\/commits/); // the mutable per-PR listing is not used
    expect(WF).toContain(`base="$(jq -r '.pull_request.base.sha' "$GITHUB_EVENT_PATH")"`);
    expect(WF).toContain(`head="$(jq -r '.pull_request.head.sha' "$GITHUB_EVENT_PATH")"`);
  });

  it("every mutant in the fixture still applies to the real workflow (its find text occurs exactly once)", () => {
    expect(MUTANTS.length).toBeGreaterThanOrEqual(15);
    for (const m of MUTANTS) expect(WF_FILE.split(m.find).length - 1, m.name).toBe(1);
    expect(new Set(MUTANTS.map((m) => m.name)).size).toBe(MUTANTS.length);
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

describe("the metadata fetch step, run for real against a stub gh (the event's snapshot, complete, or fail closed)", () => {
  const BASE = "b".repeat(40);
  const HEAD = "c".repeat(40);
  const sha = (i: number) => i.toString(16).padStart(40, "0");
  /** A stub `gh` serving a pull JSON and ONE compare JSON; the event file names BASE...HEAD and the branch. */
  function runFetch(opts: { total: unknown; listed: number; lastIsHead?: boolean; eventHead?: string }): { status: number | null; out: string; meta: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leakgate-gh-"));
    const commits = Array.from({ length: opts.listed }, (_, i) => ({ sha: i === opts.listed - 1 && opts.lastIsHead !== false ? HEAD : sha(i + 1), commit: { message: `fix: message ${i}` } }));
    fs.writeFileSync(path.join(dir, "compare.json"), JSON.stringify({ total_commits: opts.total, commits }));
    fs.writeFileSync(path.join(dir, "pull.json"), JSON.stringify({ title: "a title", body: null, head: { sha: HEAD } }));
    fs.writeFileSync(path.join(dir, "event.json"), JSON.stringify({ pull_request: { base: { sha: BASE }, head: { sha: opts.eventHead ?? HEAD, ref: "feat/a-branch" } } }));
    fs.writeFileSync(
      path.join(dir, "gh"),
      `#!/bin/sh\ncase "$2" in\n  "repos/o/r/compare/${BASE}...${HEAD}") cat "${dir}/compare.json" ;;\n  "repos/o/r/pulls/7") cat "${dir}/pull.json" ;;\n  *) echo "stub gh: unexpected $*" >&2; exit 1 ;;\nesac\n`,
      { mode: 0o755 },
    );
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "leakgate-meta-"));
    const r = spawnSync("bash", ["-e", "-c", stepScript("Fetch the pull request metadata through the API (no code)")], {
      encoding: "utf-8",
      env: { PATH: `${dir}:${process.env.PATH ?? ""}`, RUNNER_TEMP: tmp, GITHUB_EVENT_PATH: path.join(dir, "event.json"), PR_NUMBER: "7", REPO: "o/r", GH_TOKEN: "x" },
    });
    return { status: r.status, out: r.stdout + r.stderr, meta: path.join(tmp, "leak-meta") };
  }
  it("complete (3 of 3, ending at the event's head) → exit 0; the files carry the title, the event's branch and every message", () => {
    const r = runFetch({ total: 3, listed: 3 });
    expect(r.status, r.out).toBe(0);
    expect(fs.readFileSync(path.join(r.meta, "pr-title"), "utf-8")).toBe("a title\n");
    expect(fs.readFileSync(path.join(r.meta, "pr-body"), "utf-8")).toBe("\n");
    expect(fs.readFileSync(path.join(r.meta, "branch"), "utf-8")).toBe("feat/a-branch\n");
    expect(fs.readFileSync(path.join(r.meta, "commit-msg"), "utf-8")).toBe("fix: message 0\nfix: message 1\nfix: message 2\n");
  });
  it("exactly 250 passes the guard", () => {
    const r = runFetch({ total: 250, listed: 250 });
    expect(r.status, r.out).toBe(0);
  });
  it("251 fails closed (one compare response lists at most 250)", () => {
    const r = runFetch({ total: 251, listed: 250 });
    expect(r.status).toBe(1);
    expect(r.out).toContain("more than 250 commits");
  });
  it("TRUNCATED (3 reported, 2 listed) → exit 1, 'commit list truncated: failing closed'", () => {
    const r = runFetch({ total: 3, listed: 2 });
    expect(r.status).toBe(1);
    expect(r.out).toContain("commit list truncated: failing closed");
  });
  it("ZERO commits → exit 1 for THAT reason (an empty listing never scans clean)", () => {
    const r = runFetch({ total: 0, listed: 0 });
    expect(r.status).toBe(1);
    expect(r.out).toContain("the pull request has no commits: failing closed");
  });
  it("an unreadable commit count → exit 1", () => {
    expect(runFetch({ total: null, listed: 1 }).status).toBe(1);
  });
  it("THE SNAPSHOT: the listed commits not ending at the event's head → exit 1, failing closed", () => {
    const r = runFetch({ total: 3, listed: 3, lastIsHead: false });
    expect(r.status).toBe(1);
    expect(r.out).toContain("do not end at the event's head");
  });
  it("the API cannot serve the event's base...head (the compare call fails) → exit 1, never a pass", () => {
    const r = runFetch({ total: 3, listed: 3, eventHead: "d".repeat(40) });
    expect(r.status).toBe(1);
  });
  it("an unreadable event sha → exit 1", () => {
    expect(runFetch({ total: 3, listed: 3, eventHead: "not-a-sha" }).status).toBe(1);
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
  it("exit 1 with MIXED output ('PASS' then a FAIL line) → 'could not run'", () => {
    const r = withScanner('const f = process.argv[process.argv.indexOf("--field") + 1]; process.stdout.write(`PASS\\nFAIL field=${f} terms=#2\\n`); process.exitCode = 1;\n');
    expect(r.status).toBe(1);
    expect(r.out).toContain("could not run");
    expect(r.out).not.toContain("A denylisted term");
  });
  it("exit 1 with 'FAIL … terms=#garbage' → 'could not run'", () => {
    const r = withScanner('const f = process.argv[process.argv.indexOf("--field") + 1]; process.stdout.write(`FAIL field=${f} terms=#garbage\\n`); process.exitCode = 1;\n');
    expect(r.status).toBe(1);
    expect(r.out).toContain("could not run");
  });
  it("exit 1 with a FAIL line for ANOTHER field → 'could not run'", () => {
    const r = withScanner('process.stdout.write("FAIL field=release-notes terms=#2\\n"); process.exitCode = 1;\n');
    expect(r.status).toBe(1);
    expect(r.out).toContain("could not run");
    expect(r.out).not.toContain("A denylisted term");
  });
  it("exit 0 with 'PASS' and an EXTRA newline → 'could not run' (the verdict is read from the bytes, not through $(...))", () => {
    const r = withScanner('process.stdout.write("PASS\\n\\n");\n');
    expect(r.status).toBe(1);
    expect(r.out).toContain("could not run");
  });
  it("the CONTROL: a substitute that prints exactly one valid FAIL line for its field, exit 1 → a HIT (the maintainer text)", () => {
    const r = withScanner('const f = process.argv[process.argv.indexOf("--field") + 1]; process.stdout.write(`FAIL field=${f} terms=#1,#2\\n`); process.exitCode = 1;\n');
    expect(r.status).toBe(1);
    expect(r.out).toContain("A denylisted term");
    expect(r.out).not.toContain("could not run");
  });
  it("the CONTROL: a substitute that prints exactly 'PASS\\n', exit 0 → a pass", () => {
    const r = withScanner('process.stdout.write("PASS\\n");\n');
    expect(r.status, r.out).toBe(0);
  });
  it("a scanner exiting 3 → 'could not run'", () => {
    const r = withScanner("process.exit(3);\n");
    expect(r.status).toBe(1);
    expect(r.out).toContain("could not run");
  });
});

