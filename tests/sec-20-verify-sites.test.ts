// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * SEC-20 invariant: NO consumer decides a token by its HASH alone. verifyCredential answers only "is this
 * the stored hash?", and a revoked row keeps its hash, so a consumer that called it directly let a revoked
 * agent act (/api/send-message sent its messages; mint-reuse handed its token back). A consumer calls the
 * one authorizer (src/authorize-token.ts authorizeAgentToken) or goes through the dispatcher.
 *
 * verifyCredential may be REFERENCED only inside the functions below: the primitive's own module, the
 * state-aware authenticator, and the two token LOCATORS the dispatcher's verdict then revalidates. Any other
 * reference fails here: a call, a value reference, an aliased import, a namespace member, an element access
 * by string. The source is PARSED (typescript-legacy, the pinned parser of #212), never grepped.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import ts from "typescript-legacy";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "verifyCredential";

/** `<file>:<enclosing top-level function>` where a reference is allowed. */
const ALLOWED = new Set([
  "src/token-verify.ts:verifyCredential", // its definition (and a recursive use, if one is ever added)
  "src/token-verify.ts:verifySecretHash", // the no-digest form of the same primitive
  "src/auth.ts:authenticateAgent", // the STATE-aware authenticator (revoked / recovery refused first)
  "src/db.ts:findAgentRowByToken", // locator: the dispatcher revalidates the verdict it returns
  "src/db.ts:explicitCallerCachePut", // locator: which credential matched, for the dispatcher's cache entry
]);

function enclosingTopLevel(node: ts.Node): string {
  let cur: ts.Node | undefined = node;
  let name = "<module>";
  while (cur) {
    if (ts.isFunctionDeclaration(cur) && cur.name) name = cur.name.text;
    else if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name) && cur.initializer && (ts.isArrowFunction(cur.initializer) || ts.isFunctionExpression(cur.initializer))) name = cur.name.text;
    else if (ts.isMethodDeclaration(cur) && cur.name && ts.isIdentifier(cur.name)) name = cur.name.text;
    cur = cur.parent;
  }
  return name; // the OUTERMOST named function wins (the loop walks up to the file)
}

/** Every reference to verifyCredential in one source, as `<file>:<function>` plus how it was referenced. */
export function referencesIn(rel: string, text: string): Array<{ site: string; how: string }> {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Array<{ site: string; how: string }> = [];
  const visit = (n: ts.Node): void => {
    // import { verifyCredential } / import { verifyCredential as x }: the import itself is not a use, but an ALIAS is
    // refused outright (a renamed binding is how a name-matching guard is walked around).
    if (ts.isImportSpecifier(n) && (n.propertyName ?? n.name).text === NAME) {
      if (n.propertyName && n.name.text !== NAME) out.push({ site: `${rel}:<module>`, how: `aliased import as ${n.name.text}` });
      return;
    }
    // const { verifyCredential: x } = await import(...): the same, for a destructured dynamic import.
    if (ts.isBindingElement(n) && ((n.propertyName && ts.isIdentifier(n.propertyName) && n.propertyName.text === NAME) || (!n.propertyName && ts.isIdentifier(n.name) && n.name.text === NAME))) {
      out.push({ site: `${rel}:${enclosingTopLevel(n)}`, how: n.propertyName && ts.isIdentifier(n.name) && n.name.text !== NAME ? `destructured as ${n.name.text}` : "destructured" });
      return;
    }
    if (ts.isIdentifier(n) && n.text === NAME) {
      const p = n.parent;
      const isDecl = (ts.isFunctionDeclaration(p) && p.name === n) || (ts.isExportSpecifier(p));
      if (!isDecl) out.push({ site: `${rel}:${enclosingTopLevel(n)}`, how: ts.isCallExpression(p) && p.expression === n ? "call" : ts.isPropertyAccessExpression(p) ? "member" : "reference" });
    }
    if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && n.argumentExpression.text === NAME) {
      out.push({ site: `${rel}:${enclosingTopLevel(n)}`, how: "element access" });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function srcFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) srcFiles(full, out);
    else if (/\.(ts|tsx|mts|cts)$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

describe("the scanner (both legs, on synthetic sources)", () => {
  it("flags a direct call, a value reference, an aliased import, a destructured dynamic import, a namespace member and an element access", () => {
    const bad = [
      `import { verifyCredential } from "./token-verify.js";\nexport async function consumer(t: string) { return verifyCredential("a", { hash: "h" }, t); }`,
      `import { verifyCredential } from "./token-verify.js";\nconst f = verifyCredential;\nexport { f };`,
      `import { verifyCredential as vc } from "./token-verify.js";\nexport async function c(t: string) { return vc("a", { hash: "h" }, t); }`,
      `export async function c(t: string) { const { verifyCredential: v } = await import("./token-verify.js"); return v("a", { hash: "h" }, t); }`,
      `import * as tv from "./token-verify.js";\nexport async function c(t: string) { return tv.verifyCredential("a", { hash: "h" }, t); }`,
      `import * as tv from "./token-verify.js";\nexport async function c(t: string) { return tv["verifyCredential"]("a", { hash: "h" }, t); }`,
    ];
    for (const src of bad) expect(referencesIn("src/x.ts", src).filter((r) => !ALLOWED.has(r.site)).length, src).toBeGreaterThan(0);
  });
  it("passes an allowed site and a file that only uses the authorizer", () => {
    expect(referencesIn("src/auth.ts", `import { verifyCredential } from "./token-verify.js";\nexport async function authenticateAgent(t: string) { return verifyCredential("a", { hash: "h" }, t); }`).filter((r) => !ALLOWED.has(r.site))).toEqual([]);
    expect(referencesIn("src/y.ts", `import { authorizeAgentToken } from "./authorize-token.js";\nexport async function c(t: string) { return authorizeAgentToken("a", t); }`)).toEqual([]);
  });
});

describe("src: verifyCredential is referenced ONLY by the primitive, the state-aware authenticator and the locators", () => {
  const all = srcFiles(path.join(REPO, "src")).flatMap((f) => referencesIn(path.relative(REPO, f).split(path.sep).join("/"), fs.readFileSync(f, "utf-8")));
  it("precondition: the scan sees the allowed sites (it is not blind)", () => {
    const seen = new Set(all.map((r) => r.site));
    for (const s of ["src/auth.ts:authenticateAgent", "src/db.ts:findAgentRowByToken", "src/token-verify.ts:verifySecretHash"]) expect(seen.has(s), s).toBe(true);
  });
  it("no other site references it", () => {
    expect(all.filter((r) => !ALLOWED.has(r.site)).map((r) => `${r.site} (${r.how})`)).toEqual([]);
  });
});
