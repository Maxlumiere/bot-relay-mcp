// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.24.9 — the SHARED must-call guard hardening + codex's three refutation
 * mutators as PERMANENT fixtures.
 *
 * codex refuted the v1 must-call guards (which used the AST only to LOCATE a
 * function then regex'd the raw body text) with three valid-TS mutators that are
 * harmful yet passed:
 *   (a) a `// registerPersistedSecret(...)` / `// bumpAuthGeneration()` COMMENT —
 *       prose counted as the call. The killer: a TODO comment is the exact
 *       artifact left when the call is NOT yet written.
 *   (b) `const reg = <fn>; reg()` — a direct local alias the regex never saw.
 *   (c) a class-field arrow `f = () => {...}` — a node the visitor never entered.
 *
 * The fix is scripts/lib/guard-ast.mjs: `bodyCallsFunction` resolves a REAL
 * CallExpression (comments/strings are structurally incapable of satisfying it)
 * with direct-alias resolution, and `forEachFunctionUnit` covers class fields /
 * accessors / constructors. These fixtures must never pass again silently; they
 * are pinned here so a regression in the shared helper fails the build.
 *
 * The stated (b) BOUNDARY is asserted too: indirection the helper does NOT
 * resolve (dynamic property access) reads as absent — which for a must-call guard
 * is the SAFE direction (it flags, demanding the call be written plainly).
 */
import { describe, it, expect } from "vitest";
import ts from "typescript";

const { forEachFunctionUnit, bodyCallsFunction, findUnsatisfiedPrimitives } = await import("../scripts/lib/guard-ast.mjs");
const { findAuthGenViolations } = await import("../scripts/auth-gen-guard.mjs");

/**
 * The sanctioned primitives, declared as the TOP-LEVEL FUNCTION DECLARATIONS the
 * terminal bar requires. Any fixture that expects a bump to be RECOGNISED must
 * include this: the guard resolves a call to one specific declaration node, so a
 * free-floating `bumpAuthGeneration()` is refused by design. That refusal is
 * itself a round-4 fix — round 3 trusted unresolved names by spelling, which is
 * how `import x = require(...)` slipped through.
 */
const P = `function bumpAuthGeneration(){}\nfunction applyAuthStateTransition(){}\n`;

/** Parse `src`, return the body node of the first function unit named `name`. */
function callsIt(src: string, unitName: string, names: string[]): boolean {
  const sf = ts.createSourceFile("t.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let body: ts.Node | null = null;
  forEachFunctionUnit(sf, (n: string, b: ts.Node) => {
    if (n === unitName && !body) body = b;
  });
  if (!body) throw new Error(`no function unit named "${unitName}" found in source`);
  return bodyCallsFunction(body, sf, new Set(names));
}

describe("v2.24.9 shared guard-ast — structural call detection (codex's mutators)", () => {
  const REG = ["registerPersistedSecret"];
  // The terminal bar resolves to a real top-level declaration, so fixtures that
  // EXPECT the call to be found must declare the primitive. A free name is
  // refused by design (round-3 leak: unresolved names were trusted by spelling).
  const RP = `function registerPersistedSecret(n, t){}\n`;

  it("a real direct call is detected", () => {
    expect(callsIt(`${RP}function mint(n){ const t = generateToken(); registerPersistedSecret(n, t); }`, "mint", REG)).toBe(true);
  });

  it("(a) a block-comment mention is NOT a call — the killer codex found", () => {
    expect(callsIt(`function mint(n){ const t = generateToken(); /* TODO: registerPersistedSecret(n, t) */ return t; }`, "mint", REG)).toBe(false);
  });

  it("(a) a line-comment TODO is NOT a call", () => {
    expect(callsIt(`function mint(n){ const t = generateToken();\n // TODO: call registerPersistedSecret(n, t)\n return t; }`, "mint", REG)).toBe(false);
  });

  it("(a') a STRING literal mentioning the call is NOT a call", () => {
    expect(callsIt(`function mint(n){ const t = generateToken(); log("remember to registerPersistedSecret(n,t)"); return t; }`, "mint", REG)).toBe(false);
  });

  it("(b) a direct local alias is resolved and detected", () => {
    expect(callsIt(`${RP}function mint(n){ const reg = registerPersistedSecret; const t = generateToken(); reg(n, t); }`, "mint", REG)).toBe(true);
  });

  it("(c) a class-field arrow is visited, and its real call detected", () => {
    expect(callsIt(`${RP}class C { mint = (n) => { const t = generateToken(); registerPersistedSecret(n, t); }; }`, "mint", REG)).toBe(true);
  });

  it("(c) a class-field arrow that only comments the call is caught as absent", () => {
    expect(callsIt(`class C { mint = (n) => { const t = generateToken(); /* registerPersistedSecret(n,t) */ }; }`, "mint", REG)).toBe(false);
  });

  it("STATED BOUNDARY (not closed): dynamic property access is not resolved → reads absent (safe: over-flags)", () => {
    expect(callsIt(`function mint(n){ const m = { r: registerPersistedSecret }; const t = generateToken(); m["r"](n, t); }`, "mint", REG)).toBe(false);
  });
});

describe("v2.24.9 auth-gen-guard — structural bump detection closes the same evasions", () => {
  // A validity-changing mutation (the trigger). The SQL sits in a string literal.
  const MUT = `db.prepare("UPDATE agents SET token_hash = ? WHERE name = ?").run(h, n);`;
  const names = (src: string) => findAuthGenViolations(src, "t.ts").map((v: { name: string }) => v.name);

  it("(a) a COMMENT bump is FLAGGED — v1 regex passed it, and a stale cache = auth bypass", () => {
    expect(names(`function rotate(n, h){ ${MUT} /* bumpAuthGeneration() */ }`)).toContain("rotate");
  });

  it("(c) a class-field mutator omitting the bump is FLAGGED — v1 never visited PropertyDeclaration", () => {
    expect(names(`class C { rotate = (n, h) => { ${MUT} }; }`)).toContain("rotate");
  });

  it("(b) a real bump reached through a direct alias is RECOGNIZED (no false positive)", () => {
    expect(findAuthGenViolations(`${P}function rotate(n, h){ const bump = bumpAuthGeneration; ${MUT} bump(); }`, "t.ts")).toEqual([]);
  });

  it("INNOCENT TWIN: a normal mutator that bumps directly is clean", () => {
    expect(findAuthGenViolations(`${P}function rotate(n, h){ ${MUT} bumpAuthGeneration(); }`, "t.ts")).toEqual([]);
  });
});

describe("v2.24.9 nested-function boundary (Victra's never-invoked-callback refutation)", () => {
  const MUT = `db.prepare("UPDATE agents SET token_hash = ? WHERE name = ?").run(h, name);`;
  const names = (src: string) => findAuthGenViolations(src, "t.ts").map((v: { name: string }) => v.name);

  it("UNDER-DETECTION CLOSED: a bump inside a NEVER-INVOKED callback is FLAGGED (v1 counted it → auth bypass on a token that never registers)", () => {
    expect(names(`function rotate(name, h){ ${MUT} const onSuccess = () => bumpAuthGeneration(); }`)).toContain("rotate");
  });

  it("INNOCENT TWIN: a bump inside an `if` block still PASSES — same execution unit, not a function boundary", () => {
    expect(findAuthGenViolations(`${P}function rotate(name, h){ ${MUT} if (ok) { bumpAuthGeneration(); } }`, "t.ts")).toEqual([]);
  });

  it("INNOCENT TWIN: a bump inside `try` still PASSES (breaking this would fail every honest conditional register)", () => {
    expect(findAuthGenViolations(`${P}function rotate(name, h){ try { ${MUT} bumpAuthGeneration(); } catch (e) {} }`, "t.ts")).toEqual([]);
  });

  it("ACCEPTED OVER-FLAG (safe, documented): an IIFE doing the bump reads as absent → FLAGGED (allowlist is the remedy; no bespoke IIFE detection by design)", () => {
    expect(names(`function rotate(name, h){ ${MUT} (() => bumpAuthGeneration())(); }`)).toContain("rotate");
  });

  it("ACCEPTED RISK (labelled, NOT 'safe'): reachability within a unit is not checked — an if(false) bump still passes; runtime paths are the behavioural tests' job", () => {
    expect(findAuthGenViolations(`${P}function rotate(name, h){ ${MUT} if (false) { bumpAuthGeneration(); } }`, "t.ts")).toEqual([]);
  });
});

/**
 * ── #151 round 2: BINDING + SCOPE safety ─────────────────────────────────────
 * Round 1 fixed the scoping rule in the CALL scan and left the ALIAS pre-pass on
 * the old rule — two passes over one body, two answers to "where does this unit
 * end." codex refuted it with three mutators (1-3 below); five more of the same
 * family (4-8) were found while fixing it. All eight were EXECUTED against the
 * shipped findAuthGenViolations and all eight returned [] — i.e. every one of
 * them shipped a token/auth mutation with no bump and the guard said clean.
 *
 * 4-8 are NOT codex's: 5 and 6 are a distinct root cause its bar does not name —
 * shadowing of the TARGET name itself, as opposed to alias handling.
 */
describe("v2.24.9 #151 r2 — alias binding + scope safety (harm fixtures, all executed)", () => {
  const MUT = `db.prepare("UPDATE agents SET token_hash = ? WHERE name = ?").run(h, name);`;
  const names = (src: string) => findAuthGenViolations(src, "t.ts").map((v: { name: string }) => v.name);

  it("codex-1: an alias declared in a NESTED function must not seed the outer unit's name set", () => {
    expect(names(`function rotate(name, h){ ${MUT}
      const done = () => log("unrelated completion");
      function neverInvoked(){ const done = bumpAuthGeneration; }
      done(); }`)).toContain("rotate");
  });

  it("codex-1': same defect reached through a nested ARROW rather than a declaration", () => {
    expect(names(`function rotate(name, h){ ${MUT}
      const done = () => log("unrelated completion");
      const cb = () => { const done = bumpAuthGeneration; };
      done(); }`)).toContain("rotate");
  });

  it("codex-2: a REASSIGNED alias must not survive (let a = bump; a = other; a())", () => {
    expect(names(`function rotate(name, h){ ${MUT}
      let finish = bumpAuthGeneration;
      finish = () => log("unrelated completion");
      finish(); }`)).toContain("rotate");
  });

  it("codex-2': the var-hoisted variant of the same reassignment", () => {
    expect(names(`function rotate(name, h){ ${MUT}
      var go = bumpAuthGeneration; go = somethingElse; go(); }`)).toContain("rotate");
  });

  it("codex-3: an alias spelling must NOT match a property-access callee (unrelated.finish())", () => {
    expect(names(`function rotate(name, h){ ${MUT}
      const finish = bumpAuthGeneration;
      unrelated.finish(); }`)).toContain("rotate");
  });

  it("fixer-4: an alias SHADOWED by a nearer const must not count — we cannot say which binding the call resolves to", () => {
    expect(names(`function rotate(name, h){ ${MUT}
      const finish = bumpAuthGeneration;
      { const finish = () => log("shadow"); finish(); } }`)).toContain("rotate");
  });

  it("fixer-5 (NEW ROOT CAUSE, not in codex's bar): a PARAMETER shadowing the target name must not satisfy the guard", () => {
    expect(names(`function rotate(name, h, bumpAuthGeneration){ ${MUT}
      bumpAuthGeneration(); }`)).toContain("rotate");
  });

  it("fixer-6 (NEW ROOT CAUSE): a local const shadowing the target name must not satisfy the guard", () => {
    expect(names(`function rotate(name, h){ ${MUT}
      const bumpAuthGeneration = () => log("not the real one");
      bumpAuthGeneration(); }`)).toContain("rotate");
  });

  // ── INNOCENT TWINS — each genuinely bumps; breaking any of these fails honest code ──

  it("TWIN: an honest single-binding const alias is still resolved", () => {
    expect(findAuthGenViolations(`${P}function rotate(name, h){ ${MUT} const bump = bumpAuthGeneration; bump(); }`, "t.ts")).toEqual([]);
  });

  // DELIBERATELY INVERTED in #151 round 3. This used to assert that
  // `db.bumpAuthGeneration()` is an innocent twin. It is not: the sanctioned
  // primitives are TOP-LEVEL FUNCTIONS in this codebase — verified, both are
  // `export function`, all 18 call sites are bare identifiers, and there are
  // ZERO property-style calls in src/db.ts. Treating a receiver form as the
  // sanctioned call was root E, and keeping a "closed set of receivers" would
  // have preserved the hole while looking safe.
  it("ROOT E: a RECEIVER form is refused — no receiver is the sanctioned primitive (db.x())", () => {
    expect(names(`function rotate(name, h){ ${MUT} db.bumpAuthGeneration(); }`)).toContain("rotate");
  });

  it("ROOT E: an unrelated receiver spelled like the primitive is refused (metrics.x())", () => {
    expect(names(`function rotate(name, h){ ${MUT} metrics.bumpAuthGeneration(); }`)).toContain("rotate");
  });

  it("TWIN: a bump inside a bare nested block still counts — a block is not a function boundary", () => {
    expect(findAuthGenViolations(`${P}function rotate(name, h){ ${MUT} { bumpAuthGeneration(); } }`, "t.ts")).toEqual([]);
  });

  it("TWIN: a bump inside a loop still counts", () => {
    expect(findAuthGenViolations(`${P}function rotate(name, h){ ${MUT} for (const x of xs) { bumpAuthGeneration(); } }`, "t.ts")).toEqual([]);
  });

  it("TWIN: routing through applyAuthStateTransition still counts", () => {
    expect(findAuthGenViolations(`${P}function rotate(name, h){ ${MUT} applyAuthStateTransition(name, "rotated"); }`, "t.ts")).toEqual([]);
  });

  it("TWIN: an unrelated local named `finish` with no alias at all does not crash or flag a bumping unit", () => {
    expect(findAuthGenViolations(`${P}function rotate(name, h){ ${MUT} const finish = () => log("x"); finish(); bumpAuthGeneration(); }`, "t.ts")).toEqual([]);
  });

  it("STATED BOUNDARY (not closed): a destructured reference reads as absent → OVER-flags, the safe direction", () => {
    expect(names(`function rotate(name, h){ ${MUT} const { bumpAuthGeneration: b } = db; b(); }`)).toContain("rotate");
  });

  it("ROOT F1: a nested FUNCTION DECLARATION shadowing the primitive is refused", () => {
    expect(names(`function rotate(name, h){ ${MUT} function bumpAuthGeneration(){} bumpAuthGeneration(); }`)).toContain("rotate");
  });

  it("ROOT F2: an ENCLOSING-scope block shadow around the unit is refused", () => {
    expect(names(`{ const bumpAuthGeneration = () => log("x"); function rotate(name, h){ ${MUT} bumpAuthGeneration(); } }`)).toContain("rotate");
  });

  // codex's actual F3 shape: the alias is bound exactly ONCE inside the unit (so
  // round 2's bound-exactly-once rule accepted it) but only inside a BLOCK, while
  // the call sits outside that block and resolves to an unrelated MODULE-level
  // binding. This refutes the round-2 doc claim that a name bound once in a unit
  // "provably refers to that target at every position."
  it("ROOT F3: a block-local alias does not escape its block — the call outside resolves elsewhere", () => {
    expect(names(`const f = () => log("outer");\nfunction rotate(name, h){ ${MUT} { const f = bumpAuthGeneration; } f(); }`)).toContain("rotate");
  });

  it("ROOT F4: a named function expression's own binding is RECURSION, not the primitive", () => {
    expect(names(`const rotate = function bumpAuthGeneration(name, h){ ${MUT} bumpAuthGeneration(); };`)).toContain("rotate");
  });

  it("ROOT F5: a class-field method collision via this.x() is refused", () => {
    expect(names(`class C { bumpAuthGeneration(){} rotate = (name, h) => { ${MUT} this.bumpAuthGeneration(); }; }`)).toContain("rotate");
  });

  it("ROOT G: a unit merely SPELLED like the primitive is ANALYSED, not exempt wholesale", () => {
    expect(names(`class C { bumpAuthGeneration = (name, h) => { ${MUT} }; }`)).toContain("bumpAuthGeneration");
  });

  it("ROOT G: the same for an allowlisted migration name on a class field", () => {
    expect(names(`class C { migrateSchemaToV2_1 = (name, h) => { ${MUT} }; }`)).toContain("migrateSchemaToV2_1");
  });

  it("TWIN (ROOT G): the REAL top-level primitive IS still exempt from bumping itself", () => {
    expect(findAuthGenViolations(`function bumpAuthGeneration(){ ${MUT} }`, "t.ts")).toEqual([]);
  });

  it("TWIN (ROOT G): the REAL top-level allowlisted migration is still exempt", () => {
    expect(findAuthGenViolations(`function migrateSchemaToV2_1(db){ ${MUT} }`, "t.ts")).toEqual([]);
  });

  it("TWIN: an honest const alias still resolves when USED INSIDE a block", () => {
    expect(findAuthGenViolations(`${P}function rotate(name, h){ ${MUT} const bump = bumpAuthGeneration; { bump(); } }`, "t.ts")).toEqual([]);
  });

  // ── #151 round 4: THE TERMINAL BAR ────────────────────────────────────────
  // Accept only a resolved direct TOP-LEVEL FUNCTION DECLARATION with a body,
  // in this file. Reject every other binding kind wholesale. Round 3 accepted a
  // CATEGORY ("any top-level binding of the name") and lost six more ways at the
  // module boundary; this accepts ONE declaration node, so there is nothing left
  // to enumerate. Module-scope `P` supplies the real primitives where needed.

  it("TERMINAL BAR: a direct named import of an unrelated function is refused", () => {
    expect(names(`import { bumpAuthGeneration } from "./unrelated";\nfunction rotate(name, h){ ${MUT} bumpAuthGeneration(); }`)).toContain("rotate");
  });

  it("TERMINAL BAR: a DEFAULT import is refused", () => {
    expect(names(`import bumpAuthGeneration from "./unrelated";\nfunction rotate(name, h){ ${MUT} bumpAuthGeneration(); }`)).toContain("rotate");
  });

  it("TERMINAL BAR: an import-equals binding is refused", () => {
    expect(names(`import bumpAuthGeneration = require("./unrelated");\nfunction rotate(name, h){ ${MUT} bumpAuthGeneration(); }`)).toContain("rotate");
  });

  it("TERMINAL BAR: a NAMESPACE import is refused", () => {
    expect(names(`import * as bumpAuthGeneration from "./unrelated";\nfunction rotate(name, h){ ${MUT} bumpAuthGeneration(); }`)).toContain("rotate");
  });

  it("TERMINAL BAR: an import RENAMED to the primitive's spelling is refused (local name is not identity)", () => {
    expect(names(`import { other as bumpAuthGeneration } from "./m";\nfunction rotate(name, h){ ${MUT} bumpAuthGeneration(); }`)).toContain("rotate");
  });

  it("TERMINAL BAR: an ambient `declare const` is refused", () => {
    expect(names(`declare const bumpAuthGeneration: () => void;\nfunction rotate(name, h){ ${MUT} bumpAuthGeneration(); }`)).toContain("rotate");
  });

  it("TERMINAL BAR: an ambient `declare function` (no body) is refused — it declares nothing and runs nothing", () => {
    expect(names(`declare function bumpAuthGeneration(): void;\nfunction rotate(name, h){ ${MUT} bumpAuthGeneration(); }`)).toContain("rotate");
  });

  // MODULE scope deliberately — that is codex's actual shape. A `using` INSIDE
  // the unit was already caught by round 3's local-binding rule, so an in-unit
  // fixture would pass on the broken code and be false coverage of the finding.
  it("TERMINAL BAR: a module-scope `using` binding is refused", () => {
    expect(names(`using bumpAuthGeneration = resource;\nfunction rotate(name, h){ ${MUT} bumpAuthGeneration(); }`)).toContain("rotate");
  });

  it("TERMINAL BAR: a module-scope `await using` binding is refused", () => {
    expect(names(`await using bumpAuthGeneration = asyncResource;\nfunction rotate(name, h){ ${MUT} bumpAuthGeneration(); }`)).toContain("rotate");
  });

  it("TERMINAL BAR: an unresolved FREE name is refused — round 3 trusted these by spelling", () => {
    expect(names(`function rotate(name, h){ ${MUT} bumpAuthGeneration(); }`)).toContain("rotate");
  });

  it("TERMINAL BAR: a top-level CLASS named like the primitive is refused", () => {
    expect(names(`class bumpAuthGeneration {}\nfunction rotate(name, h){ ${MUT} bumpAuthGeneration(); }`)).toContain("rotate");
  });

  it("TERMINAL BAR: a top-level ENUM named like the primitive is refused", () => {
    expect(names(`enum bumpAuthGeneration { X }\nfunction rotate(name, h){ ${MUT} bumpAuthGeneration(); }`)).toContain("rotate");
  });

  it("TERMINAL BAR: a top-level const arrow named like the primitive is refused", () => {
    expect(names(`const bumpAuthGeneration = () => {};\nfunction rotate(name, h){ ${MUT} bumpAuthGeneration(); }`)).toContain("rotate");
  });

  it("SELF-FOUND fx3: an alias used BEFORE its declaration is refused (TDZ — mutation commits, then it throws)", () => {
    expect(names(`${P}function rotate(name, h){ ${MUT} a(); const a = bumpAuthGeneration; }`)).toContain("rotate");
  });

  it("TWIN: the real top-level primitive + a bare call still passes", () => {
    expect(findAuthGenViolations(`${P}function rotate(name, h){ ${MUT} bumpAuthGeneration(); }`, "t.ts")).toEqual([]);
  });

  it("TWIN: an honest const alias of the real primitive still passes", () => {
    expect(findAuthGenViolations(`${P}function rotate(name, h){ ${MUT} const b = bumpAuthGeneration; b(); }`, "t.ts")).toEqual([]);
  });

  it("PREMISE: findUnsatisfiedPrimitives names a primitive converted to a const arrow", () => {
    const sf = ts.createSourceFile("t.ts", `const bumpAuthGeneration = () => {};`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    expect(findUnsatisfiedPrimitives(sf, new Set(["bumpAuthGeneration"]))).toEqual(["bumpAuthGeneration"]);
  });

  it("PREMISE: a genuine top-level function declaration satisfies it", () => {
    const sf = ts.createSourceFile("t.ts", `export function bumpAuthGeneration(): void {}`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    expect(findUnsatisfiedPrimitives(sf, new Set(["bumpAuthGeneration"]))).toEqual([]);
  });

  it("LOUD-FAILURE CONTRACT: bodyCallsFunction THROWS without parent links rather than silently under-detecting on parameters", () => {
    const sf = ts.createSourceFile("t.ts", `function rotate(n){ bumpAuthGeneration(); }`, ts.ScriptTarget.Latest, /* setParentNodes */ false, ts.ScriptKind.TS);
    let body: ts.Node | null = null;
    forEachFunctionUnit(sf, (n: string, b: ts.Node) => { if (n === "rotate" && !body) body = b; });
    expect(() => bodyCallsFunction(body as unknown as ts.Node, sf, new Set(["bumpAuthGeneration"]))).toThrow(/setParentNodes/);
  });
});
