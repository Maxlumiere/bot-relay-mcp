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
 * ── THE DISEASE, NAMED (read this before changing anything) ──────────────────
 * Three rounds of this guard failed audit, with seven distinct root causes
 * (A-G): regex-over-body-text, alias pollution across function boundaries,
 * surviving reassignment, alias-spelling-as-property, local/parameter shadows,
 * lexical-scope shadows, and a caller exemption keyed on a name. Every one is
 * the same disease:
 *
 *     THE GUARD IDENTIFIED A THING BY ITS SPELLING WHEN THE PROPERTY IT MUST
 *     ASSERT IS ABOUT A BINDING.
 *
 * Each round patched the spellings we thought of; each audit found the spellings
 * we did not. That does not converge, because the predicate cannot express the
 * property. So this version does not patch spellings. It shrinks the accepted
 * surface until SPELLING IS IDENTITY:
 *
 *     ACCEPT ONLY a bare identifier call that LEXICALLY RESOLVES to a top-level
 *     binding of a sanctioned name — plus a `const` alias that itself so
 *     resolves. REFUSE EVERYTHING ELSE, LOUDLY.
 *
 * "Everything else" includes every property receiver, every shadowed name, every
 * mutable binding, every ambiguous one. Those all OVER-flag: a loud false build
 * failure, never a silent hole.
 *
 * ── WHY NOT THE TYPESCRIPT CHECKER ───────────────────────────────────────────
 * Symbol resolution via ts.Program is the theoretically right answer and was
 * deliberately NOT taken (Victra's ruling): it pulls a full program + tsconfig
 * dependency into a standalone script and is a large change to a security guard
 * at the end of a long arc. The scope chain below is narrower in what it
 * ACCEPTS, which is the safe way to be less powerful.
 *
 * ── DIRECTION-OF-FAILURE (the rule that governs every claim in this file) ─────
 * For a MUST-CALL guard, UNDER-detection is the only dangerous direction: a
 * missing required call that the guard does not flag ships a real hole (a stale
 * auth cache = accepting a revoked token). OVER-detection only produces a loud
 * false build failure.
 *
 * ⚠ EVERY DIRECTION CLAIM IN THIS FILE MUST SIT NEXT TO THE FIXTURE THAT PROVES
 * IT (@fixture tags below). This is mechanical on purpose. Twice now a comment
 * in this file asserted a direction that was FALSE — round 1 said reassignment
 * "does not resolve" when it resolved wrongly and PASSED; round 2 said "any
 * receiver counts ... that is the OVER-flag direction" when accepting more
 * receivers means the guard PASSES more, i.e. UNDER-detects. Both were written
 * while moving fast, which is exactly when a remember-to-check rule fails. A
 * direction claim with no fixture beside it is the smell.
 *
 * ── GUARD TAXONOMY (the durable map — answers "could this defect be here?") ───
 *   • must-CALL — "a function that does X must CALL Y" (auth-gen-guard,
 *     secret-register-guard). Dangerous direction: UNDER-detection. THIS is the
 *     class the spelling-vs-binding disease attacks, and the only class these
 *     helpers serve.
 *   • must-NOT-CONTAIN — "this forbidden construct must not appear outside file
 *     Z" (cli-profile-guard, agent-class-guard, and the bash sanctioned_helper /
 *     ip_classifier / drift guards). CANNOT carry this defect: a comment matching
 *     the forbidden pattern only OVER-triggers. Its own hazard is a LEAKY
 *     forbidden-pattern matcher (case / whitespace / variant evasion).
 *   • must-MATCH — "two values must be equal" (lockfile_version_sync_guard).
 * A guard is defined by this ROLE, not by its file type: sanctioned_helper_guard
 * is bash inside pre-publish-check.sh, NOT a scripts/*.mjs — scoping a guard
 * census by file extension is how it gets missed. Enumerate by role, then
 * discover the artifacts, never the reverse.
 *
 * ── EVERY PASS THAT WALKS A BODY, AND ITS SCOPING RULE (keep this current) ────
 *   1. forEachFunctionUnit      — scope: THE WHOLE FILE, no boundary. Must find
 *      every named unit, because each is analysed on its own.
 *   2. forEachOwnBodyNode       — scope: ONE EXECUTION UNIT. Descends through
 *      blocks / if / try / loops; STOPS at nested function units. Used ONLY to
 *      find candidate CallExpressions.
 *   3. scopeBindings/resolve    — scope: THE LEXICAL CHAIN from a call site up to
 *      the SourceFile. Bindings are collected per scope WITHOUT descending into
 *      nested scopes, with `var`/function-declaration hoisting to the nearest
 *      function scope. This is the only pass that answers "what does this name
 *      refer to," and it is deliberately separate from (2): (2) asks WHERE a call
 *      is, (3) asks WHAT it calls.
 * A future pass that reasons about a unit's body routes through (2), or states
 * here why it needs a different rule.
 *
 * ── NODE COVERAGE (forEachFunctionUnit) — enumerated, with the gaps NAMED ─────
 * COVERS: function declarations; arrow / function-expression bound to a name;
 * class methods; class-field arrow / fn-expression; get/set accessors;
 * constructors (reported as "constructor"); object-literal function properties.
 * DOES NOT COVER (stated, not implied-total):
 *   • anonymous functions with no stable name (IIFEs, inline callbacks) — there
 *     is nothing to name in a violation. A must-call mutator is expected to be a
 *     named unit.
 *   • ACCEPTED RISK, honestly labelled (NOT "safe"): REACHABILITY within a unit
 *     is not verified. A call in `if (false)` still counts, so the guard proves
 *     the call is PRESENT, not that it runs on every path. Runtime-path coverage
 *     is the behavioural tests' job.
 *     @fixture "ACCEPTED RISK ... an if(false) bump still passes"
 */
