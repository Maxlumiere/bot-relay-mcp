// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * PR-B invariants, enforced by construction (architect rulings e26359ac, 8c8ef8ea, 64131354):
 *   1. NO await between the FINAL authorization check and the identity/token write it authorizes:
 *      every handler in src/identity-mutators.ts has its declared shape, the dispatcher routes the
 *      tool to it, nothing awaits between the final auth-generation re-check and dispatch, and any
 *      handler in src/tools calling an identity mutator is registered.
 *   1b. ANY write derived from an awaited verify (architect 07fe7cfc): every site that awaits a verify
 *      is classified in VERIFY_SITES (matched EXACTLY against a TypeScript parse of src), and the digest
 *      heal's no-bump exception in scripts/auth-gen-guard.mjs holds only for a CAS heal. The behaviour
 *      is tested in tests/pr-b-verify-derived-writes.test.ts.
 *   2. bcrypt never runs on the event loop: a COMPARE exists only in the worker pool; HASHING only at
 *      the 8 inventoried in-transaction sites, each a NAMED exception with its reason.
 * Source is read with comments stripped, so a comment can neither satisfy nor trip a check.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
// PINNED PARSER (#212), the one the guards parse with.
import ts from "typescript-legacy";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(REPO, "src");
const { IDENTITY_MUTATING_TOOLS, IDENTITY_MUTATOR_FUNCTIONS, VERIFY_SITES, VERIFY_PRIMITIVES } = await import("../src/identity-mutators.js");
const { findAuthGenViolations } = await import("../scripts/auth-gen-guard.mjs");
const MODULES: Record<string, Record<string, unknown>> = {
  "tools/identity": await import("../src/tools/identity.js"),
  "tools/spawn": await import("../src/tools/spawn.js"),
};
const AsyncFunction = (async () => {}).constructor;

/** Source with comments removed (block and line comments; strings are left intact). */
function code(file: string): string {
  return fs
    .readFileSync(file, "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}
function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...srcFiles(full));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}
/** Each top-level `function NAME(` and the code up to the next one: the calls a function makes. */
function functionsOf(text: string): Array<{ name: string; body: string }> {
  const re = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/gm;
  const starts = [...text.matchAll(re)].map((m) => ({ name: m[1], at: m.index! }));
  return starts.map((s, i) => ({ name: s.name, body: text.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : text.length) }));
}

