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
 * "Mints a token" = the function body calls `generateToken(`. Verified at authoring
 * time: every generateToken() use in db.ts produces a PERSISTED credential (agent
 * token, rotated token, or recovery handle), so this trigger has no false
 * positives today. Over-inclusion is SAFE (it only demands a register call);
 * under-inclusion is the dangerous direction, so the trigger is deliberately
 * coarse.
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

const MINT_CALL_RE = /\bgenerateToken\s*\(/;
const REGISTER_CALL_RE = /\bregisterPersistedSecret\s*\(/;
// registerPersistedSecret is the sanctioned register primitive; it lives in
// secret-registry.ts, not db.ts, so it never needs to register itself. Kept as an
// EXPLICIT allowlist so a future db.ts helper that legitimately mints a token for
// a non-persisted purpose can be added CONSCIOUSLY rather than silently evading.
const EXEMPT = new Set(["registerPersistedSecret", "registerIdentitySecret"]);

/** Does this function body mint a token (and therefore owe a register call)? */
function mintsAToken(bodyText) {
  return MINT_CALL_RE.test(bodyText);
}

/**
 * Analyze source text; return { name, line } for functions that mint a token but
 * never call registerPersistedSecret. Exported so the negative-fixture test can
 * prove the guard FAILS on an omitted register.
 */
export function findSecretRegisterViolations(source, fileName = "db.ts") {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations = [];

  const analyze = (name, bodyNode, nameNode) => {
    if (!name || EXEMPT.has(name)) return;
    const bodyText = bodyNode.getText(sf);
    if (mintsAToken(bodyText) && !REGISTER_CALL_RE.test(bodyText)) {
      violations.push({ name, line: sf.getLineAndCharacterOfPosition(nameNode.getStart(sf)).line + 1 });
    }
  };

  const visit = (node) => {
    // 1. function NAME(...) { ... }
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      analyze(node.name.text, node.body, node.name);
    }
    // 2. const NAME = (...) => { ... } / const NAME = function (...) { ... }
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
    // 4. { NAME: (...) => { ... } } object-literal property holding a function
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
      for (const v of findSecretRegisterViolations(src, path.basename(abs))) {
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
