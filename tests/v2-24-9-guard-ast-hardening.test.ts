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

const { forEachFunctionUnit, bodyCallsFunction } = await import("../scripts/lib/guard-ast.mjs");
const { findAuthGenViolations } = await import("../scripts/auth-gen-guard.mjs");

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

  it("a real direct call is detected", () => {
    expect(callsIt(`function mint(n){ const t = generateToken(); registerPersistedSecret(n, t); }`, "mint", REG)).toBe(true);
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
    expect(callsIt(`function mint(n){ const reg = registerPersistedSecret; const t = generateToken(); reg(n, t); }`, "mint", REG)).toBe(true);
  });

  it("(c) a class-field arrow is visited, and its real call detected", () => {
    expect(callsIt(`class C { mint = (n) => { const t = generateToken(); registerPersistedSecret(n, t); }; }`, "mint", REG)).toBe(true);
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
    expect(findAuthGenViolations(`function rotate(n, h){ const bump = bumpAuthGeneration; ${MUT} bump(); }`, "t.ts")).toEqual([]);
  });

  it("INNOCENT TWIN: a normal mutator that bumps directly is clean", () => {
    expect(findAuthGenViolations(`function rotate(n, h){ ${MUT} bumpAuthGeneration(); }`, "t.ts")).toEqual([]);
  });
});

describe("v2.24.9 nested-function boundary (Victra's never-invoked-callback refutation)", () => {
  const MUT = `db.prepare("UPDATE agents SET token_hash = ? WHERE name = ?").run(h, name);`;
  const names = (src: string) => findAuthGenViolations(src, "t.ts").map((v: { name: string }) => v.name);

  it("UNDER-DETECTION CLOSED: a bump inside a NEVER-INVOKED callback is FLAGGED (v1 counted it → auth bypass on a token that never registers)", () => {
    expect(names(`function rotate(name, h){ ${MUT} const onSuccess = () => bumpAuthGeneration(); }`)).toContain("rotate");
  });

  it("INNOCENT TWIN: a bump inside an `if` block still PASSES — same execution unit, not a function boundary", () => {
    expect(findAuthGenViolations(`function rotate(name, h){ ${MUT} if (ok) { bumpAuthGeneration(); } }`, "t.ts")).toEqual([]);
  });

  it("INNOCENT TWIN: a bump inside `try` still PASSES (breaking this would fail every honest conditional register)", () => {
    expect(findAuthGenViolations(`function rotate(name, h){ try { ${MUT} bumpAuthGeneration(); } catch (e) {} }`, "t.ts")).toEqual([]);
  });

  it("ACCEPTED OVER-FLAG (safe, documented): an IIFE doing the bump reads as absent → FLAGGED (allowlist is the remedy; no bespoke IIFE detection by design)", () => {
    expect(names(`function rotate(name, h){ ${MUT} (() => bumpAuthGeneration())(); }`)).toContain("rotate");
  });

  it("ACCEPTED RISK (labelled, NOT 'safe'): reachability within a unit is not checked — an if(false) bump still passes; runtime paths are the behavioural tests' job", () => {
    expect(findAuthGenViolations(`function rotate(name, h){ ${MUT} if (false) { bumpAuthGeneration(); } }`, "t.ts")).toEqual([]);
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
    expect(findAuthGenViolations(`function rotate(name, h){ ${MUT} const bump = bumpAuthGeneration; bump(); }`, "t.ts")).toEqual([]);
  });

  it("TWIN: a property access on the REAL name still counts (db.bumpAuthGeneration())", () => {
    expect(findAuthGenViolations(`function rotate(name, h){ ${MUT} db.bumpAuthGeneration(); }`, "t.ts")).toEqual([]);
  });

  it("TWIN: a bump inside a bare nested block still counts — a block is not a function boundary", () => {
    expect(findAuthGenViolations(`function rotate(name, h){ ${MUT} { bumpAuthGeneration(); } }`, "t.ts")).toEqual([]);
  });

  it("TWIN: a bump inside a loop still counts", () => {
    expect(findAuthGenViolations(`function rotate(name, h){ ${MUT} for (const x of xs) { bumpAuthGeneration(); } }`, "t.ts")).toEqual([]);
  });

  it("TWIN: routing through applyAuthStateTransition still counts", () => {
    expect(findAuthGenViolations(`function rotate(name, h){ ${MUT} applyAuthStateTransition(name, "rotated"); }`, "t.ts")).toEqual([]);
  });

  it("TWIN: an unrelated local named `finish` with no alias at all does not crash or flag a bumping unit", () => {
    expect(findAuthGenViolations(`function rotate(name, h){ ${MUT} const finish = () => log("x"); finish(); bumpAuthGeneration(); }`, "t.ts")).toEqual([]);
  });

  it("STATED BOUNDARY (not closed): a destructured reference reads as absent → OVER-flags, the safe direction", () => {
    expect(names(`function rotate(name, h){ ${MUT} const { bumpAuthGeneration: b } = db; b(); }`)).toContain("rotate");
  });

  it("LOUD-FAILURE CONTRACT: bodyCallsFunction THROWS without parent links rather than silently under-detecting on parameters", () => {
    const sf = ts.createSourceFile("t.ts", `function rotate(n){ bumpAuthGeneration(); }`, ts.ScriptTarget.Latest, /* setParentNodes */ false, ts.ScriptKind.TS);
    let body: ts.Node | null = null;
    forEachFunctionUnit(sf, (n: string, b: ts.Node) => { if (n === "rotate" && !body) body = b; });
    expect(() => bodyCallsFunction(body as unknown as ts.Node, sf, new Set(["bumpAuthGeneration"]))).toThrow(/setParentNodes/);
  });
});
