// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * INV-DB-01 slice 2b-i's scanner (the SEC-22 pattern, ruling e6e1b44e Q3): every REFERENCE in a program's files to
 * a node fs function that opens a FILE descriptor on a path (resolved through import aliases and namespaces by the pinned
 * typescript-legacy checker, never matched by name). Closing any descriptor to a file drops every POSIX lock the
 * process holds on it, so an fs open of a DB-family file in a process holding a native connection to it is the
 * lock-drop hazard; the inventory (tests/inv-db-01-fs-open-scan.test.ts) names every site and the SOURCE of its path.
 *
 * A site's key is `<file>::<enclosing top-level function>::<api>`; the inventory pins how many sites each key has, so
 * a new or moved site fails until it is listed with its reason.
 *   - a CALL or any other value use (an alias, a destructured property, an argument, a stored value) of an opener;
 *   - REJECTED: the fs module named outside a static import (require, createRequire()(), dynamic import), a loader
 *     with a non-literal specifier, computed member access on the module, and the namespace used as a value.
 * NAMED BOUNDARY (not seen, by design): code outside the scanned files (dependencies), and a descriptor opened by a
 * native addon (better-sqlite3's own opens, which SQLite's VFS manages).
 */
import ts from "typescript-legacy";
import { resolveBinding, topLevelName } from "./ts-binding.js";

/**
 * The fs functions that open a FILE descriptor on a path (stat, exists, mkdir, chmod, rename, unlink do not). Out of
 * scope by design: DIRECTORY openers (opendir, readdir). POSIX record locks belong to a (process, inode) pair, so
 * closing a descriptor on a directory releases only locks on that directory, never the DB file's or its -shm's.
 */
const OPENERS = [
  "open", "openSync", "readFile", "readFileSync", "writeFile", "writeFileSync", "appendFile", "appendFileSync",
  "createReadStream", "createWriteStream", "copyFile", "copyFileSync", "cp", "cpSync", "truncate", "truncateSync",
  "watch", "watchFile", "openAsBlob",
];
const apiPattern = (apis: readonly string[]) => new RegExp(`(?:^|/)@types/node/(?:fs|fs/promises)\\.d\\.ts:(${apis.join("|")})$`);
/**
 * INV-DB-01 slice 3: the fs functions that REMOVE a path (the never-unlink scan: relay code never unlinks a DB-family
 * file, side files included; the slice-3 ruling). Passed to fsOpenSites as its `apis`.
 */
export const REMOVERS = ["unlink", "unlinkSync", "rm", "rmSync", "rmdir", "rmdirSync"] as const;
const FS_MODULE = /@types\/node\/(?:fs|fs\/promises)\.d\.ts:"(?:node:)?fs(?:\/promises)?"$/;
const FS_SPECIFIER = /^(node:)?fs(\/promises)?$/;

export interface FsOpenSite {
  /** `<file>::<enclosing top-level function>::<api>` (or `::rejected`). */
  key: string;
  api: string;
  /** The site's FULL source text (the never-unlink scan pins it exactly; Codex #391 R1). */
  text: string;
  why?: string;
}

export function fsOpenSites(
  program: ts.Program,
  rel: (f: string) => string,
  inFile: (relPath: string) => boolean,
  apis: readonly string[] = OPENERS,
): FsOpenSite[] {
  const OPENER = apiPattern(apis);
  const checker = program.getTypeChecker();
  const out: FsOpenSite[] = [];
  const keyOf = (b: { key: string } | null) => b?.key ?? "";
  for (const sf of program.getSourceFiles()) {
    const file = rel(sf.fileName);
    if (!inFile(file) || sf.isDeclarationFile) continue;
    const site = (n: ts.Node, api: string, why?: string) =>
      out.push({ key: `${file}::${topLevelName(n)}::${api}`, api, text: n.getText(sf), ...(why ? { why } : {}) });

    const isLoaderCall = (c: ts.CallExpression): boolean => {
      if (c.expression.kind === ts.SyntaxKind.ImportKeyword) return true;
      if (ts.isIdentifier(c.expression) && c.expression.text === "require") return true;
      if (ts.isCallExpression(c.expression) && ts.isIdentifier(c.expression.expression) && c.expression.expression.text === "createRequire") return true;
      return false;
    };

    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && isLoaderCall(n)) {
        const spec = n.arguments[0];
        if (!spec || !(ts.isStringLiteral(spec) || ts.isNoSubstitutionTemplateLiteral(spec))) site(n, "rejected", "a module loader with a non-literal specifier");
      }
      if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && FS_SPECIFIER.test(n.text)) {
        const p = n.parent;
        const staticSpecifier = (ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) && p.moduleSpecifier === n;
        const ambient = ts.isModuleDeclaration(p) && p.name === n;
        if (!staticSpecifier && !ambient) site(n, "rejected", "fs loaded outside a static import");
      }
      if (ts.isExportDeclaration(n) && !n.exportClause && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && FS_SPECIFIER.test(n.moduleSpecifier.text)) {
        site(n, "rejected", "export * from fs re-exports every opener");
      }
      if (ts.isIdentifier(n)) {
        const p = n.parent;
        const declaration = ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isExportSpecifier(p) || (ts.isFunctionDeclaration(p) && p.name === n);
        if (!declaration) {
          const key = keyOf(resolveBinding(checker, n, rel));
          const m = OPENER.exec(key);
          if (m) {
            const isCall = (ts.isCallExpression(p) && p.expression === n) || (ts.isPropertyAccessExpression(p) && p.name === n && ts.isCallExpression(p.parent) && p.parent.expression === p);
            site(isCall ? (ts.isCallExpression(p) ? p : p.parent) : n, isCall ? m[1]! : `${m[1]!} (reference)`);
          } else if (FS_MODULE.test(key)) {
            // `fs.promises` names the fs/promises module through a member: the access itself is the module value.
            let outer: ts.Node = ts.isPropertyAccessExpression(p) && p.name === n ? p : n;
            while (ts.isParenthesizedExpression(outer.parent) || ts.isAsExpression(outer.parent) || ts.isNonNullExpression(outer.parent)) outer = outer.parent;
            // A TYPE position (`fs.Stats`, `typeof fs.promises`) is a qualified name, not a value: it opens nothing.
            const typeOnly = ts.isQualifiedName(outer.parent);
            const direct = typeOnly || (ts.isPropertyAccessExpression(outer.parent) && outer.parent.expression === outer);
            // `fs.promises.x` is two direct accesses: allowed (the opener itself is then seen as an identifier).
            if (!direct) {
              const how = ts.isElementAccessExpression(outer.parent) && outer.parent.expression === outer ? "computed member access on fs" : "the fs namespace used as a value";
              site(outer.parent, "rejected", how);
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

/** Sites grouped by key, with their count. */
export function siteCounts(sites: FsOpenSite[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of sites) out[s.key] = (out[s.key] ?? 0) + 1;
  return out;
}
