// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * #61 — every scripts/*-guard.mjs must be INVOKED by a gate. A guard that is not
 * run is invisible by construction: it passes its own unit tests, its source may
 * still claim it is "enforced", and nothing errors — exactly how secret-register-
 * guard.mjs was wired into no gate while src/secret-registry.ts asserted it failed
 * the build.
 *
 * FILESYSTEM-DRIVEN, and that is the acceptance criterion, not a detail (the-fixer,
 * victra): the set of guards is GLOB'D from disk, and the gates are READ from disk.
 * There is deliberately NO hand-maintained list of guard names anywhere in this
 * file — a check that carries its own copy of "the guards" can go stale against
 * the thing it checks, which is the same defect class it exists to catch. Add a
 * new scripts/*-guard.mjs and this test fails until a gate invokes it.
 *
 * BOUNDARY — MEASURED, NOT REASONED (victra, #196). This check asserts that a
 * `node …<guard>` invocation STRING exists somewhere in a gate file. That is a
 * TEXTUAL PROXY for execution, and its limit was measured, not argued: a guard
 * wired into a shell function that no `step` line ever calls — e.g.
 * scripts/_dead-guard.mjs behind `_never_called_step() { node …_dead-guard.mjs; }`
 * with no `step "…" _never_called_step` line — makes this suite PASS.
 *   - What it ESTABLISHES: a guard file present on disk with NO invocation text
 *     anywhere in the gates reddens the build. That is the real defect class this
 *     exists for — "add a guard file, forget to wire it at all" — and it is closed.
 *   - What it does NOT establish: that the matched invocation is actually REACHED
 *     at gate runtime. An invocation that is dead (inside a function no `step`
 *     calls — measured above), commented out (`# node …guard.mjs` still matches
 *     the regex), or in a branch that never runs will PASS. Presence-of-text,
 *     not execution.
 * This is the day's lesson one level up: a textual proxy standing in for
 * behaviour — the same shape as the ADR-0003 auth-gen guard matching SQL text for
 * what a statement DOES. The execution-based fix — assert each guard in the gate's
 * actual RUN LIST, not its source text — is filed as #197 for the backlog, gated
 * on first MEASURING the cost of running the gate inside a test (a slow/flaky gate
 * is worse than this textual check with its boundary stated). Do not "harden" this
 * regex to chase dead code; the honest fix is run-list, not a smarter proxy.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = path.join(ROOT, "scripts");

// Discovered, never declared.
const guards = readdirSync(SCRIPTS)
  .filter((f) => /-guard\.mjs$/.test(f))
  .sort();

// The gates, also read from disk: scripts/pre-publish-check.sh (the pre-publish
// gate) and package.json (its `prebuild` lifecycle runs prebuild-guard). A guard
// counts as invoked when a `node` command in either actually runs it — a mention
// in a comment does not qualify (that is how a stale claim survives).
const gates =
  readFileSync(path.join(SCRIPTS, "pre-publish-check.sh"), "utf-8") +
  "\n" +
  readFileSync(path.join(ROOT, "package.json"), "utf-8");

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("#61 — every scripts/*-guard.mjs is invoked by a gate", () => {
  it("discovers guards from disk, and there is at least one (a vacuous empty glob must not pass)", () => {
    // Guards found:  otherwise a wrong SCRIPTS path would make every check below
    // vacuously true. This line is the tripwire for that.
    expect(guards.length).toBeGreaterThan(0);
  });

  for (const guard of guards) {
    it(`${guard} is invoked by a gate (pre-publish-check.sh or package.json)`, () => {
      const invoked = new RegExp("node\\b[^\\n]*" + escapeRe(guard)).test(gates);
      expect(
        invoked,
        `${guard} exists on disk but no gate INVOKES it. A guard that is not run is invisible by construction. Wire it with a \`node scripts/${guard}\` step in scripts/pre-publish-check.sh (or, for a prebuild-time guard, package.json's "prebuild").`,
      ).toBe(true);
    });
  }
});
