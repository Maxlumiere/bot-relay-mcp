// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * #61 + #197b — every scripts/*-guard.mjs must actually RUN in a gate. A guard that is
 * not run is invisible by construction: it passes its own unit tests, its source may
 * still claim it is "enforced", and nothing errors — exactly how secret-register-guard.mjs
 * was wired into no gate while src/secret-registry.ts asserted it failed the build.
 *
 * FILESYSTEM-DRIVEN, the acceptance criterion (the-fixer, victra): guards are GLOB'D from
 * disk, gates are READ from disk. NO hand-maintained list of guard names — a check that
 * carries its own copy of "the guards" goes stale against the thing it checks, the same
 * defect class it exists to catch.
 *
 * #197b — EXECUTION-BASED, replacing the #196 textual proxy. The gate's `--list-steps`
 * mode records, for every step that WOULD execute, its LABEL and its resolved ARGV — the
 * actual command — without running it (cheap: no build/vitest/network). This test binds
 * each guard to a REACHED step by that step's ARGV containing the guard file. That closes
 * both #196-class gaps AND the two codex #206 bypasses:
 *   - a commented-out / dead / never-`step`ed invocation no longer appears as a reached
 *     step (the #196 gap);
 *   - a step whose function was gutted to a no-op (`# node …guard.mjs` + `true`) no longer
 *     binds, because the reached step's ARGV is the command, not a source regex that also
 *     matches the comment (codex bypass 2 — guards are invoked DIRECTLY now, so the argv
 *     IS the guard command);
 *   - a result-gated step cannot appear in the list at all — scripts/step-gate-guard.mjs
 *     (design 2a, flat FULL_MODE block) rejects it, so list == executed (codex bypass 1).
 *
 * BOUNDARY (both halves): STRONGER than the #196 regex — a REACHED step's actual command
 * must invoke the guard, not merely a source string (comment or dead code). WEAKER than
 * full execution — --list-steps skips the command, so this proves the guard WOULD be
 * invoked by a reached step, not that it ran or passed (the guard's own concern). A
 * build-hook guard (package.json `prebuild`) is not a gate step, so the run list cannot
 * cover it: those keep a textual package.json check (stated, not hidden).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { execFileSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = path.join(ROOT, "scripts");
const GATE = path.join(SCRIPTS, "pre-publish-check.sh");

// Discovered, never declared.
const guards = readdirSync(SCRIPTS)
  .filter((f) => /-guard\.mjs$/.test(f))
  .sort();

const pkgJson: { scripts?: Record<string, string> } = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf-8"));
// PACKAGE BUILD-HOOK FALLBACK — dev-time hygiene, NOT enforcement (victra-ratified boundary,
// codex #206; the same threat model the step-gate and cli-profile guards carry).
//   CATCHES: ACCIDENTAL non-wiring — a guard on disk never referenced as the `scripts.prebuild`
//     command (the #61 establish-case: "added a guard file, forgot to wire it"). Within
//     ORDINARY SINGLE-LINE syntax the grammar admits only a `node <canonical scripts/guard>`
//     command (a newline-separated `node …guard\ntrue` is the deliberate exception documented
//     under DOES NOT CATCH), so the common accidental
//     mistakes redden, each with an executed fixture below: `echo node …guard`, `true`,
//     `true || node …guard`, `false && node …guard || true`, a same-basename other-dir script,
//     `node other.mjs …guard`, a pipe.
//   DOES NOT CATCH: a DELIBERATELY crafted prebuild string. A committer who can write the
//     prebuild can delete the guard outright — a static parser adds nothing against them; the
//     control is CODE REVIEW. Deletion is LOUD in review; a crafted string (`node …guard\ntrue`
//     masks the guard's failure) is QUIET and reads as wired, so the harm is a FALSE CLAIM OF
//     ENFORCEMENT — which is exactly why this check never claims the guard is "enforced at
//     build time," only that the prebuild REFERENCES it. Chasing crafted forms opens an
//     unbounded tail (CR, unicode separators, $IFS) — deliberately not entered.
// The boundary is TESTED, not asserted: the negative fixtures prove the accidental cases
// redden, and a newline fixture DOCUMENTS a permitted deliberate-evasion shape — so the
// permission is known and measured, not unchecked prose (guard-ast RESOLVER COVERAGE, 2026-08-11:
// the one false claim in sixteen was the one nobody executed).
export function prebuildRunsGuardScript(prebuild: string, canonicalGuardPath: string): boolean {
  const cmd = prebuild.trim();
  if (/[&|;`]|\$\(|[<>()]/.test(cmd)) return false; // any INLINE operator / subshell / redirection reddens. NB a NEWLINE separator is deliberately NOT in this set — `node …guard\ntrue` binds (documented deliberate-crafting boundary; see header + PERMITS fixture)
  const toks = cmd.split(/\s+/).filter(Boolean);
  if (toks.length < 2) return false;
  const isNodeCmd = toks[0] === "node" || toks[0].endsWith("/node");
  return isNodeCmd && path.resolve(ROOT, toks[1]) === canonicalGuardPath;
}
const invokedInPrebuild = (guard: string) =>
  prebuildRunsGuardScript(pkgJson.scripts?.prebuild ?? "", path.resolve(SCRIPTS, guard));

// The actual RUN LIST: each reached step's { label, cmd, script }. --full so the 3 opt-in
// steps are enumerated too (mode-flag-gated, not result-gated — the step-gate guard vouches).
// cmd = argv[0], script = argv[1] (the file `node` would execute).
function reachedSteps(): { label: string; cmd: string; script: string }[] {
  const out = execFileSync("bash", [GATE, "--full", "--list-steps"], { cwd: ROOT, encoding: "utf-8", timeout: 120_000 });
  return out
    .split("\n")
    .filter((l) => l.startsWith("list-step:"))
    .map((l) => {
      const body = l.slice("list-step:".length);
      const m = body.match(/^(.*) :: cmd=(\S*) :: script=(.*)$/);
      return m ? { label: m[1].trim(), cmd: m[2].trim(), script: m[3].trim() } : { label: body.trim(), cmd: "", script: "" };
    });
}

// A guard is BOUND to a reached step only when that step's command is `node` and the
// guard file is the SCRIPT POSITION (argv[1]) — the file node actually executes. Not an
// arbitrary substring: `echo <guard-path>` (cmd!=node) and `node other.mjs <guard-path>`
// (script!=guard) both fail to bind (codex #206 bypass 2/4).
const isNode = (cmd: string) => cmd === "node" || cmd.endsWith("/node");

describe("#61/#197b — every scripts/*-guard.mjs actually runs in a gate (execution-based)", () => {
  const reached = reachedSteps();

  it("discovers guards from disk, and there is at least one (a vacuous empty glob must not pass)", () => {
    expect(guards.length).toBeGreaterThan(0);
  });

  it("--list-steps emits reached steps WITH a node-script position (the mechanism works)", () => {
    // Tripwire: if --list-steps broke or stopped emitting the script field, every bind
    // below would fail loudly rather than pass vacuously — but assert it directly too.
    expect(reached.length).toBeGreaterThan(0);
    expect(reached.some((s) => isNode(s.cmd) && s.script.length > 0)).toBe(true);
  });

  const guardCanonicalPaths = new Map(guards.map((g) => [g, path.resolve(SCRIPTS, g)]));
  for (const guard of guards) {
    it(`${guard} is the executed node script of a REACHED gate step (or a package.json build hook)`, () => {
      // Bind ONLY when a reached step runs `node <this guard>`, comparing the argv[1] SCRIPT
      // POSITION by CANONICAL PATH equality to scripts/<guard> — not basename (so a
      // same-basename script in another dir, `node other/<guard>.mjs`, does NOT bind — codex
      // #206), not a substring, not the label, not a source regex.
      const canonical = guardCanonicalPaths.get(guard);
      const reachedAsNodeScript = reached.some((s) => isNode(s.cmd) && s.script !== "" && path.resolve(s.script) === canonical);
      if (reachedAsNodeScript) return;
      // Not executed by any reached step → the only legitimate case is a build-time hook
      // that is NOT a gate step (package.json `prebuild`); the run list can't cover it.
      expect(
        invokedInPrebuild(guard),
        `${guard} is NOT the executed node script of any reached step in --list-steps, and not a package.json ` +
          `build hook. A guard that is not run is invisible by construction. Wire it as a DIRECT ` +
          `\`step "…" node scripts/${guard} …\` at column 0 in pre-publish-check.sh (or, for a build-time guard, ` +
          `package.json's "prebuild").`,
      ).toBe(true);
    });
  }
});

