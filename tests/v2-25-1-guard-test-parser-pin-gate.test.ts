// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * #212 — GUARD-TEST PARSER-PIN GATE (AST). Companion to the typescript-legacy pin.
 *
 * The AST guards parse with the PINNED `typescript-legacy` (scripts/lib/guard-parse.mjs),
 * so the build's own `typescript` devDependency can bump to 7 (Corsa). The hazard this
 * gate closes: a guard-AST test (or a helper the guards reach) that hand-builds a
 * SourceFile with the BUMPABLE `typescript` and feeds it into the pinned guard helpers is
 * exercising a parser configuration that NEVER occurs in production — green today only
 * because typescript@6 === typescript-legacy@6, silently divergent once typescript bumps.
 *
 * PARSE, DON'T MATCH. A regex was tried first and leaked a new import form every round —
 * subpath `typescript/lib/...`, template-literal `import(`typescript`)`, multiline static
 * import, computed specifier, comment-interior text — because distinguishing CODE from
 * STRING/COMMENT and spanning lines are PARSER properties a regex cannot have. This gate
 * walks the `typescript-legacy` AST (the very compiler the guards are pinned to) and
 * inspects only REAL import / export / require nodes. By construction:
 *   · comments are not AST nodes            -> comment-interior text cannot false-positive
 *   · fixture strings are call ARGUMENTS,
 *     not module specifiers                 -> NO file needs a self-exemption (that special
 *                                              case was itself a defect source)
 *   · multiline is meaningless to an AST    -> a split import is one node
 *   · a NoSubstitutionTemplateLiteral, and
 *     a concat of string literals, RESOLVE  -> `import(`typescript`)` / `"type"+"script"`
 *                                              are decided, not guessed
 *
 * FAIL CLOSED ON INABILITY TO LOOK — absence is never evidence of cleanliness:
 *   · UNPARSEABLE FILE: `ts.createSourceFile` is error-tolerant — on syntax it cannot read it
 *     returns a PARTIAL tree (no exception) with `parseDiagnostics`. A partial tree has no
 *     import nodes, so a naive walk reads it as clean — and since this gate parses with v6
 *     while #212 exists to let the build bump to 7, TS7-era syntax would blind the gate
 *     PRECISELY when the bump it enables lands. So parsing goes through
 *     `parseGuardSource` (scripts/lib/guard-parse.mjs), which THROWS on any parse diagnostic;
 *     the scan converts that throw into an offender. Same fail-closed check the guards rely on.
 *   · MISSING SCAN ROOT: the roots are DECLARED (EXPECTED_ROOTS), not discovered. A declared
 *     root that is absent is a FAILURE, so renaming/losing `scripts/` is a loud red with a
 *     name — and removing a root becomes a visible edit to the declaration, reviewable.
 *
 * UNDECIDABLE SPECIFIERS FAIL CLOSED — but only when genuinely undecidable. A specifier's
 * statically known PREFIX is resolved; it is an offender iff that prefix could still complete
 * to `typescript` / `typescript/…`. A fully-opaque `import(variable)` (empty prefix) fails
 * closed; a computed specifier whose literal prefix rules typescript out — measured on
 * tests/config.test.ts's `import("../src/config.js?x=" + Date.now())` cache-busting — passes.
 * "Cannot prove it is NOT typescript" is the bar (mirroring `findUnresolvablePrimitives`).
 *
 * ALLOWLIST entries are FULL RELATIVE PATHS (never basenames — a basename would exempt a
 * same-named file in the other tree). None today.
 *
 * SCOPE: tests/ and scripts/ — the guard sources a test can reach for `ts`. STATED BOUND
 * (recorded, not an unexamined gap): a re-export routed through a module OUTSIDE these
 * trees (src/ or a dependency) is beyond a source scan and is not caught. Not a live path
 * today — the guards and the pinned parser both live in scripts/, and guard-parse.mjs
 * re-exports `typescript-legacy`. If the guard parser ever moves, widen EXPECTED_ROOTS.
 */
