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
const BUMP_CALL_RE = /\b(?:bumpAuthGeneration|applyAuthStateTransition)\s*\(/;

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
 */
export function findAuthGenViolations(source, fileName = "db.ts") {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations = [];

  // Analyze one NAMED function unit (declaration / arrow / function-expression /
  // method): if its body performs a validity-changing agents mutation it MUST
  // bump, unless it is a self-bumper or an explicit init-only migration.
  const analyze = (name, bodyNode, nameNode) => {
    if (!name || SELF_BUMPERS.has(name) || INIT_ONLY_ALLOWLIST.has(name)) return;
    const bodyText = bodyNode.getText(sf);
    if (hasValidityChangingMutation(bodyText) && !BUMP_CALL_RE.test(bodyText)) {
      violations.push({ name, line: sf.getLineAndCharacterOfPosition(nameNode.getStart(sf)).line + 1 });
    }
  };

  const visit = (node) => {
    // 1. function NAME(...) { ... }
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      analyze(node.name.text, node.body, node.name);
    }
    // 2. const NAME = (...) => { ... }  /  const NAME = function (...) { ... }
    //    (the arrow / function-expression evasion codex constructed)
    else if (
      ts.isVariableDeclaration(node) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
      node.initializer.body
    ) {
      analyze(node.name.text, node.initializer.body, node.name);
    }
    // 3. class/object method NAME(...) { ... }
    else if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.body) {
      analyze(node.name.text, node.body, node.name);
    }
    // 4. { NAME: (...) => { ... } }  object-literal property holding a function
    else if (
      ts.isPropertyAssignment(node) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
      node.initializer.body
    ) {
      analyze(node.name.text, node.initializer.body, node.name);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
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
      for (const v of findAuthGenViolations(src, path.basename(abs))) {
        all.push({ file: abs, ...v });
      }
    }
  } catch (err) {
    process.stderr.write(`auth-gen-guard: parse error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
  if (all.length > 0) {
    process.stderr.write(
      "ADR-0003 auth-generation drift: these functions mutate token/auth validity but never bump the auth generation (a stale verified-token cache = accepting a revoked token):\n",
    );
    for (const v of all) process.stderr.write(`  ${v.file}:${v.line}  ${v.name}()\n`);
    process.stderr.write("\nFix: call bumpAuthGeneration() after the mutation (or route through applyAuthStateTransition).\n");
    process.exit(1);
  }
  process.stdout.write("All token/auth mutators bump the auth generation — verified-token cache invalidation intact\n");
  process.exit(0);
}

// Run as CLI only when invoked directly (not when imported by the test).
// Compare resolved filesystem paths (fileURLToPath decodes %20 etc.) so a
// working directory with spaces — e.g. "…/Claude AI/…" — still triggers main().
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
