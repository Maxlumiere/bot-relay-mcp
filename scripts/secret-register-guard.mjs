#!/usr/bin/env node
// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * PR C v2 — redact-by-value registration drift guard (TS-AST based).
 *
 * The redact-by-value registry (src/secret-registry.ts) only protects a live
 * credential if EVERY db.ts function that mints a token also registers it — and,
 * since v2, registers it via registerPersistedSecret AFTER the write commits. A
 * new mutator that mints a token and forgets to register it re-opens exactly the
 * un-named / substring-embedded log-leak gap redact-by-value exists to close, and
 * it does so SILENTLY (the token still authenticates; nothing complains). This
 * guard makes the invariant load-bearing at build time: it walks the AST of
 * src/db.ts, finds every function whose body mints a token, and asserts each ALSO
 * calls registerPersistedSecret.
 *
 * "Mints a token" = the unit contains a RESOLVED CALL to `generateToken` — not a
 * body-text match. Verified at authoring time: every generateToken() use in db.ts
 * produces a PERSISTED credential (agent token, rotated token, or recovery
 * handle), so the trigger has no false positives today.
 *
 * DIRECTION, per case (the bare word "coarse" used to stand here and hid a
 * quantifier — see the two mechanical rules in guard-ast.mjs):
 *   • a unit that mints for a NON-persisted purpose would be flagged and told to
 *     register → OVER-flag, loud false build failure, safe.
 *     @fixture "TWIN: a unit that mints and registers passes"
 *   • a mint reached by a form the resolver REFUSES reads as NO MINT → no
 *     register is demanded → the unit passes → **UNDER-detect**. This is the
 *     dangerous direction, and it is the price of resolving the trigger. It is
 *     NOT hypothetical — MEASURED: `import * as auth` + `auth.generateToken()`
 *     is a real mint that the trigger does not see, so an unregistered token
 *     there passes. src/db.ts uses a direct named import, so this is not live
 *     today; it is a KNOWN, PINNED boundary, not a closed one.
 *     @fixture "STATED BOUNDARY: a namespace-import mint escapes the trigger"
 *   • a LOCAL FAKE `generateToken` correctly does NOT trigger — it is not the
 *     primitive, so no register is owed. That one is right, not a gap.
 *     @fixture "TWIN: a local fake generateToken owes nothing"
 *
 * Leaving the trigger on TEXT would have been worse in the other direction: any
 * comment or string mentioning generateToken would demand a register (noisy), and
 * an aliased real mint would still be missed. Structural on both sides keeps the
 * two halves at the same strength — the #151 two-sided-predicate lesson.
 *
 * ── BOUNDARY — what this guard enforces, and what it does NOT (state it, never
 *    imply totality; same discipline as auth-gen-guard) ──────────────────────
 *   ENFORCES: a db.ts function that calls generateToken() also calls
 *     registerPersistedSecret() somewhere in its body — catching a brand-new
 *     mutator that never registers at all (the case a call-site-count or a
 *     helper-coupling approach misses).
 *   DOES NOT ENFORCE (covered elsewhere or out of scope by design):
 *     • Placement — that the register is on the SUCCESS path, after the commit,
 *       and on EVERY branch. A function could call generateToken() and
 *       registerPersistedSecret() on unrelated branches and still pass. The
 *       behavioural tests (tests/v2-24-8-secret-register-after-commit) assert the
 *       actual property: a failed/retried mutation registers nothing and a live
 *       token survives four same-principal failures.
 *     • A token PERSISTED without generateToken() (e.g. an externally-supplied
 *       credential written straight to token_hash) — not triggered. No such path
 *       exists in db.ts today; if one is added it must register explicitly.
 *     • Obfuscation — dynamically-named / eval'd / reflection-dispatched /
 *       string-concatenated mutators are OUT OF SCOPE BY DESIGN. This defends
 *       against ACCIDENTAL drift (a new mutator shipped without the register),
 *       not a malicious insider.
 *
 * Exit: 0 = clean · 1 = violations (stderr) · 2 = usage/parse error
 * Usage: node scripts/secret-register-guard.mjs <db.ts> [<file> ...]
 */
import ts from "typescript";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  forEachFunctionUnit,
  bodyCallsFunction,
  isTopLevelFunctionDeclaration,
  findUnresolvablePrimitives,
} from "./lib/guard-ast.mjs";

/**
 * ── v2.24.11 REBUILD ON THE SHARED HELPER — BOTH SIDES STRUCTURAL ────────────
 * v1 of this guard regexed the function's raw body TEXT for BOTH halves:
 * `/\bgenerateToken\s*\(/` for the trigger and `/\bregisterPersistedSecret\s*\(/`
 * for the required call. So a `// TODO: registerPersistedSecret(name, t)` comment
 * satisfied it, and an aliased or shadowed name defeated it — the same seven
 * root causes (A-G) auth-gen-guard failed audit on four times.
 *
 * BOTH halves now resolve a real CallExpression through scripts/lib/guard-ast.mjs.
 * The trigger is hardened too, deliberately: **a two-sided predicate is only as
 * strong as its weaker side** — if the trigger never fires, no register is ever
 * demanded and the hardened required-call side never runs. That was the #151
 * lesson and it is why this does not fix one half and stop.
 *
 * ENVIRONMENT — verified for THIS file, not inherited from db.ts's other guard:
 * both primitives are IMPORTED into src/db.ts (`./auth.js`, `./secret-registry.js`)
 * and declared as top-level `export function` in those files. The helper resolves
 * one hop and VERIFIES the declaration node there. Measured on the real file:
 * 5/5 legitimate units recognised on both sides, 0 missed.
 */
