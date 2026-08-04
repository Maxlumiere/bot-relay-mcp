#!/usr/bin/env node
// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0003 (v2.20.0) — auth-generation invalidation drift guard (TS-AST based).
 *
 * The verified-token cache (src/auth-cache.ts) is only safe if EVERY mutation
 * that can change a token's validity bumps the auth generation
 * (db.bumpAuthGeneration). A stale cache = accepting a revoked token = an auth
 * bypass. This guard makes the invariant load-bearing at build time: it walks
 * the AST of src/db.ts, finds every function whose body performs a
 * validity-changing `agents` mutation, and asserts each ALSO calls
 * `bumpAuthGeneration(` — or routes through `applyAuthStateTransition(`, which
 * bumps internally.
 *
 * A "validity-changing mutation" is:
 *   • an `UPDATE agents SET …` whose statement touches a token/auth column
 *     (token_hash, auth_state, previous_token_hash, recovery_token_hash,
 *      rotation_grace_expires_at, token_lookup, previous_token_lookup), or
 *   • any `DELETE FROM agents …` (removing a row invalidates its cached verdict).
 *
 * SELF-EVIDENT bumpers are exempt from needing to call themselves:
 *   • `bumpAuthGeneration` / `applyAuthStateTransition` — the sanctioned bump
 *     primitives (the latter contains a dynamic `UPDATE agents SET` + bumps).
 *
 * ── FROZEN ACCEPTANCE CRITERIA (Victra ADR-0003 gate — do NOT whack-a-mole) ───
 * This guard exists to catch ACCIDENTAL DRIFT — a new/edited mutator that ships
 * with no bump. It is COMPLETE when all three hold; it is not iterated further:
 *   • MUST visit the common function syntaxes a mutator is realistically
 *     written as: function declarations, arrow functions + function expressions
 *     assigned to a name, class methods, and object-literal function
 *     properties. (codex proved the declaration-only v1 was evaded by an arrow.)
 *   • MUST exempt init-only migrations via an EXPLICIT name allowlist
 *     (INIT_ONLY_ALLOWLIST), NOT a `migrateSchemaTo*` wildcard — so a runtime
 *     mutator cannot evade by naming itself `migrateSchemaTo…`.
 *   • MUST NOT chase adversarial obfuscation — dynamically-named / eval'd /
 *     reflection-dispatched / string-concatenated mutators are OUT OF SCOPE BY
 *     DESIGN. That is a malicious-insider threat model; this guard defends
 *     against accidental drift. It also does not prove EVERY return-path bumps
 *     (the behavioral tests in tests/v2-20-0-auth-latency.test.ts do that,
 *     one case per mutation path). An obfuscation-only finding is a documented
 *     note, NOT a merge blocker.
 *
 * Exit: 0 = clean · 1 = violations (stderr) · 2 = usage/parse error
 * Usage: node scripts/auth-gen-guard.mjs <db.ts> [<file> ...]
 */
import ts from "typescript";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  forEachFunctionUnit,
  bodyCallsFunction,
  isTopLevelFunctionDeclaration,
  findUnsatisfiedPrimitives,
} from "./lib/guard-ast.mjs";

const SENSITIVE_COLS = [
  "token_hash",
  "auth_state",
  "previous_token_hash",
  "recovery_token_hash",
  "rotation_grace_expires_at",
  "token_lookup",
  "previous_token_lookup",
];
// Functions that ARE the bump primitives — they don't need to call themselves.
const SELF_BUMPERS = new Set(["bumpAuthGeneration", "applyAuthStateTransition"]);
// EXPLICIT init-only allowlist (codex ADR-0003 forward-hardening): schema
// migrations run ONCE during DB initialization, before the daemon serves any
// auth request — the per-process verified-token cache is empty then, so a
// one-time backfill of auth columns has nothing to invalidate. They ALSO
// cannot bump: bumpAuthGeneration writes auth_meta, which an EARLY migration
// (e.g. V2_1) predates (auth_meta is created in V2_20). This is an EXPLICIT set
// — NOT a `migrateSchemaTo*` wildcard — so a validity-changing mutator can't
// evade the guard merely by naming itself `migrateSchemaTo…`. A future
// migration that rewrites a token/auth column must be added here CONSCIOUSLY
// (and only if it is genuinely init-only). Today only V2_1 backfills auth_state
// (on token_hash IS NULL rows, which can't have a positive cache entry).
const INIT_ONLY_ALLOWLIST = new Set(["migrateSchemaToV2_1"]);
// The required-bump call names — a validity mutator satisfies the invariant by
// calling EITHER (applyAuthStateTransition bumps internally). Detected
// STRUCTURALLY via bodyCallsFunction (a resolved CallExpression), NOT a regex
// over body text: a `// bumpAuthGeneration()` comment or a matching string can
// no longer satisfy it (the codex refutation of the copied regex-over-body
// shape). SELF_BUMPERS IS exactly this set of sanctioned calls.