describe("INVARIANT 1: no await between the final authorization check and the write it authorizes", () => {
  it("every registered identity/token-mutating handler has its declared shape (sync, or its write before its first await)", () => {
    for (const [tool, reg] of Object.entries(IDENTITY_MUTATING_TOOLS)) {
      const fn = MODULES[reg.module]?.[reg.handler] as ((...a: unknown[]) => unknown) | undefined;
      expect(typeof fn, `${tool}: ${reg.module}.${reg.handler} is not a function`).toBe("function");
      if (reg.shape === "sync") {
        expect(fn!.constructor === AsyncFunction, `${tool}: ${reg.handler} is ASYNC: an await could separate its final auth check from its write`).toBe(false);
      } else {
        const text = fn!.toString();
        // The identifier, not "name(": the test runner rewrites an imported call to `(0, mod.name)(`.
        const write = text.search(new RegExp(`\\b${reg.writeBeforeFirstAwait}\\b`));
        const firstAwait = text.search(/\bawait\b/);
        expect(write, `${tool}: ${reg.handler} no longer calls ${reg.writeBeforeFirstAwait}`).toBeGreaterThanOrEqual(0);
        expect(firstAwait === -1 || write < firstAwait, `${tool}: ${reg.handler} awaits BEFORE its authorized write`).toBe(true);
      }
    }
  });

  it("the dispatcher routes each registered tool to its registered handler", () => {
    const server = code(path.join(SRC, "server.ts"));
    for (const [tool, reg] of Object.entries(IDENTITY_MUTATING_TOOLS)) {
      expect(server, `dispatch does not route ${tool} to ${reg.handler}`).toMatch(new RegExp(`case "${tool}":\\s*return ${reg.handler}\\(`));
    }
  });

  it("ONE site (architect b11ef8ad): runCall calls revalidate AFTER the last await of auth, and NOTHING awaits between it and dispatch", () => {
    const file = path.join(SRC, "server.ts");
    const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf-8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    // revalidate is the binding imported from ./auth-verdict.js, not a look-alike.
    const imported = sf.statements.some(
      (st) =>
        ts.isImportDeclaration(st) &&
        ts.isStringLiteral(st.moduleSpecifier) &&
        st.moduleSpecifier.text === "./auth-verdict.js" &&
        !!st.importClause?.namedBindings &&
        ts.isNamedImports(st.importClause.namedBindings) &&
        st.importClause.namedBindings.elements.some((e) => e.name.text === "revalidate" && !e.propertyName),
    );
    expect(imported, "revalidate is imported from ./auth-verdict.js").toBe(true);
    let runCall: ts.FunctionDeclaration | undefined;
    const find = (n: ts.Node): void => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === "runCall") runCall = n;
      ts.forEachChild(n, find);
    };
    find(sf);
    expect(runCall, "runCall exists").toBeDefined();
    const awaits: Array<{ pos: number; callee: string }> = [];
    const revalidates: number[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isAwaitExpression(n)) {
        const e = n.expression;
        awaits.push({ pos: n.getStart(sf), callee: ts.isCallExpression(e) && ts.isIdentifier(e.expression) ? e.expression.text : "?" });
      }
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "revalidate") revalidates.push(n.getEnd());
      ts.forEachChild(n, visit);
    };
    visit(runCall!);
    expect(revalidates, "runCall calls revalidate exactly once").toHaveLength(1);
    const dispatchAwait = awaits.find((a) => a.callee === "dispatch");
    const authAwait = awaits.find((a) => a.callee === "enforceAuth");
    expect(dispatchAwait && authAwait, "await enforceAuth(...) and await dispatch(...) both exist").toBeTruthy();
    expect(revalidates[0], "revalidate runs after the auth await").toBeGreaterThan(authAwait!.pos);
    const between = awaits.filter((a) => a.pos > revalidates[0] && a.pos < dispatchAwait!.pos);
    expect(between, "an await between revalidate and the handler's dispatch").toEqual([]);
  });

  it("every handler in src/tools that calls an identity/token mutator is REGISTERED (a new one cannot appear silently)", () => {
    const registered = new Set(Object.values(IDENTITY_MUTATING_TOOLS).map((r) => r.handler));
    const unregistered: string[] = [];
    for (const file of srcFiles(path.join(SRC, "tools"))) {
      for (const f of functionsOf(code(file))) {
        if (!f.name.startsWith("handle")) continue;
        const calls = IDENTITY_MUTATOR_FUNCTIONS.filter((m) => new RegExp(`\\b${m}\\(`).test(f.body.slice(f.body.indexOf("{"))));
        if (calls.length && !registered.has(f.name)) unregistered.push(`${path.relative(REPO, file)}: ${f.name} calls ${calls.join(", ")}`);
      }
    }
    expect(unregistered).toEqual([]);
  });
});

