// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * SEC-20.T2 (gate row): NO path other than `relay recover` turns a revoked or recovery_pending agent ACTIVE.
 *
 * The structural half. Every SQL statement in src that can make a row's auth_state 'active' is found by PARSING
 * the source (typescript-legacy, the pinned parser of #212), never by grep (a grep misses a statement split across
 * lines or built from parts): each string expression (literals, templates, and `+` chains of them) is folded into
 * one text, and any that UPDATEs agents assigning auth_state, or INSERTs / REPLACEs INTO agents, is a SITE.
 * Every site is listed below by `<file>:<function>` with WHY it cannot revive a revoked row; a new site, or a
 * changed count at a listed one, fails here until it is reviewed and listed. tests/sec-20-revoked-cannot-send.test.ts
 * holds the behavioural half (every mint/register/rotate path on a revoked row leaves it revoked).
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import ts from "typescript-legacy";
import { srcProgram, topLevelName, virtualProgram } from "./_helpers/ts-binding.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Fold a string expression (literal, template, `+` chain, parenthesized) into its text; null if not a string. */
function foldString(n: ts.Node): string | null {
  if (ts.isStringLiteralLike(n)) return n.text;
  if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map((s) => "${…}" + s.literal.text).join("");
  if (ts.isParenthesizedExpression(n)) return foldString(n.expression);
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = foldString(n.left);
    const r = foldString(n.right);
    if (l !== null || r !== null) return (l ?? "${…}") + (r ?? "${…}");
  }
  return null;
}

export interface Site { site: string; kind: "update-auth_state" | "insert" | "replace" | "upsert"; sql: string }

/**
 * Codex #315 R2 N3: STRUCTURE, not spelling. Identifier quoting ("x", `x`, [x]) and a schema qualifier (main.agents)
 * are normalized away, statements are split on `;`, and each is matched by its SQL shape: UPDATE [OR <conflict>]
 * agents SET … (the SET list, up to WHERE / FROM / RETURNING), INSERT [OR <conflict>] INTO agents (an ON CONFLICT …
 * DO UPDATE is an upsert), REPLACE INTO / INSERT OR REPLACE. A builder's bare `auth_state = ?` SET fragment counts.
 */
export function classifySql(raw: string): Site["kind"][] {
  const norm = raw
    .replace(/"([A-Za-z_]\w*)"/g, "$1")
    .replace(/`([A-Za-z_]\w*)`/g, "$1")
    .replace(/\[([A-Za-z_]\w*)\]/g, "$1")
    .replace(/\b\w+\.agents\b/gi, "agents")
    .replace(/\s+/g, " ")
    .toLowerCase();
  const kinds: Site["kind"][] = [];
  for (const stmt of norm.split(";")) {
    if (/\breplace into agents\b/.test(stmt) || /\binsert or replace into agents\b/.test(stmt)) kinds.push("replace");
    else if (/\binsert (?:or \w+ )?into agents\b/.test(stmt)) kinds.push(/\bon conflict\b[\s\S]*\bdo update\b/.test(stmt) ? "upsert" : "insert");
    else {
      const m = /\bupdate (?:or \w+ )?agents set (.*?)(?: where | from | returning |$)/.exec(stmt);
      if (m && /\bauth_state\s*=/.test(m[1])) kinds.push("update-auth_state");
      else if (/^\s*auth_state\s*=\s*\?/.test(stmt)) kinds.push("update-auth_state");
    }
  }
  return kinds;
}

