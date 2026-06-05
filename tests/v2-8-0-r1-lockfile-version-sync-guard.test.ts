// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.8.0 R1 — regression coverage for the lockfile-version-sync guard
 * added to scripts/pre-publish-check.sh.
 *
 * The bug class this guard catches: package.json says version X.Y.Z but
 * package-lock.json's root `.version` and/or `.packages[""].version`
 * say something else. `npm ci` does NOT validate this drift. CI passes,
 * the pre-publish gate (pre-R1) passed because it ran against the
 * working-tree lockfile rather than the committed one. The published
 * tarball would carry package.json's version, but the lockfile inside
 * still advertises the prior version. Consumer-visible inconsistency.
 *
 * Origin: v2.8.0 R0 ad9ac9fd shipped with package.json=2.8.0 +
 * package-lock.json root=2.7.4 because a rebase resolved the lockfile
 * conflict via `--ours`, the operator regenerated the lockfile in the
 * working tree, but never `git add` + amended the regen back into the
 * rebase commit. Caught post-merge pre-tag; fixed via v2.8.0 R1 (this
 * guard added the same round).
 *
 * Test path matches shipped path: this file extracts the actual
 * `lockfile_version_sync_guard` function from scripts/pre-publish-check.sh
 * via awk and invokes it against planted fixture directories. Same code
 * path the pre-publish gate runs. NOT a TS reimplementation — closes the
 * "tests must exercise the shipped script, not a mock" loop the v2.6.3
 * guard test already established.
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const GATE_SCRIPT = path.join(REPO_ROOT, "scripts", "pre-publish-check.sh");

// Read the current package.json version dynamically so this test file
// itself satisfies the v2.6.3 tests_drift_guard (which forbids hardcoded
// current-version literals in tests/ — they go stale on the next bump).
// Same pattern as tests/v2-6-3-drift-guard-tests-scan.test.ts uses.
const CURRENT_VERSION: string = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8"),
).version;
// A deliberately-old version literal for desync fixtures. Hardcoded
// because the POINT of the desync test is to prove the guard catches a
// mismatch — and this older literal is intentional, not drift. Older
// version literals do NOT trigger the v2.6.3 guard (that only flags
// the CURRENT version).
const OLD_VERSION = "2.7.4";
// A different older version literal used for the "only one lockfile
// field drifts" cases (L3/L4). Distinct from OLD_VERSION so the
// stderr citations stay unambiguous.
const OTHER_OLD_VERSION = "2.7.9";

interface GuardResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Source `lockfile_version_sync_guard` from the gate script and invoke
 * it against the given PROJECT_ROOT. Same awk-extraction pattern as the
 * v2.6.3 drift-guard test — the guard runs against the SAME bytes that
 * ship in scripts/pre-publish-check.sh.
 */
function runGuard(projectRoot: string): GuardResult {
  const script = `
set -u
PROJECT_ROOT='${projectRoot.replace(/'/g, "'\\''")}'
eval "$(awk '/^lockfile_version_sync_guard\\(\\) \\{/,/^\\}/' '${GATE_SCRIPT.replace(/'/g, "'\\''")}')"
lockfile_version_sync_guard
exit $?
`;
  const r = spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 10_000 });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const tempDirs: string[] = [];

function plantFixture(pkgVersion: string, lockRootVersion: string, lockPkgVersion: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v280r1-guard-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "test-fixture", version: pkgVersion }, null, 2),
  );
  fs.writeFileSync(
    path.join(dir, "package-lock.json"),
    JSON.stringify(
      {
        name: "test-fixture",
        version: lockRootVersion,
        lockfileVersion: 3,
        requires: true,
        packages: { "": { name: "test-fixture", version: lockPkgVersion } },
      },
      null,
      2,
    ),
  );
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()!;
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe("v2.8.0 R1 — lockfile version-sync guard", () => {
  it("(L1) all three versions equal → exit 0, success message", () => {
    const dir = plantFixture(CURRENT_VERSION, CURRENT_VERSION, CURRENT_VERSION);
    const r = runGuard(dir);
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("Lockfile version synced");
    expect(r.stdout).toContain(`package.json=${CURRENT_VERSION}`);
  });

  it("(L2) lockfile ROOT .version drifts from package.json → exit 1, all three versions cited, remediation guidance", () => {
    // The exact v2.8.0 R0 bug: package.json bumped (CURRENT_VERSION)
    // but lockfile root + packages[""] still lag the bump (OLD_VERSION).
    // Origin: a rebase that resolved the lockfile conflict via `--ours`
    // and never regenerated the lockfile back into the committed tree.
    const dir = plantFixture(CURRENT_VERSION, OLD_VERSION, OLD_VERSION);
    const r = runGuard(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("package.json <-> package-lock.json version drift");
    // All three values must be cited so the operator can spot the drift
    // at a glance without having to re-run jq.
    expect(r.stderr).toContain(`package.json .version:               ${CURRENT_VERSION}`);
    expect(r.stderr).toContain(`package-lock.json .version:          ${OLD_VERSION}`);
    expect(r.stderr).toContain(`package-lock.json .packages[""]:     ${OLD_VERSION}`);
    // Remediation guidance must point at the regen + amend flow that
    // closes both the in-place bug AND the rebase-checklist gap.
    expect(r.stderr).toContain("rm -rf node_modules package-lock.json && npm install");
    expect(r.stderr).toContain("git commit --amend");
  });

  it("(L3) only lockfile .packages[\"\"].version drifts (root agrees with package.json) → exit 1", () => {
    // A subtler drift class: someone hand-edits the lockfile root
    // version but misses .packages[""].version (or vice versa). Both
    // fields must agree with package.json. This pins that the guard
    // checks BOTH lockfile entries, not just one.
    const dir = plantFixture(CURRENT_VERSION, CURRENT_VERSION, OTHER_OLD_VERSION);
    const r = runGuard(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("version drift");
    expect(r.stderr).toContain(`package-lock.json .packages[""]:     ${OTHER_OLD_VERSION}`);
  });

  it("(L4) only lockfile ROOT .version drifts (packages[\"\"] agrees with package.json) → exit 1", () => {
    // Mirror of L3 — same defense-in-depth check from the other side.
    const dir = plantFixture(CURRENT_VERSION, OTHER_OLD_VERSION, CURRENT_VERSION);
    const r = runGuard(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("version drift");
    expect(r.stderr).toContain(`package-lock.json .version:          ${OTHER_OLD_VERSION}`);
  });

  it("(L5) baseline at HEAD (real repo) — guard passes against the shipped tree", () => {
    // Final defense-in-depth: invoke the guard against the actual repo
    // state. If this ever fails on main, the gate caught a real drift
    // before publish — exactly the contract v2.8.0 R1 establishes. If
    // the repo is mid-bump (package.json bumped, lockfile not yet
    // regenerated), this is expected to fail and surfaces the work
    // remaining before tag/publish.
    const r = runGuard(REPO_ROOT);
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("Lockfile version synced");
  });
});
