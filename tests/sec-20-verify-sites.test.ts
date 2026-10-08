// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * SEC-20 invariant: NO consumer decides a token by its hash or digest alone, and every token locator's consumer
 * revalidates. A revoke KEEPS the hash, so a hash match says nothing about whether the agent may act: a consumer
 * goes through the one authorizer (src/authorize-token.ts authorizeAgentToken) or the dispatcher.
 *
 * Codex #315 R1 P2 (DESIGN): round 1 pinned one SPELLING (verifyCredential). This pins the low-level verify and
 * digest APIs and the token locators by BINDING: every reference in src is resolved with the TypeScript checker
 * (the pinned typescript-legacy of #212) to its declaration, through import aliases, re-exports and namespace
 * imports, called, awaited or passed as a value. Each API's references must sit in its listed consumers; a new
 * consumer fails here until it is reviewed and listed.
 *
 * STATED RESIDUAL (by ruling; this guards DRIFT, not an adversarial author): references the checker cannot bind
 * are NOT seen: computed member access (`m[name]`), eval, require() by a variable, a dynamic import by a computed
 * specifier (also refused by #212's gate).
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import ts from "typescript-legacy";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The pinned APIs: `<declaring file>:<export>` -> the `<file>:<top-level function>` sites allowed to reference it. */
const PINNED: Record<string, { allowed: string[]; why: string }> = {
  "src/token-verify.ts:verifyCredential": {
    allowed: ["src/token-verify.ts:verifySecretHash", "src/auth.ts:authenticateAgent", "src/db.ts:findAgentRowByToken", "src/db.ts:explicitCallerCachePut"],
    why: "the hash primitive: only the state-aware authenticator and the two locators (the dispatcher revalidates their verdicts)",
  },
  "src/token-verify.ts:verifySecretHash": {
    allowed: ["src/server.ts:createServer", "src/db.ts:abandonRegistration"],
    why: "a recovery / registration-recovery HANDLE (no digest): verified in the dispatcher, or under a CAS on the verified hash",
  },
  "src/bcrypt-pool.ts:compareOffLoop": { allowed: ["src/token-verify.ts:verifyCredential"], why: "the pooled bcrypt: only the primitive" },
  "src/token-lookup.ts:digestVerdict": {
    allowed: ["src/token-verify.ts:verifyCredential", "src/db.ts:findAgentRowByToken", "src/db.ts:explicitCallerCachePut"],
    why: "the digest decision: the primitive, and the two locators choosing WHICH stored credential to verify (never an authorization)",
  },
  "src/token-lookup.ts:computeTokenLookup": {
    allowed: ["src/db.ts:mintAgentToken", "src/db.ts:registerAgent", "src/db.ts:rotateAgentToken", "src/db.ts:rotateAgentTokenAdmin", "src/db.ts:resolveAgentByTokenVerdict", "src/db.ts:explicitCallerCacheGetVerdict", "src/db.ts:explicitCallerCachePut"],
    why: "WRITERS of the digest (mint, register, rotate), and the verified-token CACHE key (a hit is a verdict the dispatcher revalidates)",
  },
  // Codex #315 R2 N5: the digest CANDIDATES and the raw lookup KEYS can decide a token as surely as digestVerdict
  // (`tokenLookupCandidates(t).includes(row.token_lookup)` is a hash-only authorization). Every token-lookup.ts export
  // was reviewed: storedLookupKeyId, unreachableLookupRanges and KEY_ID_SEPARATOR never see a token (key ids and
  // index ranges only), and _resetTokenLookupCacheForTests is a test seam; they are not pinned.
  "src/token-lookup.ts:tokenLookupCandidates": { allowed: ["src/db.ts:findAgentRowByToken"], why: "the digest forms of a presented token: only the locator's indexed lookup" },
  "src/token-lookup.ts:lookupKeys": {
    allowed: ["src/token-lookup.ts:computeTokenLookup", "src/token-lookup.ts:digestVerdict", "src/token-lookup.ts:tokenLookupCandidates", "src/token-lookup.ts:unreachableLookupRanges", "src/db.ts:tokenDigestReport"],
    why: "the raw HMAC keys: the digest functions themselves, the index-range planner, and the doctor report (key ids only)",
  },
  "src/db.ts:findAgentRowByToken": {
    allowed: ["src/db.ts:resolveAgentByTokenVerdict", "src/tools/status.ts:checkToken"],
    why: "the locator: the dispatcher's resolver (its verdict is revalidated) and health_check (followed by authorizeAgentToken + revalidate)",
  },
  "src/db.ts:resolveAgentByToken": { allowed: [], why: "no consumer today; a new one is reviewed here" },
  "src/db.ts:resolveAgentByTokenVerdict": { allowed: ["src/db.ts:resolveAgentByToken", "src/server.ts:createServer"], why: "the dispatcher's token-only resolver (its verdict is revalidated)" },
  "src/db.ts:explicitCallerCachePut": { allowed: ["src/server.ts:createServer"], why: "the dispatcher's cache fill (generation-bound; every hit is revalidated)" },
  "src/auth.ts:authenticateAgent": { allowed: ["src/server.ts:createServer", "src/authorize-token.ts:authorizeAgentToken"], why: "the state-aware half of authorization: the dispatcher and the one authorizer, each followed by revalidate" },
};

function topLevelName(node: ts.Node): string {
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

function srcProgram(): ts.Program {
  const cfgPath = path.join(REPO, "tsconfig.json");
  const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, REPO);
  return ts.createProgram({ rootNames: parsed.fileNames, options: { ...parsed.options, noEmit: true } });
}

/** A program over VIRTUAL files (for the checker's own legs). */
function virtualProgram(files: Record<string, string>): ts.Program {
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

const relOf = (f: string) => path.relative(REPO, f).split(path.sep).join("/");

describe("the checker (both legs, on virtual sources bound to a pinned API)", () => {
  const base = { "src/token-verify.ts": "export async function verifyCredential(..._a: unknown[]) { return 'ok'; }" };
  const run = (consumer: string, extra: Record<string, string> = {}) =>
    pinnedReferences(virtualProgram({ ...base, ...extra, "src/consumer.ts": consumer }), (f) => path.relative("/virtual", f).split(path.sep).join("/"), ["src/token-verify.ts:verifyCredential"]).filter((r) => r.site.startsWith("src/consumer.ts"));
  it("precondition: the virtual program RESOLVES its imports (no diagnostic), so a miss below is the scanner's, not the fixture's", () => {
    const prog = virtualProgram({ ...base, "src/consumer.ts": `import { verifyCredential } from "./token-verify.js";\nexport function c() { return verifyCredential(); }` });
    expect(ts.getPreEmitDiagnostics(prog).map((d) => ts.flattenDiagnosticMessageText(d.messageText, " ")).filter((m) => /Cannot find module/.test(m))).toEqual([]);
  });
  it("finds a direct call, an ALIASED import, a RE-EXPORT, a NAMESPACE member, a value reference and a NON-awaited call", () => {
    expect(run(`import { verifyCredential } from "./token-verify.js";\nexport async function c() { return verifyCredential(); }`).length).toBe(1);
    expect(run(`import { verifyCredential as vc } from "./token-verify.js";\nexport async function c() { return vc(); }`).length).toBe(1);
    expect(run(`import { again } from "./re.js";\nexport function c() { return again(); }`, { "src/re.ts": `export { verifyCredential as again } from "./token-verify.js";` }).length).toBe(1);
    expect(run(`import * as tv from "./token-verify.js";\nexport function c() { return tv.verifyCredential(); }`).length).toBe(1);
    expect(run(`import { verifyCredential } from "./token-verify.js";\nexport const f = verifyCredential;`).length).toBe(1);
    expect(run(`import { verifyCredential } from "./token-verify.js";\nexport function c() { void verifyCredential().then(() => 1); }`).length).toBe(1);
  });
  it("Codex #315 R2 N5, the exact bypass: `tokenLookupCandidates(token).includes(row.token_lookup)` is a reference to a PINNED API", () => {
    const files = {
      "src/token-lookup.ts": "export function tokenLookupCandidates(t: string): string[] { return [t]; }",
      "src/consumer.ts": `import { tokenLookupCandidates } from "./token-lookup.js";\nexport function authorizes(token: string, row: { token_lookup: string | null }) { return tokenLookupCandidates(token).includes(row.token_lookup!); }`,
    };
    const refs = pinnedReferences(virtualProgram(files), (f) => path.relative("/virtual", f).split(path.sep).join("/"), ["src/token-lookup.ts:tokenLookupCandidates"]);
    expect(refs.map((r) => r.site)).toEqual(["src/consumer.ts:authorizes"]);
    expect(PINNED["src/token-lookup.ts:tokenLookupCandidates"].allowed).not.toContain("src/consumer.ts:authorizes");
  });
  it("does NOT flag a same-named LOCAL function (the binding, not the spelling, decides)", () => {
    expect(run(`function verifyCredential() { return 1; }\nexport function c() { return verifyCredential(); }`)).toEqual([]);
  });
});

describe("src: every pinned verify / digest / locator API is referenced ONLY by its listed consumers", () => {
  const refs = pinnedReferences(srcProgram(), relOf, Object.keys(PINNED));
  it("precondition: the scan sees the known consumers (it is not blind)", () => {
    for (const [api, site] of [["src/token-verify.ts:verifyCredential", "src/auth.ts:authenticateAgent"], ["src/auth.ts:authenticateAgent", "src/authorize-token.ts:authorizeAgentToken"], ["src/token-lookup.ts:computeTokenLookup", "src/db.ts:registerAgent"]]) {
      expect(refs.some((r) => r.api === api && r.site === site), `${api} @ ${site}`).toBe(true);
    }
  });
  it("no reference outside its API's allowlist", () => {
    expect(refs.filter((r) => !PINNED[r.api].allowed.includes(r.site)).map((r) => `${r.api} referenced by ${r.site} (${r.how})`)).toEqual([]);
  });
  it("no stale allowlist entry (each listed consumer still references its API)", () => {
    const stale = Object.entries(PINNED).flatMap(([api, p]) => p.allowed.filter((site) => !refs.some((r) => r.api === api && r.site === site)).map((site) => `${api} no longer used by ${site}`));
    expect(stale).toEqual([]);
  });
});