import ts from "typescript";

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
 * Invoke cb(name, bodyNode, nameNode) for every NAMED function unit in the
 * source file. See "NODE COVERAGE" above for exactly what is and is not visited.
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

/**
 * Is this unit a TOP-LEVEL function declaration with this name?
 *
 * ROOT G: auth-gen-guard exempted any unit whose NAME matched a sanctioned
 * primitive, so a class-field mutator spelled `bumpAuthGeneration` doing the
 * harmful UPDATE was exempt wholesale. An exemption for "the primitive itself"
 * must mean the actual top-level declaration, not anything sharing its spelling.
 * @fixture "ROOT G: a class field spelled like the primitive is ANALYSED, not exempt"
 */
export function isTopLevelFunctionDeclaration(nameNode) {
  const decl = nameNode?.parent;
  if (!decl || !ts.isFunctionDeclaration(decl)) return false;
  return !!decl.parent && ts.isSourceFile(decl.parent);
}

/**
 * THE execution-unit scoping rule, in ONE place. Visits every node of
 * `bodyNode`'s own execution unit: descends through blocks / if / try / loops /
 * switch; STOPS at nested function units (a different unit, analysed separately).
 *
 * Used ONLY to locate candidate CallExpressions. It deliberately does NOT decide
 * what a name refers to — that is the scope chain's job. Round 2 conflated the
 * two and the binding pass inherited this walker's function-skipping, which made
 * its own FunctionDeclaration branch unreachable (codex root F1).
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

/** Nodes that introduce a lexical scope. */
function isScopeNode(n) {
  return (
    ts.isSourceFile(n) ||
    isFunctionNode(n) ||
    ts.isBlock(n) ||
    ts.isModuleBlock(n) ||
    ts.isCaseBlock(n) ||
    ts.isForStatement(n) ||
    ts.isForInStatement(n) ||
    ts.isForOfStatement(n) ||
    ts.isCatchClause(n) ||
    ts.isClassDeclaration(n) ||
    ts.isClassExpression(n)
  );
}

/** Every identifier bound by a binding name (identifier or destructuring pattern). */
function eachBoundName(nameNode, add) {
  if (!nameNode) return;
  if (ts.isIdentifier(nameNode)) {
    add(nameNode.text, nameNode.parent);
  } else if (ts.isObjectBindingPattern(nameNode) || ts.isArrayBindingPattern(nameNode)) {
    for (const el of nameNode.elements) if (ts.isBindingElement(el)) eachBoundName(el.name, add);
  }
}