/** Every statement in one source that can set a row's auth_state. Outermost string expressions only. */
export function authStateWritesIn(rel: string, text: string): Site[] {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: Site[] = [];
  const visit = (n: ts.Node): void => {
    const folded = foldString(n);
    if (folded !== null) {
      const site = `${rel}:${topLevelName(n)}`;
      for (const kind of classifySql(folded)) out.push({ site, kind, sql: folded.replace(/\s+/g, " ") });
      return; // an outer string expression already covers its parts
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
    else if (/\.ts$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/**
 * Every site, with WHY it cannot turn a revoked or recovery_pending row active. Count = statements at that site.
 * The way back from a revoke is `relay recover` (it DELETEs the row; a fresh register INSERTs a new one), and,
 * for recovery_pending only, register_agent with the row's own recovery token (the dispatcher checks it).
 */
const ALLOWED: Record<string, { kinds: Partial<Record<Site["kind"], number>>; why: string }> = {
  "src/db.ts:migrateSchemaToV2_1": { kinds: { "update-auth_state": 1 }, why: "active -> legacy_bootstrap for hash-less rows; never writes active" },
  "src/db.ts:applyAuthStateTransition": { kinds: { "update-auth_state": 1 }, why: "the generic CAS helper (WHERE auth_state = expected from-state); its calls are checked below" },
  "src/db.ts:mintAgentToken": { kinds: { insert: 1, "update-auth_state": 1 }, why: "INSERT: a NEW name only (no upsert). UPDATE (--force): refuses a revoked / recovery_pending row (RevokedAgentMintError, SEC-20.T2)" },
  "src/db.ts:registerAgent": { kinds: { insert: 1, "update-auth_state": 1 }, why: "INSERT: a NEW name only. UPDATE: CAS on the existing state; revoked stays revoked; recovery_pending -> active only after the dispatcher verified its recovery token (spawn_agent refuses existing names)" },
  "src/db.ts:rotateAgentToken": { kinds: { "update-auth_state": 1 }, why: "active -> rotation_grace only (WHERE auth_state = 'active')" },
  "src/db.ts:rotateAgentTokenAdmin": { kinds: { "update-auth_state": 1 }, why: "active -> rotation_grace only (WHERE auth_state = 'active')" },
  "src/db.ts:revokeAgentToken": { kinds: { "update-auth_state": 1 }, why: "-> revoked / recovery_pending; never writes active" },
};

/**
 * Every reference to applyAuthStateTransition, resolved BY BINDING (Codex #315 R2 N3: an aliased import escaped the
 * spelling check). Each must be a DIRECT call with literal from/to states; any other use (a value, an alias passed
 * on, a computed state) is unclassified and fails.
 */
const TRANSITION = "src/db.ts:applyAuthStateTransition";
export function transitionUses(program: ts.Program, rel: (f: string) => string): Array<{ site: string; from: string | null; to: string | null; direct: boolean }> {
  const checker = program.getTypeChecker();
  const out: Array<{ site: string; from: string | null; to: string | null; direct: boolean }> = [];
  const lit = (n: ts.Node | undefined) => (n && ts.isStringLiteralLike(n) ? n.text : null);
  const bound = (id: ts.Identifier): boolean => {
    let sym = checker.getSymbolAtLocation(id);
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    const d = sym?.declarations?.[0];
    return !!d && `${rel(d.getSourceFile().fileName)}:${sym!.name}` === TRANSITION;
  };
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !rel(sf.fileName).startsWith("src/")) continue;
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n)) {
        const p = n.parent;
        const skip = (ts.isFunctionDeclaration(p) && p.name === n) || ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isExportSpecifier(p);
        if (!skip && bound(n)) {
          // The callee: `f(...)` or `ns.f(...)`. Anything else (a value, a property read) is not a reviewable call.
          const calleeExpr = ts.isPropertyAccessExpression(p) && p.name === n ? p : n;
          const call = calleeExpr.parent;
          const direct = !!call && ts.isCallExpression(call) && call.expression === calleeExpr;
          out.push({ site: `${rel(sf.fileName)}:${topLevelName(n)}`, from: direct ? lit((call as ts.CallExpression).arguments[1]) : null, to: direct ? lit((call as ts.CallExpression).arguments[2]) : null, direct });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

const files = srcFiles(path.join(REPO, "src")).map((f) => ({ rel: path.relative(REPO, f).split(path.sep).join("/"), text: fs.readFileSync(f, "utf-8") }));
const all = files.flatMap((f) => authStateWritesIn(f.rel, f.text));
const transitions = transitionUses(srcProgram(), (f) => path.relative(REPO, f).split(path.sep).join("/"));

describe("the scanner (both legs, on synthetic sources)", () => {
  it("finds a statement split across `+` lines, a template, an INSERT OR REPLACE, an upsert and a builder's SET fragment", () => {
    const src = [
      `export function a() { db.prepare("UPDATE agents SET last_seen = ?, " + "auth_state = 'active' " + "WHERE name = ?").run(); }`,
      "export function b(x: string) { db.exec(`UPDATE agents SET auth_state = 'active', x = ${x} WHERE name = 'n'`); }",
      `export function c() { db.prepare("INSERT OR REPLACE INTO agents (name, auth_state) VALUES (?, 'active')").run(); }`,
      `export function d() { db.prepare("INSERT INTO agents (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET auth_state = 'active'").run(); }`,
      `export function e() { const cols = ["auth_state = ?"]; return cols; }`,
    ].join("\n");
    expect(authStateWritesIn("src/x.ts", src).map((s) => `${s.site}:${s.kind}`)).toEqual(["src/x.ts:a:update-auth_state", "src/x.ts:b:update-auth_state", "src/x.ts:c:replace", "src/x.ts:d:upsert", "src/x.ts:e:update-auth_state"]);
  });
  it("Codex #315 R2 N3: a conflict clause, quoted identifiers, a schema qualifier and a second statement are all seen", () => {
    expect(classifySql(`UPDATE OR ABORT agents SET auth_state = 'active', revoked_at = NULL WHERE name = ?`)).toEqual(["update-auth_state"]);
    expect(classifySql(`UPDATE "agents" SET "auth_state" = 'active', revoked_at = NULL WHERE name = ?`)).toEqual(["update-auth_state"]);
    expect(classifySql("UPDATE `agents` SET [auth_state] = 'active' WHERE name = ?")).toEqual(["update-auth_state"]);
    expect(classifySql(`UPDATE main.agents SET auth_state = 'active'`)).toEqual(["update-auth_state"]);
    expect(classifySql(`SELECT 1; UPDATE agents SET auth_state = 'active' WHERE name = 'x'`)).toEqual(["update-auth_state"]);
    expect(classifySql(`INSERT INTO agents (name) VALUES (?) ON CONFLICT (name) DO UPDATE SET auth_state = 'active'`)).toEqual(["upsert"]);
  });
  it("Codex #315 R2 N3: an ALIASED applyAuthStateTransition (and one passed as a value) is found by binding", () => {
    const files = {
      "src/db.ts": "export function applyAuthStateTransition(_n: string, _f: string, _t: string): void {}",
      "src/a.ts": `import { applyAuthStateTransition as transition } from "./db.js";\nexport function revive(n: string) { transition(n, "revoked", "active"); }`,
      "src/b.ts": `import { applyAuthStateTransition } from "./db.js";\nexport const t = applyAuthStateTransition;`,
    };
    const uses = transitionUses(virtualProgram(files), (f) => path.relative("/virtual", f).split(path.sep).join("/"));
    expect(uses.filter((u) => u.direct).map((u) => [u.site, u.from, u.to])).toEqual([["src/a.ts:revive", "revoked", "active"]]);
    expect(uses.some((u) => !u.direct)).toBe(true);
  });
  it("does NOT flag a WHERE-only mention or an unrelated table", () => {
    const src = `export function f() { db.prepare("UPDATE agents SET last_seen = ? WHERE auth_state = 'active'").run(); db.prepare("UPDATE tasks SET auth_state = 'x'").run(); }`;
    expect(authStateWritesIn("src/x.ts", src)).toEqual([]);
  });
});

describe("SEC-20.T2: every statement that can set auth_state is listed and justified", () => {
  it("precondition: the scan sees the known sites (it is not blind)", () => {
    for (const s of ["src/db.ts:mintAgentToken", "src/db.ts:registerAgent", "src/db.ts:applyAuthStateTransition"]) expect(all.some((a) => a.site === s), s).toBe(true);
  });
  it("the sites in src are EXACTLY the listed ones, with the listed counts (a new or changed site fails until reviewed)", () => {
    const found: Record<string, Partial<Record<Site["kind"], number>>> = {};
    for (const a of all) (found[a.site] ??= {})[a.kind] = ((found[a.site] ??= {})[a.kind] ?? 0) + 1;
    expect(found).toEqual(Object.fromEntries(Object.entries(ALLOWED).map(([k, v]) => [k, v.kinds])));
  });
  it("no INSERT into agents is an upsert (an upsert could overwrite a revoked row)", () => {
    for (const a of all.filter((x) => x.kind === "insert")) expect(a.sql, a.site).not.toMatch(/ON\s+CONFLICT|OR\s+REPLACE/i);
    expect(all.filter((x) => x.kind === "replace" || x.kind === "upsert")).toEqual([]);
  });
  it("every applyAuthStateTransition use (by binding) is a direct call naming LITERAL states, and none moves a revoked / recovery_pending row to active", () => {
    expect(transitions.length).toBeGreaterThan(0);
    for (const t of transitions) {
      expect(t.direct, `${t.site}: a non-call use of applyAuthStateTransition cannot be reviewed`).toBe(true);
      expect([t.from, t.to].includes(null), `${t.site}: a non-literal state cannot be reviewed`).toBe(false);
      if (t.to === "active") expect(["revoked", "recovery_pending"], t.site).not.toContain(t.from);
    }
  });
});
