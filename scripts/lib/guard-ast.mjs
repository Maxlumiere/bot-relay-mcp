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
 * ── EVERY PASS THAT WALKS A BODY, AND ITS SCOPING RULE (keep this current) ────
 * Two passes over one body applying two different answers to "where does this
 * unit end" is not an edge case — it is the defect that shipped in round 1 of
 * this fix and it is why #151 failed audit. So the rule is enumerated here, and
 * the two passes that need the SAME rule now share ONE implementation rather
 * than agreeing by inspection (ADR-0015 L4 — one predicate, one site):
 *
 *   1. forEachFunctionUnit (visit)  — scope: THE WHOLE FILE, no boundary.
 *      Deliberately descends into nested functions: every named unit must be
 *      found, because each is analysed on its own. Different job, different
 *      rule, and that difference is correct.
 *   2. forEachOwnBodyNode           — scope: ONE EXECUTION UNIT. Descends
 *      through blocks / if / try / loops / switch; STOPS at nested function
 *      units. This is the only "this unit's body" rule in the file.
 *        ├─ collectUnitBindings uses it (which names are bound here)
 *        └─ bodyCallsFunction  uses it (which calls happen here)
 *      They cannot drift apart because there is nothing to keep in sync.
 *
 * If you add a third pass that reasons about a unit's body, route it through
 * forEachOwnBodyNode or state here why it needs a different rule.
 *
 * ── bodyCallsFunction — what resolves, and the boundary that does NOT ─────────
 * RESOLVES a CallExpression whose callee is:
 *   • a direct Identifier in the name set, NOT locally shadowed  requiredCall()
 *   • a property access ending in a name in the set              x.requiredCall()
 *   • a local alias bound EXACTLY ONCE in this unit by a `const` initialised to
 *     a name in the set: `const a = requiredCall` then `a()`     (codex (b))
 * REFUSED — these look like the required call and are NOT counted, so the guard
 * OVER-flags (loud false failure, the safe direction):
 *   • an alias whose name is bound more than once in the unit (a shadow — we
 *     cannot say which binding `a()` resolves to)
 *   • a `let`/`var` alias. `const` is not a style preference here: it makes
 *     reassignment a COMPILE error, so `let a = requiredCall; a = other; a()`
 *     is structurally impossible to satisfy the guard rather than being
 *     detected after the fact. Structure over policing.
 *   • a call to a target name that is itself locally bound — a parameter, const,
 *     function declaration, catch variable or destructured name shadowing
 *     `requiredCall` means the call may not be the imported one.
 *   • an alias spelling appearing as a PROPERTY (`unrelated.finish()`). A local
 *     binding says nothing about an object's property.
 *   • the function passed as a callback / argument and invoked elsewhere
 *   • destructured (`const { requiredCall } = mod`) or dynamically-accessed
 *     (`mod["requiredCall"]()`) references
 *
 * ⚠ ROUND 1 SHIPPED A DOC NOTE THAT WAS FALSE — do not restore it. It listed
 * reassignment under "does not resolve," implying safety. Reassignment did not
 * fail to resolve; it resolved WRONGLY and PASSED the guard. A comment asserting
 * an invariant the code does not hold is worse than no comment: it retires the
 * question. If you add a boundary here, prove which direction it errs with an
 * executed fixture, and pin it.
 *
 * ── PARAMETERS REQUIRE PARENT LINKS ──────────────────────────────────────────
 * A unit's parameters are not inside its body node, so they are reached via
 * bodyNode.parent. bodyCallsFunction THROWS if that link is missing rather than
 * proceeding blind — without it a parameter shadowing a target name is invisible
 * and the guard silently under-detects. Create SourceFiles with
 * setParentNodes = true (both shipped call sites do).
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

/**
 * THE scoping rule, in ONE place. Visits every node of `bodyNode`'s OWN
 * execution unit: descends through blocks / if / try / loops / switch (same
 * unit), stops at nested function units (different unit, analysed separately by
 * forEachFunctionUnit).
 *
 * Every pass that reasons about "this unit's body" MUST go through this, or two
 * passes end up applying two different answers to "where does this unit end" —
 * which is exactly the defect that shipped in v1 of this fix (the call scan
 * stopped at function boundaries; the alias pre-pass did not, so an alias
 * declared in a never-invoked nested function satisfied the outer unit).
 * Extracted rather than duplicated so the two CANNOT drift apart (ADR-0015 L4).
 */
function forEachOwnBodyNode(bodyNode, cb) {
  const walk = (node) => {
    cb(node);
    ts.forEachChild(node, (child) => {
      if (isFunctionNode(child)) return;
      walk(child);
    });
  };
  walk(bodyNode);
}

