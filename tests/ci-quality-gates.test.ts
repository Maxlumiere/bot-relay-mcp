// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The CI quality gates: a BLOCKING secrets scan (gitleaks, pinned by SHA-256) and a BLOCKING bug lint on the lines a
 * change adds, both required through ci-ok. These rows pin the pure parts (the diff parser, the added-line filter,
 * the scope, the canary markers), the verdict, and the workflow's shape. The gates themselves are proven on every CI
 * run by their canaries (every rule / the secrets scan must fire on a known-bad input) and their planted checks (a
 * violation committed in the CI checkout must BLOCK), which need the pinned tools and so run in their jobs, not here.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseAddedLines, onAddedLines, inLintScope, canaryExpectations } from "../scripts/ci-lint-changed.mjs";
import { verdict } from "../scripts/ci-verdict.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("the added-line filter", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -3,0 +4,2 @@ ctx",
    "+added4",
    "+added5",
    "@@ -10 +12 @@",
    "-old",
    "+new12",
    "@@ -20,3 +21,0 @@",
    "-gone",
    "diff --git a/src/b.ts b/src/b.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/b.ts",
    "@@ -0,0 +1,3 @@",
    "+x",
    "+y",
    "+z",
  ].join("\n");
  it("reads added lines per file: ranges, single lines, pure deletions (none), new files", () => {
    const m = parseAddedLines(diff);
    expect([...m.get("src/a.ts")!].sort((a, b) => a - b)).toEqual([4, 5, 12]);
    expect([...m.get("src/b.ts")!]).toEqual([1, 2, 3]);
  });
  it("keeps findings on added lines only; a message with NO rule (not linted) is kept wherever it is", () => {
    const added = parseAddedLines(diff);
    const results = [
      { filePath: "/r/src/a.ts", messages: [{ line: 4, ruleId: "eqeqeq", message: "m" }, { line: 6, ruleId: "eqeqeq", message: "untouched line" }] },
      { filePath: "/r/src/b.ts", messages: [{ line: undefined, ruleId: null, message: "File ignored because outside of base path." }] },
    ];
    const kept = onAddedLines(results, added, (p: string) => p.replace("/r/", ""));
    expect(kept).toEqual([
      { file: "src/a.ts", line: 4, rule: "eqeqeq", message: "m" },
      { file: "src/b.ts", line: 1, rule: "not-linted", message: "File ignored because outside of base path." },
    ]);
  });
  it("the scope: the root package's TypeScript and the scripts, never fixtures", () => {
    for (const f of ["src/db.ts", "tests/x.test.ts", "scripts/a.mjs", "src/cli/init.ts"]) expect(inLintScope(f), f).toBe(true);
    for (const f of ["tests/fixtures/bad.ts", "README.md", "hooks/check-relay.sh", "extensions/vscode/src/a.ts", "tools/lint/canary/clean.ts"]) expect(inLintScope(f), f).toBe(false);
  });
});

describe("the lint canaries", () => {
  const dir = "tools/lint/canary";
  const files = fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith(".ts"));
  it("cover every blocking rule, one canary line each, and a clean file with none", () => {
    const exp = files.flatMap((f) => canaryExpectations(`${dir}/${f}`, read(`${dir}/${f}`)));
    const config = read("tools/lint/eslint.config.mjs");
    const rules = [...config.matchAll(/^\s+"?(@typescript-eslint\/[a-z-]+|eqeqeq)"?:/gm)].map((m) => m[1]).sort();
    expect(rules).toEqual(["@typescript-eslint/no-floating-promises", "@typescript-eslint/no-misused-promises", "@typescript-eslint/no-unused-vars", "eqeqeq"]);
    expect(exp.map((e) => e.rule).sort()).toEqual(rules);
    expect(files).toContain("clean.ts");
    expect(canaryExpectations("clean.ts", read(`${dir}/clean.ts`))).toEqual([]);
  });
});

describe("ci-ok requires both blocking gates", () => {
  const needs = (over: Record<string, string> = {}) => {
    const base: Record<string, string> = {
      changes: "success", shard: "success", checks: "success", test: "success", smoke: "success",
      "timing-bars": "success", "test-windows": "success", "test-macos": "success", secrets: "success", lint: "success",
    };
    return Object.fromEntries(Object.entries({ ...base, ...over }).map(([k, r]) => [k, { result: r, outputs: k === "changes" ? { full: "true" } : {} }]));
  };
  it("green only when secrets AND lint succeeded; a skip, failure or cancellation of either FAILS", () => {
    expect(verdict(needs(), "all").ok).toBe(true);
    for (const j of ["secrets", "lint"]) for (const r of ["skipped", "failure", "cancelled"]) expect(verdict(needs({ [j]: r }), "all").ok, `${j}=${r}`).toBe(false);
  });
  it("a missing gate (not in needs) FAILS", () => {
    const n = needs();
    delete n.secrets;
    expect(verdict(n, "all").ok).toBe(false);
  });
});

describe("the gates' pins and wiring", () => {
  const sh = read("scripts/ci-gitleaks.sh");
  const ci = read(".github/workflows/ci.yml");
  it("gitleaks: one exact version and a 64-hex SHA-256, checked before the binary runs", () => {
    expect(sh).toMatch(/^GITLEAKS_VERSION="\d+\.\d+\.\d+"$/m);
    expect(sh).toMatch(/^GITLEAKS_SHA256="[0-9a-f]{64}"$/m);
    expect(sh).toMatch(/sha256sum "\$tgz"[\s\S]*if \[ "\$got" != "\$GITLEAKS_SHA256" \][\s\S]*exit 1[\s\S]*tar -xzf/);
    expect(sh).toMatch(/--redact/);
    expect(sh).not.toMatch(/releases\/latest|@latest/);
  });
  it("the lint toolchain: exact versions only (no ranges) and a lockfile", () => {
    const pkg = JSON.parse(read("tools/lint/package.json"));
    for (const [name, v] of Object.entries(pkg.devDependencies as Record<string, string>)) expect(v, name).toMatch(/^\d+\.\d+\.\d+$/);
    expect(fs.existsSync(path.join(ROOT, "tools/lint/package-lock.json"))).toBe(true);
  });
  it("both jobs run their canary and their planted check BEFORE the blocking step, and ci-ok needs both", () => {
    const job = (id: string) => ci.slice(ci.indexOf(`\n  ${id}:\n`), ci.indexOf("\n  # ", ci.indexOf(`\n  ${id}:\n`) + 5));
    const sec = job("secrets");
    expect(sec.indexOf("ci-gitleaks.sh install")).toBeLessThan(sec.indexOf("ci-gitleaks.sh canary"));
    expect(sec.indexOf("ci-gitleaks.sh canary")).toBeLessThan(sec.indexOf("ci-gitleaks.sh plant-check"));
    expect(sec.indexOf("ci-gitleaks.sh plant-check")).toBeLessThan(sec.indexOf("ci-gitleaks.sh scan-event"));
    expect(sec).toMatch(/fetch-depth: 0/);
    const lint = job("lint");
    expect(lint.indexOf("--canary")).toBeLessThan(lint.indexOf("--plant-check"));
    expect(lint.indexOf("--plant-check")).toBeLessThan(lint.indexOf("--changed"));
    expect(lint).toMatch(/ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
    expect(ci).toMatch(/^    needs: \[[^\]]*\bsecrets\b[^\]]*\blint\b[^\]]*\]$/m);
  });
});
