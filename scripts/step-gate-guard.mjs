#!/usr/bin/env node
// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * #197b — step-gate premise assertion (the guard that makes `--list-steps` honest).
 *
 * scripts/pre-publish-check.sh --list-steps records each step's LABEL and SKIPS its
 * command, so a test can assert each guard is REACHED without running the ~10-minute gate.
 * That LIST run equals the EXECUTED run ONLY IF a step's reachability never depends on a
 * prior command's RESULT: `step()` returns 0 in --list-steps, so a step gated on an
 * earlier command's success (`if built_ok; then step …`) would be enumerated while the
 * real gate might never reach it — the list would OVER-report, in the dangerous direction
 * (a guard read as "wired" that never actually runs).
 *
 * DESIGN 2a (victra ruling), FAIL-CLOSED: every `step "…"` must be UNCONDITIONAL — at
 * column 0 — EXCEPT the single vetted `if [ "$FULL_MODE" = "1" ]` block (a MODE FLAG: an
 * INPUT identical in the list and real runs, not a command result). ANY other shape — an
 * indented step outside that block, or a `cmd && step` / `if <cmd>; then step` — reddens
 * here until it is explicitly vetted (moved to column 0, or — only for a genuine
 * mode-flag gate — the allowlisted block widened with a reason). A defect the check
 * REFUSES, not one it polices: we deliberately do NOT classify arbitrary enclosing
 * conditions (design 2b) — 24 of 27 steps are already unconditional, so the extra
 * machinery would buy nothing while adding a subtle surface to get wrong.
 *
 * ⚠ LIMIT — P2 (victra: STATE IT, DO NOT GUARD IT). --list-steps' cheapness/safety ALSO
 * assumes no BARE heavy or side-effecting command runs at top level (a future bare
 * `node dist/index.js &` would actually execute during a list-steps run). This guard does
 * NOT enforce that, on purpose: a shell script is mostly bare top-level commands
 * (assignments, echo, function definitions), so a bare-command guard would fight the
 * file's normal structure and get disabled; and the blast radius is bounded — --list-steps
 * runs inside a vitest test, not production, so a leaked process is a CI annoyance, not a
 * fleet hazard. If it ever bites, design against the real incident rather than guessing now.
 *
 * BOUNDARY — the CLAIM, in precise words (victra ratification, codex #206). This does NOT
 * claim "no bypass exists". It claims: WITHIN the literal-`step` convention this gate
 * follows, the --list-steps run list matches what actually executes, AND any DEPARTURE from
 * that convention reddens here — a result-gated literal step, a step nested inside the
 * FULL_MODE block, or a non-step line in that block. That is checkable and true. It does NOT
 * prove a step's command does its job — that is the run-list coverage test's
 * (node-script-position) concern, and each guard's own.
 *
 * THREAT MODEL (deliberate, mirrors the cli-profile-guard's ratified boundary): a dev-time
 * hygiene guard against ACCIDENTAL result-gating — the natural mistake `if built_ok; then
 * step "x"; fi`, written with a literal `step`. It does NOT defend against DELIBERATE
 * evasion: dynamic dispatch (`S=step; "$S" "x"`), `eval`, or command aliasing route around
 * ANY regex-based shell check (adversarial shell parsing is unwinnable), and a committer who
 * controls the gate file can always disable a dev guard — that is a code-review concern, not
 * a static one. The list==executed equivalence is therefore claimed only for literal-`step`
 * control flow; a future dynamic step dispatch is out of scope by the same threat model
 * every other guard in this gate carries (codex #206 target 3). This is deliberately scoped,
 * not an oversight: "reject dynamic dispatch robustly" is not achievable statically, so the
 * PROOF is scoped rather than overclaimed.
 */
import { readFileSync } from "fs";

const path = process.argv[2] || "scripts/pre-publish-check.sh";
const lines = readFileSync(path, "utf-8").split("\n");

// The one vetted conditional block: `if [ "$FULL_MODE" = "1" ]; then … fi`.
const fmOpen = lines.findIndex((l) => /^if \[ "\$FULL_MODE" = "1" \]; then\s*$/.test(l));
if (fmOpen === -1) {
  console.error(`step-gate-guard: no vetted 'if [ "$FULL_MODE" = "1" ]; then' block in ${path}.`);
  console.error("  The premise rests on exactly ONE mode-flag-gated block; its absence means the gate");
  console.error("  structure changed — re-vet before trusting --list-steps.");
  process.exit(1);
}
const fmClose = lines.findIndex((l, i) => i > fmOpen && /^fi\b/.test(l));
if (fmClose === -1) {
  console.error(`step-gate-guard: unterminated FULL_MODE block (no column-0 'fi' after line ${fmOpen + 1}) in ${path}.`);
  process.exit(1);
}
// A second FULL_MODE block would mean two vetted regions — not modelled; fail loud.
if (lines.some((l, i) => i !== fmOpen && /^if \[ "\$FULL_MODE" = "1" \]; then/.test(l))) {
  console.error(`step-gate-guard: more than one FULL_MODE block in ${path} — the single-vetted-block assumption is violated; re-vet.`);
  process.exit(1);
}

const violations = [];

// The vetted FULL_MODE block must be a FLAT LIST OF DIRECT STEPS — every non-blank,
// non-comment line in it is an indented `step "…"`. Nothing else: no nested function,
// `if`, loop, or bare command, any of which could hide a RESULT-gated step inside the
// otherwise-blessed line range (codex #206 bypass 1: `if prereq; then step "target"; fi`
// nested in the block). Rejecting non-step lines closes that — a step reachable only
// through nested control flow is not a direct child of the mode-flag and does not belong.
for (let i = fmOpen + 1; i < fmClose; i++) {
  const l = lines[i];
  if (l.trim() === "" || l.trimStart().startsWith("#")) continue;
  if (/^\s+step "/.test(l)) continue;
  violations.push({ line: i + 1, text: l.trim() });
}

let checked = 0;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (line.trimStart().startsWith("#")) continue; // comment line
  if (/^\s*step\(\)\s*\{/.test(line)) continue; // the step() definition itself
  // A `step "…"` INVOCATION: at statement start (col 0 or indented) OR after a separator
  // (`&&`, `||`, `;`, `then`) — the latter is exactly the result-gated shape we forbid.
  if (!/(^|[\s;&|]|\bthen\b)step "/.test(line)) continue;
  checked++;
  if (/^step "/.test(line)) continue; // OK: unconditional, column 0
  // OK only as a DIRECT step in the vetted block (the flat-body check above guarantees
  // the block holds nothing but direct steps, so no nested-gated step can reach here).
  if (/^\s+step "/.test(line) && i > fmOpen && i < fmClose) continue;
  violations.push({ line: i + 1, text: line.trim() });
}
// De-dup by line (a nested-gated step trips both the flat-body and the step check).
{
  const seen = new Set();
  for (let k = violations.length - 1; k >= 0; k--) {
    if (seen.has(violations[k].line)) violations.splice(k, 1);
    else seen.add(violations[k].line);
  }
  violations.sort((a, b) => a.line - b.line);
}

if (violations.length > 0) {
  console.error(`step-gate-guard: ${violations.length} step invocation(s) are NOT unconditional (design 2a, fail-closed):`);
  for (const v of violations) console.error(`  ${path}:${v.line}:  ${v.text}`);
  console.error("");
  console.error("Every `step` must be at column 0 (unconditional) except the vetted FULL_MODE block. A");
  console.error("result-gated step (`cmd && step`, `if <cmd>; then step`) makes --list-steps OVER-report:");
  console.error("the list shows a step the real gate can skip. Fix: move it to column 0, or — only for a");
  console.error("genuine mode-flag gate — widen the allowlisted block in this guard with a reason.");
  process.exit(1);
}
console.log(`step-gate-guard: OK — all ${checked} step invocation(s) are unconditional (or in the vetted FULL_MODE block).`);
