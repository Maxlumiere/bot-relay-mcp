#!/usr/bin/env node
// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.17.0 P3 — CLI-profile branching drift guard (TS-AST based).
 *
 * The agent-CLI profile registry (src/agent-cli-profiles.ts) is the ONE place
 * hardcoded claude/codex DECISION LOGIC may live. This walks the AST of every
 * other src/ *.ts file and flags the dangerous BRANCH FORMS — regardless of
 * syntactic ordering, which a regex cannot do reliably (codex's audit found 3
 * bypasses of the original regex; AST closes the whole class):
 *
 *   1. equality / inequality (=== !== == !=) with a CLI-id string literal on
 *      EITHER operand — `id === "codex"` AND the reversed `"codex" === id`;
 *   2. a switch `case` label that is a CLI-id string literal — `case "claude":`;
 *   3. a regex that alternates the CLI ids — a /.../ literal OR `new RegExp("…")`
 *      whose source mentions BOTH "claude" and "codex" (covers capturing
 *      `(claude|codex)`, noncapturing `(?:claude|codex)`, and bare `claude|codex`).
 *
 * It deliberately does NOT flag prose, ~/.claude/… paths, --flags, display
 * strings ("Codex CLI"), longer identifiers ("claude-scope-planner"), or
 * registry lookups by id (`getAgentCliProfile("codex")`) — none of those are a
 * branch. Per the codex + victra gate: stay TARGETED, no blanket-literal guard.
 *
 * THREAT MODEL (deliberate, Victra-ratified scope boundary): this is a dev-time
 * hygiene guard against ACCIDENTAL drift, not a security sandbox. It resolves
 * string + no-substitution-template literals (devs realistically write both).
 * It does NOT constant-fold arbitrary expressions — e.g. `id === ("co"+"dex")`
 * or `new RegExp("claude"+"|"+"codex")` are adversarial obfuscation, not
 * accidental drift, and anyone splitting strings to evade the guard would just
 * add the allowlist comment anyway. For any intentional exception, use
 * `// CLI-PROFILE-ALLOWLIST: <reason>` on the offending line.
 *
 * Escape hatch: put `// CLI-PROFILE-ALLOWLIST: <reason>` on the offending line.
 *
 * Usage:   node scripts/cli-profile-guard.mjs <dir> [<dir> ...]
 * Exit:    0 = clean · 1 = violations (printed to stderr) · 2 = usage/parse error
 */
import ts from "typescript";
import fs from "fs";
import path from "path";

const CLI_IDS = new Set(["claude", "codex"]);
const EQ_OPS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);
const EXCLUDE_BASENAME = new Set(["agent-cli-profiles.ts"]);
const ALLOW_MARK = "CLI-PROFILE-ALLOWLIST:";

// A CLI-id LITERAL operand: a string literal OR a no-substitution template
// literal (`codex`) whose value is a CLI id. Template literals are resolved the
// same as strings because devs realistically write them; arbitrary expressions
// are NOT constant-folded (see the threat-model note at the top of this file).
function isCliIdLiteral(node) {
  return (
    !!node &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
    CLI_IDS.has(node.text)
  );
}

// A regex source ALTERNATES the CLI ids iff each id is pipe-adjacent (`id|` or
// `|id`) — i.e. an actual alternation branch, not mere co-occurrence. This
// flags capturing / noncapturing / bare / interleaved (claude|foo|codex) forms
// but SPARES a sequence like /claude.*codex/ (no `|` between the ids) and a
// single-id regex /^codex-/. Escaped pairs (incl. a literal \|) are stripped
// first so they don't count as an alternation operator.
function isCliRegexAlternation(source) {
  const cleaned = source.replace(/\\./g, "");
  const participates = (id) => cleaned.includes(id + "|") || cleaned.includes("|" + id);
  return participates("claude") && participates("codex");
}

function scanFile(file, violations) {
  const src = fs.readFileSync(file, "utf-8");
  const allowedLines = new Set();
  src.split("\n").forEach((l, i) => {
    if (l.includes(ALLOW_MARK)) allowedLines.add(i + 1);
  });

  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  const report = (node, kind) => {
    const ln = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    if (allowedLines.has(ln)) return;
    violations.push({ file, line: ln, kind, snippet: node.getText(sf).replace(/\s+/g, " ").slice(0, 100) });
  };

  const visit = (node) => {
    // 1. id-equality branch — CLI literal on EITHER operand of === !== == !=
    if (ts.isBinaryExpression(node) && EQ_OPS.has(node.operatorToken.kind)) {
      if (isCliIdLiteral(node.left) || isCliIdLiteral(node.right)) {
        report(node, "cli-id equality branch");
      }
    }
    // 2. switch/case on a CLI id
    if (ts.isCaseClause(node) && isCliIdLiteral(node.expression)) {
      report(node, "cli-id switch/case");
    }
    // 3a. regex literal alternating the CLI ids (actual `|` branch, not a sequence)
    if (ts.isRegularExpressionLiteral(node) && isCliRegexAlternation(node.text)) {
      report(node, "cli-id regex alternation");
    }
    // 3b. new RegExp("claude|codex") / new RegExp(`claude|codex`) — a string or
    // no-substitution-template arg that alternates the ids
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "RegExp" &&
      node.arguments &&
      node.arguments.length > 0
    ) {
      const arg = node.arguments[0];
      if (
        (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) &&
        isCliRegexAlternation(arg.text)
      ) {
        report(node, "cli-id RegExp() alternation");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
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
    process.stderr.write("usage: cli-profile-guard.mjs <dir> [<dir> ...]\n");
    process.exit(2);
  }
  const files = [];
  for (const r of roots) {
    const abs = path.resolve(r);
    if (!fs.existsSync(abs)) {
      process.stderr.write(`cli-profile-guard: no such path: ${abs}\n`);
      process.exit(2);
    }
    if (fs.statSync(abs).isDirectory()) collectTsFiles(abs, files);
    else if (abs.endsWith(".ts")) files.push(abs);
  }

  const violations = [];
  try {
    for (const f of files) {
      if (EXCLUDE_BASENAME.has(path.basename(f))) continue;
      scanFile(f, violations);
    }
  } catch (err) {
    process.stderr.write(`cli-profile-guard: parse error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }

  if (violations.length > 0) {
    process.stderr.write("Hardcoded claude|codex CLI branching outside the profile registry:\n");
    for (const v of violations) {
      process.stderr.write(`  ${v.file}:${v.line}  [${v.kind}]  ${v.snippet}\n`);
    }
    process.stderr.write("\nFix: read from src/agent-cli-profiles.ts (getAgentCliProfile / profileProcessPatternSource).\n");
    process.stderr.write(`If genuinely needed, append '// ${ALLOW_MARK} <reason>' to the offending line.\n`);
    process.exit(1);
  }
  process.stdout.write(
    "No hardcoded claude|codex branching outside src/agent-cli-profiles.ts — registry consolidated\n",
  );
  process.exit(0);
}

main();
