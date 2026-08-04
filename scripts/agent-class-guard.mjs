#!/usr/bin/env node
// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0002 (v2.21.0) — agent-class taxonomy drift guard (TS-AST based).
 *
 * `src/agent-class.ts` is the SINGLE SOURCE OF TRUTH for the agent
 * coordination-class taxonomy. This walks the AST of every OTHER src/ *.ts file
 * and rejects the two re-fork forms — the exact class this guard exists to
 * prevent (a parallel/confabulated taxonomy, like the one the orchestrator
 * nearly shipped):
 *
 *   1. a class-value STRING LITERAL used as a BRANCH — equality/inequality
 *      (=== !== == !=) with a class-id literal on EITHER operand, or a
 *      switch `case` label that is a class-id literal;
 *   2. a PARALLEL VOCABULARY — an array literal containing ≥2 class-id string
 *      literals (covers `[...]`, `new Set([...])`, `z.enum([...])`).
 *
 * The fix is always: import the value / enum / const from `src/agent-class.ts`
 * and branch on the imported identifier (NOT a literal). It deliberately does
 * NOT flag prose, single-mention description strings (`"one of orchestrator |
 * builder | …"`), or imported-identifier comparisons (`a.class === TRANSIENT`) —
 * none of those re-fork the taxonomy.
 *
 * THREAT MODEL (mirrors the cli-profile guard, Victra-ratified): dev-time
 * hygiene against ACCIDENTAL drift, not a sandbox. It resolves string +
 * no-substitution-template literals; it does NOT constant-fold obfuscation.
 * Escape hatch: `// AGENT-CLASS-ALLOWLIST: <reason>` on the offending line.
 *
 * Exit: 0 = clean · 1 = violations (stderr) · 2 = usage/parse error.
 * Usage: node scripts/agent-class-guard.mjs <dir> [<dir> ...]
 */
import ts from "typescript";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// The full canonical taxonomy (declarable + sentinel + reserved). Any of these
// as a branch/vocab OUTSIDE the SSOT is drift.
const CLASS_VALUES = new Set([
  "orchestrator",
  "builder",
  "advisory",
  "auditor",
  "transient",
  "unclassified",
  "bridge",
]);
const EQ_OPS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);
const EXCLUDE_BASENAME = new Set(["agent-class.ts"]);
const ALLOW_MARK = "AGENT-CLASS-ALLOWLIST:";

function isClassLiteral(node) {
  return (
    !!node &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
    CLASS_VALUES.has(node.text)
  );
}

/** Analyze source text; return [{line, kind, snippet}] violations. Exported for the negative-fixture test. */
export function findAgentClassViolations(source, fileName = "f.ts") {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const allowed = new Set();
  source.split("\n").forEach((l, i) => {
    if (l.includes(ALLOW_MARK)) allowed.add(i + 1);
  });
  const violations = [];
  const report = (node, kind) => {
    const ln = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    if (allowed.has(ln)) return;
    violations.push({ line: ln, kind, snippet: node.getText(sf).replace(/\s+/g, " ").slice(0, 80) });
  };
  const visit = (node) => {
    // 1a. equality branch on a class-id literal (either operand)
    if (ts.isBinaryExpression(node) && EQ_OPS.has(node.operatorToken.kind)) {
      if (isClassLiteral(node.left) || isClassLiteral(node.right)) report(node, "class-value equality branch");
    }
    // 1b. switch/case on a class-id literal
    if (ts.isCaseClause(node) && isClassLiteral(node.expression)) report(node, "class-value switch/case");
    // 2. parallel vocabulary — an array literal with ≥2 class-id literals
    if (ts.isArrayLiteralExpression(node)) {
      const n = node.elements.filter((e) => isClassLiteral(e)).length;
      if (n >= 2) report(node, "parallel class vocabulary");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}

function collectTsFiles(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) collectTsFiles(p, out);
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(p);
  }
}

function main() {
  const roots = process.argv.slice(2);
  if (roots.length === 0) {
    process.stderr.write("usage: agent-class-guard.mjs <dir> [<dir> ...]\n");
    process.exit(2);
  }
  const files = [];
  for (const r of roots) {
    const abs = path.resolve(r);
    if (!fs.existsSync(abs)) {
      process.stderr.write(`agent-class-guard: no such path: ${abs}\n`);
      process.exit(2);
    }
    if (fs.statSync(abs).isDirectory()) collectTsFiles(abs, files);
    else if (abs.endsWith(".ts")) files.push(abs);
  }
  const all = [];
  try {
    for (const f of files) {
      if (EXCLUDE_BASENAME.has(path.basename(f))) continue;
      for (const v of findAgentClassViolations(fs.readFileSync(f, "utf-8"), path.basename(f))) {
        all.push({ file: f, ...v });
      }
    }
  } catch (err) {
    process.stderr.write(`agent-class-guard: parse error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
  if (all.length > 0) {
    process.stderr.write("Agent-class taxonomy drift — class values branched on / re-declared outside src/agent-class.ts:\n");
    for (const v of all) process.stderr.write(`  ${v.file}:${v.line}  [${v.kind}]  ${v.snippet}\n`);
    process.stderr.write("\nFix: import the value / enum / const from src/agent-class.ts and branch on the imported identifier.\n");
    process.stderr.write(`For a genuine one-off, append '// ${ALLOW_MARK} <reason>' to the line.\n`);
    process.exit(1);
  }
  process.stdout.write("No agent-class taxonomy drift outside src/agent-class.ts — SSOT intact\n");
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
