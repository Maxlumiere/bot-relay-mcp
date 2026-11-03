// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * CI speed (Part A): the scope rules, the shard-parity check, the macOS PR subset, and the shape of
 * .github/workflows/ci.yml that keeps the safety properties:
 *   - the three checks branch protection REQUIRES keep their exact names (renaming one would leave every PR
 *     waiting on a check that never reports);
 *   - the smoke runs in parallel with the tests and skips the gate's suite steps ONLY on pull requests;
 *   - macOS runs the full suite on main and nightly, the subset only on pull requests;
 *   - a ready pull request cancels its superseded run; a draft, main and nightly never do;
 *   - the aggregates run `always()` and check every result explicitly (a skipped job reports Success).
 * The workflow checks are TEXT checks on job blocks (no YAML parser is a dependency).
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { scope, isDocPath } from "../scripts/ci-scope.mjs";
import { shardParity, repoRelative } from "../scripts/ci-shard-parity.mjs";
import { macosPrSubset, MACOS_PR_PATTERNS } from "../scripts/ci-macos-pr-subset.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CI = fs.readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8");

/** Each job's block (from `  <id>:` to the next job), keyed by id. */
function jobs(src: string): Record<string, string> {
  const start = src.indexOf("\njobs:\n");
  expect(start, "ci.yml has a jobs: section").toBeGreaterThan(0);
  const body = src.slice(start + "\njobs:\n".length);
  const out: Record<string, string> = {};
  const re = /^  ([A-Za-z0-9_-]+):\s*$/gm;
  const heads = [...body.matchAll(re)];
  heads.forEach((m, i) => {
    out[m[1]] = body.slice(m.index!, i + 1 < heads.length ? heads[i + 1].index : body.length);
  });
  return out;
}
const J = jobs(CI);
const nameOf = (block: string) => (block.match(/^    name: (.+)$/m) ?? [])[1]?.trim();

describe("scope: docs-only and full", () => {
  it("a docs path is Markdown anywhere or anything under docs/", () => {
    for (const f of ["README.md", "docs/x.md", "docs/img/a.png", "hooks/NOTES.MD"]) expect(isDocPath(f), f).toBe(true);
    for (const f of ["src/a.ts", "tests/a.test.ts", "package.json", ".github/workflows/ci.yml", "md"]) expect(isDocPath(f), f).toBe(false);
  });
  it("the scope table", () => {
    const pr = (o: object) => scope({ event: "pull_request", draft: false, ciFull: false, changed: ["src/a.ts"], ...o });
    expect(pr({})).toEqual({ docsOnly: false, full: true });
    expect(pr({ draft: true })).toEqual({ docsOnly: false, full: false });
    expect(pr({ draft: true, ciFull: true })).toEqual({ docsOnly: false, full: true });
    expect(pr({ changed: ["README.md", "docs/a.md"] })).toEqual({ docsOnly: true, full: false });
    expect(pr({ changed: ["README.md", "src/a.ts"] })).toEqual({ docsOnly: false, full: true });
    // Fail SAFE: unknown or empty changes are never docs-only.
    expect(pr({ changed: null })).toEqual({ docsOnly: false, full: true });
    expect(pr({ changed: [] })).toEqual({ docsOnly: false, full: true });
    expect(scope({ event: "push", draft: false, ciFull: false, changed: ["src/a.ts"] })).toEqual({ docsOnly: false, full: true });
    expect(scope({ event: "push", draft: false, ciFull: false, changed: ["CHANGELOG.md"] })).toEqual({ docsOnly: true, full: false });
    for (const event of ["schedule", "workflow_dispatch"]) expect(scope({ event, draft: false, ciFull: false, changed: null })).toEqual({ docsOnly: false, full: true });
  });
});

describe("shard parity", () => {
  const suite = ["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts"];
  it("disjoint shards that cover the suite pass, with the totals", () => {
    const v = shardParity(2, [{ files: ["tests/a.test.ts", "tests/c.test.ts"], tests: 5 }, { files: ["tests/b.test.ts"], tests: 2 }], suite);
    expect(v).toEqual({ ok: true, problems: [], files: 3, tests: 7 });
  });
  it("FAILS on a file run twice, a file in no shard, an extra file, or the wrong number of shards", () => {
    expect(shardParity(2, [{ files: ["tests/a.test.ts", "tests/b.test.ts"], tests: 1 }, { files: ["tests/b.test.ts", "tests/c.test.ts"], tests: 1 }], suite).problems.join()).toMatch(/b\.test\.ts ran in shard 1 AND shard 2/);
    expect(shardParity(2, [{ files: ["tests/a.test.ts"], tests: 1 }, { files: ["tests/b.test.ts"], tests: 1 }], suite).problems.join()).toMatch(/in NO shard \(1\): tests\/c\.test\.ts/);
    expect(shardParity(1, [{ files: [...suite, "tests/z.test.ts"], tests: 1 }], suite).problems.join()).toMatch(/not in the suite \(1\): tests\/z\.test\.ts/);
    expect(shardParity(4, [{ files: suite, tests: 1 }], suite).problems.join()).toMatch(/expected 4 shard reports, found 1/);
  });
  it("paths from any runner's checkout compare as repo-relative", () => {
    expect(repoRelative("/home/runner/work/bot-relay-mcp/bot-relay-mcp/tests/a.test.ts")).toBe("tests/a.test.ts");
    expect(repoRelative("C:\\a\\b\\tests\\x.test.ts".split("\\").join(path.sep))).toBe("tests/x.test.ts");
  });
});

