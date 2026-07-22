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
 * SCOPE (documented boundary, like the cli-profile guard): the guard proves a
 * mutator contains a bump; it does not prove EVERY return-path bumps. That
 * finer property is covered by the behavioral invalidation tests
 * (tests/v2-20-0-auth-latency.test.ts — one case per mutation path). The guard's
 * job is to catch the OMISSION class — a new/edited mutator that ships with no
 * bump at all — which it does, adversarially proven by its negative fixture.
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
// Init-only schema migrations (the `migrateSchemaToV2_x` chain) run ONCE at
// startup, before the daemon serves any auth request — the per-process
// verified-token cache is empty at that point, so a one-time backfill of
// auth_state/token columns has nothing to invalidate. Exempt by the codebase's
// migration-naming convention.
const INIT_ONLY_RE = /^migrateSchemaTo/;
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
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const name = node.name.text;
      if (!SELF_BUMPERS.has(name) && !INIT_ONLY_RE.test(name)) {
        const bodyText = node.body.getText(sf);
        if (hasValidityChangingMutation(bodyText) && !BUMP_CALL_RE.test(bodyText)) {
          const line = sf.getLineAndCharacterOfPosition(node.name.getStart(sf)).line + 1;
          violations.push({ name, line });
        }
      }
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
