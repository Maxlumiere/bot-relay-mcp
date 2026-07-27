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