describe("INVARIANT 2: bcrypt never runs on the event loop", () => {
  it("a bcrypt COMPARE exists ONLY in the worker pool (src/bcrypt-pool.ts)", () => {
    const hits = srcFiles(SRC)
      .filter((f) => /\bcompareSync\b|\bbcrypt\s*\.\s*compare\b|\bverifyToken\b/.test(code(f)))
      .map((f) => path.relative(REPO, f));
    expect(hits).toEqual(["src/bcrypt-pool.ts"]);
  });

  /**
   * The ONLY hashing left on the loop: inside synchronous SQLite transactions, where an awaited worker
   * call is impossible (descope (A), architect 8c8ef8ea). Each is a NAMED exception. The end state (backlog):
   * hash in the pool before the transaction and retire every entry here.
   */
  const HASH_EXCEPTIONS: Record<string, { count: number; reason: string }> = {
    mintAgentToken: { count: 1, reason: "mints the token hash inside the operator mint transaction" },
    registerAgent: { count: 4, reason: "fresh token, a legacy row's first token, a new row's token, and its registration-recovery handle, all inside the register transaction" },
    rotateAgentToken: { count: 1, reason: "the rotated token's hash, inside the CAS rotate transaction" },
    rotateAgentTokenAdmin: { count: 1, reason: "the admin-rotated token's hash, inside the CAS rotate transaction" },
    revokeAgentToken: { count: 1, reason: "the recovery token's hash, inside the revoke transaction" },
  };

  it("bcrypt HASHING exists only in auth.ts hashToken, called ONLY at the 8 named in-transaction sites", () => {
    const hashSyncFiles = srcFiles(SRC).filter((f) => /\bhashSync\b|\bbcrypt\s*\.\s*hash\b/.test(code(f))).map((f) => path.relative(REPO, f));
    expect(hashSyncFiles).toEqual(["src/auth.ts"]);
    const callers = srcFiles(SRC)
      .filter((f) => !f.endsWith(path.join("src", "auth.ts")) && /\bhashToken\(/.test(code(f)))
      .map((f) => path.relative(REPO, f));
    expect(callers).toEqual(["src/db.ts"]);
    const counts: Record<string, number> = {};
    for (const f of functionsOf(code(path.join(SRC, "db.ts")))) {
      const n = (f.body.match(/\bhashToken\(/g) ?? []).length;
      if (n) counts[f.name] = n;
    }
    expect(counts).toEqual(Object.fromEntries(Object.entries(HASH_EXCEPTIONS).map(([k, v]) => [k, v.count])));
  });
});

/**
 * Every `await <verify primitive>(...)` under `root`, keyed `<file>:<enclosing top-level function>`, in source
 * order. Codex R1 #3: the callee is resolved by its BINDING, not its spelling: the TypeScript checker gives the
 * callee's type, and a function's type points at its DECLARATION, so `import { verifyCredential as check }`, a
 * `const check = verifyCredential`, a destructured dynamic import or a re-export all resolve to the same
 * primitive. The language does the resolving; nothing here matches names at call sites.
 */
function awaitedVerifySites(root: string = SRC, primitives: readonly string[] = VERIFY_PRIMITIVES): Record<string, string[]> {
  const prims = new Set<string>(primitives);
  const files = srcFiles(root);
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowJs: false,
    noEmit: true,
    skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  /** The primitive a callee resolves to (by its type's declaration), or null. */
  const primitiveOf = (callee: ts.Expression): string | null => {
    const decls = checker.getTypeAtLocation(callee).getSymbol()?.getDeclarations() ?? [];
    for (const d of decls) {
      if ((ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d)) && d.name && ts.isIdentifier(d.name) && prims.has(d.name.text)) {
        return d.name.text;
      }
    }
    return null;
  };
  const out: Record<string, string[]> = {};
  for (const file of files) {
    const sf = program.getSourceFile(file);
    if (!sf) throw new Error(`awaitedVerifySites: ${file} is not in the program`);
    const visit = (n: ts.Node, top: string): void => {
      if (ts.isFunctionDeclaration(n) && n.parent === sf) top = n.name?.text ?? "<anonymous>";
      if (ts.isAwaitExpression(n) && ts.isCallExpression(n.expression)) {
        const name = primitiveOf(n.expression.expression);
        if (name) (out[`${path.relative(REPO, file).split(path.sep).join("/")}:${top}`] ??= []).push(name);
      }
      ts.forEachChild(n, (c) => visit(c, top));
    };
    visit(sf, "<module>");
  }
  return out;
}

describe("INVARIANT 1b: every write derived from an awaited verify is classified (none, dispatcher, or guarded)", () => {
  it("VERIFY_SITES matches EXACTLY the awaited verifies in src (a new one fails here until it is classified)", () => {
    const want = Object.fromEntries(Object.entries(VERIFY_SITES).map(([k, v]) => [k, [...v.awaits]]));
    expect(awaitedVerifySites()).toEqual(want);
  });
  it("the scan is not vacuous: it finds the dashboard's verify inside an inline route handler", () => {
    expect(awaitedVerifySites()["src/transport/http.ts:startHttpServer"]).toEqual(["verifyCredential"]);
  });
  it("MUTANTS (Codex R1 #3): an ALIASED import, a const alias, a destructured dynamic import and a re-export are all found by binding", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-sites-"));
    try {
      fs.writeFileSync(path.join(dir, "prims.ts"), "export async function verifyCredential(t: string): Promise<boolean> { return t.length > 0; }\n");
      fs.writeFileSync(path.join(dir, "reexport.ts"), "export { verifyCredential as reCheck } from './prims.js';\n");
      fs.writeFileSync(
        path.join(dir, "use.ts"),
        [
          "import { verifyCredential as check } from './prims.js';",
          "import { reCheck } from './reexport.js';",
          "import { verifyCredential } from './prims.js';",
          "export async function viaAlias(): Promise<void> { await check('t'); }",
          "export async function viaConst(): Promise<void> { const c2 = verifyCredential; await c2('t'); }",
          "export async function viaDynamic(): Promise<void> { const { verifyCredential: d } = await import('./prims.js'); await d('t'); }",
          "export async function viaReexport(): Promise<void> { await reCheck('t'); }",
          "export async function notAVerify(): Promise<void> { const other = async (_: string) => true; await other('t'); }",
          "",
        ].join("\n"),
      );
      const sites = awaitedVerifySites(dir, ["verifyCredential"]);
      const key = (fn: string) => `${path.relative(REPO, path.join(dir, "use.ts")).split(path.sep).join("/")}:${fn}`;
      expect(sites[key("viaAlias")], "aliased import").toEqual(["verifyCredential"]);
      expect(sites[key("viaConst")], "const alias").toEqual(["verifyCredential"]);
      expect(sites[key("viaDynamic")], "destructured dynamic import").toEqual(["verifyCredential"]);
      expect(sites[key("viaReexport")], "re-export").toEqual(["verifyCredential"]);
      expect(sites[key("notAVerify")], "a look-alike that is not the primitive").toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the auth-gen guard's no-bump exception holds ONLY for a CAS digest heal", () => {
  const P = "function bumpAuthGeneration(){}\nfunction applyAuthStateTransition(){}\nfunction getDb(): any { return null; }\n";
  const heal = (name: string, sql: string, extra = "") =>
    `${P}function ${name}(row: any, digest: string): void {\n  getDb().prepare("${sql}").run(digest, row.name, row.token_hash, row.token_lookup);\n  ${extra}\n}\n`;
  const CAS = "UPDATE agents SET token_lookup = ? WHERE name = ? AND token_hash = ? AND token_lookup IS ?";
  const names = (src: string) => findAuthGenViolations(src).map((v: { name: string }) => v.name);
  it("the CAS heal under its registered name needs no bump (both columns)", () => {
    expect(names(heal("selfHealTokenLookup", CAS))).toEqual([]);
    expect(names(heal("selfHealTokenLookup", "UPDATE agents SET previous_token_lookup = ? WHERE name = ? AND previous_token_hash = ? AND previous_token_lookup IS ?"))).toEqual([]);
  });
  it("is a VIOLATION again when the SET is widened, the CAS is dropped or weakened, the name differs, or another mutation joins it", () => {
    const cases: Array<[string, string]> = [
      ["widened SET", heal("selfHealTokenLookup", "UPDATE agents SET token_lookup = ?, token_hash = ? WHERE name = ? AND token_hash = ? AND token_lookup IS ?")],
      ["no CAS (name only)", heal("selfHealTokenLookup", "UPDATE agents SET token_lookup = ? WHERE name = ?")],
      ["hash dropped", heal("selfHealTokenLookup", "UPDATE agents SET token_lookup = ? WHERE name = ? AND token_lookup IS ?")],
      ["OR widens the WHERE", heal("selfHealTokenLookup", "UPDATE agents SET token_lookup = ? WHERE name = ? AND token_hash = ? AND token_lookup IS ? OR 1 = 1")],
      ["mismatched pair", heal("selfHealTokenLookup", "UPDATE agents SET previous_token_lookup = ? WHERE name = ? AND token_hash = ? AND token_lookup IS ?")],
      ["another name", heal("healSomethingElse", CAS)],
      ["another mutation joins it", heal("selfHealTokenLookup", CAS, `getDb().prepare("UPDATE agents SET auth_state = 'revoked' WHERE name = ?").run(row.name);`)],
    ];
    for (const [label, src] of cases) expect(names(src).length, label).toBe(1);
  });
});
