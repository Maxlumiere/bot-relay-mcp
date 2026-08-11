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
 * we did not. Round 3 tried "accept any top-level binding of the name" and lost
 * six more ways at the MODULE boundary — direct/default/equals imports, ambient
 * declares, `using` bindings, and unresolved free names all counted.
 *
 * ── THE TERMINAL BAR (do not widen this; widening is how every round started) ─
 *
 *     ACCEPT ONLY a bare identifier call that resolves to a VERIFIED TOP-LEVEL
 *     FUNCTION DECLARATION WITH A BODY whose name is sanctioned — in the file
 *     under analysis, OR one hop away through a direct relative NAMED import
 *     whose imported name is sanctioned and whose target file declares it that
 *     way — plus a `const` alias, declared before the call, that itself so
 *     resolves. REJECT EVERYTHING ELSE.
 *
 * Rejected wholesale: renamed / default / namespace / `import =` bindings, bare
 * package specifiers, unresolvable paths, re-export and barrel chains, every
 * ambient declaration, every variable / class / enum / `using` binding, every
 * property or element receiver, every shadowed or ambiguous name, and every
 * unresolved free name.
 *
 * This is why it is TERMINAL rather than one more patch. Every earlier round
 * accepted a CATEGORY and then discovered which members of the category nobody
 * had thought of. This accepts ONE declaration node. There is nothing left to
 * enumerate, because the answer to "what about form X?" is now always REJECTED.
 * Everything rejected OVER-flags: a loud false build failure, never a hole.
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
 * ⚠ TWO MECHANICAL RULES, because four direction claims in this file have now
 * been wrong and none of them was carelessness — they were a sentence pattern:
 *   1. EVERY DIRECTION CLAIM SITS NEXT TO THE FIXTURE THAT PROVES IT (@fixture
 *      tags below). A direction claim with no fixture beside it is the smell.
 *   2. A DIRECTION CLAIM MUST NAME **WHICH DIRECTION, FOR WHICH CASE**.
 *      "Conservative", "safe", "coarse" are not directions — they hide a
 *      quantifier. Every one of the four had the same shape: a property true in
 *      ONE direction, stated as if true generally.
 * The four, for the record: round 1 said reassignment "does not resolve" when it
 * resolved wrongly and PASSED. Round 2 said "any receiver counts ... the
 * OVER-flag direction" when accepting more receivers makes the guard PASS more,
 * i.e. UNDER-detect. Round 2 said the trigger side "over-triggers on a comment,
 * the SAFE direction" — true, and half the story, since it also under-detects
 * when the SQL is not textually present. Round 3 documented ignoring TDZ as
 * "conservative" — true for the shadow direction, false for the alias direction,
 * where position-blindness errs toward ACCEPT.
 *
 * ── ⚠ BOTH SIDES OF THIS PREDICATE MUST BE EQUALLY STRONG ────────────────────
 * This guard is TWO-SIDED: "does this unit mutate?" THEN "then it must bump."
 * The must-bump side is now resolved to a single declaration node. The
 * does-it-mutate side (hasValidityChangingMutation, in auth-gen-guard.mjs) is
 * still a TEXT match. **A two-sided predicate is only as strong as its weaker
 * side: if the trigger never fires, no bump is ever demanded and everything
 * below never runs.** Hardening one side MOVES the guard's real strength to the
 * other — it does not raise it. The trigger side is now ALSO binding-resolved:
 * resolveUnitSqlText (below) follows a mutator's identifiers through module-scope
 * CONST bindings — aliases, objects, arrays, transitively — using this same
 * resolver, and findSqlBackedSoftBindings makes a let/var-backed SQL binding a
 * loud refusal rather than a silent miss (#57 / #192). SQL still reaches the
 * trigger only as a literal in this file: string CONCATENATION and CROSS-MODULE
 * imports remain out of scope by design (concatenation is not routine-accidental;
 * cross-module identity needs a TypeChecker — the same boundary as the call side).
 *
 * ── ⚠ WHAT DOES THIS RESOLVER TREAT AS OUTSIDE ITS WORLD? ────────────────────
 * Standing question for the next person, because this is how round 3 failed:
 * WHEN YOU REPLACE A PROXY WITH A RESOLVER, THE RESOLVER'S FRAME BECOMES THE NEW
 * PROXY. Round 3 correctly replaced spelling-matching with lexical resolution,
 * then scoped the resolver to lexical scopes INSIDE the file — and every
 * `import { x as y }` is a re-binding, so the module boundary is exactly where
 * spelling and identity come apart hardest. The reasoning inside the frame was
 * sound; the frame was drawn too small.
 *
 * ── ⚠ THIS BOUNDARY WAS REWRITTEN IN #145. READ WHY. ────────────────────────
 * It previously said: *"this helper handles SAME-FILE primitives only. A guard
 * whose primitive is IMPORTED cannot use it … Do not build toward it by widening
 * the bar."* That sentence is SUPERSEDED, and it is replaced rather than quietly
 * contradicted, because inheriting a stale map is how the next person gets hurt.
 *
 * WHAT WAS ACTUALLY WRONG WITH IT: "same file" was never the requirement. **A
 * VERIFIED TOP-LEVEL FUNCTION DECLARATION** was. The helper simply could not see
 * past the file boundary, and the boundary note described that limitation as if
 * it were the rule.
 *
 * #145 proved it mattered: `registerPersistedSecret` and `generateToken` are
 * IMPORTED into src/db.ts (declared in src/secret-registry.ts and src/auth.ts).
 * Measured against the real file, the same-file-only bar recognised **0 of 5**
 * legitimate call sites and would have failed every build.
 *
 * THE NEW BOUNDARY — direct relative NAMED imports, one hop, verified:
 *   HANDLES: `import { primitive } from "./sibling.js"` where the IMPORTED name
 *     is sanctioned AND that file declares it as a top-level function with a
 *     body. Identity is settled by the declaration node, never by the specifier
 *     string — the specifier is demoted to a path lookup.
 *   REFUSES (all OVER-flag): renamed imports (`{ other as primitive }`), default,
 *     namespace and `import =` bindings, bare package specifiers, unresolvable
 *     paths, re-export chains and barrel files (ONE hop only — not chased),
 *     dynamic imports.
 * The PREDICATE is unchanged; only its REACH grew. If the real import graph ever
 * stops being direct relative specifiers to sibling files, this is the point
 * where a TypeChecker wins — measure it rather than assuming it stays simple.
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
import { ts } from "./guard-parse.mjs";
import fs from "fs";
import path from "path";

/**
 * RESOLVE-AND-VERIFY (Victra ruling, #145) — parse cache for one-hop import
 * resolution. Keyed by absolute path; each imported module is read and parsed at
 * most once per process.
 */
const _moduleCache = new Map();

/**
 * Resolve a RELATIVE module specifier to a real source file on disk.
 *
 * Returns null — meaning REFUSE — for anything not a direct relative path to an
 * existing file: bare package specifiers, unresolvable paths, and (by omission)
 * anything needing node_modules resolution. Refusing is the OVER-flag direction.
 * @fixture "TERMINAL BAR: a bare package import is refused"
 */
function resolveRelativeModule(specifier, fromFileName) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  if (!fromFileName || !path.isAbsolute(fromFileName)) return null;
  const base = path.resolve(path.dirname(fromFileName), specifier);
  // TS ESM writes `./x.js` for `./x.ts`. Try the TS source first, then literal.
  const candidates = base.endsWith(".js")
    ? [base.slice(0, -3) + ".ts", base.slice(0, -3) + ".tsx", base]
    : [base + ".ts", base + ".tsx", base, path.join(base, "index.ts")];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch {
      /* unreadable → refuse */
    }
  }
  return null;
}