/** Does this function body perform a validity-changing agents mutation? */
function hasValidityChangingMutation(bodyText) {
  const compact = bodyText.replace(/\s+/g, " ");
  if (/DELETE\s+FROM\s+agents\b/i.test(compact)) return true;
  // An UPDATE agents SET … that mentions any sensitive column. The SQL may be
  // string-concatenated, so we scope loosely: an `UPDATE agents SET` present in
  // the body together with a sensitive column name. Over-inclusion is SAFE (it
  // only demands a bump); under-inclusion is the dangerous direction.
  if (/UPDATE\s+agents\s+SET\b/i.test(compact)) {
    for (const col of SENSITIVE_COLS) {
      if (new RegExp("\\b" + col + "\\b").test(compact)) return true;
    }
  }
  return false;
}

/**
 * Analyze source text; return an array of { name, line } for functions that
 * mutate token/auth validity but do not bump the generation. Exported so the
 * negative-fixture test can prove the guard FAILS on an omitted bump.
 *
 * v2.24 hardening — the required-bump check is now STRUCTURAL (bodyCallsFunction,
 * a resolved CallExpression) via the shared scripts/lib/guard-ast.mjs, closing
 * the comment / alias / class-field evasions codex found in the copied
 * regex-over-body-text shape. Node coverage also widened (class fields,
 * accessors, constructors — see forEachFunctionUnit).
 *
 * ⚠ THE SQL TRIGGER (hasValidityChangingMutation) IS STILL A TEXT MATCH, AND ITS
 * DIRECTION CUTS BOTH WAYS. The old note here said only that it "over-triggers
 * on a comment mentioning the SQL, which is the SAFE direction." That is true
 * and it is HALF THE STORY — a half-stated direction is a false claim wearing a
 * technicality. Stated in full, per case:
 *   • a comment/string that merely MENTIONS the SQL  -> OVER-triggers (safe: a
 *     false demand to bump, never a missed one).
 *   • SQL that is NOT textually in the body — hoisted into a module-level
 *     constant, or built by concatenation -> UNDER-detects: no bump is ever
 *     demanded, so the fully-hardened must-bump side never runs. Concatenation
 *     is documented out of scope by design (below); the HOISTED CONSTANT is a
 *     genuine gap inside the accidental-drift model and is queued as its own
 *     item. Measured LATENT, not active: every `UPDATE agents SET` in today's
 *     src/db.ts sits inside a function unit, and there are zero module-level
 *     mutation constants.
 * This is the WEAKER SIDE of a two-sided predicate — see guard-ast.mjs. Do not
 * read the hardened call side as making the guard strong overall.
 */
export function findAuthGenViolations(source, fileName = "db.ts") {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations = [];
  forEachFunctionUnit(sf, (name, bodyNode, nameNode) => {
    if (!name) return;
    // ROOT G (codex, #151 round 2): this exemption used to key on the NAME
    // alone, so ANY unit spelled `bumpAuthGeneration` — a class field, a method,
    // an object-literal property — was exempt wholesale. A mutator could do the
    // harmful UPDATE and skip the guard entirely just by being named after the
    // primitive. The exemption must mean "IS the sanctioned primitive," which is
    // the TOP-LEVEL FUNCTION DECLARATION, not anything sharing its spelling.
    // Same disease as the callee side: identity by spelling instead of binding.
    if ((SELF_BUMPERS.has(name) || INIT_ONLY_ALLOWLIST.has(name)) && isTopLevelFunctionDeclaration(nameNode)) {
      return;
    }
    const bodyText = bodyNode.getText(sf);
    // TRIGGER: text (over-trigger-safe). REQUIRED CALL: structural (a real
    // CallExpression to bumpAuthGeneration / applyAuthStateTransition or a direct
    // local alias) — comments and strings are structurally incapable of it.
    if (hasValidityChangingMutation(bodyText) && !bodyCallsFunction(bodyNode, sf, SELF_BUMPERS)) {
      violations.push({ name, line: sf.getLineAndCharacterOfPosition(nameNode.getStart(sf)).line + 1 });
    }
  });
  return violations;
}