import { describe, it, expect } from "vitest";
import ts from "typescript-legacy";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The guards' own fail-closed pinned parser — reused, not re-implemented (it throws
// GuardParseError on any parse diagnostic instead of returning a partial tree).
const { parseGuardSource } = await import("../scripts/lib/guard-parse.mjs");

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

export interface SpecifierRef {
  /** Statically-known prefix of the specifier (the WHOLE specifier when `exact`). */
  prefix: string;
  /** True iff the entire specifier is statically known (literal, or a concat of literals). */
  exact: boolean;
  /** Source text of the specifier expression, for reporting. */
  text: string;
}

/** Resolve the statically-known prefix of a module-specifier expression. */
function resolvePrefix(expr: ts.Expression): { prefix: string; exact: boolean } {
  if (ts.isStringLiteralLike(expr)) return { prefix: expr.text, exact: true }; // "x" 'x' `x`
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = resolvePrefix(expr.left);
    if (!left.exact) return { prefix: left.prefix, exact: false }; // left already partial -> stop
    const right = resolvePrefix(expr.right);
    return { prefix: left.prefix + right.prefix, exact: right.exact };
  }
  if (ts.isTemplateExpression(expr)) return { prefix: expr.head.text, exact: false }; // `head${…}`
  if (ts.isParenthesizedExpression(expr)) return resolvePrefix(expr.expression);
  return { prefix: "", exact: false }; // identifier, call, property access, … — opaque
}

/**
 * Collect module specifiers from the REAL import/export/require nodes of `sourceText`,
 * parsed by the pinned `parseGuardSource` — which THROWS (GuardParseError) on any parse
 * diagnostic rather than returning a partial tree. A specifier that is not statically fully
 * known is returned with `exact:false` and its known prefix, never guessed.
 */
