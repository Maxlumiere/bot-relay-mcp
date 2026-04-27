// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.4.3 — pre-publish `npm audit` resilience.
 *
 * The wrapper at scripts/audit-with-retry.sh is the live circuit between
 * `npm audit` and the green CI badge. Tests classify the four real outcomes:
 *
 *   - clean response → exit 0
 *   - real high+ vuln finding → exit 1 (no retry on findings)
 *   - transient registry error 3x in a row → soft-fail to exit 0
 *   - unknown / malformed response → exit 1 (don't silently skip)
 *
 * The wrapper exposes a test seam (`RELAY_TEST_AUDIT_CMD`) so we never hit
 * the real npm registry from the test suite — the scripts/pre-publish gate
 * itself does that against the live registry once per gate run.
 *
 * Mocks return canonical-shape JSON to stdout + npm-style errors to stderr.
 * The "transient" classification is a stderr-pattern match, so the mocks
 * surface the same markers npm itself prints on registry-side failures.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, "..", "scripts", "audit-with-retry.sh");

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runWrapper(env: Record<string, string>, level = "high"): RunResult {
  const r = spawnSync("bash", [SCRIPT, level], {
    env: {
      ...process.env,
      // Default: skip backoff sleeps in tests.
      RELAY_AUDIT_NO_BACKOFF: "1",
      // Override max attempts ONLY when the test sets it; otherwise inherit
      // the production default of 3 so the contract stays intact.
      ...env,
    },
    encoding: "utf8",
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

describe("v2.4.3 — npm audit resilience wrapper", () => {
  it("(A1) clean audit on first try → exit 0", () => {
    const mock = `echo '{"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":0,"critical":0,"total":0}}}'; exit 0`;
    const r = runWrapper({ RELAY_TEST_AUDIT_CMD: mock });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/no vulns at threshold \(attempt 1\)/);
    // No retry chatter on the fast path.
    expect(r.stderr).not.toMatch(/retrying/);
  });

  it("(A2) real high+ vuln finding → exit 1, no retry", () => {
    // metadata.vulnerabilities.high > 0 ⇒ real finding ⇒ exit 1 immediately.
    // Wrapper must NOT retry findings (that's not what retry is for).
    const mock = `echo '{"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":2,"critical":0,"total":2}}}'; exit 1`;
    const r = runWrapper({ RELAY_TEST_AUDIT_CMD: mock });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/high\+ vulnerabilities found/);
    expect(r.stderr).not.toMatch(/retrying/);
  });

  it("(A3) transient 400 (the v2.4.0 main repro) 3x → soft-fail to exit 0", () => {
    // Reproduces the exact CI red on commit fb4cff0: "400 Bad Request -
    // POST .../audits/quick - Bad Request" + "endpoint is being retired".
    // Wrapper retries 3x, classifies as registry flake, exits 0 with WARN.
    const mock = `echo '{}'; echo "npm warn audit 400 Bad Request - POST https://registry.npmjs.org/-/npm/v1/security/audits/quick - Bad Request" >&2; echo "This endpoint is being retired. Use the bulk advisory endpoint instead." >&2; exit 1`;
    const r = runWrapper({ RELAY_TEST_AUDIT_CMD: mock });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/attempt 1 hit transient registry error/);
    expect(r.stderr).toMatch(/attempt 2 hit transient registry error/);
    expect(r.stderr).toMatch(/transient registry errors 3x in a row/);
    expect(r.stderr).toMatch(/soft-failing to exit 0/);
  });

  it("(A4) transient 503 3x with backoff → soft-fail to exit 0", () => {
    // 5xx is the other classic registry-side flake. Same outcome as A3.
    const mock = `echo '{}'; echo "npm error fetch failed for https://registry.npmjs.org/-/npm/v1/security/advisories/bulk: HTTP 503 Service Unavailable" >&2; exit 1`;
    const r = runWrapper({ RELAY_TEST_AUDIT_CMD: mock });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/transient registry errors 3x in a row/);
    expect(r.stderr).toMatch(/HTTP 503/);
  });

  it("(A5) malformed response with no transient marker → exit 1", () => {
    // Don't silently skip a new failure mode — surface it.
    const mock = `echo "this is not json at all"; echo "weird unknown error not matching any transient pattern" >&2; exit 1`;
    const r = runWrapper({ RELAY_TEST_AUDIT_CMD: mock });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/unknown failure mode/);
    expect(r.stderr).not.toMatch(/soft-failing/);
  });

  it("(A6) transient on attempt 1 then clean → exit 0 without soft-fail", () => {
    // Retry budget should fund recovery, not just paper over real failures.
    // First attempt hits a transient error; second attempt succeeds; the
    // wrapper exits 0 on the success path (NOT on the soft-fail path).
    const mock = `if [ "\${RELAY_AUDIT_ATTEMPT:-1}" -ge 2 ]; then echo '{"metadata":{"vulnerabilities":{"high":0,"critical":0}}}'; exit 0; else echo '{}'; echo "ETIMEDOUT during npm audit fetch" >&2; exit 1; fi`;
    const r = runWrapper({ RELAY_TEST_AUDIT_CMD: mock });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/no vulns at threshold/);
    // Saw exactly one retry (attempt 1) before success on attempt 2.
    expect(r.stderr).toMatch(/attempt 1 hit transient registry error/);
    expect(r.stderr).not.toMatch(/transient registry errors 3x in a row/);
  });
});
