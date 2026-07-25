#!/usr/bin/env node
// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.23.x #140 — probe-cache eviction drift guard (TS-AST based).
 *
 * The two liveness probe caches (src/db.ts `_negativeProbeCache` /
 * `_positiveProbeCache`) are keyed by agent NAME and cache the ANCHOR-liveness
 * verdict computed by `computeLivenessVerdict`. They are only safe if EVERY
 * writer that CREATES, REPLACES, or DELETES a name's liveness identity evicts
 * BOTH caches UNCONDITIONALLY — otherwise a stale entry outlives the binding it
 * described and mislabels the next one (a live row read `dead`, or an argv-scan
 * alive signal suppressed by a stale negative) until the ~5s TTL. This is the
 * #140 defect; codex found a FIFTH site that four reviewers missed because it
 * was correctly BRACED — the class was framed by syntax (`unbraced if`) when the
 * defect is CONDITIONALITY on a CAS writer. This guard reframes it by BEHAVIOUR.
 *
 * WIDENED PREDICATE (codex, #140 rebuild). A function is an "identity writer" if
 * its body performs ANY of:
 *   • `INSERT INTO agents`  — CREATE a name's identity  (registerAgent)
 *   • `DELETE FROM agents`  — DELETE a name's identity  (unregister / teardown /
 *                             orphan-reap / abandon-purge)
 *   • `UPDATE agents SET …` that writes `session_id` / `agent_pid` /
 *     `agent_pid_start` — REPLACE the session or the probe anchor (the five
 *     teardown/anchor writers). `\bagents\b` deliberately does NOT match
 *     `agents_new` (the schema-rebuild table), so a migration rebuild is exempt
 *     by construction, not by allowlist.
 * Over-inclusion is SAFE (it only demands an eviction, which is always correct —
 * at most one extra probe); under-inclusion is the dangerous direction.
 *
 * REQUIREMENT. An identity writer MUST evict BOTH caches, and each eviction must
 * be a TOP-LEVEL STATEMENT of the function body — i.e. a direct statement of the
 * function's block, not nested inside an `if`/loop/branch. That is the SEMANTIC
 * encoding of "unconditional": the braced fifth site put its evictions inside
 * `if (r.changes === 1) { … }`, so they were NOT top-level → this guard flags
 * exactly that shape WITHOUT grepping for `if (`. A writer with two SQL forms in
 * separate branches must hoist a SINGLE eviction to the common tail (as
 * `closeAgentSession` now does) so the guard can verify it on every path.
 *
 * INIT-ONLY ALLOWLIST. Schema migrations run ONCE at DB initialization, before
 * the daemon serves any read — the probe caches are empty then, so a one-time
 * backfill of session_id has nothing to evict (and predates the caches). This is
 * an EXPLICIT set — NOT a `migrateSchemaTo*` wildcard — so a runtime writer can't
 * evade by naming itself `migrateSchemaTo…`. Add a migration here CONSCIOUSLY,
 * and only if it is genuinely init-only.
 *
 * ── FROZEN ACCEPTANCE CRITERIA (mirrors auth-gen-guard; do NOT whack-a-mole) ──
 * Catches ACCIDENTAL DRIFT — a new/edited identity writer that ships with no
 * eviction, or with a conditional (non-top-level) one. It is COMPLETE when:
 *   • it visits the syntaxes a writer is realistically written as: function
 *     declarations, named arrows/function-expressions, methods, object-literal
 *     function properties (same set auth-gen proved necessary);
 *   • it exempts init-only migrations via the EXPLICIT name allowlist;
 *   • it does NOT chase adversarial obfuscation (dynamically-named / eval'd /
 *     reflection-dispatched / string-concatenated writers, or an eviction hidden
 *     behind an alias) — that is a malicious-insider model, not accidental
 *     drift. It also does not prove EVERY early-return path evicts (the per-site
 *     CAS-loser tests in tests/v2-23-0-cache-invalidation.test.ts do that, one
 *     case per shipped writer). An obfuscation-only gap is a documented note.
 *
 * Exit: 0 = clean · 1 = violations (stderr) · 2 = usage/parse error
 * Usage: node scripts/probe-cache-guard.mjs <db.ts> [<file> ...]
 */
import ts from "typescript";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Columns whose mutation REPLACES the session or the probe anchor — the inputs
// computeLivenessVerdict reads (agent_pid / agent_pid_start) plus session_id,
// which rotates the identity. Writing any of these under an `UPDATE agents SET`
// makes the function an identity writer.
const IDENTITY_COLS = ["session_id", "agent_pid", "agent_pid_start"];

// The two evictions an identity writer must perform, at the top level.
const NEG = "_negativeProbeCache";
const POS = "_positiveProbeCache";

// EXPLICIT init-only allowlist. migrateSchemaToV2_0 backfills session_id on the
// pre-v2-final rows ONCE at init (see src/db.ts) — the probe caches do not exist
// yet, so there is nothing to evict. NOT a wildcard: a runtime writer cannot
// evade by naming itself migrateSchemaTo….
const INIT_ONLY_ALLOWLIST = new Set(["migrateSchemaToV2_0"]);

/** Does this function body perform a CREATE/REPLACE/DELETE of a name's liveness
 *  identity? Text-based + loosely scoped: the SQL may be string-concatenated.
 *  `\bagents\b` excludes `agents_new` / `agent_capabilities`. */