export function moduleSpecifiers(sourceText: string, fileName = "scan.ts"): SpecifierRef[] {
  const sf = parseGuardSource(fileName, sourceText) as ts.SourceFile; // throws on parse diagnostics
  const refs: SpecifierRef[] = [];
  const record = (expr: ts.Expression): void => {
    const { prefix, exact } = resolvePrefix(expr);
    refs.push({ prefix, exact, text: expr.getText(sf) });
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      record(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      record(node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if ((isImport || isRequire) && node.arguments.length >= 1) record(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return refs;
}

/**
 * Could this specifier denote the bumpable `typescript` package (bare or subpath)? An exact
 * specifier is decided outright; a partial one is an offender iff its known prefix could still
 * complete to `typescript` / `typescript/…` — the fail-closed direction for the undecidable.
 */
export function couldBeBumpableTypescript(ref: SpecifierRef): boolean {
  const p = ref.prefix;
  if (ref.exact) return p === "typescript" || p.startsWith("typescript/");
  return "typescript".startsWith(p) || "typescript/".startsWith(p) || p.startsWith("typescript/");
}

// Full RELATIVE PATHS permitted to reference the bumpable typescript (none today). Each entry
// needs a comment stating why the bumpable compiler is required there.
const ALLOWLIST = new Set<string>([]);

export interface ScanRoot {
  /** repo-relative label, for reporting + for the declared-but-missing failure. */
  rel: string;
  /** absolute directory to scan. */
  abs: string;
}

// DECLARED, not discovered. A declared root that is absent FAILS the gate — a lost/renamed
// root must never silently drop out of the proof. Removing a root is a visible edit here.
const EXPECTED_ROOTS: ScanRoot[] = [
  { rel: "tests", abs: path.join(REPO_ROOT, "tests") },
  { rel: "scripts", abs: path.join(REPO_ROOT, "scripts") },
];

/** All source files under `dir`, recursively, excluding build output + deps. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (["node_modules", "dist", "out", ".git"].includes(ent.name)) continue;
      out.push(...sources(path.join(dir, ent.name)));
    } else if (/\.(m|c)?[jt]s$/.test(ent.name)) {
      out.push(path.join(dir, ent.name));
    }
  }
  return out;
}

/**
 * Scan the declared roots. Every way the gate can fail to LOOK is an offender, never a pass:
 * a missing declared root, a file the pinned parser cannot fully parse, and of course any
 * specifier that is (or could be) the bumpable typescript.
 */
export function scanRoots(roots: ScanRoot[]): string[] {
  const offenders: string[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root.abs)) {
      offenders.push(
        `declared scan root "${root.rel}/" is MISSING (${root.abs}) — a removed root must be a visible ` +
          `edit to EXPECTED_ROOTS, never a silent pass`,
      );
      continue;
    }
    for (const file of sources(root.abs)) {
      const rel = path.relative(REPO_ROOT, file);
      if (ALLOWLIST.has(rel)) continue;
      let refs: SpecifierRef[];
      try {
        refs = moduleSpecifiers(fs.readFileSync(file, "utf8"), file);
      } catch (e) {
        if (e instanceof Error && e.name === "GuardParseError") {
          offenders.push(
            `${rel}: UNPARSEABLE by the pinned typescript-legacy — cannot certify (fail closed; a partial ` +
              `tree must never read as clean). If this is TS7-era syntax, the pin needs re-platforming.`,
          );
          continue;
        }
        throw e;
      }
      for (const ref of refs) {
        if (!couldBeBumpableTypescript(ref)) continue;
        offenders.push(
          ref.exact
            ? `${rel}: imports the bumpable ${ref.text} (use typescript-legacy)`
            : `${rel}: UNDECIDABLE specifier ${ref.text} — its prefix cannot rule out the bumpable typescript`,
        );
      }
    }
  }
  return offenders;
}

describe("#212 guard-test parser-pin gate (AST) — nothing a guard test reaches parses with the bumpable typescript", () => {
  it("no declared root is missing, no scanned file is unparseable, and no specifier is (or could be) the bumpable typescript", () => {
    expect(
      scanRoots(EXPECTED_ROOTS),
      "a guard test (or a helper it reaches) must parse with the PINNED typescript-legacy, every declared\n" +
        "root must exist, every file must fully parse, and every import specifier must be provably NOT the\n" +
        "bumpable typescript. Offenders:\n" + scanRoots(EXPECTED_ROOTS).join("\n"),
    ).toEqual([]);
  });
});

describe("#212 gate FAILS CLOSED on inability to look (absence is never clean)", () => {
  it("P1 — an UNPARSEABLE scanned file is an offender (a partial tree is not certified clean)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pin-gate-p1-"));
    try {
      fs.writeFileSync(path.join(dir, "broken.ts"), "const broken = ;\nfunction f(] { return @@@ }\n");
      const offenders = scanRoots([{ rel: "tmp", abs: dir }]);
      expect(offenders.some((o) => /UNPARSEABLE/.test(o)), offenders.join("\n") || "(no offenders)").toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("P1 — moduleSpecifiers itself refuses a file with parse diagnostics (reuses guard-parse fail-closed)", () => {
    expect(() => moduleSpecifiers("const broken = ;\nfunction f(] { return @@@ }\n")).toThrow(/GuardParseError|parse diagnostic/);
  });

  it("P2 — a DECLARED-but-MISSING scan root is an offender (a lost root must not silently drop from the proof)", () => {
    const offenders = scanRoots([{ rel: "ghost", abs: path.join(REPO_ROOT, "does-not-exist-abc123") }]);
    expect(offenders.some((o) => /MISSING/.test(o)), offenders.join("\n") || "(no offenders)").toBe(true);
  });

  it("positive control — scanRoots really detects a bumpable import in a scanned file (not vacuously green)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pin-gate-pos-"));
    try {
      fs.writeFileSync(path.join(dir, "x.ts"), 'import ts from "typescript";\nexport const a = 1;\n');
      const offenders = scanRoots([{ rel: "tmp", abs: dir }]);
      expect(offenders.some((o) => /imports the bumpable/.test(o))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#212 matcher (AST) — implements the RULE, not the forms it was built from", () => {
  const only = (src: string): SpecifierRef => {
    const refs = moduleSpecifiers(src);
    if (refs.length !== 1) throw new Error(`expected exactly 1 specifier, got ${refs.length} in: ${src}`);
    return refs[0];
  };
  const offends = (src: string): boolean => couldBeBumpableTypescript(only(src));

  // Decided-bumpable forms — including probes a regex leaked (subpath, template literal,
  // multiline static) and a string-concat that resolves EXACTLY to "typescript".
  const FLAGGED: [string, string][] = [
    ["default import", 'import ts from "typescript";'],
    ["namespace import", 'import * as ts from "typescript";'],
    ["type-only import", 'import type { Node } from "typescript";'],
    ["side-effect import", 'import "typescript";'],
    ["dynamic import", 'const p = import("typescript");'],
    ["require", 'const ts = require("typescript");'],
    ["import-equals require", 'import ts = require("typescript");'],
    ["re-export named", 'export { Node } from "typescript";'],
    ["re-export star", 'export * from "typescript";'],
    ["subpath import", 'import ts from "typescript/lib/typescript.js";'],
    ["PROBE template-literal specifier", 'const p = import(`typescript`);'],
    ["PROBE multiline static import", 'import {\n  createSourceFile,\n} from "typescript";'],
    ["string-concat resolving to typescript", 'const p = import("type" + "script");'],
  ];
  it.each(FLAGGED)("FLAGS the bumpable %s", (_label, line) => {
    const ref = only(line);
    expect(ref.exact).toBe(true);
    expect(offends(line)).toBe(true);
  });

  // Undecidable-and-could-be-typescript forms — fail CLOSED (offender, though not `exact`).
  const UNDECIDABLE: [string, string][] = [
    ["fully-opaque variable", "const p = import(m);"],
    ["template with substitution", "const p = import(`type${x}`);"],
    ['concat starting exactly "typescript"', 'const p = import("typescript" + suffix);'],
  ];
  it.each(UNDECIDABLE)("FLAGS the undecidable %s (fails closed)", (_label, line) => {
    const ref = only(line);
    expect(ref.exact).toBe(false);
    expect(offends(line)).toBe(true);
  });

  // Decidably-NOT-typescript — must pass, including the real cache-busting pattern that a
  // blunt "any non-literal fails" rule wrongly flagged (measured against tests/config.test.ts).
  const CLEAN: [string, string][] = [
    ["pinned alias", 'import ts from "typescript-legacy";'],
    ["pinned dynamic", 'const p = import("typescript-legacy");'],
    ["pinned subpath", 'import ts from "typescript-legacy/lib/typescript.js";'],
    ["unrelated package typescript-eslint", 'import { x } from "typescript-eslint";'],
    ["cache-busting relative import", 'const p = import("../src/config.js?x=" + Date.now());'],
    ['concat starting "typescript-" (rules out bumpable)', 'const p = import("typescript-" + rest);'],
  ];
  it.each(CLEAN)("ALLOWS %s", (_label, line) => {
    expect(offends(line)).toBe(false);
  });

  it("comment-interior text and data strings are not import nodes at all", () => {
    expect(moduleSpecifiers('/*\nimport ts from "typescript";\n*/\nexport const x = 1;')).toHaveLength(0);
    expect(moduleSpecifiers('// import ts from "typescript"\nexport const y = 2;')).toHaveLength(0);
    expect(moduleSpecifiers('const label = "typescript";')).toHaveLength(0);
  });
});
