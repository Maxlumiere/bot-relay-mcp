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
import { ts, parseGuardSource } from "./lib/guard-parse.mjs";
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
 * #57 — module-scope const bindings: name -> { text, node } of its initializer.
 * The SQL trigger reads a unit's body TEXT, so SQL hoisted to a module-level const
 * is invisible (the body holds the identifier, not the literal). We keep the
 * initializer NODE too so a const-to-const alias (const B = A) can be followed
 * TRANSITIVELY to the literal — see bodyTextWithModuleConsts (codex #192). Collect
 * ONLY top-level consts; a const inside an enclosing function is already covered by
 * that outer unit's body text — an over-flag, the safe direction (boundary V5).
 */
function collectModuleScopeConsts(sf) {
  const map = new Map();
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    if (!(stmt.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (decl.initializer && ts.isIdentifier(decl.name)) {
        map.set(decl.name.text, { text: decl.initializer.getText(sf), node: decl.initializer });
      }
    }
  }
  return map;
}

/**
 * #57 — splice the initializer text of every module-scope const THIS unit's body
 * references into the body text, so the trigger sees a hoisted literal exactly as
 * if it were inline.
 *
 * TRANSITIVE to the terminal literal, at ARBITRARY DEPTH (codex #192, victra): an
 * alias is the same scope at a deeper INDIRECTION — `const B = A; const C = B` is
 * an ordinary refactor, not the string-concat exclusion — so we follow each
 * spliced const's OWN references onward until no module-const identifiers remain.
 * There is NO depth limit, stated so no silent bound hides here: the walk is a
 * transitive closure over a FINITE set (the module consts), and the `seen` set
 * splices each at most once, which both bounds the total work to O(#consts) and
 * makes a reference cycle (A = B, B = A) terminate instead of hang.
 *
 * Per-unit by construction: the walk STARTS from this unit's body, so a shared
 * const is resolved only for the units that reference it — it flags the one that
 * skips the bump and not the one that makes it (boundary V9) — and a const no unit
 * references is spliced nowhere, so it flags nothing (V10). Follows the BINDING by
 * name; shadowing is an adversarial case the guard's freeze deliberately excludes.
 */
function bodyTextWithModuleConsts(bodyNode, sf, moduleConsts) {
  const bodyText = bodyNode.getText(sf);
  if (moduleConsts.size === 0) return bodyText;
  const seen = new Set();
  const queue = [];
  const enqueueRefs = (node) => {
    const visit = (n) => {
      if (ts.isIdentifier(n) && moduleConsts.has(n.text)) queue.push(n.text);
      ts.forEachChild(n, visit);
    };
    visit(node);
  };
  enqueueRefs(bodyNode);
  let extra = "";
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue; // finite closure + cycle break: splice each const once
    seen.add(name);
    const entry = moduleConsts.get(name);
    extra += " " + entry.text;
    enqueueRefs(entry.node); // follow const-to-const aliases onward to the terminal literal
  }
  return seen.size === 0 ? bodyText : bodyText + extra;
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
 *     constant, or built by concatenation -> would UNDER-detect: no bump is
 *     demanded, so the fully-hardened must-bump side never runs. Split by case:
 *       - HOISTED CONSTANT + ALIAS CHAIN: CLOSED (#57). collectModuleScopeConsts +
 *         bodyTextWithModuleConsts splice the initializer text of each
 *         module-scope const a unit references into THAT unit's effective body
 *         text — following const-to-const aliases (const B = A; const C = B)
 *         TRANSITIVELY to the terminal literal at arbitrary depth, cycle-safe
 *         (codex #192): an alias is the same scope at a deeper indirection, not a
 *         new scope, so a hop limit would just relocate the gap. A hoisted literal
 *         then reaches the trigger exactly as if inline, and attribution stays
 *         per-unit — a shared const blames only the unit that skipped the bump,
 *         never the one that made it. Was measured LATENT when closed (zero
 *         module-level mutation constants in src/db.ts), so a correct fix changes
 *         nothing about the real file: if real db.ts starts flagging, the fix is
 *         over-flagging, not the codebase drifting.
 *       - CONCATENATION ("UPDATE agents " + "SET …"): still UNDER-detects, and
 *         is out of scope BY DESIGN (below) — the whack-a-mole the freeze exists
 *         to prevent. Do NOT grow the #57 fix into it.
 * The trigger is still a text match; #57 widened the text it sees to a unit's
 * body PLUS the consts it names, not the whole file (that would over-flag V8–V10
 * — a benign-column update, an innocent shared-const user, an unused const). It
 * remains the WEAKER SIDE of a two-sided predicate — see guard-ast.mjs. Do not
 * read the hardened call side as making the guard strong overall.
 */
export function findAuthGenViolations(source, fileName = "db.ts") {
  const sf = parseGuardSource(fileName, source); // pinned-parser gate: throws on parse diagnostics → main() exits 2
  const violations = [];
  // #57 — resolve module-scope const bindings so hoisted SQL reaches the trigger.
  const moduleConsts = collectModuleScopeConsts(sf);
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
    // #57 — the unit's body text WITH the initializer text of any module-scope
    // const it references spliced in, so hoisted SQL is seen as if inline.
    const bodyText = bodyTextWithModuleConsts(bodyNode, sf, moduleConsts);
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
