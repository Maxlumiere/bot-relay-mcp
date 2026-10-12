// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * BINDING-RESOLVED references for the SEC-20 pins: the TypeScript checker (the pinned typescript-legacy of #212) resolves
 * each identifier to its declaration, through import aliases, re-exports, namespace imports and shorthand object values.
 * `resolveBinding` is the ONE resolver of the verify-sites pin (SEC-20.T3) and the async-handler inventory. The T2 SQL
 * pin keeps its own until it is retired (the auth_state edge trigger replaces it); it shares only program construction.
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

/**
 * What an identifier BINDS to: `<declaring file>:<symbol>` and the declaration, or null. A shorthand object value
 * (`{ verifyCredential }`) binds to the VALUE it carries, not to the new object's property (Codex #316 R1 #2: the
 * property symbol belongs to the consumer's object, so the escape was invisible).
 */
export function resolveBinding(checker: ts.TypeChecker, id: ts.Identifier, rel: (f: string) => string): { key: string; decl: ts.Declaration } | null {
  const p = id.parent;
  let sym = ts.isShorthandPropertyAssignment(p) && p.name === id ? checker.getShorthandAssignmentValueSymbol(p) : checker.getSymbolAtLocation(id);
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  const decl = sym?.declarations?.[0];
  if (!sym || !decl) return null;
  return { key: `${rel(decl.getSourceFile().fileName)}:${sym.name}`, decl };
}

/** Every binding-resolved reference to a pinned API in `program`'s files under `rootRel`. */
export function pinnedReferences(program: ts.Program, rel: (f: string) => string, pinned: string[]): Array<{ api: string; site: string; how: string }> {
  const checker = program.getTypeChecker();
  const out: Array<{ api: string; site: string; how: string }> = [];
  const keyOf = (id: ts.Identifier): string | null => {
    const b = resolveBinding(checker, id, rel);
    return b && pinned.includes(b.key) ? b.key : null;
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
          const key = keyOf(n);
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