// The negative fixtures ARE the deliverable (victra ruling), not the parser: a boundary
// claim needs an executed fixture proving WHICH DIRECTION it errs. A prebuild the parser
// rejects makes the coverage fallback return false → coverage REDS for that guard
// (fail-closed). Grammar, scoped to ORDINARY SINGLE-LINE syntax: a single direct
// `node <canonical guard>` binds, and the inline operators ` & | ; ` $( ) < > ` redden
// (reject rather than model reachability — narrow beats clever). This is NOT "any operator
// reddens": a NEWLINE command separator is deliberately NOT in that reject set — it binds
// (`node …guard\ntrue`), the false-permit direction chosen on purpose per the documented
// deliberate-crafting boundary (header CATCHES / DOES NOT CATCH) and the PERMITS fixture below.
describe("#197b — package build-hook fallback: constrained prebuild grammar (executed fixtures)", () => {
  const G = path.resolve(SCRIPTS, "prebuild-guard.mjs");
  const runs = (s: string) => prebuildRunsGuardScript(s, G);

  // POSITIVE — within ordinary single-line syntax, only a direct `node <canonical guard>`
  // command binds. (The newline-separated shape in the PERMITS fixture below also binds — the
  // documented deliberate-crafting exception, not an ordinary-syntax case.)
  it("binds a direct `node scripts/prebuild-guard.mjs`", () => expect(runs("node scripts/prebuild-guard.mjs")).toBe(true));
  it("binds it with args", () => expect(runs("node scripts/prebuild-guard.mjs --strict")).toBe(true));

  // NEGATIVE — each MUST NOT bind (victra's required set + more). Each is a real prebuild
  // that a compromised/careless author could write; each makes `npm run build` succeed
  // WITHOUT running the guard, so binding it would be a false "guard is wired" claim.
  it("rejects `true || node …guard` — the || RHS is unreachable (codex #206 round 3)", () => expect(runs("true || node scripts/prebuild-guard.mjs")).toBe(false));
  it("rejects `false && node …guard` — the guard is on a conditional && RHS", () => expect(runs("false && node scripts/prebuild-guard.mjs")).toBe(false));
  it("rejects `false && node …guard || true` — exits 0 without the guard", () => expect(runs("false && node scripts/prebuild-guard.mjs || true")).toBe(false));
  it("rejects `echo node …guard` — prints, never runs it", () => expect(runs("echo node scripts/prebuild-guard.mjs")).toBe(false));
  it("rejects `node other.mjs …guard` — the guard is data, not the executed script", () => expect(runs("node scripts/other.mjs scripts/prebuild-guard.mjs")).toBe(false));
  it("rejects a same-basename script in another dir", () => expect(runs("node other/prebuild-guard.mjs")).toBe(false));
  it("rejects `true`", () => expect(runs("true")).toBe(false));
  it("rejects a piped guard `node …guard | cat`", () => expect(runs("node scripts/prebuild-guard.mjs | cat")).toBe(false));

  // BOUNDARY, DOCUMENTED not asserted (victra ruling, codex #206). This shape is PERMITTED
  // deliberately: `node …guard\ntrue` is a newline-separated two-command prebuild — the guard
  // RUNS but `true` masks its exit, so its FAILURE is silently bypassed. We do NOT block it:
  // it is a deliberately crafted string, out of scope by the threat model above (code review,
  // not a static parser, is the control), and chasing newline opens an unbounded tail (CR,
  // unicode separators, $IFS). This executed fixture records that the permission is KNOWN and
  // MEASURED — the boundary erring toward false-permit, in this exact direction, on purpose.
  it("PERMITS a newline-crafted `node …guard\\ntrue` — a deliberately crafted string is out of scope", () => {
    expect(runs("node scripts/prebuild-guard.mjs\ntrue")).toBe(true);
  });
});
