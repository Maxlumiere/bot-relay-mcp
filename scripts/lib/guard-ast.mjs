// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Shared structural primitives for the MUST-CALL drift guards (auth-gen-guard,
 * secret-register-guard). These guards enforce "a function that does X must also
 * CALL Y" — every token/auth mutator must call bumpAuthGeneration; every
 * token-minter must call registerPersistedSecret.
 *
 * ── THE DEFECT THESE REPLACE ────────────────────────────────────────────────
 * The v1 guards used the AST only to LOCATE a function, then ran a regex over
 * the function's raw body TEXT to decide whether the required call was present
 * (`REQUIRED_CALL_RE.test(bodyNode.getText())`). That enforces "the body text
 * contains this substring," not "this code calls this function." codex refuted
 * it with three valid-TS mutators that are harmful yet passed:
 *   (a) a `// TODO: call registerPersistedSecret(...)` COMMENT — prose counts as
 *       the call. This is the killer: a TODO comment is the single most likely
 *       artifact left at the exact moment the call has NOT been written.
 *   (b) `const mint = generateToken; ... mint()` — the trigger/required name is
 *       reached through a local alias the regex never sees.
 *   (c) a class-field arrow `mint = (name) => {...}` — a function-bearing node
 *       the v1 visitor never descended into.
 *
 * The fix is to make the PREDICATE structural: resolve a real CallExpression
 * through the AST. Comments and string literals are not CallExpression nodes, so
 * they are STRUCTURALLY INCAPABLE of satisfying it — not filtered out, incapable.
 * (Filtering is another blocklist; structure is a predicate. That distinction is
 * the whole fix.)
 *
 * ── DIRECTION-OF-FAILURE ASYMMETRY (read before "fixing" anything here) ───────
 * For a MUST-CALL guard, UNDER-detection is the only dangerous direction: a
 * missing required call that the guard does not flag ships a real hole (a stale
 * auth cache, a live token omitted from redaction). OVER-detection — demanding a
 * call that was not strictly needed — only produces a false build failure, which
 * is loud and annoying, never a silent hole. So when a check here is coarse,
 * confirm which way it errs: coarse-but-over-triggering is acceptable;
 * coarse-and-under-detecting is the bug. Do NOT "tighten" the over-triggering
 * half and call the guard fixed — that is fixing the safe direction.
 *
 * ── GUARD TAXONOMY (the durable map — answers "could this defect be here?") ───
 * Every drift guard in this repo is one of three shapes, and the shape decides
 * whether the comment-proxy defect above can even exist:
 *   • must-CALL — "a function that does X must CALL Y" (auth-gen-guard,
 *     secret-register-guard). Dangerous direction: UNDER-detection — a missing
 *     call the guard fails to flag ships a real hole. THIS is the class the
 *     comment/alias proxy attacks, and the ONLY class these helpers serve.
 *   • must-NOT-CONTAIN — "this forbidden construct must not appear outside file
 *     Z" (cli-profile-guard, agent-class-guard, and the bash sanctioned_helper /
 *     ip_classifier / drift guards). It CANNOT carry the comment-proxy defect: a
 *     comment matching the forbidden pattern only OVER-triggers (a false failure
 *     = safe). Its own hazard is a LEAKY forbidden-pattern matcher (case /
 *     whitespace / variant evasion — a different defect, e.g. sanctioned_helper's
 *     SQL-casing). The CORRECT handling of the comment case is a precedent
 *     already in this repo: ip_classifier_guard excludes comment lines
 *     (`grep -vE ':\s*(//|\*)'`) so a CIDR in a doc comment does not false-fail —
 *     do the equivalent when a must-NOT-CONTAIN matcher would trip on prose.
 *   • must-MATCH — "two values must be equal" (lockfile_version_sync_guard).
 *     Neither call nor contain; a consistency/equality check.
 * A guard is defined by this ROLE, not by its file type: sanctioned_helper_guard
 * is bash inside pre-publish-check.sh, NOT a scripts/*.mjs — scoping a guard
 * census by file extension is exactly how it gets missed (one miss from bad
 * scoping surfaces a whole category, not one item). Enumerate by role, then
 * discover the artifacts — never the reverse.
 *
 * ── NODE COVERAGE (forEachFunctionUnit) — enumerated, with the gaps NAMED ─────
 * COVERS (a named function unit the guard can check + cite in a violation):
 *   • function declarations                         function f() {}
 *   • arrow / function-expression bound to a name    const f = () => {} / = function(){}
 *   • class methods                                  class C { f() {} }
 *   • class-field arrow / fn-expression (codex (c))  class C { f = () => {} }
 *   • get/set accessors                              get x() {} / set x(v) {}
 *   • constructors (reported as "constructor")       class C { constructor() {} }
 *   • object-literal function properties             { f: () => {} } / { f: function(){} }
 * DOES NOT COVER (stated, not implied-total):
 *   • anonymous functions with no stable name (IIFEs, inline callbacks) — there
 *     is nothing to name in a violation, and a mutator you cannot name is not a
 *     maintainable finding. A must-call mutator is expected to be a named unit.
 *   • bodyCallsFunction counts a call only in the unit's OWN body, NOT inside a
 *     nested function unit (arrow / fn-expression / method / accessor /
 *     constructor). A required call in a NEVER-INVOKED closure (`const onSuccess
 *     = () => requiredCall()`) is that closure's, not this unit's — counting it
 *     would UNDER-detect, the only dangerous direction (a wired-but-uncalled
 *     handler reads as working code, worse than a TODO). So the scan stops at
 *     function boundaries. It does NOT stop at blocks / if / try / loops /
 *     switch — those are the SAME execution unit, so a call inside an `if` or
 *     `try` still counts; stopping there would break every honest function that
 *     registers conditionally (the innocent twin).
 *   • ACCEPTED OVER-FLAG (safe, named not discovered): an immediately-invoked
 *     function expression genuinely runs, but is skipped like any function node,
 *     so an IIFE doing the required call reads as absent → the guard OVER-flags
 *     → a loud false failure, fixable with an allowlist comment. Deliberately no
 *     bespoke IIFE detection — added machinery buys rarer correctness for a new
 *     place to be subtly wrong, and this already fails safe.
 *   • ACCEPTED RISK, honestly labelled (NOT "over-trigger safe" — it is
 *     under-detection we choose not to close here): REACHABILITY within a unit
 *     is not verified. A call in `if (false)` or an unreachable branch still
 *     counts, so the guard proves the call is PRESENT in the own-body, not that
 *     it runs on every path. Runtime-path coverage is the behavioural tests' job.
 *
 * ── bodyCallsFunction — what resolves, and the boundary that does NOT ─────────
 * RESOLVES a CallExpression whose callee is:
 *   • a direct Identifier in the name set                 requiredCall()
 *   • a property access ending in a name in the set       x.requiredCall()
 *   • a DIRECT local alias: `const a = <name>` then a()    (codex (b))
 * DOES NOT resolve (open boundary — indirection ≈ obfuscation, outside the
 * ACCIDENTAL-DRIFT threat model this guard defends; I will not imply totality):
 *   • reassignment (`let a = other; a = requiredCall; a()`)
 *   • the function passed as a callback / argument and invoked elsewhere
 *   • destructured (`const { requiredCall } = mod`) or dynamically-accessed
 *     (`mod["requiredCall"]()`) references
 * Anyone splitting a reference across those forms to evade the guard is not
 * drifting by accident, and would add the allowlist comment anyway.
 */
