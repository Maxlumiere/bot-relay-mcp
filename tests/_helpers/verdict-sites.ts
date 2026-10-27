// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Where code outside src/path-walk.ts touches a path-walk VERDICT (comparePaths' "same" | "different" |
 * "inconclusive"). The ONLY sanctioned shape is a comparePaths call passed DIRECTLY to isProtected(...) or
 * isTrustedMatch(...) (ruled on #357 R2): then no verdict ever exists outside path-walk.ts, so none can be
 * compared with `=== "same"`, tested for truthiness, stored, or passed on. Every other reference to comparePaths is a
 * site: a comparison, a truthiness test, a stored result, the function passed as a value, a re-export, and an element
 * access spelled with its name. Bindings are resolved with the pinned parser (aliases, namespaces), never a regex.
 */
import ts from "typescript-legacy";
import { resolveBinding, topLevelName } from "./ts-binding.js";

export interface VerdictSite {
  site: string;
  ok: boolean;
  why: string;
}

const API = "src/path-walk.ts:comparePaths";
const READERS = new Set(["src/path-walk.ts:isProtected", "src/path-walk.ts:isTrustedMatch"]);

export function verdictSites(program: ts.Program, rel: (f: string) => string, inFile: (relPath: string) => boolean): VerdictSite[] {
  const checker = program.getTypeChecker();
  const out: VerdictSite[] = [];
  const keyOf = (id: ts.Identifier) => resolveBinding(checker, id, rel)?.key ?? null;
  for (const sf of program.getSourceFiles()) {
    const file = rel(sf.fileName);
    if (sf.isDeclarationFile || !inFile(file)) continue;
    const add = (n: ts.Node, ok: boolean, why: string) => out.push({ site: `${file}:${topLevelName(n)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`, ok, why });
    const visit = (n: ts.Node): void => {
      if (ts.isStringLiteralLike(n) && n.text === "comparePaths" && !ts.isImportDeclaration(n.parent) && !ts.isExportDeclaration(n.parent)) {
        add(n, false, "the name spelled as a string (an element access or a lookup by name)");
      } else if (ts.isIdentifier(n) && n.text !== "default") {
        const p = n.parent;
        if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) {
          // importing it is fine; each USE is judged
        } else if (keyOf(n) === API) {
          if (ts.isExportSpecifier(p)) {
            add(n, false, "re-exported: a verdict could then be read anywhere");
          } else {
            // The callee: the identifier itself, or `ns.comparePaths`.
            const callee: ts.Node = ts.isPropertyAccessExpression(p) && p.name === n ? p : n;
            const call = callee.parent;
            if (!ts.isCallExpression(call) || call.expression !== callee) {
              add(n, false, "the function used as a value, not called");
            } else {
              const reader = call.parent;
              const readerKey =
                ts.isCallExpression(reader) && reader.arguments.includes(call)
                  ? ts.isIdentifier(reader.expression)
                    ? keyOf(reader.expression)
                    : ts.isPropertyAccessExpression(reader.expression) && ts.isIdentifier(reader.expression.name)
                      ? keyOf(reader.expression.name)
                      : null
                  : null;
              if (readerKey && READERS.has(readerKey)) add(n, true, "passed directly to a sanctioned reader");
              else add(n, false, "its verdict is read outside isProtected / isTrustedMatch");
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
