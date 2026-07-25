// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.23.0 — pre-publish gate: BRANCH-IDENTITY + no-CI-run hardening.
 *
 * The pre-publish gate asserted CI COLOUR ("is this commit's CI green?") but NOT
 * BRANCH IDENTITY — so a green FEATURE BRANCH published silently as if it were
 * main, shipping unmerged code to every user. And a commit with NO ci.yml run
 * WARNed "proceed at own risk" — unverified reading as safe, the silence-as-
 * failure class this whole line of work exists to end.
 *
 * These tests extract the two gate functions from the SHIPPED script and run them
 * against a MOCKED `git`/`gh` so every branch is deterministic — including the
 * ones that must FAIL. A guard that cannot be shown to fail is a constant.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const GATE = path.join(REPO_ROOT, "scripts", "pre-publish-check.sh");

let sandbox: string;
let binDir: string;

/** A mock `git` honoring `-C <dir>`, driven by MOCK_HEAD / MOCK_ORIGIN / MOCK_FETCH_RC. */
const MOCK_GIT = `#!/usr/bin/env bash
args=("$@")
if [ "\${args[0]}" = "-C" ]; then args=("\${args[@]:2}"); fi
case "\${args[0]} \${args[1]}" in
  "rev-parse HEAD") echo "\${MOCK_HEAD}"; [ -n "\${MOCK_HEAD}" ] && exit 0 || exit 1 ;;
  "rev-parse FETCH_HEAD") [ -n "\${MOCK_ORIGIN}" ] && { echo "\${MOCK_ORIGIN}"; exit 0; } || exit 1 ;;
  "fetch --quiet") exit "\${MOCK_FETCH_RC:-0}" ;;
  *) exit 0 ;;
esac
`;

/** A mock `gh` that emits MOCK_CI as the resolved status (the function pipes --jq through gh). */
const MOCK_GH = `#!/usr/bin/env bash
echo "\${MOCK_CI:-unknown}"
`;

/**
 * Extract a shell function body from the gate script and run it with a controlled
 * PATH (mocks first) + env. Returns { code, out }.
 */