const MINT = new Set(["generateToken"]);
const REGISTER = new Set(["registerPersistedSecret"]);
// The register primitives themselves never need to register their own output.
// SCOPED BY DECLARATION, NOT BY NAME (root G, codex #151): keying an exemption on
// a NAME let any unit merely SPELLED `registerPersistedSecret` — a class field, a
// method — skip the guard wholesale. An exemption must mean "IS the primitive."
const EXEMPT = new Set(["registerPersistedSecret", "registerIdentitySecret"]);

/**
 * Analyze source text; return { name, line } for functions that mint a token but
 * never call registerPersistedSecret. Exported so the negative-fixture test can
 * prove the guard FAILS on an omitted register.
 *
 * `fileName` SHOULD be an absolute path — one-hop import resolution needs it.
 * When it is not, imported primitives simply do not resolve and every minter
 * reads as unregistered: loud over-flag, never a silent pass.
 * @fixture "trigger and required call both resolve through imports"
 */
export function findSecretRegisterViolations(source, fileName = "db.ts") {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations = [];
  forEachFunctionUnit(sf, (name, bodyNode, nameNode) => {
    if (!name) return;
    if (EXEMPT.has(name) && isTopLevelFunctionDeclaration(nameNode)) return;
    // TRIGGER: does this unit actually CALL generateToken (structurally)?
    if (!bodyCallsFunction(bodyNode, sf, MINT)) return;
    // REQUIRED: does it actually CALL registerPersistedSecret (structurally)?
    if (bodyCallsFunction(bodyNode, sf, REGISTER)) return;
    violations.push({ name, line: sf.getLineAndCharacterOfPosition(nameNode.getStart(sf)).line + 1 });
  });
  return violations;
}

/** The primitives this guard rests on, for premise enforcement. */
export const REQUIRED_PRIMITIVES = new Set([...MINT, ...REGISTER]);

function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    process.stderr.write("usage: secret-register-guard.mjs <db.ts> [<file> ...]\n");
    process.exit(2);
  }
  const all = [];
  try {
    for (const f of files) {
      const abs = path.resolve(f);
      if (!fs.existsSync(abs)) {
        process.stderr.write(`secret-register-guard: no such path: ${abs}\n`);
        process.exit(2);
      }
      const src = fs.readFileSync(abs, "utf-8");
      // PREMISE ENFORCEMENT. This guard rests on both primitives RESOLVING from
      // this file to a verified top-level function declaration — here, one hop
      // through `./auth.js` and `./secret-registry.js`. If that stops holding
      // (moved behind a barrel, re-exported, renamed at the import site), every
      // minter would read as unregistered and the failure would look like the
      // codebase broke rather than the guard's premise. Say which, and refuse.
      const premiseSf = ts.createSourceFile(abs, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const unresolvable = findUnresolvablePrimitives(premiseSf, REQUIRED_PRIMITIVES);
      if (unresolvable.length > 0) {
        process.stderr.write(
          `secret-register-guard: PREMISE VIOLATED in ${abs}\n` +
            `  These primitives no longer resolve to a top-level function declaration: ${unresolvable.join(", ")}\n` +
            `  This guard resolves a call ONE hop through a direct relative named import\n` +
            `  and verifies the declaration in the target file. Barrel/re-export chains,\n` +
            `  renamed imports and package specifiers are deliberately NOT followed.\n` +
            `  Fix: keep the primitive a top-level \`function\` reached by a direct\n` +
            `  relative named import, or rework this guard (see scripts/lib/guard-ast.mjs).\n`,
        );
        process.exit(2);
      }
      // ABSOLUTE path, not basename: one-hop import resolution needs a real path.
      for (const v of findSecretRegisterViolations(src, abs)) {
        all.push({ file: abs, ...v });
      }
    }
  } catch (err) {
    process.stderr.write(`secret-register-guard: parse error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
  if (all.length > 0) {
    process.stderr.write(
      "PR C redact-by-value drift: these functions mint a token but never call registerPersistedSecret " +
        "(a live credential that mints here would be omitted from redact-by-value — a silent log-leak gap):\n",
    );
    for (const v of all) process.stderr.write(`  ${v.file}:${v.line}  ${v.name}()\n`);
    process.stderr.write(
      "\nFix: call registerPersistedSecret(principal, <plaintext>) on the SUCCESS path, AFTER the write commits.\n",
    );
    process.exit(1);
  }
  process.stdout.write("All token-minting db.ts functions register the persisted secret — redact-by-value coverage intact\n");
  process.exit(0);
}

// Run as CLI only when invoked directly (not when imported by the test). Compare
// resolved filesystem paths (fileURLToPath decodes %20 etc.) so a working
// directory with spaces — e.g. "…/Claude AI/…" — still triggers main().
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