/**
 * Every name BOUND inside this unit (its own parameters + every declaration in
 * its own body), with a count, plus which of those bindings are `const <a> =
 * <target>` alias declarations.
 *
 * The count is what makes this binding-aware without a TypeChecker: a name bound
 * exactly once, by a `const` initialised to a target, provably refers to that
 * target at every position in the unit. Anything else — two bindings (a shadow),
 * a `let`/`var` (reassignable), a parameter — is ambiguous, and ambiguity must
 * resolve to NOT-a-call, which OVER-flags. That is the safe direction.
 */
function collectUnitBindings(bodyNode, names) {
  const total = new Map();
  const constToTarget = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);

  const addName = (nameNode) => {
    if (!nameNode) return;
    if (ts.isIdentifier(nameNode)) {
      bump(total, nameNode.text);
    } else if (ts.isObjectBindingPattern(nameNode) || ts.isArrayBindingPattern(nameNode)) {
      // `const { requiredCall } = mod` binds the name too — it must count as a
      // binding (so it shadows), even though it is not a resolvable alias.
      for (const el of nameNode.elements) if (ts.isBindingElement(el)) addName(el.name);
    }
  };

  // The unit's OWN parameters. They are not inside bodyNode, so they are reached
  // through the parent link — see the setParentNodes requirement in
  // bodyCallsFunction. A parameter named like a target shadows the import.
  const fnNode = bodyNode.parent;
  if (fnNode && isFunctionNode(fnNode) && fnNode.parameters) {
    for (const p of fnNode.parameters) addName(p.name);
  }

  forEachOwnBodyNode(bodyNode, (node) => {
    if (ts.isVariableDeclaration(node)) {
      addName(node.name);
      const list = node.parent;
      const isConst =
        list && ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
      if (
        isConst &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isIdentifier(node.initializer) &&
        names.has(node.initializer.text)
      ) {
        bump(constToTarget, node.name.text);
      }
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      addName(node.name);
    } else if (ts.isClassDeclaration(node) && node.name) {
      addName(node.name);
    } else if (ts.isCatchClause(node) && node.variableDeclaration) {
      addName(node.variableDeclaration.name);
    }
  });

  // An alias counts only if its name is bound EXACTLY ONCE in this unit and that
  // one binding is the const-to-target. A second binding of the same name is a
  // shadow, and we cannot say which one a call resolves to.
  const aliases = new Set();
  for (const [name, n] of constToTarget) if (n === 1 && total.get(name) === 1) aliases.add(name);

  // A TARGET name that is itself bound locally (parameter, const, function decl,
  // catch var, destructure) may resolve to the local, not the import — so a bare
  // call to it is no longer proof. Do not count it; over-flag instead.
  const shadowedTargets = new Set();
  for (const name of names) if ((total.get(name) ?? 0) > 0) shadowedTargets.add(name);

  return { aliases, shadowedTargets };
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
export function bodyCallsFunction(bodyNode, _sf, names) {
  // Parameters are reached via bodyNode.parent, so the SourceFile MUST have been
  // created with setParentNodes = true. Throwing is deliberate: without the
  // parent link a parameter shadowing a target name would be invisible and the
  // guard would silently UNDER-detect. A loud failure (the CLI catches this and
  // exits 2) beats a guard that quietly stops guarding.
  if (!bodyNode.parent) {
    throw new Error(
      "bodyCallsFunction: bodyNode has no parent — create the SourceFile with setParentNodes = true",
    );
  }
  const { aliases, shadowedTargets } = collectUnitBindings(bodyNode, names);

  let found = false;
  forEachOwnBodyNode(bodyNode, (node) => {
    if (found || !ts.isCallExpression(node)) return;
    const callee = node.expression;
    if (ts.isIdentifier(callee)) {
      // A bare identifier: the real name (unless locally shadowed) or a proven
      // single-binding const alias.
      const n = callee.text;
      if ((names.has(n) && !shadowedTargets.has(n)) || aliases.has(n)) found = true;
    } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
      // `x.requiredCall()`. Matched against the REAL names only — an alias is a
      // local binding and says nothing about an object's property, so applying
      // alias spellings here made an unrelated `unrelated.finish()` satisfy the
      // guard. A local binding cannot shadow a property either, so
      // shadowedTargets does not apply. Coarse (any receiver counts) and that is
      // the OVER-flag direction, which is safe.
      if (names.has(callee.name.text)) found = true;
    }
  });
  return found;
}