/** Parse a resolved module once, with parents (the scope chain needs them). */
function parseModule(absPath) {
  const hit = _moduleCache.get(absPath);
  if (hit !== undefined) return hit;
  let parsed = null;
  try {
    parsed = ts.createSourceFile(
      absPath,
      fs.readFileSync(absPath, "utf-8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    // Pinned-parser gate for the one-hop import TARGET. createSourceFile is
    // error-tolerant (returns a partial tree, does not throw), so a target using
    // syntax newer than the pin would parse partially and could make a primitive
    // falsely resolve/not-resolve. A partial parse cannot be trusted → refuse
    // (return null). Unlike a SCANNED file this does not hard-fail: a call that
    // fails to resolve here already makes the guard OVER-flag (loud red), the
    // safe direction. The scanned file itself is gated in each guard's main via
    // parseGuardSource, which throws.
    if (parsed && (parsed.parseDiagnostics?.length ?? 0) > 0) parsed = null;
  } catch {
    parsed = null; // unreadable → refuse
  }
  _moduleCache.set(absPath, parsed);
  return parsed;
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
const _scopeBindingsCache = new WeakMap();
function scopeBindings(scope) {
  const cached = _scopeBindingsCache.get(scope);
  if (cached) return cached;
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
      } else if (ts.isEnumDeclaration(child) && child.name && depth === 0) {
        add(child.name.text, child);
      } else if (
        ts.isImportSpecifier(child) ||
        ts.isImportClause(child) ||
        ts.isNamespaceImport(child) ||
        ts.isImportEqualsDeclaration(child)
      ) {
        // Collected by their LOCAL name, and then rejected as a binding kind.
        // Note the local name is deliberately NOT trusted as identity: `import
        // { other as bumpAuthGeneration }` re-binds the spelling, which is why
        // the module boundary is where spelling and identity come apart hardest.
        // Under the terminal bar none of these can satisfy the guard anyway —
        // collecting them is for a precise refusal, not for safety.
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
  _scopeBindingsCache.set(scope, map);
  return map;
}

/**
 * Resolve `name` as seen from `fromNode` to the declaration(s) that bind it:
 * the binding list of the NEAREST enclosing scope that binds it, or [] if
 * nothing in this file binds it (a free / global / unresolved name).
 *
 * It deliberately does NOT classify the result. Round 3 returned a KIND
 * ("top" vs "local") and then trusted "top" — which accepted every module-scope
 * binding by SPELLING: direct imports, default imports, import-equals, ambient
 * declares, `using` bindings, classes, and unresolved names alike. Returning raw
 * declarations, and making the caller demand one specific declaration NODE, is
 * what turns this from allow-a-category into default-deny.
 */
function resolveName(name, fromNode) {
  for (let n = fromNode; n; n = n.parent) {
    if (!isScopeNode(n)) continue;
    const decls = scopeBindings(n).get(name);
    if (decls) return decls;
  }
  return [];
}

/**
 * IS this declaration node the actual sanctioned primitive — a direct top-level
 * function declaration WITH A BODY whose name is sanctioned?
 *
 * This is the terminal bar. Every other binding kind is rejected wholesale, so
 * there is no category left to enumerate: the answer to "what about form X?" is
 * always "rejected." `d.body` is required so an AMBIENT `declare function
 * bumpAuthGeneration(): void` — which declares nothing and runs nothing — cannot
 * satisfy it.
 * @fixture "TERMINAL BAR: every non-function-declaration binding kind is refused"
 */
function isPrimitiveDeclaration(decl, names) {
  return (
    !!decl &&
    ts.isFunctionDeclaration(decl) &&
    !!decl.body &&
    !!decl.name &&
    names.has(decl.name.text) &&
    !!decl.parent &&
    ts.isSourceFile(decl.parent)
  );
}

/**
 * RESOLVE-AND-VERIFY: is this binding a NAMED IMPORT that genuinely resolves to
 * the sanctioned primitive one file over?
 *
 * ── WHY THIS IS NOT A WIDENING OF THE BAR ────────────────────────────────────
 * The tempting version accepts on "module specifier string + imported name."
 * That makes an IDENTITY CLAIM REST ON A STRING — the same class of defect this
 * whole arc has been deleting. This instead DEMOTES the specifier to a path
 * lookup and settles identity by verifying the actual declaration node in the
 * resolved file, using the IDENTICAL predicate (`isPrimitiveDeclaration`).
 * The predicate is unchanged; only its REACH grows, by exactly one hop, with a
 * verification at the end of it.
 *
 * REQUIRES ALL THREE:
 *   1. the IMPORTED name (`propertyName ?? name`) is sanctioned — so
 *      `import { other as registerPersistedSecret }` is REFUSED, because the
 *      local spelling is precisely not the imported thing.
 *      @fixture "RESOLVE-AND-VERIFY: a renamed import is refused"
 *   2. the specifier resolves to a real source file (relative paths only)
 *   3. in THAT file the imported name is a top-level function declaration with
 *      a body.
 *
 * REFUSES, all OVER-flagging (loud false failure, never a hole): default,
 * namespace and `import =` bindings; bare package specifiers; unresolvable
 * paths; re-export chains and barrel files (NOT followed — one hop only);
 * dynamic imports.
 * @fixture "RESOLVE-AND-VERIFY: a re-export chain is refused (one hop only)"
 */
function importResolvesToPrimitive(decl, names, fromFileName) {
  // ONLY a named ImportSpecifier. ImportClause (default), NamespaceImport and
  // ImportEqualsDeclaration all fall through to refusal.
  if (!decl || !ts.isImportSpecifier(decl)) return false;
  const importedName = (decl.propertyName ?? decl.name)?.text;
  if (!importedName || !names.has(importedName)) return false;

  const decl_ = decl.parent?.parent?.parent; // ImportSpecifier→NamedImports→ImportClause→ImportDeclaration
  const spec = decl_ && ts.isImportDeclaration(decl_) ? decl_.moduleSpecifier : undefined;
  if (!spec || !ts.isStringLiteral(spec)) return false;

  const abs = resolveRelativeModule(spec.text, fromFileName);
  if (!abs) return false;
  const mod = parseModule(abs);
  if (!mod) return false;

  // The SAME predicate, one file over. A re-export (`export { x } from "./y"`)
  // is not a FunctionDeclaration, so a barrel refuses here rather than being
  // chased — one hop, verified, or nothing.
  for (const st of mod.statements) {
    if (
      ts.isFunctionDeclaration(st) &&
      st.body &&
      st.name &&
      st.name.text === importedName &&
      names.has(st.name.text)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * THE PREMISE this helper rests on: each sanctioned name must actually BE a
 * top-level function declaration in the file under analysis. Returns the names
 * that are NOT.
 *
 * Enforcing it is the difference between an argument and a complete artifact.
 * If someone converts `export function bumpAuthGeneration()` into
 * `const bumpAuthGeneration = () => …`, this helper stops resolving ANY call to
 * it — the guard would still fail loudly, but as a confusing wall of violations
 * rather than a statement of what actually changed. The caller uses this to say
 * so precisely. Today it is a no-op: both primitives are `export function`.
 * @fixture "PREMISE: a primitive converted to a const arrow is reported by name"
 */
/**
 * PREMISE for a guard whose primitives are IMPORTED (#145): does each sanctioned
 * name RESOLVE, from this file, to a verified top-level function declaration —
 * same-file OR one hop through a direct relative named import? Returns those
 * that do not.
 *
 * Same job as findUnsatisfiedPrimitives, one environment over. Without it, a
 * primitive that stops resolving (moved to a barrel, re-exported, renamed at the
 * import site) makes EVERY minter read as unregistered — the guard would still
 * fail loudly, but as an avalanche that reads like the codebase broke rather
 * than like the guard's premise did. This says which.
 * @fixture "PREMISE: an unresolvable primitive is reported by name"
 */
export function findUnresolvablePrimitives(sf, names) {
  const missing = [];
  for (const name of names) {
    let ok = false;
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.body && st.name && st.name.text === name) ok = true;
    }
    if (!ok) {
      // Look for a named import of it and verify one hop.
      for (const st of sf.statements) {
        if (!ts.isImportDeclaration(st)) continue;
        const named = st.importClause?.namedBindings;
        if (!named || !ts.isNamedImports(named)) continue;
        for (const el of named.elements) {
          if (el.name.text !== name) continue;
          if (importResolvesToPrimitive(el, new Set([name]), sf.fileName)) ok = true;
        }
      }
    }
    if (!ok) missing.push(name);
  }
  return missing;
}

export function findUnsatisfiedPrimitives(sf, names) {
  const missing = [];
  for (const name of names) {
    let ok = false;
    for (const st of sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.body && st.name && st.name.text === name) ok = true;
    }
    if (!ok) missing.push(name);
  }
  return missing;
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
 * @param {ts.SourceFile} sf   the parsed file — its `fileName` MUST be a real
 *   absolute path for one-hop import resolution to work; when it is not, imports
 *   simply refuse (over-flag).
 * @param {Set<string>} names  callee names that count as "the required call"
 */
export function bodyCallsFunction(bodyNode, sf, names) {
  // Resolution walks parent links. Throwing is deliberate: without them every
  // shadow is invisible and the guard would silently UNDER-detect. The CLI
  // catches this and exits non-zero.
  // @fixture "LOUD-FAILURE CONTRACT: throws without parent links"
  if (!bodyNode.parent) {
    throw new Error(
      "bodyCallsFunction: bodyNode has no parent — create the SourceFile with setParentNodes = true",
    );
  }

  /**
   * Does bare identifier `name`, used at `site`, provably reach THE primitive?
   * Default-deny: everything that is not the one accepted declaration node, or a
   * `const` alias of it, returns false and therefore OVER-flags.
   */
  const reaches = (name, site, allowAlias) => {
    const decls = resolveName(name, site);
    // Unresolved / free names are REFUSED. Round 3 accepted them by spelling,
    // which is how `import x = require(...)` slipped through: the binding was
    // never collected, so the name looked free, so it was trusted.
    // @fixture "TERMINAL BAR: an unresolved free name is refused"
    if (decls.length !== 1) return false;
    if (isPrimitiveDeclaration(decls[0], names)) return true;
    // One hop, verified — see importResolvesToPrimitive. `_sf.fileName` must be a
    // real absolute path for this to resolve; when it is not (unit fixtures), it
    // simply refuses, which is the over-flag direction.
    if (importResolvesToPrimitive(decls[0], names, sf?.fileName)) return true;
    if (!allowAlias) return false;
    const init = constAliasInitializer(decls[0]);
    if (!init) return false;
    // The alias must be declared BEFORE the call. A `const` used above its
    // declaration is a TDZ ReferenceError — the mutation commits and then the
    // call throws, leaving exactly the stale cache this guard exists to prevent.
    // The terminal bar does NOT close this one: position is orthogonal to
    // declaration kind, so an alias-before-declaration is still a well-formed
    // `const <a> = <primitive>`. Refusing it OVER-flags in the one odd-but-legal
    // case (an alias declared later in an ENCLOSING scope, hoisted-and-called
    // later at runtime), which is the safe direction.
    // @fixture "SELF-FOUND fx3: an alias used before its declaration is refused"
    if (decls[0].getStart() > site.getStart()) return false;
    // The alias target must itself reach the primitive, from the alias's own
    // position. Chained aliases (a -> b -> primitive) are refused: over-flag.
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

// ─────────────────────────────────────────────────────────────────────────────
// TRIGGER-SIDE BINDING RESOLUTION (#57 / #192) — the DOES-IT-MUTATE half.
//
// The must-CALL half above resolves a bare callee to ONE declaration node. The
// does-it-mutate half has the mirror-image job: decide whether a unit's body
// reaches validity SQL, INCLUDING SQL hoisted to a module-scope binding. It is
// built on the SAME resolver (resolveName) for the SAME reason — the property is
// about a BINDING, not a spelling. A name that resolves to a local const, a
// parameter, an import, or a nested-function binding is NOT the module constant,
// so a mutator whose `REVOKE_SQL` is a parameter is correctly NOT attributed the
// module SQL (#192 ruling 2 — the S1/S2 shadow bar). Resolving by NAME instead
// would be ROOT G again, one costume over.
//
// DIRECTION-OF-FAILURE, per case (mechanical rule 2 — name the direction):
//   • const chain / object / array → resolved to the terminal literal text and
//     spliced. Coarser than property-precise: a WHOLE object/array initializer is
//     spliced, not just the member used. That OVER-includes — the SAFE direction
//     for a must-CALL trigger — and the per-unit must-bump check still attributes
//     correctly (a sibling that bumps is clean, the one that does not is flagged).
//     @fixture "object-property and array-element constants are resolved"
//     @fixture "property resolution must not over-flag (... attribution)"
//   • let / var → NOT resolved. Its initializer does not establish what the use
//     site reads (it can be reassigned), so reading it UNDER-detects in the
//     dangerous direction (benign initializer, revoke reassignment). Surfaced for
//     the caller to REFUSE loudly (fail-closed, exit 2), never read as a value.
//     @fixture "an unresolvable binding is REFUSED, and the refusal is actionable"
//   • local / param / import / fn / class binding → resolves to a NON-module
//     decl and contributes nothing: the shadow is respected structurally.
//     @fixture "a SHADOWED name must not be attributed to the module constant"
// ─────────────────────────────────────────────────────────────────────────────
//
// ── RESOLVER COVERAGE — STATED, not discovered (victra, #192 round 3) ─────────
// Six review rounds each found a binding form the resolver did not handle, so the
// boundary is written down here rather than rediscovered. Two facts, both MEASURED
// (see the destructuring + call-side fixtures), not assumed:
//
// 1. resolveName (via scopeBindings/eachBoundName) REGISTERS a broad set — it
//    returns the declaration NODE for: a simple `const/let/var X`; EVERY
//    destructuring form — object `{a}`, renamed `{a:b}`, array `[a]`, nested,
//    rest `{...r}`/`[...r]`, and defaults `{a = …}` (the leaf is a BindingElement);
//    destructured parameters; function/class/enum declarations; imports (by LOCAL
//    name); catch variables; a named function-expression's own name. It returns
//    [] for a free/global/unbound name and MORE THAN ONE decl for an ambiguous
//    (re-bound) name. So destructuring was never invisible to resolveName — the
//    round-2/round-3 gaps were in the CONSUMERS, which did not handle the
//    BindingElement node it returns.
//
// 2. Meaning is the CONSUMER's, and each consumer's DEFAULT DIRECTION is what makes
//    the same resolver safe on one side and dangerous on the other:
//    • must-CALL (bodyCallsFunction → isPrimitiveDeclaration / constAliasInitializer):
//      accepts ONLY a top-level FunctionDeclaration, or a simple `const <id> =
//      <primitive>` alias. EVERYTHING else — including a destructured bump alias
//      `const { bumpAuthGeneration: bump } = m` — is REJECTED, which OVER-flags.
//      Unhandled ⇒ over-flag ⇒ SAFE. @fixture "call side over-flags a destructured
//      bump alias (safe direction)".
//    • does-it-mutate (resolveUnitSqlText → moduleBindingInfo): accepts a module
//      VariableDeclaration AND a module BindingElement (all destructuring forms +
//      defaults); const ⇒ splice (transitive), let/var ⇒ refuse. Here an UNSEEN
//      binding is simply not spliced ⇒ the SQL is not there ⇒ UNDER-detect ⇒
//      DANGEROUS, which is why this side must accept broadly and errs toward
//      over-splicing whole objects/arrays.
//    OUT of scope on BOTH sides, by design: string CONCATENATION (not accidental
//    drift) and CROSS-MODULE imported identity (needs a TypeChecker). Named
//    boundaries, not gaps.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * For a RESOLVED module-scope binding — a plain `const/let X = …` VariableDeclaration
 * OR a destructuring BindingElement (`const { revoke: X } = Q`, `const [Y] = LIST`)
 * — return { kind: "const"|"soft", initNode } or null if it is not module-scope.
 *
 * A destructured name (#192 re-review, codex) is an ordinary property/array alias,
 * so it is IN scope. Consistent with the coarse whole-initializer splice for a
 * const object/array, the thing spliced for a BindingElement is the ENCLOSING
 * declaration's initializer (the whole `Q` / `LIST`), which resolveConstText then
 * follows to the literal — property-precise pick is deliberately not attempted
 * (OVER-includes = the safe direction). The kind comes from the enclosing
 * VariableDeclarationList, so a destructured `let` is still `soft` (refused).
 */
function moduleBindingInfo(decl) {
  let varDecl = null;
  if (ts.isVariableDeclaration(decl)) {
    varDecl = decl;
  } else if (ts.isBindingElement(decl)) {
    let n = decl.parent;
    while (n && !ts.isVariableDeclaration(n)) n = n.parent; // up through (possibly nested) binding patterns
    varDecl = n && ts.isVariableDeclaration(n) ? n : null;
  }
  if (!varDecl) return null;
  const list = varDecl.parent; // VariableDeclarationList
  if (!list || !ts.isVariableDeclarationList(list)) return null;
  const stmt = list.parent; // VariableStatement
  if (!stmt || !ts.isVariableStatement(stmt)) return null;
  if (!stmt.parent || !ts.isSourceFile(stmt.parent)) return null; // MODULE scope only
  return { kind: (list.flags & ts.NodeFlags.Const) !== 0 ? "const" : "soft", initNode: varDecl.initializer ?? null };
}

/**
 * Invoke `cb(boundDecl)` for each name a top-level VariableDeclaration binds: the
 * VariableDeclaration itself for a simple `X`, or each leaf BindingElement for a
 * destructuring pattern (including aliases `{ a: X }` and nested patterns). This
 * is the SAME set resolveName resolves a destructured use to, so the refusal side
 * and the resolve side agree on what a module binding is.
 */
function eachModuleBoundDecl(decl, cb) {
  if (ts.isIdentifier(decl.name)) {
    cb(decl);
    return;
  }
  const walk = (pat) => {
    if (ts.isObjectBindingPattern(pat) || ts.isArrayBindingPattern(pat)) {
      for (const el of pat.elements) {
        if (!ts.isBindingElement(el)) continue;
        if (ts.isIdentifier(el.name)) cb(el);
        else walk(el.name); // nested pattern
      }
    }
  };
  walk(decl.name);
}

/**
 * Visit every value-position identifier reference in `root`'s OWN execution unit
 * (STOPS at nested function units, like forEachOwnBodyNode). Skips the non-
 * reference identifier positions that would otherwise resolve by coincidence: the
 * member of `a.b`, the right of a qualified name, an object-literal property KEY,
 * and binding NAMES. Shorthand `{ x }` IS a reference, so it is kept.
 */
function forEachValueIdentifier(root, cb) {
  const walk = (node) => {
    ts.forEachChild(node, (child) => {
      if (isFunctionNode(child)) return; // separate unit (its text is spliced wholesale if it is an initializer)
      if (ts.isPropertyAccessExpression(node) && child === node.name) return;
      if (ts.isQualifiedName(node) && child === node.right) return;
      if (ts.isPropertyAssignment(node) && child === node.name) return;
      if (
        (ts.isVariableDeclaration(node) ||
          ts.isParameter(node) ||
          ts.isBindingElement(node) ||
          ts.isPropertyDeclaration(node) ||
          ts.isFunctionDeclaration(node) ||
          ts.isClassDeclaration(node)) &&
        child === node.name
      ) {
        return;
      }
      if (ts.isIdentifier(child)) cb(child);
      else walk(child);
    });
  };
  if (ts.isIdentifier(root)) cb(root);
  else walk(root);
}

/**
 * Every name declared by a top-level `const`/`let`/`var` in this file. A cheap
 * pre-filter (cached per SourceFile): an identifier NOT spelled like any of these
 * cannot resolve to a module binding, so resolveConstText skips resolving it —
 * this keeps the trigger-side pass linear in a unit's SIZE, not in the whole
 * file's scope depth, which is the difference between a fast guard and one that
 * re-walks the 4 000-line db.ts scope tree for every identifier. Filtering by
 * NAME loses nothing: a skipped identifier would resolve to a local/param
 * (skipped anyway) or to nothing.
 */
const _moduleNamesCache = new WeakMap();
function moduleBindingNames(sf) {
  const cached = _moduleNamesCache.get(sf);
  if (cached) return cached;
  const names = new Set();
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    // eachBoundName covers simple ids AND destructuring (object/array, renamed,
    // nested, rest, defaults), matching what resolveName registers.
    for (const decl of stmt.declarationList.declarations) {
      eachBoundName(decl.name, (n) => names.add(n));
    }
  }
  _moduleNamesCache.set(sf, names);
  return names;
}

/**
 * Splice into `parts` the initializer text of every module-scope CONST reachable
 * (binding-correct, transitively, cycle-safe) from the value identifiers in
 * `node`. `names` is the module-binding-name pre-filter (moduleBindingNames).
 * Follows const→const/property aliases to the terminal literal at ARBITRARY depth
 * — there is no hop limit, because a hop limit only relocates the gap (#192). The
 * `seen` set (keyed on decl NODES) bounds the closure to O(#module-consts) and
 * makes A = B, B = A terminate instead of hang. A `soft` (let/var) module binding
 * is recorded in `softHit` and deliberately NOT read.
 */
function resolveConstText(node, sf, parts, seen, softHit, names) {
  forEachValueIdentifier(node, (id) => {
    if (!names.has(id.text)) return; // cheap: not spelled like any module binding → cannot be one
    const decls = resolveName(id.text, id);
    if (decls.length !== 1) return; // free / ambiguous / import → out of this resolver's world
    const decl = decls[0]; // a VariableDeclaration (simple) or a BindingElement (destructured)
    const info = moduleBindingInfo(decl);
    if (!info) return; // param / local / fn / class / import / non-module → shadow-correct skip
    if (seen.has(decl)) return;
    seen.add(decl);
    if (info.kind === "soft") {
      if (softHit) softHit.add(decl.name.getText(sf));
      return;
    }
    if (info.initNode) {
      parts.push(info.initNode.getText(sf)); // whole initializer (object/array included — coarse, over-includes)
      resolveConstText(info.initNode, sf, parts, seen, softHit, names); // transitive: follow the alias onward
    }
    // A destructuring DEFAULT (const { x: R = <sql> } = obj) supplies the value when
    // the source lacks the key — splice it too (over-include = the safe direction).
    if (ts.isBindingElement(decl) && decl.initializer) {
      parts.push(decl.initializer.getText(sf));
      resolveConstText(decl.initializer, sf, parts, seen, softHit, names);
    }
  });
}

/**
 * The effective SQL-relevant text of a function unit: its own body text PLUS the
 * initializer text of every module-scope CONST it binding-resolves to
 * (transitively). Any module let/var it resolves to is added to `softHitOut` (a
 * Set of names) for the caller's fail-closed refusal — never read as a value.
 */
export function resolveUnitSqlText(bodyNode, sf, softHitOut) {
  const parts = [bodyNode.getText(sf)];
  resolveConstText(bodyNode, sf, parts, new Set(), softHitOut ?? null, moduleBindingNames(sf));
  return parts.join(" ");
}

/**
 * Does module-scope let/var `decl` reach validity SQL through its initializer OR
 * any assignment `name = <expr>` to it (binding-correct: the assignment's target
 * must resolve to THIS decl)? Const-resolves both sides so `let X = AUTH_SQL`
 * (L1, alias) and `let X = "SELECT 1"; X = "<revoke>"` (L2, reassignment) are
 * both caught. `predicate(text)` is the SQL test.
 */
function moduleSoftBindingReachesSql(decl, sf, predicate) {
  const names = moduleBindingNames(sf);
  const texts = [];
  const info = moduleBindingInfo(decl); // works for a VariableDeclaration or a BindingElement
  if (info && info.initNode) {
    texts.push(info.initNode.getText(sf));
    resolveConstText(info.initNode, sf, texts, new Set(), null, names);
  }
  if (ts.isBindingElement(decl) && decl.initializer) {
    texts.push(decl.initializer.getText(sf)); // destructuring default value
    resolveConstText(decl.initializer, sf, texts, new Set(), null, names);
  }
  const walk = (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      const target = resolveName(node.left.text, node.left);
      if (target.length === 1 && target[0] === decl) {
        texts.push(node.right.getText(sf));
        resolveConstText(node.right, sf, texts, new Set(), null, names);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return predicate(texts.join(" "));
}

/**
 * Module-scope let/var bindings whose initializer or any assignment reaches
 * validity SQL (`predicate`) — the fail-closed REFUSAL set (#192 ruling 3). A
 * const→let refactor of a SQL literal lands here and the build fails LOUDLY (the
 * caller exits 2, premise-style), rather than the guard reading a stale/benign
 * initializer and reporting a false all-clear while the reassigned statement
 * revokes a token. `_db` and plain counters never reach SQL, so the real db.ts
 * stays clean.
 * @fixture "an unresolvable binding is REFUSED, and the refusal is actionable"
 */
export function findSqlBackedSoftBindings(sf, predicate) {
  const out = [];
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    const list = stmt.declarationList;
    if ((list.flags & ts.NodeFlags.Const) !== 0) continue; // only let/var
    for (const decl of list.declarations) {
      // Each bound name (simple id OR each destructuring BindingElement).
      eachModuleBoundDecl(decl, (boundDecl) => {
        if (moduleSoftBindingReachesSql(boundDecl, sf, predicate)) out.push(boundDecl);
      });
    }
  }
  return out;
}
