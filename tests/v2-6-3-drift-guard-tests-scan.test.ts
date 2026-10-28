// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.6.3 — regression coverage for the tests/ drift-grep guard added to
 * scripts/pre-publish-check.sh.
 *
 * The bug class this guard catches: a test asserts against
 * `expect(...).toBe("X.Y.Z")` where X.Y.Z is the CURRENT package.json
 * version. As soon as the package version is bumped, the assertion goes
 * stale — but it slips past the src/-only drift guard because it lives
 * in tests/. v2.6.0 publish-prep caught one instance the hard way (the
 * --full gate failed at bumped state, not in normal iteration). v2.6.3
 * adds a guard step so the regression is caught immediately.
 *
 * Test path matches shipped path: this file invokes the actual
 * `tests_drift_guard` function from scripts/pre-publish-check.sh by
 * sourcing it via bash + awk extraction — the same code path the
 * pre-publish gate runs. NOT a TS reimplementation. Closes the loop on
 * "tests must exercise the shipped script, not a mock of it" discipline.
 *
 * PLANTS NEVER TOUCH THE REAL tests/ TREE. Each planted fixture goes into a FRESH temp project root (its own
 * package.json, at the current version, and its own tests/), and the guard runs with PROJECT_ROOT set to it: the
 * guard reads only $PROJECT_ROOT/package.json and $PROJECT_ROOT/tests. Planting into the real tests/ raced
 * other files that scan that tree (the parser-pin gate listed a plant, this file unlinked it, the read hit ENOENT,
 * measured twice in a parallel run): a test must never mutate a tree another test scans. D1 still runs the guard on
 * the REAL tree. The temp roots are removed after each test.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { shellFunctionSource } from "./_helpers/shell-function.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const GATE_SCRIPT = path.join(REPO_ROOT, "scripts", "pre-publish-check.sh");
const TESTS_DIR = path.join(REPO_ROOT, "tests");

const CURRENT_VERSION: string = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8"),
).version;

interface GuardResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Source the `tests_drift_guard` function from the gate script and invoke
 * it. Mirrors the awk-extraction pattern used in manual verification —
 * keeps the test asserting against the SAME bytes that ship in the gate.
 */
function runDriftGuard(root: string = REPO_ROOT): GuardResult {
  const script = `
set -u
PROJECT_ROOT='${root.replace(/'/g, "'\\''")}'
${shellFunctionSource(GATE_SCRIPT, "tests_drift_guard")}
tests_drift_guard
exit $?
`;
  const r = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 10_000 });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const roots: string[] = [];

/** A fresh temp project root holding ONLY the plant (and a package.json at the current version). */
function plantFixture(suffix: string, content: string): { root: string; planted: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "v2-6-3-drift-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "drift-fixture", version: CURRENT_VERSION }));
  fs.mkdirSync(path.join(root, "tests"));
  const planted = path.join(root, "tests", `_v2-6-3-fixture-${suffix}.fixture.ts`);
  fs.writeFileSync(planted, content);
  return { root, planted };
}

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("v2.6.3 — tests/ drift-grep guard regression coverage", () => {
  it("(D1) baseline at HEAD — no current-version literals → exit 0, success message", () => {
    const r = runDriftGuard();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`No tests/ drift — no hardcoded "${CURRENT_VERSION}" literals`);
  });

  it("plants never land in the REAL tests/ tree (a tree other tests scan); the guard is pointed at the plant's own root", () => {
    const { root, planted } = plantFixture("where", "export const X = 1;\n");
    expect(path.relative(TESTS_DIR, planted).startsWith(".."), `the plant ${planted} is outside ${TESTS_DIR}`).toBe(true);
    expect(planted.startsWith(path.join(root, "tests") + path.sep)).toBe(true);
    expect(fs.readdirSync(TESTS_DIR).filter((f) => f.startsWith("_v2-6-3-fixture-")), "nothing planted in the real tests/").toEqual([]);
  });

  it("(D2) planted current-version literal in tests/ → exit 1, file:line cited, remediation guidance", () => {
    const { root, planted } = plantFixture(
      "d2-bad",
      `// PLANTED for v2.6.3 regression test (D2)\n` +
        `export const HOSTILE = "${CURRENT_VERSION}";\n`,
    );
    const r = runDriftGuard(root);
    expect(r.status).toBe(1);
    // Error written to stderr per the gate's pattern.
    expect(r.stderr).toContain(`Hardcoded current-version literal "${CURRENT_VERSION}" detected`);
    expect(r.stderr).toContain(path.basename(planted));
    expect(r.stderr).toContain(":2:"); // line 2 carries the literal
    // Remediation guidance must point at the package.json-read pattern.
    expect(r.stderr).toContain("read the version from package.json");
    expect(r.stderr).toContain("readFileSync");
    expect(r.stderr).toContain("ALLOWLIST:");
  });

  it("(D3) planted literal with `// ALLOWLIST: <reason>` comment → exit 0 (per-line allowlist works)", () => {
    const { root } = plantFixture(
      "d3-allowed",
      `// PLANTED for v2.6.3 regression test (D3) — allowlist line\n` +
        `export const ALLOWED = "${CURRENT_VERSION}"; // ALLOWLIST: D3 regression — testing allowlist\n`,
    );
    const r = runDriftGuard(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("No tests/ drift");
  });

  it("(D4) older-version literal (not current) → exit 0 (selective scan: only current version triggers)", () => {
    // Catches the design intent: the guard is targeted at the CURRENT
    // version literal, not arbitrary X.Y.Z patterns. Tests legitimately
    // pin to old versions in fixtures (e.g. tests/v2-4-0-traffic-replay
    // has `version: "2.3.0"` for divergence comparisons), and those must
    // not false-positive.
    const { root } = plantFixture(
      "d4-old",
      `// PLANTED for v2.6.3 regression test (D4) — old-version fixture\n` +
        `export const HISTORICAL_FIXTURE = "1.0.0";\n` +
        `export const ALSO_HISTORICAL = "2.4.0";\n`,
    );
    const r = runDriftGuard(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("No tests/ drift");
  });

  it("(D5) literal inside a block comment / line comment → exit 0 (comment exclusion regex)", () => {
    const { root } = plantFixture(
      "d5-comment",
      `// PLANTED for v2.6.3 regression test (D5) — comment exclusion\n` +
        `// const FAKE_LITERAL = "${CURRENT_VERSION}"; // commented out, must not trigger\n` +
        ` * @see expected output: "${CURRENT_VERSION}" (jsdoc-style line — must not trigger)\n`,
    );
    const r = runDriftGuard(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("No tests/ drift");
  });
});