function runGateFn(
  fnName: string,
  env: Record<string, string>
): { code: number; out: string } {
  const harness =
    `PROJECT_ROOT="${REPO_ROOT}"\n` +
    // the gate fns call the shared _relay_is_ci_smoke helper — load it too.
    `eval "$(awk '/^_relay_is_ci_smoke\\(\\) \\{/,/^\\}/' "${GATE}")"\n` +
    `eval "$(awk '/^${fnName}\\(\\) \\{/,/^\\}/' "${GATE}")"\n` +
    `${fnName}\n`;
  const r = spawnSync("bash", ["-c", harness], {
    encoding: "utf8",
    // The skip signals are cleared by default so the ENFORCEMENT branches are
    // deterministic even when this test itself runs in CI (which sets GITHUB_ACTIONS
    // + RELAY_SMOKE_ONLY). A scenario opts into a context by passing them in `env`.
    env: {
      PATH: `${binDir}:${process.env.PATH}`,
      GITHUB_ACTIONS: "",
      CI: "",
      RELAY_SMOKE_ONLY: "",
      npm_lifecycle_event: "",
      ...env,
    },
  });
  return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "gate-branch-id-"));
  binDir = path.join(sandbox, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "git"), MOCK_GIT, { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, "gh"), MOCK_GH, { mode: 0o755 });
});
afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe("v2.23.0 pre-publish — branch-identity gate", () => {
  const SHA_A = "a".repeat(40);
  const SHA_B = "b".repeat(40);

  it("PASS: HEAD == origin/main → exit 0", () => {
    const r = runGateFn("branch_identity_gate", { MOCK_HEAD: SHA_A, MOCK_ORIGIN: SHA_A });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/HEAD == origin\/main/);
  });

  it("FAIL (the whole point): HEAD != origin/main → exit 1, refuses, prints both SHAs", () => {
    const r = runGateFn("branch_identity_gate", { MOCK_HEAD: SHA_A, MOCK_ORIGIN: SHA_B });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/HEAD is NOT origin\/main/);
    expect(r.out).toContain(SHA_A);
    expect(r.out).toContain(SHA_B);
    // Deliberately EXACT-equality, not ancestor-of — documented in the message.
    expect(r.out).toMatch(/not ancestor-of/i);
  });

  it("FAIL: cannot fetch/resolve origin/main → exit 1 (cannot-verify = refuse)", () => {
    const r = runGateFn("branch_identity_gate", { MOCK_HEAD: SHA_A, MOCK_FETCH_RC: "1" });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/could not fetch\/resolve origin\/main/);
  });

  it("OVERRIDE: RELAY_PUBLISH_ALLOW_NONMAIN=1 → exit 0 AND prints exactly what it overrides", () => {
    const r = runGateFn("branch_identity_gate", {
      MOCK_HEAD: SHA_A,
      MOCK_ORIGIN: SHA_B, // mismatch — override must still pass
      RELAY_PUBLISH_ALLOW_NONMAIN: "1",
    });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/OVERRIDE/);
    expect(r.out).toContain(SHA_A); // HEAD printed
    expect(r.out).toContain(SHA_B); // origin/main printed
    expect(r.out).toMatch(/NOT verified-equal to origin\/main/);
  });

  it("CI-SMOKE SKIP: RELAY_SMOKE_ONLY (not a publish) on a non-main branch → SKIP, not fail", () => {
    // The 25-tool smoke runs the whole gate on a PR branch (HEAD != origin/main);
    // enforcing there red-lined every non-main PR. The dedicated smoke flag skips.
    const r = runGateFn("branch_identity_gate", {
      MOCK_HEAD: SHA_A,
      MOCK_ORIGIN: SHA_B, // mismatch — the smoke skips before comparing
      RELAY_SMOKE_ONLY: "1",
    });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/SKIP/);
    expect(r.out).toMatch(/RELAY_SMOKE_ONLY/);
  });

  it("SPOOF REJECTED (codex #138 P1): GITHUB_ACTIONS=true alone does NOT skip — a non-main publish FAILS", () => {
    // A generic CI marker is not authorization for a manual publish. The old cut
    // skipped on GITHUB_ACTIONS; this proves that hole is closed.
    const r = runGateFn("branch_identity_gate", {
      MOCK_HEAD: SHA_A,
      MOCK_ORIGIN: SHA_B,
      GITHUB_ACTIONS: "true", // spoof — must be ignored
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/HEAD is NOT origin\/main/);
  });

  it("SPOOF REJECTED: RELAY_SMOKE_ONLY=1 during an ACTUAL publish (prepublishOnly) does NOT bypass → FAILS", () => {
    // Belt-and-suspenders: the smoke flag is never honored inside npm publish, so
    // `RELAY_SMOKE_ONLY=1 npm publish` from a non-main checkout is still rejected.
    const r = runGateFn("branch_identity_gate", {
      MOCK_HEAD: SHA_A,
      MOCK_ORIGIN: SHA_B,
      RELAY_SMOKE_ONLY: "1",
      npm_lifecycle_event: "prepublishOnly",
    });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/HEAD is NOT origin\/main/);
  });
});

describe("v2.23.0 pre-publish — CI green-gate: no-run promoted WARN→FAIL", () => {
  const SHA = "c".repeat(40);

  it("FAIL: no ci.yml run for HEAD → exit 1 (unverified must not read as safe)", () => {
    const r = runGateFn("ci_green_gate", { MOCK_HEAD: SHA, MOCK_CI: "no-run" });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/NO ci\.yml run/);
  });

  it("PASS: conclusion=success → exit 0", () => {
    const r = runGateFn("ci_green_gate", { MOCK_HEAD: SHA, MOCK_CI: "success" });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/conclusion=success/);
  });

  it("scoped: an in-flight run stays WARN (exit 0) — the promotion is no-run-only", () => {
    const r = runGateFn("ci_green_gate", { MOCK_HEAD: SHA, MOCK_CI: "in_progress" });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/still running/);
  });

  it("CI-SMOKE tolerant: no-run under RELAY_SMOKE_ONLY stays WARN (exit 0) — the FAIL is publish-only", () => {
    // The smoke runs while its own ci.yml run is in flight; a gh no-run there is a
    // query artifact, not an unverified publish. Only the dedicated smoke flag.
    const r = runGateFn("ci_green_gate", { MOCK_HEAD: SHA, MOCK_CI: "no-run", RELAY_SMOKE_ONLY: "1" });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/tolerated/);
  });

  it("SPOOF REJECTED: no-run under GITHUB_ACTIONS alone still FAILS (generic CI var grants nothing)", () => {
    const r = runGateFn("ci_green_gate", { MOCK_HEAD: SHA, MOCK_CI: "no-run", GITHUB_ACTIONS: "true" });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/NO ci\.yml run/);
  });
});
