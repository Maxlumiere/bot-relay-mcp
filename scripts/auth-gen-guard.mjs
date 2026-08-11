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
  foldDbCallArgs,
} from "./lib/guard-ast.mjs";

// Columns whose mutation changes a token's VALIDITY and therefore MUST bump the
// generation. EXCLUDED WITH ITS REASON (#59, victra + the-fixer measured it):
//   • revoked_at is NOT here on purpose. It is an audit timestamp — resolveAgent-
//     ByToken decides revoked/active from auth_state + `token_hash IS NULL AND
//     auth_state = 'active'`, and NOTHING reads revoked_at in a validity decision.
//     A revoked_at-only write does not move the verified-token cache, so demanding
//     a bump for it would OVER-flag. In the real file it is always co-mutated with
//     auth_state (which IS here), so it is covered incidentally.
//   ⚠ IF YOU ADD A CODE PATH THAT CONSULTS revoked_at TO DECIDE VALIDITY, add
//     "revoked_at" to this list in the same change — the exclusion's premise
//     (nothing reads it) will no longer hold.
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
 * Does this resolved text PROVE it is a read statement — does its resolved prefix
 * start with SELECT? DEFAULT-DENY, the same principle the call side uses: prove it
 * is SAFE, do not fail-to-prove it is dangerous. Used for the prepare()-argument
 * carve-out (#194 sub-decision 1, SQLite-verified): SQLite forbids a substitution
 * from appending a SECOND statement to a prepared SELECT (`prepare("SELECT …;
 * UPDATE …")` THROWS), and a single SELECT statement cannot mutate — so a prepare()
 * argument that provably STARTS as a SELECT cannot become an agents mutation and
 * does not refuse on an unresolvable clause.
 *
 * ⚠ ONLY `SELECT`, NOT `WITH` (codex #194, verified): a CTE can PREFIX a DML
 * statement as one statement — `WITH c AS (SELECT 1) UPDATE agents SET token_hash
 * = NULL` prepares AND executes and mutates validity. `WITH` therefore proves
 * nothing about read-only; accepting it by prefix was a hole. An argument whose
 * resolved prefix is EMPTY (a bare parameter), or is `WITH`/`UPDATE`/`DELETE`/
 * anything but `SELECT`, proves nothing → it still REFUSES (never silently clean).
 * exec() gets NO carve-out at all (`exec("SELECT 1; UPDATE agents …")` RUNS the
 * UPDATE), so an exec() argument with any unresolvable piece refuses.
 *
 * ⚠ A CARVE-OUT IS AN ALLOWLIST, AND AN ALLOWLIST OF N PREFIXES IS N SEPARATE
 * CLAIMS about the SQLite engine — each must be independently VERIFIED, not
 * pattern-matched by resemblance to a safe one. `WITH` was added because it
 * "looks like a read" and was a hole. If a future prefix is proposed, the bar is
 * an executed proof that it cannot carry a mutation, not that it usually does not.
 */
function isProvablyRead(text) {
  return /^SELECT\b/i.test(text.replace(/\s+/g, " ").trim());
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
 *   • let/var-backed SQL at a prepare()/exec() arg -> its WHOLE assignment set is
 *     followed (foldVarBinding, #59 Option A): every assignment resolves to a
 *     literal -> resolve and match the union; ANY assignment unresolvable -> REFUSE
 *     (exit 2), fail-closed. (Not "never read" — reassignment is now enumerated.)
 *   • CONCATENATION -> at a prepare()/exec() arg it is FOLDED (reconstructed) so
 *     split position does not matter; a non-literal operand REFUSES. Away from a DB
 *     call the whole-body pass catches it only INCIDENTALLY — two non-contiguous
 *     sub-matches over raw text (issue #193) — split-dependent, never to be relied
 *     on. Neither "out of scope" nor "caught": see guard-ast RESOLVER COVERAGE.
 *   • a bare parameter / dynamic value at a DB call -> REFUSED (never silently
 *     clean, codex #194); CROSS-MODULE imported identity -> out of scope (needs a
 *     TypeChecker), refused at a DB call. Named boundaries, not gaps.
 *
 * The hoisted-constant gap is CLOSED, and was measured LATENT at 0294854 (zero
 * module-scope validity SQL in the real src/db.ts), so a correct fix changes
 * nothing about the real file — if real db.ts starts flagging, the fix is
 * over-flagging, not the codebase drifting.
 */
/**
 * Per-unit verdict with precedence baked in (#59 — PROOF BEATS UNCERTAINTY BEATS
 * SILENCE). Each unit gets EXACTLY ONE verdict, so exit-1 and exit-2 can never
 * both fire on one statement:
 *   • PROVABLE VIOLATION — the resolved text (the whole-body binding-resolved text
 *     of #57/#192, PLUS every FOLDED prepare()/exec() literal so a mid-token concat
 *     "token_" + "hash" reconstructs to "token_hash", PLUS the literal RUNS that
 *     resolved inside an otherwise-refused arg) shows a validity mutation and the
 *     unit does not bump → VIOLATION (exit 1), even if part of the statement is
 *     unresolvable: unknown text cannot un-mutate a visible mutation.
 *   • else any DB-call arg is unresolvable AND the unit does not bump → REFUSE
 *     (exit 2): the honest "I could not read all of it," never a silent all-clear.
 *     A bumping unit is safe regardless of what it does → clean, not refused.
 *   • else clean (exit 0).
 * ROOT G exemption unchanged: only the sanctioned primitive's own top-level
 * function declaration is exempt, not anything sharing its spelling.
 */
function classifyUnits(sf) {
  const violations = [];
  const refusals = [];
  forEachFunctionUnit(sf, (name, bodyNode, nameNode) => {
    if (!name) return;
    if ((SELF_BUMPERS.has(name) || INIT_ONLY_ALLOWLIST.has(name)) && isTopLevelFunctionDeclaration(nameNode)) {
      return;
    }
    const parts = [resolveUnitSqlText(bodyNode, sf, null)];
    let firstRefuse = null;
    for (const a of foldDbCallArgs(bodyNode, sf)) {
      if (a.kind === "literal") parts.push(a.text); // FOLD: split position no longer matters
      else if (a.kind === "refuse") {
        parts.push(a.partial || ""); // the runs that DID resolve, so a visible violation still shows
        // SUB-DECISION 1 (victra #194, SQLite-verified): a prepare() argument that
        // provably STARTS as a read (SELECT/WITH) cannot become a validity mutation
        // — SQLite rejects a second statement appended by any substitution
        // (prepare("SELECT …; UPDATE …") THROWS), so a resolved-read prepare arg with
        // an unresolvable piece does NOT refuse. An empty/non-read resolved prefix
        // (a bare parameter) proves nothing → refuse. exec() runs multiple
        // statements (exec("SELECT 1; UPDATE agents SET token_hash=NULL") executes
        // the UPDATE) → an exec() arg with any unresolvable piece REFUSES.
        if (!firstRefuse && (a.method === "exec" || !isProvablyRead(a.partial || ""))) firstRefuse = a;
      }
    }
    const bumps = bodyCallsFunction(bodyNode, sf, SELF_BUMPERS);
    const line = sf.getLineAndCharacterOfPosition(nameNode.getStart(sf)).line + 1;
    if (hasValidityChangingMutation(parts.join(" ")) && !bumps) {
      violations.push({ name, line }); // PROOF beats uncertainty
      return;
    }
    if (firstRefuse && !bumps) {
      refusals.push({ name, line: firstRefuse.line, reason: firstRefuse.reason }); // uncertainty beats silence
    }
  });
  return { violations, refusals };
}

/**
 * Functions that mutate token/auth validity but do not bump the generation
 * (exit 1). Exported so the negative-fixture test can prove the guard FAILS on an
 * omitted bump. See classifyUnits for the trigger, the fold, and the precedence.
 */
export function findAuthGenViolations(source, fileName = "db.ts") {
  const sf = parseGuardSource(fileName, source); // pinned-parser gate: throws on parse diagnostics → main() exits 2
  return classifyUnits(sf).violations;
}

/**
 * The fail-closed REFUSAL set (exit 2): units whose prepare()/exec() SQL ARGUMENT,
 * of ANY shape, cannot be resolved to a literal — a bare parameter or other
 * dynamic value, a cross-module import, a function-call result, a reference cycle,
 * a concatenation with a non-literal operand, or a reassignable let/var whose
 * assignment set is not all-literal (#59, victra Option A; supersedes the #192
 * file-level let/var scan — the module let/var refusal is now handled prepare-
 * scoped inside foldSqlArg). A SEPARATE exit code from a violation because "I
 * cannot analyse this" is a different fact from "your code is wrong". SCOPED to
 * arguments that reach a DB call — the-fixer measured a blanket version at 20
 * false refusals on real db.ts, this scoping at 0.
 */
export function findUnresolvableBindings(source, fileName = "db.ts") {
  const sf = parseGuardSource(fileName, source);
  return classifyUnits(sf).refusals;
}

/**
 * Premise-style refusal message (#192/#59: "the message is part of the fix").
 * NAMES each unit/binding, says WHY it cannot be resolved (per-reason), and states
 * the REMEDY (inline the literal, or build it from in-file const literals) — so
 * the cheaper path out of the failed build is fixing the SQL's identity, not
 * deleting the check. Never a bare "refusing".
 */
export function formatRefusal(refusals) {
  const lines = refusals.map((r) => `    ${r.name}  (line ${r.line})${r.reason ? " — " + r.reason : ""}`);
  return (
    "  Token/auth SQL reaches a DB call through something this guard cannot resolve to a\n" +
    "  literal:\n" +
    lines.join("\n") +
    "\n\n  The guard reconstructs SQL only from in-file `const` string literals (and\n" +
    "  concatenations of them, folded). It refuses rather than guess when the SQL comes\n" +
    "  from a reassignable `let`/`var`, a cross-module import, a function-call result, a\n" +
    "  reference cycle, or a concatenation with a non-literal operand — reading such a\n" +
    "  value could report a false all-clear while the statement that runs revokes a token.\n" +
    "  Exit 2 = \"cannot analyse this\", deliberately NOT exit 1 = \"your code is wrong\".\n" +
    "  Remedy: inline the SQL literal at the prepare()/exec() call, or build it from\n" +
    "  in-file `const` string literals, so its identity is fixed where it is used.\n"
  );
}

function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    process.stderr.write("usage: auth-gen-guard.mjs <db.ts> [<file> ...]\n");
    process.exit(2);
  }
  const all = [];
  const allRefusals = [];
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
      // PRECEDENCE (#59 — PROOF BEATS UNCERTAINTY BEATS SILENCE): collect BOTH the
      // provable violations (exit 1) and the refusals (exit 2). A provable
      // violation outranks a refusal — a mutation visible in the resolved text is
      // established fact — so nothing is decided until every file is scanned. Exit
      // 1 = "your code is wrong", exit 2 = "I cannot analyse this"; the two are
      // deliberately distinct (#192), and an unresolvable statement is never
      // silently clean — it flags or it refuses.
      for (const v of findAuthGenViolations(src, path.basename(abs))) all.push({ file: abs, ...v });
      for (const r of findUnresolvableBindings(src, path.basename(abs))) allRefusals.push({ file: abs, ...r });
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
  // No provable violation anywhere → now the refusals decide (exit 2). Reached
  // only when nothing is exit-1, so PROOF has already had its precedence.
  if (allRefusals.length > 0) {
    const where = allRefusals.length ? allRefusals[0].file : "";
    process.stderr.write(`auth-gen-guard: CANNOT ANALYSE ${where}\n` + formatRefusal(allRefusals));
    process.exit(2);
  }
  process.stdout.write("All token/auth mutators bump the auth generation — verified-token cache invalidation intact\n");
  process.exit(0);
}

// Run as CLI only when invoked directly (not when imported by the test).
// Compare resolved filesystem paths (fileURLToPath decodes %20 etc.) so a
// working directory with spaces — e.g. "…/Claude AI/…" — still triggers main().
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