import ts from "typescript";

/**
 * Invoke cb(name, bodyNode, nameNode) for every NAMED function unit in the
 * source file. See the "NODE COVERAGE" note above for exactly what is and is not
 * visited.
 */
export function forEachFunctionUnit(sf, cb) {
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      cb(node.name.text, node.body, node.name);
    } else if (
      ts.isVariableDeclaration(node) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
      node.initializer.body
    ) {
      cb(node.name.text, node.initializer.body, node.name);
    } else if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.body) {
      cb(node.name.text, node.body, node.name);
    } else if (
      ts.isPropertyDeclaration(node) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
      node.initializer.body
    ) {
      // class-field arrow / function-expression — the codex (c) evasion
      cb(node.name.text, node.initializer.body, node.name);
    } else if (
      (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.body
    ) {
      cb(node.name.text, node.body, node.name);
    } else if (ts.isConstructorDeclaration(node) && node.body) {
      cb("constructor", node.body, node);
    } else if (
      ts.isPropertyAssignment(node) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
      node.initializer.body
    ) {
      cb(node.name.text, node.initializer.body, node.name);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/** Collect DIRECT local aliases of any name in `names`: `const a = <name>`. */
function collectDirectAliases(bodyNode, names) {
  const aliases = new Set();
  const walk = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isIdentifier(node.initializer) &&
      names.has(node.initializer.text)
    ) {
      aliases.add(node.name.text);
    }
    ts.forEachChild(node, walk);
  };
  walk(bodyNode);
  return aliases;
}

/**
 * Structurally decide whether `bodyNode` contains a CallExpression to any name
 * in `names` (or a direct local alias of one). Comments and string literals are
 * not CallExpression nodes and therefore cannot satisfy this. See the boundary
 * note above for the indirection cases this does not resolve.
 *
 * @param {ts.Node} bodyNode  the function body to scan
 * @param {ts.SourceFile} _sf  (kept for signature symmetry / future position use)
 * @param {Set<string>} names  callee names that count as "the required/trigger call"
 */
function isFunctionNode(n) {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n) ||
    ts.isConstructorDeclaration(n)
  );
}

export function bodyCallsFunction(bodyNode, _sf, names) {
  const aliases = collectDirectAliases(bodyNode, names);
  const isTarget = (n) => names.has(n) || aliases.has(n);

  let found = false;
  const visit = (node) => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && isTarget(callee.text)) {
        found = true;
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.name) &&
        isTarget(callee.name.text)
      ) {
        found = true;
      }
    }
    if (found) return;
    // Descend, but NOT into a nested function unit. A call inside a nested
    // closure belongs to THAT unit's execution, not this one's, and may never be
    // invoked (a wired-but-uncalled `const onSuccess = () => requiredCall()`).
    // Counting it here would UNDER-detect — the only dangerous direction. The
    // nested unit is analysed separately by forEachFunctionUnit. (Erring the
    // other way — a required call genuinely made inside an invoked callback, e.g.
    // `arr.forEach(x => requiredCall(x))` — is NOT counted and OVER-flags, which
    // is the safe direction for a must-call guard.)
    ts.forEachChild(node, (child) => {
      if (found || isFunctionNode(child)) return;
      visit(child);
    });
  };
  visit(bodyNode);
  return found;
}
