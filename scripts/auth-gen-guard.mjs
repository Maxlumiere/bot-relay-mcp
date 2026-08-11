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
import { parseGuardSource } from "./lib/guard-parse.mjs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  forEachFunctionUnit,
  bodyCallsFunction,
  isTopLevelFunctionDeclaration,
  findUnsatisfiedPrimitives,
  resolveUnitSqlText,
  findSqlBackedSoftBindings,
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
 * v2.24 hardening — the required-bump check is STRUCTURAL (bodyCallsFunction,
 * a resolved CallExpression) via the shared scripts/lib/guard-ast.mjs, closing
 * the comment / alias / class-field evasions codex found in the copied
 * regex-over-body-text shape. Node coverage also widened (class fields,
 * accessors, constructors — see forEachFunctionUnit).
 *
 * TWO-SIDED PREDICATE — both sides now BINDING-RESOLVED (guard-ast.mjs), which
 * matters because a two-sided predicate is only as strong as its weaker side:
 *   • REQUIRED CALL — resolves a bare call to the ONE sanctioned top-level
 *     function declaration (or a const alias of it).
 *   • DOES-IT-MUTATE (#57 / #192) — the SQL trigger no longer reads only a unit's
 *     literal body text. resolveUnitSqlText follows the unit's identifiers through
 *     module-scope CONST bindings — aliases, objects, arrays, and destructuring
 *     (object/array/renamed/nested/rest/default) — TRANSITIVELY to the terminal
 *     literal, using the SAME resolver as the call side, so a hoisted
 *     `const REVOKE_SQL = "UPDATE agents SET token_hash …"` is seen as if inline.
 *     Resolution is by BINDING, not name: an identifier resolving to a LOCAL
 *     const, a PARAMETER, an import, or a nested-function binding is NOT the
 *     module constant, so a mutator whose `REVOKE_SQL` is a parameter is correctly
 *     NOT flagged (the S1/S2 shadow bar). Name-matching instead is ROOT G reborn.
 *
 * DIRECTIONS, per case (each sits beside its fixture in
 * tests/v2-20-0-auth-latency.test.ts, ADR-0003 F):
 *   • a comment/string that merely MENTIONS the SQL -> OVER-triggers (safe).
 *   • object/array constant -> the WHOLE initializer is spliced (coarser than
 *     property-precise): OVER-includes, the safe direction, and the per-unit bump
 *     check still flags only the guilty sibling (KT3).
 *   • let/var-backed SQL -> deliberately NOT read (its initializer does not
 *     establish what runs — it can be reassigned). Surfaced by
 *     findUnresolvableBindings and REFUSED loudly (exit 2), never passed.
 *   • CONCATENATION and CROSS-MODULE imports -> out of scope by design (see
 *     guard-ast.mjs): concatenation is not routine-accidental drift; cross-module
 *     identity needs a TypeChecker. Named boundaries, not gaps.
 *
 * The hoisted-constant gap is CLOSED, and was measured LATENT at 0294854 (zero
 * module-scope validity SQL in the real src/db.ts), so a correct fix changes
 * nothing about the real file — if real db.ts starts flagging, the fix is
 * over-flagging, not the codebase drifting.
 */
export function findAuthGenViolations(source, fileName = "db.ts") {
  const sf = parseGuardSource(fileName, source); // pinned-parser gate: throws on parse diagnostics → main() exits 2
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
    // #57/#192 — the unit's body text PLUS the initializer text of every
    // module-scope CONST it binding-resolves to (transitive), so hoisted SQL is
    // seen as if inline. A let/var-backed SQL binding is handled by the refusal
    // path (findUnresolvableBindings), not here.
    const bodyText = resolveUnitSqlText(bodyNode, sf, null);
    // TRIGGER: text (over-trigger-safe). REQUIRED CALL: structural (a real
    // CallExpression to bumpAuthGeneration / applyAuthStateTransition or a direct
    // local alias) — comments and strings are structurally incapable of it.
    if (hasValidityChangingMutation(bodyText) && !bodyCallsFunction(bodyNode, sf, SELF_BUMPERS)) {
      violations.push({ name, line: sf.getLineAndCharacterOfPosition(nameNode.getStart(sf)).line + 1 });
    }
  });
  return violations;
}

/**
 * The fail-closed REFUSAL set (#192 ruling 3): module-scope let/var bindings whose
 * initializer OR any assignment reaches validity SQL. Returns { name, line } for
 * each. A SEPARATE pure function from findAuthGenViolations, mirroring the
 * findUnsatisfiedPrimitives / main split — so the refusal MESSAGE is testable and
 * the exit-1 ("your code is wrong") vs exit-2 ("I cannot analyse this")
 * distinction is preserved (#192: collapsing them is how guards get disabled).
 *
 * WHY let/var is refused and not resolved: a let can be reassigned, so its
 * initializer does not establish what the use site reads. the-fixer's L2 — a
 * benign initializer reassigned to a token-revoking statement — makes it concrete:
 * resolving the initializer reads "SELECT 1" and reports CLEAN while the statement
 * that runs revokes a token. Under-detection produced by the resolver's own logic.
 * Fail-closed is the only sound verdict; the ACCEPTED COST is that a const->let
 * refactor of a SQL literal fails the build, which is the intended behaviour.
 */
export function findUnresolvableBindings(source, fileName = "db.ts") {
  const sf = parseGuardSource(fileName, source);
  return findSqlBackedSoftBindings(sf, hasValidityChangingMutation).map((decl) => ({
    name: decl.name.getText(sf),
    line: sf.getLineAndCharacterOfPosition(decl.name.getStart(sf)).line + 1,
  }));
}

/**
 * Premise-style refusal message (#192: "the message is part of the fix"). NAMES
 * each binding, says WHY it cannot be resolved (let/var is reassignable), and
 * states the REMEDY (make it const, or inline the literal) — so the cheaper path
 * out of the failed build is fixing the binding, not deleting the check. Never a
 * bare "refusing".
 */
export function formatRefusal(refusals) {
  const lines = refusals.map((r) => `    ${r.name}  (declared at line ${r.line})`);
  return (
    "  A token/auth SQL statement is held in a reassignable `let`/`var` binding:\n" +
    lines.join("\n") +
    "\n\n  A `let`/`var` can be reassigned, so its initializer does not establish what the\n" +
    "  statement actually executes: reading it could report a false all-clear while a\n" +
    "  later reassignment revokes a token. This guard refuses to guess rather than miss\n" +
    "  a bump (exit 2 = cannot analyse, NOT exit 1 = your code is wrong).\n" +
    "  Remedy: make the binding a `const`, or inline the SQL literal at the call site,\n" +
    "  so the statement's identity is fixed where it is used.\n"
  );
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
      // pinned-parser gate: throws on parse diagnostics → main() exits 2
      const premiseSf = parseGuardSource(path.basename(abs), src);
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
      // FAIL-CLOSED REFUSAL (#192 ruling 3), premise-style: exit 2, its own
      // diagnosis, BEFORE the exit-1 violation scan. A token/auth SQL statement
      // held in a reassignable let/var cannot be soundly analysed, so refuse with
      // an actionable message rather than read a stale initializer and pass. Exit
      // 2 = "I cannot analyse this", kept distinct from exit 1 = "your code is
      // wrong" — the false-all-clear the exit-1 wording would imply is exactly the
      // stale cache this guard exists to prevent.
      const refusals = findUnresolvableBindings(src, path.basename(abs));
      if (refusals.length > 0) {
        process.stderr.write(`auth-gen-guard: CANNOT ANALYSE ${abs}\n` + formatRefusal(refusals));
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