/**
 * Names bound DIRECTLY in `scope`, as Map<name, declNode[]>.
 *
 * Collected without descending into nested scopes, with two corrections that
 * matter for correctness rather than taste:
 *   • `var` and function declarations HOIST to the nearest function/source
 *     scope, so a function scope also absorbs them from nested blocks. Missing
 *     that would leave a `var` shadow invisible → UNDER-detection.
 *     @fixture "ROOT F1: a nested function declaration shadowing the primitive"
 *   • a named FUNCTION EXPRESSION binds its OWN name inside itself, so
 *     `const rotate = function bumpAuthGeneration(){ ... bumpAuthGeneration() }`
 *     is recursion, not the primitive.
 *     @fixture "ROOT F4: a named function expression's own binding is recursion"
 */
function scopeBindings(scope) {
  const map = new Map();
  const add = (name, decl) => {
    const arr = map.get(name);
    if (arr) arr.push(decl);
    else map.set(name, [decl]);
  };

  if (isFunctionNode(scope)) {
    for (const p of scope.parameters ?? []) eachBoundName(p.name, add);
    if (ts.isFunctionExpression(scope) && scope.name) add(scope.name.text, scope);
  }
  if (ts.isCatchClause(scope) && scope.variableDeclaration) {
    eachBoundName(scope.variableDeclaration.name, add);
  }
  if ((ts.isClassDeclaration(scope) || ts.isClassExpression(scope)) && scope.name) {
    add(scope.name.text, scope);
  }

  const isFnScope = isFunctionNode(scope) || ts.isSourceFile(scope);
  const walk = (node, depth) => {
    ts.forEachChild(node, (child) => {
      const nested = isScopeNode(child);
      // Block-scoped declarations only count at depth 0 (this scope itself).
      if (ts.isVariableDeclaration(child)) {
        const list = child.parent;
        const isVar =
          list && ts.isVariableDeclarationList(list) && (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0;
        if (depth === 0 || (isVar && isFnScope)) eachBoundName(child.name, add);
      } else if (ts.isFunctionDeclaration(child) && child.name) {
        if (depth === 0 || isFnScope) add(child.name.text, child);
      } else if (ts.isClassDeclaration(child) && child.name && depth === 0) {
        add(child.name.text, child);
      } else if (ts.isImportSpecifier(child) || ts.isImportClause(child) || ts.isNamespaceImport(child)) {
        if (child.name) add(child.name.text, child);
      }
      // Do not descend into a nested FUNCTION at all — its interior is a
      // different unit. Other nested scopes are descended only to pick up
      // hoisted var/function declarations for a function scope.
      if (isFunctionNode(child)) return;
      walk(child, nested ? depth + 1 : depth);
    });
  };
  walk(scope, 0);
  return map;
}

/**
 * Resolve `name` as seen from `fromNode`. Returns:
 *   { kind: "top" }                — resolves to a direct top-level binding, or
 *                                    is free (an import/global). Spelling IS
 *                                    identity here, and only here.
 *   { kind: "local", decls: [...] } — bound by a nearer scope; NOT the primitive
 *                                    unless it is a proven const alias.
 */
function resolveName(name, fromNode) {
  for (let n = fromNode; n; n = n.parent) {
    if (!isScopeNode(n)) continue;
    const decls = scopeBindings(n).get(name);
    if (!decls) continue;
    if (ts.isSourceFile(n)) {
      // A binding found at SourceFile scope is only "top level" if it is a
      // direct top-level declaration. scopeBindings hoists var/function decls
      // out of nested blocks, so verify the declaration is not nested.
      // @fixture "ROOT F2: a block-enclosed shadow around the unit"
      const anyNested = decls.some((d) => {
        for (let p = d; p; p = p.parent) {
          if (ts.isSourceFile(p)) return false;
          if (ts.isBlock(p) || ts.isModuleBlock(p) || ts.isCaseBlock(p)) return true;
        }
        return false;
      });
      return anyNested ? { kind: "local", decls } : { kind: "top", decls };
    }
    return { kind: "local", decls };
  }
  return { kind: "top", decls: [] };
}

/** Is this declaration `const <id> = <identifier>`? Returns the initializer or null. */
function constAliasInitializer(decl) {
  if (!decl || !ts.isVariableDeclaration(decl)) return null;
  const list = decl.parent;
  if (!list || !ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return null;
  if (!ts.isIdentifier(decl.name) || !decl.initializer || !ts.isIdentifier(decl.initializer)) return null;
  return decl.initializer;
}

/**
 * Structurally decide whether `bodyNode`'s OWN execution unit contains a call
 * that provably reaches one of `names`.
 *
 * ACCEPTS exactly two shapes:
 *   1. `requiredCall()` — a bare identifier resolving to a TOP-LEVEL binding of
 *      a sanctioned name (i.e. not shadowed anywhere between here and the file).
 *   2. `a()` where `a` is bound EXACTLY ONCE, by a `const`, to an identifier that
 *      itself resolves top-level into `names` at the alias's own position.
 *      `const` makes reassignment a COMPILE error, so a mutated alias is
 *      structurally impossible rather than policed.
 *      @fixture "TWIN: an honest single-binding const alias is still resolved"
 *
 * REFUSES everything else — each OVER-flags (loud false failure, never a hole):
 *   • ANY property-access or element-access receiver, including `this.x()` and
 *     `db.x()`. The sanctioned primitives are TOP-LEVEL FUNCTIONS in this
 *     codebase (verified: both are `export function`, all 18 call sites are bare
 *     identifiers, zero property-style calls), so no receiver form is an innocent
 *     twin. Accepting arbitrary receivers was root E — and note the DIRECTION:
 *     accepting more receivers makes the guard PASS more, which is
 *     UNDER-detection, not the "over-flag" round 2's comment claimed.
 *     @fixture "ROOT E: an unrelated receiver spelled like the primitive"
 *   • a shadowed name — parameter, local const/let/var, nested function
 *     declaration, catch variable, destructured binding, enclosing block.
 *     @fixture "ROOT F: lexical shadows"
 *   • an ambiguous name — bound more than once in its scope, so no single
 *     declaration can be proven.
 *     @fixture "ROOT F3: a block-local alias does not escape its block"
 *   • a `let`/`var` alias, a destructured alias, a dynamically-accessed name.
 *
 * @param {ts.Node} bodyNode  the function body to scan
 * @param {ts.SourceFile} _sf  (kept for signature symmetry)
 * @param {Set<string>} names  callee names that count as "the required call"
 */
export function bodyCallsFunction(bodyNode, _sf, names) {
  // Resolution walks parent links. Throwing is deliberate: without them every
  // shadow is invisible and the guard would silently UNDER-detect. The CLI
  // catches this and exits non-zero.
  // @fixture "LOUD-FAILURE CONTRACT: throws without parent links"
  if (!bodyNode.parent) {
    throw new Error(
      "bodyCallsFunction: bodyNode has no parent — create the SourceFile with setParentNodes = true",
    );
  }

  /** Does bare identifier `name`, used at `site`, provably reach a sanctioned name? */
  const reaches = (name, site, allowAlias) => {
    const r = resolveName(name, site);
    if (r.kind === "top") return names.has(name);
    if (!allowAlias) return false;
    // Exactly one declaration, or we cannot say which binding wins.
    if (r.decls.length !== 1) return false;
    const init = constAliasInitializer(r.decls[0]);
    if (!init) return false;
    // The alias target must itself resolve top-level, from the alias's position.
    return reaches(init.text, init, false);
  };

  let found = false;
  forEachOwnBodyNode(bodyNode, (node) => {
    if (found || !ts.isCallExpression(node)) return;
    const callee = node.expression;
    if (ts.isIdentifier(callee) && reaches(callee.text, callee, true)) found = true;
  });
  return found;
}
