// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * #48 — extension npm-audit gate: threshold + wiring.
 *
 * The extension's advisories were, until this gate, caught by neither Dependabot
 * (its security updater cannot bump an override-pinned transitive — measured, it
 * dies with "conflicting-dependencies") nor CI (only the root tree was audited).
 * scripts/pre-publish-check.sh now runs `audit-with-retry.sh high` in the
 * extension dir — the SAME wrapper and level as the root audit.
 *
 * These are the executed proofs victra required:
 *  - PROVE IT BITES: a HIGH (or CRITICAL) makes the gate exit non-zero.
 *  - NEVER CRY WOLF: a moderate-only result must PASS (0). We carry a
 *    deliberately-accepted MODERATE (@hono/node-server); gating on moderate would
 *    keep CI permanently red on an accepted item and train everyone to ignore it.
 *  - The gate is actually WIRED into the pre-publish gate.
 *
 * The wrapper's RELAY_TEST_AUDIT_CMD hook replaces `npm audit` with a stub that
 * emits canned metadata + the exit code npm audit returns at --audit-level=high
 * (non-zero only when high+ are present), so the threshold is proven without a
 * real vulnerable dependency in the tree.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const WRAPPER = path.join(REPO_ROOT, "scripts/audit-with-retry.sh");

function runGate(metadata: Record<string, number>, npmAuditExit: number): number {
  const json = JSON.stringify({ metadata: { vulnerabilities: metadata } });
  // Emit the canned audit JSON, then exit as npm audit would at --audit-level=high.
  const stub = `printf '%s' '${json}'; exit ${npmAuditExit}`;
  const res = spawnSync("bash", [WRAPPER, "high"], {
    encoding: "utf8",
    env: { ...process.env, RELAY_TEST_AUDIT_CMD: stub },
  });
  return res.status ?? 1;
}

const V = (o: Partial<Record<string, number>>) => ({ info: 0, low: 0, moderate: 0, high: 0, critical: 0, ...o });

describe("#48 extension audit gate — threshold (bites on high, never on moderate)", () => {
  it("BITES: a HIGH makes the gate exit non-zero", () => {
    expect(runGate(V({ high: 1 }), 1)).not.toBe(0);
  });

  it("BITES: a CRITICAL makes the gate exit non-zero", () => {
    expect(runGate(V({ critical: 1 }), 1)).not.toBe(0);
  });

  it("PASSES on moderate-only — a deliberately-accepted moderate must NEVER gate", () => {
    // npm audit --audit-level=high exits 0 when only moderates are present.
    expect(runGate(V({ moderate: 3 }), 0)).toBe(0);
  });

  it("PASSES on a fully clean tree", () => {
    expect(runGate(V({}), 0)).toBe(0);
  });

  it("is WIRED into the pre-publish gate (extension audit step at the root `high` level)", () => {
    const gate = fs.readFileSync(path.join(REPO_ROOT, "scripts/pre-publish-check.sh"), "utf8");
    expect(gate).toMatch(/extension_audit/);
    expect(gate).toMatch(/step "extension npm audit \(high\+, parity with root\)"/);
    // uses the SAME wrapper + level as the root audit (parity)
    expect(gate).toMatch(/cd "\$ext_dir" && bash "\$PROJECT_ROOT\/scripts\/audit-with-retry\.sh" high/);
  });
});
