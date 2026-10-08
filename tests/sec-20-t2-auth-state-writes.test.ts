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

function topLevelName(node: ts.Node): string {
  let name = "<module>";
  for (let cur: ts.Node | undefined = node; cur; cur = cur.parent) {
    if (ts.isFunctionDeclaration(cur) && cur.name) name = cur.name.text;
    else if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name) && cur.initializer && (ts.isArrowFunction(cur.initializer) || ts.isFunctionExpression(cur.initializer))) name = cur.name.text;
  }
  return name;
}

export interface Site { site: string; kind: "update-auth_state" | "insert" | "replace"; sql: string }

/** Every statement in one source that can set a row's auth_state. Outermost string expressions only. */
export function authStateWritesIn(rel: string, text: string): Site[] {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: Site[] = [];
  const visit = (n: ts.Node): void => {
    const folded = foldString(n);
    if (folded !== null) {
      const sql = folded.replace(/\s+/g, " ");
      const site = `${rel}:${topLevelName(n)}`;
      if (/\bREPLACE\s+INTO\s+agents\b/i.test(sql) || /\bINSERT\s+OR\s+REPLACE\s+INTO\s+agents\b/i.test(sql)) out.push({ site, kind: "replace", sql });
      else if (/\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+agents\b/i.test(sql)) out.push({ site, kind: "insert", sql });
      else if (/\bUPDATE\s+agents\b/i.test(sql) && /\bSET\b[\s\S]*\bauth_state\s*=/i.test(sql.replace(/\bWHERE\b[\s\S]*$/i, ""))) out.push({ site, kind: "update-auth_state", sql });
      else if (/^\s*auth_state\s*=\s*\?/i.test(sql)) out.push({ site, kind: "update-auth_state", sql }); // a SET fragment a builder joins
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

/** Every call of applyAuthStateTransition: [site, from-state literal, to-state literal] (null = not a literal). */
export function transitionCallsIn(rel: string, text: string): Array<{ site: string; from: string | null; to: string | null }> {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: Array<{ site: string; from: string | null; to: string | null }> = [];
  const lit = (n: ts.Node | undefined) => (n && ts.isStringLiteralLike(n) ? n.text : null);
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "applyAuthStateTransition") {
      out.push({ site: `${rel}:${topLevelName(n)}`, from: lit(n.arguments[1]), to: lit(n.arguments[2]) });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const files = srcFiles(path.join(REPO, "src")).map((f) => ({ rel: path.relative(REPO, f).split(path.sep).join("/"), text: fs.readFileSync(f, "utf-8") }));
const all = files.flatMap((f) => authStateWritesIn(f.rel, f.text));
const transitions = files.flatMap((f) => transitionCallsIn(f.rel, f.text));

describe("the scanner (both legs, on synthetic sources)", () => {
  it("finds a statement split across `+` lines, a template, an INSERT OR REPLACE, an upsert and a builder's SET fragment", () => {
    const src = [
      `export function a() { db.prepare("UPDATE agents SET last_seen = ?, " + "auth_state = 'active' " + "WHERE name = ?").run(); }`,
      "export function b(x: string) { db.exec(`UPDATE agents SET auth_state = 'active', x = ${x} WHERE name = 'n'`); }",
      `export function c() { db.prepare("INSERT OR REPLACE INTO agents (name, auth_state) VALUES (?, 'active')").run(); }`,
      `export function d() { db.prepare("INSERT INTO agents (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET auth_state = 'active'").run(); }`,
      `export function e() { const cols = ["auth_state = ?"]; return cols; }`,
    ].join("\n");
    expect(authStateWritesIn("src/x.ts", src).map((s) => `${s.site}:${s.kind}`)).toEqual(["src/x.ts:a:update-auth_state", "src/x.ts:b:update-auth_state", "src/x.ts:c:replace", "src/x.ts:d:insert", "src/x.ts:e:update-auth_state"]);
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
    expect(all.filter((x) => x.kind === "replace")).toEqual([]);
  });
  it("every applyAuthStateTransition call names LITERAL states, and none moves a revoked / recovery_pending row to active", () => {
    expect(transitions.length).toBeGreaterThan(0);
    for (const t of transitions) {
      expect([t.from, t.to].includes(null), `${t.site}: a non-literal state cannot be reviewed`).toBe(false);
      if (t.to === "active") expect(["revoked", "recovery_pending"], t.site).not.toContain(t.from);
    }
  });
});