function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    process.stderr.write("usage: auth-gen-guard.mjs <db.ts> [<file> ...]\n");
    process.exit(2);
  }
  const all = [];
  try {
    for (const f of files) {
      const abs = path.resolve(f);
      if (!fs.existsSync(abs)) {
        process.stderr.write(`auth-gen-guard: no such path: ${abs}\n`);
        process.exit(2);
      }
      const src = fs.readFileSync(abs, "utf-8");
      // PREMISE ENFORCEMENT (Victra ruling, #151 round 4). The whole helper
      // rests on each sanctioned primitive genuinely BEING a top-level function
      // declaration in this file — that is the only condition under which a bare
      // call can be resolved to it. If someone converts one to
      // `const bumpAuthGeneration = () => …`, no call resolves any more and the
      // guard would still fail — but as an avalanche of violations that reads
      // like the codebase broke, not like the guard's premise did. Say which it
      // is, and refuse to run rather than guess.
      const premiseSf = ts.createSourceFile(
        path.basename(abs),
        src,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      const missing = findUnsatisfiedPrimitives(premiseSf, SELF_BUMPERS);
      if (missing.length > 0) {
        process.stderr.write(
          `auth-gen-guard: PREMISE VIOLATED in ${abs}\n` +
            `  These sanctioned primitives are not top-level function declarations here: ${missing.join(", ")}\n` +
            `  This guard can only resolve a bare call to a primitive that is declared as a\n` +
            `  top-level \`function\` in the file under analysis. Converting one to a const\n` +
            `  arrow, an import, or a method silently removes the guard's ability to see ANY\n` +
            `  call to it — so it refuses to run instead of reporting a false all-clear.\n` +
            `  Fix: keep the primitive a top-level function declaration, or rework this guard\n` +
            `  to resolve cross-module identity (needs a TypeChecker — see guard-ast.mjs).\n`,
        );
        process.exit(2);
      }
      for (const v of findAuthGenViolations(src, path.basename(abs))) {
        all.push({ file: abs, ...v });
      }
    }
  } catch (err) {
    // Labelled "analysis error", not "parse error": this catch covers the whole
    // analysis, and the most likely throw is the parent-links contract
    // violation from bodyCallsFunction — nothing to do with malformed TS. A
    // loud failure with a misleading label still sends the next person hunting
    // for a syntax error that does not exist.
    process.stderr.write(`auth-gen-guard: analysis error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
  if (all.length > 0) {
    process.stderr.write(
      "ADR-0003 auth-generation drift: these functions mutate token/auth validity but never bump the auth generation (a stale verified-token cache = accepting a revoked token):\n",
    );
    for (const v of all) process.stderr.write(`  ${v.file}:${v.line}  ${v.name}()\n`);
    process.stderr.write(
      "\nFix: call bumpAuthGeneration() after the mutation (or route through applyAuthStateTransition).\n" +
        "\nIF YOU BELIEVE YOU ALREADY BUMP: this guard only accepts a call it can prove\n" +
        "reaches the top-level primitive — a BARE call, or a `const` alias of one. It\n" +
        "deliberately REFUSES these, because it cannot prove which binding they reach:\n" +
        "  • any receiver form   — db.bumpAuthGeneration(), this.bumpAuthGeneration()\n" +
        "  • a destructured ref  — const { bumpAuthGeneration } = db;\n" +
        "  • a property alias    — const b = db.bumpAuthGeneration;\n" +
        "  • a let/var alias, or a name shadowed by a parameter/local/nested function\n" +
        "Each of those is refused LOUDLY rather than passed silently: a missed bump is a\n" +
        "stale auth cache, and this guard would rather fail your build than miss one.\n" +
        "The remedy is the direct call: `bumpAuthGeneration();` after the mutation.\n",
    );
    process.exit(1);
  }
  process.stdout.write("All token/auth mutators bump the auth generation — verified-token cache invalidation intact\n");
  process.exit(0);
}

// Run as CLI only when invoked directly (not when imported by the test).
// Compare resolved filesystem paths (fileURLToPath decodes %20 etc.) so a
// working directory with spaces — e.g. "…/Claude AI/…" — still triggers main().
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
