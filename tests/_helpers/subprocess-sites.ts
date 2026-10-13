// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * SEC-22's scanner, over a program's files. It inventories every REFERENCE to node's child_process spawn family
 * (resolved through import aliases and namespaces by the pinned typescript-legacy checker, never matched by name), not
 * only direct calls (architect, 13 Oct, after Codex #336 R1 P2: `const run = spawnSync; run("whoami")` added no site):
 *   - a CALL is classified by how it names its program AND its options, per API: spawn / spawnSync / execFile /
 *     execFileSync need `systemBinary(...)` or the real `process.execPath` as the program, and options that are an
 *     object literal with no `shell` other than `false` (a shell finds programs by name); exec / execSync ARE a shell
 *     (always "other"); fork runs node, unless `options.execPath` names another program;
 *   - any OTHER value use (an alias, a destructured property, an argument, a stored value) is a "reference" site;
 *   - REJECTED outright: the string "child_process" / "node:child_process" anywhere but a static import/export
 *     (require, createRequire(...)(...), dynamic import), and computed member access on the module (`cp["spawnSync"]`).
 * NAMED BOUNDARY (not seen, by design): code inside a string that is evaluated (a Worker's eval'd source), and code
 * outside the scanned files (dependencies such as cross-spawn). tests/sec-22-system-binaries.test.ts pins both.
 */
import ts from "typescript-legacy";
import { resolveBinding, topLevelName } from "./ts-binding.js";

const SPAWN_FAMILY = /child_process\.d\.ts:(spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)$/;
const CP_MODULE = /child_process\.d\.ts:"(node:)?child_process"$/;
const NODE_PROCESS = /@types\/node\/[^:]+:process$/;
const CP_SPECIFIER = /^(node:)?child_process$/;

export interface SubprocessSite {
  /** "<file>::<enclosing top-level function>::<first argument's text, or the reference's text>" */
  key: string;
  /** The API (spawnSync, ...), "reference", or "rejected". */
  api: string;
  /** systemBinary | execPath: a checked program; other: a bare name, a variable, a shell, unchecked options; reference / rejected: see above. */
  program: "systemBinary" | "execPath" | "other" | "reference" | "rejected";
  /** Why a site is not checked (other / rejected). */
  why?: string;
}

export function subprocessSites(program: ts.Program, rel: (f: string) => string, inFile: (relPath: string) => boolean): SubprocessSite[] {
  const checker = program.getTypeChecker();
  const out: SubprocessSite[] = [];
  const keyOf = (b: { key: string } | null) => b?.key ?? "";
  for (const sf of program.getSourceFiles()) {
    const file = rel(sf.fileName);
    if (!inFile(file)) continue;
    const site = (n: ts.Node, text: string, api: string, programKind: SubprocessSite["program"], why?: string) =>
      out.push({ key: `${file}::${topLevelName(n)}::${text}`, api, program: programKind, ...(why ? { why } : {}) });

    const isRealExecPath = (e: ts.Expression | undefined): boolean =>
      !!e && ts.isPropertyAccessExpression(e) && e.name.text === "execPath" && ts.isIdentifier(e.expression) && NODE_PROCESS.test(keyOf(resolveBinding(checker, e.expression, rel)));
    const isSystemBinary = (e: ts.Expression | undefined): boolean =>
      !!e && ts.isCallExpression(e) && ts.isIdentifier(e.expression) && /system-binary\.ts:systemBinary$/.test(keyOf(resolveBinding(checker, e.expression, rel)));
    /** A member's STATIC name: an identifier, a string or number literal, or a computed literal key; else null (unknowable). */
    const staticName = (n: ts.PropertyName): string | null => {
      if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
      if (ts.isComputedPropertyName(n) && (ts.isStringLiteral(n.expression) || ts.isNoSubstitutionTemplateLiteral(n.expression) || ts.isNumericLiteral(n.expression))) return n.expression.text;
      return null;
    };
    /**
     * The value of a literal option, or why it cannot be read: "absent" | "unreadable" | the initializer. In property
     * order (a later member wins). UNREADABLE (Codex #336 R2 NEW-2): a spread, a shorthand of that name, an accessor or
     * method of that name, and ANY member whose key cannot be known statically (`[someName]`: it may be this option).
     */
    const option = (opts: ts.Expression | undefined, name: string): ts.Expression | "absent" | "unreadable" => {
      if (!opts) return "absent";
      if (!ts.isObjectLiteralExpression(opts)) return "unreadable";
      let found: ts.Expression | "absent" | "unreadable" = "absent";
      for (const p of opts.properties) {
        if (ts.isSpreadAssignment(p)) {
          found = "unreadable"; // a spread may carry it, unless a later literal member overrides
          continue;
        }
        const key = p.name ? staticName(p.name) : null;
        if (key === null) found = "unreadable";
        else if (key !== name) continue;
        else if (ts.isPropertyAssignment(p)) found = p.initializer;
        else found = "unreadable"; // a shorthand, a getter/setter or a method named like the option
      }
      return found;
    };

    const classifyCall = (call: ts.CallExpression, api: string) => {
      const first = call.arguments[0];
      const text = first ? first.getText(sf) : "<none>";
      if (api === "exec" || api === "execSync") return site(call, text, api, "other", "exec/execSync run a shell, which finds programs by name");
      const optsArg = api === "fork"
        ? call.arguments.find((a, k) => k > 0 && !ts.isArrayLiteralExpression(a))
        : call.arguments.find((a, k) => k > 0 && !ts.isArrayLiteralExpression(a) && !(ts.isIdentifier(a) && k === 1 && call.arguments.length > 2));
      if (api === "fork") {
        const ep = option(optsArg, "execPath");
        if (ep === "absent") return site(call, text, api, "execPath");
        if (ep === "unreadable") return site(call, text, api, "other", "fork's options cannot be read (execPath may be overridden)");
        return isRealExecPath(ep) || isSystemBinary(ep) ? site(call, text, api, "execPath") : site(call, text, api, "other", "fork's execPath names another program");
      }
      const shell = option(optsArg, "shell");
      if (shell === "unreadable") return site(call, text, api, "other", "options are not a literal: a shell override cannot be ruled out");
      if (shell !== "absent" && shell.kind !== ts.SyntaxKind.FalseKeyword) return site(call, text, api, "other", "a shell option: it finds programs by name");
      if (isSystemBinary(first)) return site(call, text, api, "systemBinary");
      if (isRealExecPath(first)) return site(call, text, api, "execPath");
      return site(call, text, api, "other", "the program is a bare name or an unchecked expression");
    };

    /** Is `n` a function that LOADS a module: require, a createRequire(...) result, or import()? */
    const isLoaderCall = (c: ts.CallExpression): boolean => {
      if (c.expression.kind === ts.SyntaxKind.ImportKeyword) return true;
      if (ts.isIdentifier(c.expression) && c.expression.text === "require") return true;
      if (ts.isCallExpression(c.expression) && ts.isIdentifier(c.expression.expression) && c.expression.expression.text === "createRequire") return true;
      if (ts.isIdentifier(c.expression)) {
        const decl = checker.getSymbolAtLocation(c.expression)?.declarations?.[0];
        const init = decl && ts.isVariableDeclaration(decl) ? decl.initializer : undefined;
        if (init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "createRequire") return true;
      }
      return false;
    };

    const visit = (n: ts.Node): void => {
      // REJECTED (ruled, Codex #336 R2 NEW-1 (c)): a module loader whose specifier is not a literal: it may load child_process.
      if (ts.isCallExpression(n) && isLoaderCall(n)) {
        const spec = n.arguments[0];
        if (!spec || !(ts.isStringLiteral(spec) || ts.isNoSubstitutionTemplateLiteral(spec))) {
          site(n, n.getText(sf), "rejected", "rejected", "a module loader (require / import() / createRequire) with a non-literal specifier");
        }
      }
      // A SITE (ruled, NEW-1 (d)): `export * from "child_process"` re-exports the whole family.
      if (ts.isExportDeclaration(n) && !n.exportClause && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && CP_SPECIFIER.test(n.moduleSpecifier.text)) {
        site(n, n.getText(sf), "rejected", "rejected", "export * from child_process re-exports the whole spawn family");
      }
      // REJECTED: the module named outside a static import/export (require, createRequire()(), dynamic import).
      if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && CP_SPECIFIER.test(n.text)) {
        const p = n.parent;
        const staticSpecifier = (ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) && p.moduleSpecifier === n;
        const ambientModule = ts.isModuleDeclaration(p) && p.name === n;
        if (!staticSpecifier && !ambientModule) site(n, n.getText(sf), "rejected", "rejected", "child_process loaded outside a static import (require / createRequire / dynamic import)");
      }
      // A SITE (ruled, NEW-1 (d)): a re-export of a spawn-family binding (`export { spawnSync }`, `export { spawnSync as run }`).
      if (ts.isExportSpecifier(n)) {
        const local = n.propertyName ?? n.name;
        const target = ts.isIdentifier(local) ? keyOf(resolveBinding(checker, local, rel)) : "";
        if (SPAWN_FAMILY.test(target)) site(n, n.getText(sf), "reference", "reference", "a re-export of a spawn-family function");
      }
      if (ts.isIdentifier(n)) {
        const p = n.parent;
        const declaration =
          ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isExportSpecifier(p) || (ts.isFunctionDeclaration(p) && p.name === n);
        if (!declaration) {
          const key = keyOf(resolveBinding(checker, n, rel));
          const fam = SPAWN_FAMILY.exec(key);
          if (fam) {
            const callee = ts.isCallExpression(p) && p.expression === n ? p : ts.isPropertyAccessExpression(p) && p.name === n && ts.isCallExpression(p.parent) && p.parent.expression === p ? p.parent : null;
            if (callee) classifyCall(callee, fam[1]!);
            else site(n, (ts.isPropertyAccessExpression(p) || ts.isBindingElement(p) ? p : n).getText(sf), "reference", "reference", "a spawn-family function used as a value (aliased, destructured, passed or stored)");
          } else if (CP_MODULE.test(key)) {
            // RULED (NEW-1 (a)): the namespace/default binding may appear ONLY as the object of a direct, NON-computed
            // property access (`cp.spawnSync`). Any other use (computed access, passed, stored, spread, returned,
            // destructured, including computed destructuring (b)) FAILS: the capability would leave the inventory.
            let outer: ts.Node = n;
            while (ts.isParenthesizedExpression(outer.parent) || ts.isAsExpression(outer.parent) || ts.isNonNullExpression(outer.parent) || ts.isTypeAssertionExpression(outer.parent)) outer = outer.parent;
            const direct = ts.isPropertyAccessExpression(outer.parent) && outer.parent.expression === outer;
            if (!direct) {
              const how = ts.isElementAccessExpression(outer.parent) && outer.parent.expression === outer ? "computed member access on child_process" : "the child_process namespace used as a value (passed, stored, destructured, spread or returned)";
              site(outer.parent, outer.parent.getText(sf).slice(0, 80), "rejected", "rejected", how);
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}
