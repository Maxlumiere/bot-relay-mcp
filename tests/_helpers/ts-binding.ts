// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * BINDING-RESOLVED references for the SEC-20 pins (tests/sec-20-verify-sites.test.ts, tests/sec-20-t2-auth-state-writes.test.ts):
 * the TypeScript checker (the pinned typescript-legacy of #212) resolves each identifier to its declaration, through
 * import aliases, re-exports and namespace imports. ONE implementation for both pins.
 */
import path from "path";
import { fileURLToPath } from "url";
import ts from "typescript-legacy";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function topLevelName(node: ts.Node): string {
  let name = "<module>";
  for (let cur: ts.Node | undefined = node; cur; cur = cur.parent) {
    if (ts.isFunctionDeclaration(cur) && cur.name) name = cur.name.text;
    else if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name) && cur.initializer && (ts.isArrowFunction(cur.initializer) || ts.isFunctionExpression(cur.initializer))) name = cur.name.text;
  }
  return name;
}

/** Every binding-resolved reference to a pinned API in `program`'s files under `rootRel`. */
export function pinnedReferences(program: ts.Program, rel: (f: string) => string, pinned: string[]): Array<{ api: string; site: string; how: string }> {
  const checker = program.getTypeChecker();
  const out: Array<{ api: string; site: string; how: string }> = [];
  const keyOf = (sym: ts.Symbol | undefined): string | null => {
    if (!sym) return null;
    let s = sym;
    if (s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
    const d = s.declarations?.[0];
    if (!d) return null;
    const key = `${rel(d.getSourceFile().fileName)}:${s.name}`;
    return pinned.includes(key) ? key : null;
  };
  for (const sf of program.getSourceFiles()) {
    const file = rel(sf.fileName);
    if (!file.startsWith("src/") || sf.isDeclarationFile) continue;
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n)) {
        const p = n.parent;
        const isOwnDecl = ts.isFunctionDeclaration(p) && p.name === n;
        const inImportExport = ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isExportSpecifier(p);
        if (!isOwnDecl && !inImportExport) {
          const key = keyOf(checker.getSymbolAtLocation(n));
          if (key) out.push({ api: key, site: `${file}:${topLevelName(n)}`, how: ts.isCallExpression(p) && p.expression === n ? "call" : ts.isPropertyAccessExpression(p) ? "member" : "reference" });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

export function srcProgram(): ts.Program {
  const cfgPath = path.join(REPO, "tsconfig.json");
  const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, REPO);
  return ts.createProgram({ rootNames: parsed.fileNames, options: { ...parsed.options, noEmit: true } });
}

/** A program over VIRTUAL files (for the checker's own legs). */
export function virtualProgram(files: Record<string, string>): ts.Program {
  const options: ts.CompilerOptions = { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2022, noEmit: true };
  const host = ts.createCompilerHost(options);
  const abs = (f: string) => path.join("/virtual", f);
  const byAbs = new Map(Object.entries(files).map(([k, v]) => [abs(k), v]));
  host.fileExists = (f) => byAbs.has(f) || ts.sys.fileExists(f);
  host.readFile = (f) => byAbs.get(f) ?? ts.sys.readFile(f);
  // Module resolution walks DIRECTORIES too: the virtual ones must exist for it, or no import resolves (a blind leg).
  host.directoryExists = (d) => [...byAbs.keys()].some((k) => k.startsWith(`${d}/`)) || ts.sys.directoryExists(d);
  host.realpath = (f) => f;
  const orig = host.getSourceFile.bind(host);
  host.getSourceFile = (f, lang) => (byAbs.has(f) ? ts.createSourceFile(f, byAbs.get(f)!, lang, true) : orig(f, lang));
  return ts.createProgram({ rootNames: [...byAbs.keys()], options, host });
}

