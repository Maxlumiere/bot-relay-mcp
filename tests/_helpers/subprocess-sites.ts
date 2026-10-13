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
    /** The value of a literal option, or why it cannot be read: "absent" | "unreadable" | the initializer. */
    const option = (opts: ts.Expression | undefined, name: string): ts.Expression | "absent" | "unreadable" => {
      if (!opts) return "absent";
      if (!ts.isObjectLiteralExpression(opts)) return "unreadable";
      let found: ts.Expression | "absent" | "unreadable" = "absent";
      for (const p of opts.properties) {
        if (ts.isSpreadAssignment(p)) found = "unreadable"; // a spread may carry it, unless a later literal property overrides
        else if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name) found = p.initializer;
        else if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) found = "unreadable";
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

    const visit = (n: ts.Node): void => {
      // REJECTED: the module named outside a static import/export (require, createRequire()(), dynamic import).
      if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && CP_SPECIFIER.test(n.text)) {
        const p = n.parent;
        const staticSpecifier = (ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) && p.moduleSpecifier === n;
        const ambientModule = ts.isModuleDeclaration(p) && p.name === n;
        if (!staticSpecifier && !ambientModule) site(n, n.getText(sf), "rejected", "rejected", "child_process loaded outside a static import (require / createRequire / dynamic import)");
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
            // Through casts, parentheses and non-null assertions: `(cp as any)["spawnSync"]` is the same access.
            let outer: ts.Node = n;
            while (ts.isParenthesizedExpression(outer.parent) || ts.isAsExpression(outer.parent) || ts.isNonNullExpression(outer.parent) || ts.isTypeAssertionExpression(outer.parent)) outer = outer.parent;
            if (ts.isElementAccessExpression(outer.parent) && outer.parent.expression === outer) {
              site(outer.parent, outer.parent.getText(sf), "rejected", "rejected", "computed member access on child_process");
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