describe("the macOS pull-request subset", () => {
  const subset = macosPrSubset(ROOT);
  it("is chosen from the test sources, is not empty, and holds the hook, launchd and runInit tests", () => {
    expect(subset.length).toBeGreaterThan(20);
    for (const f of ["tests/hook-mute-diagnostics.test.ts", "tests/v2-4-0-instance-cli.test.ts"]) expect(subset, f).toContain(f);
  });
  it("every pattern selects at least one test (none is dead)", () => {
    const srcs = subset.map((f) => fs.readFileSync(path.join(ROOT, f), "utf8"));
    for (const re of MACOS_PR_PATTERNS) expect(srcs.some((s) => re.test(s)), String(re)).toBe(true);
  });
});

describe("ci.yml keeps the safety properties", () => {
  it("the three REQUIRED checks keep their exact names", () => {
    const names = Object.values(J).map(nameOf);
    for (const n of ["Test (Node 22)", "25-tool smoke (Node 22)", "Test (macOS — launchd side-effect guard)"]) expect(names, n).toContain(n);
  });
  it("the smoke no longer waits for the tests, and skips the gate's suite steps ONLY on pull requests", () => {
    expect(J.smoke).toMatch(/^    needs: changes$/m);
    expect(J.smoke).toMatch(/RELAY_SMOKE_ONLY: '1'/);
    expect(J.smoke).toMatch(/RELAY_SMOKE_SKIP_SUITE: \$\{\{ github\.event_name == 'pull_request' && '1' \|\| '' \}\}/);
    expect(J.smoke).toMatch(/run: bash scripts\/pre-publish-check\.sh/);
    expect(J.smoke, "the smoke stays build-less (fresh-clone ordering lock)").not.toMatch(/^\s+run: npm run build\s*$/m);
  });
  it("macOS: the subset ONLY on pull requests, the full suite otherwise; the launchd assertions and the bars stay", () => {
    expect(J["test-macos"]).toMatch(/if: github\.event_name == 'pull_request'\n\s+#[^\n]*\n\s+run: \|\n[\s\S]*ci-macos-pr-subset\.mjs/);
    expect(J["test-macos"]).toMatch(/- name: Run the full test suite \(main and nightly\)\n\s+if: github\.event_name != 'pull_request'\n\s+run: npx vitest run --maxWorkers=2/);
    expect(J["test-macos"]).toMatch(/Assert no bot-relay launchd service pre-exists/);
    expect(J["test-macos"]).toMatch(/Assert the suite installed NO real launchd service/);
    expect(J["test-macos"]).toMatch(/run: node scripts\/run-timing-bars\.mjs/);
  });
  it("the shard count and the parity check agree, and every shard writes the report the check reads", () => {
    const shards = (J.shard.match(/shard: \[([^\]]*)\]/) ?? [])[1]?.split(",").map((s) => s.trim());
    expect(shards).toEqual(["1", "2", "3", "4"]);
    expect(J.shard).toMatch(/--shard=\$\{\{ matrix\.shard \}\}\/4 /);
    expect(J.shard).toMatch(/--outputFile\.json=\.vitest-shard\/shard-\$\{\{ matrix\.shard \}\}\.json/);
    expect(J.test).toMatch(/node scripts\/ci-shard-parity\.mjs 4 \.vitest-shard/);
  });
  it("a READY pull request cancels its superseded run; drafts, main and nightly never cancel", () => {
    expect(CI).toMatch(/cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' && !github\.event\.pull_request\.draft \}\}/);
    expect(CI).toMatch(/group: ci-\$\{\{ \(github\.event_name == 'pull_request' && !github\.event\.pull_request\.draft\) && format\('pr-\{0\}', github\.event\.pull_request\.number\) \|\| github\.run_id \}\}/);
  });
  it("the aggregates run always() and check results explicitly; ci-ok needs every other job", () => {
    for (const id of ["test", "ci-ok"]) expect(J[id], id).toMatch(/^    if: always\(\)$/m);
    const needs = (J["ci-ok"].match(/^    needs: \[([^\]]*)\]/m) ?? [])[1]?.split(",").map((s) => s.trim()).sort();
    expect(needs).toEqual(Object.keys(J).filter((k) => k !== "ci-ok").sort());
  });
  it("no scoped job can be skipped by a FAILED scope job (it fails safe and runs)", () => {
    for (const id of ["timing-bars", "test-windows", "test-macos", "smoke"]) expect(J[id], id).toMatch(/needs\.changes\.result != 'success' \|\|/);
  });
  it("there is no workflow-level paths filter (it would leave required checks Pending)", () => {
    expect(CI).not.toMatch(/^\s+paths(-ignore)?:/m);
  });
});