function hasIdentityMutation(bodyText) {
  const compact = bodyText.replace(/\s+/g, " ");
  if (/\bINSERT\s+INTO\s+agents\b/i.test(compact)) return true; // CREATE
  if (/\bDELETE\s+FROM\s+agents\b/i.test(compact)) return true; // DELETE
  // REPLACE — an `UPDATE agents SET …` that writes a session/anchor column. The
  // column check is scoped to the SET CLAUSE (each `SET` → its `WHERE`, or to end
  // when there is no WHERE), so an identity column that appears ONLY in a WHERE
  // predicate — e.g. a status-only migration keyed `WHERE … session_id IS NULL` —
  // is NOT a false match. Scanning every UPDATE in the body (matchAll) keeps
  // under-inclusion (the dangerous direction) from hiding behind a leading
  // status-only UPDATE.
  for (const m of compact.matchAll(/\bUPDATE\s+agents\s+SET\b([\s\S]*?)(?:\bWHERE\b|$)/gi)) {
    const setClause = m[1];
    for (const col of IDENTITY_COLS) {
      if (new RegExp("\\b" + col + "\\b").test(setClause)) return true;
    }
  }
  return false;
}

/** Is `expr` a call to `<cacheName>.delete(...)`? */
function isEvictionCall(expr, cacheName) {
  return (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === cacheName &&
    expr.expression.name.text === "delete"
  );
}

/**
 * Scan the DIRECT statements of a function body block for the two evictions.
 * "Top-level" = a statement of the function's own block, NOT nested inside an
 * `if`/loop/inner block/closure. Returns { neg, pos } booleans. A non-block body
 * (single-expression arrow) has no statements → { false, false }.
 */
function topLevelEvictions(bodyNode) {
  const found = { neg: false, pos: false };
  if (!bodyNode || !ts.isBlock(bodyNode)) return found;
  for (const stmt of bodyNode.statements) {
    if (!ts.isExpressionStatement(stmt)) continue;
    if (isEvictionCall(stmt.expression, NEG)) found.neg = true;
    if (isEvictionCall(stmt.expression, POS)) found.pos = true;
  }
  return found;
}

/**
 * Analyze source text; return { name, line, reason } for identity writers that
 * do not evict both caches unconditionally (top-level). Exported so the
 * negative-fixture test can prove the guard FAILS on a drifted writer.
 */
export function findProbeCacheViolations(source, fileName = "db.ts") {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations = [];

  const analyze = (name, bodyNode, nameNode) => {
    if (!name || INIT_ONLY_ALLOWLIST.has(name)) return;
    if (!hasIdentityMutation(bodyNode.getText(sf))) return;
    const { neg, pos } = topLevelEvictions(bodyNode);
    if (neg && pos) return; // clean
    const line = sf.getLineAndCharacterOfPosition(nameNode.getStart(sf)).line + 1;
    // A `.delete` call present in the body text but NOT found as a top-level
    // statement is the BRACED-fifth-site shape: the eviction sits inside a
    // conditional (e.g. `if (r.changes === 1) { … }`), so it is skipped on the
    // CAS-loser path. Distinguish that from a genuinely absent eviction.
    const bodyStr = bodyNode.getText(sf);
    const label = (cache, atTopLevel) =>
      atTopLevel ? null : bodyStr.includes(`${cache}.delete`) ? `${cache}.delete is nested/conditional (not top-level — skipped on the CAS-loser path)` : `${cache}.delete is missing`;
    const reason = [label(NEG, neg), label(POS, pos)].filter(Boolean).join("; ");
    violations.push({ name, line, reason });
  };

  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      analyze(node.name.text, node.body, node.name);
    } else if (
      ts.isVariableDeclaration(node) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
      node.initializer.body
    ) {
      analyze(node.name.text, node.initializer.body, node.name);
    } else if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.body) {
      analyze(node.name.text, node.body, node.name);
    } else if (
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
    process.stderr.write("usage: probe-cache-guard.mjs <db.ts> [<file> ...]\n");
    process.exit(2);
  }
  const all = [];
  try {
    for (const f of files) {
      const abs = path.resolve(f);
      if (!fs.existsSync(abs)) {
        process.stderr.write(`probe-cache-guard: no such path: ${abs}\n`);
        process.exit(2);
      }
      const src = fs.readFileSync(abs, "utf-8");
      for (const v of findProbeCacheViolations(src, path.basename(abs))) {
        all.push({ file: abs, ...v });
      }
    }
  } catch (err) {
    process.stderr.write(`probe-cache-guard: parse error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
  if (all.length > 0) {
    process.stderr.write(
      "#140 probe-cache eviction drift: these functions CREATE/REPLACE/DELETE a name's liveness identity but do not evict both probe caches unconditionally (a stale entry outlives the binding it described → the next binding reads a wrong liveness verdict until the TTL):\n",
    );
    for (const v of all) process.stderr.write(`  ${v.file}:${v.line}  ${v.name}()  — ${v.reason}\n`);
    process.stderr.write(
      "\nFix: add `_negativeProbeCache.delete(name); _positiveProbeCache.delete(name);` as TOP-LEVEL statements (unconditional — never inside an `if (r.changes …)`). If this is a genuine init-only migration, add it to INIT_ONLY_ALLOWLIST consciously.\n",
    );
    process.exit(1);
  }
  process.stdout.write("All liveness-identity writers evict both probe caches unconditionally — probe-cache invalidation intact\n");
  process.exit(0);
}

// Run as CLI only when invoked directly (not when imported by the test). Compare
// resolved paths (fileURLToPath decodes %20 etc.) so a working directory with
// spaces — e.g. "…/Claude AI/…" — still triggers main().
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
