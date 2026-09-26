// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * TRIPWIRE, NOT THE GUARD (ADR-0046). The real enforcement of edge scope is
 * behavioural: tests/adr-0046-edge-scope-metamorphic.test.ts plants foreign rows
 * that collide on name and anchor and requires every accessor's local results to be
 * identical. This file is a cheap early warning for ACCIDENTAL drift by an honest
 * builder, and is audited only for false alarms.
 *
 * KNOWN LIMITS, by design (deliberate evasion, not drift; the metamorphic test
 * makes them irrelevant, so they are NOT chased here):
 *   - tautologies: `edge_id = edge_id`, `edge_id IS edge_id`;
 *   - `edge_id IS NOT DISTINCT FROM ?` and other non-`=` spellings;
 *   - a predicate borrowed from another UNION / compound-select branch;
 *   - SQL assembled across variables or function calls (seen only through its
 *     literal parts), views, and dynamically built identifiers;
 *   - an edge_id comparison against the WRONG value (it checks shape, not value).
 *
 * ADR-0043 rule 3 — DRIFT TRIPWIRE: every agent_bindings key starts with edge_id,
 * and every query that looks a binding up by NAME, ANCHOR, CONVERSATION or
 * BINDING ID also RESTRICTS it to one edge: `edge_id = ?` as a top-level AND
 * conjunct of every OR branch of the condition at that table's level. An edge
 * comparison anywhere else (an OR alternative, an EXISTS subquery, another table's
 * column) does not restrict the rows, so it does not count (round-2 audit).
 *
 * Why a guard and not care: in hub mode (v2.3) this table holds rows from many
 * edges. A lookup by (host_id, window_pid, window_pid_start) or by agent_name
 * without the edge would silently match another relay's `architect`, which is the
 * name-keyed identity F7 exists to prevent. Today every row is local, so such a
 * query would pass every runtime test; only a static rule catches it.
 *
 * Parsed, not grepped: sources go through the PINNED parser
 * (scripts/lib/guard-parse.mjs). String literals, templates and `+` chains are
 * assembled into the SQL they build. binding_id counts as a scoped column: the
 * primary key is (edge_id, binding_id), so binding_id alone is not a key.
 * SCOPE, stated honestly: only SQL text that itself names agent_bindings is
 * checked. A WHERE fragment held in a variable and interpolated is seen only
 * through its literal parts — how the codebase builds these queries today.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
// @ts-expect-error — .mjs helper without types
import { parseGuardSource, ts } from "../scripts/lib/guard-parse.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Columns that make a lookup a NAME / ANCHOR / CONVERSATION / BINDING lookup.
 * binding_id is here because the primary key is (edge_id, binding_id): a
 * binding_id alone no longer names one row once another edge's rows exist.
 */
const SCOPED_COLUMNS = /\b(agent_name|host_id|window_pid|window_pid_start|conversation_id|binding_id)\b/;

/** Depth-0 keywords that end a WHERE / ON condition. */
const CLAUSE_END = new Set([
  "where", "on", "join", "inner", "left", "right", "cross", "natural", "group", "order", "limit",
  "having", "union", "except", "intersect", "returning", "window",
]);
const NOT_AN_ALIAS = new Set([...CLAUSE_END, "set", "as", "values", "default"]);

function norm(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    // An accidental quoted identifier names the same thing: "edge_id", `edge_id`, [edge_id].
    .replace(/"([A-Za-z_][A-Za-z0-9_]*)"|`([A-Za-z_][A-Za-z0-9_]*)`|\[([A-Za-z_][A-Za-z0-9_]*)\]/g, (_m, a, b, c) => a ?? b ?? c)
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Walk `text`, calling `at(i, depth)` at each position OUTSIDE a quoted string,
 * with the paren depth at that position. Returning true stops the walk.
 */
function walk(text: string, at: (i: number, depth: number) => boolean | void): void {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      const close = text.indexOf(ch, i + 1);
      i = close === -1 ? text.length : close;
      continue;
    }
    if (ch === "(") depth++;
    if (at(i, depth) === true) return;
    if (ch === ")") depth--;
  }
}

/** The word starting at i, if i is a word boundary. */
function wordAt(text: string, i: number): string | null {
  if (i > 0 && /[a-z0-9_.]/.test(text[i - 1])) return null;
  const m = /^[a-z_][a-z0-9_]*/.exec(text.slice(i));
  return m ? m[0] : null;
}

/** Split on a depth-0 AND / OR keyword. */
function splitTop(text: string, word: "and" | "or"): string[] {
  const parts: string[] = [];
  let from = 0;
  walk(text, (i, depth) => {
    if (depth === 0 && wordAt(text, i) === word) {
      parts.push(text.slice(from, i));
      from = i + word.length;
    }
  });
  parts.push(text.slice(from));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** "(x)" → "x" when the outer parens wrap the WHOLE text. */
function unwrap(text: string): string | null {
  const t = text.trim();
  if (!t.startsWith("(") || !t.endsWith(")")) return null;
  let closesAt = -1;
  walk(t, (i, depth) => {
    if (t[i] === ")" && depth === 1) {
      closesAt = i;
      return true;
    }
  });
  return closesAt === t.length - 1 ? t.slice(1, -1) : null;
}

/**
 * Does `cond` RESTRICT the binding rows to one edge? Every OR branch must carry,
 * as one of its own top-level AND conjuncts, `edge_id = ?` / `edge_id IN (...)` /
 * `edge_id IS ?` on the binding table (unqualified, or qualified by its name or
 * alias). An edge comparison inside an OR alternative, a subquery, a NOT, or on
 * another table's column does not restrict these rows.
 */
function edgeConstraining(cond: string, quals: Set<string>): boolean {
  const branches = splitTop(cond, "or");
  if (branches.length === 0) return false;
  return branches.every((branch) => {
    const inner = unwrap(branch);
    if (inner !== null && splitTop(inner, "or").length > 0 && inner !== branch) return edgeConstraining(inner, quals);
    return splitTop(branch, "and").some((c) => {
      const wrapped = unwrap(c);
      if (wrapped !== null) return edgeConstraining(wrapped, quals);
      const m = /^(?:([a-z_][a-z0-9_]*)\.)?edge_id\s*(?:=|in\s*\(|is\s+(?!not\b|null\b))/.exec(c);
      return !!m && (m[1] === undefined || quals.has(m[1]));
    });
  });
}

/** The WHERE / ON conditions that apply at the level of one agent_bindings reference. */
function conditionsAt(s: string, from: number): string[] {
  // The reference's own level: up to the paren that closes its enclosing group.
  let end = s.length;
  walk(s.slice(from), (i, depth) => {
    if (depth < 0 || (depth === 0 && s[from + i] === ")")) {
      end = from + i;
      return true;
    }
  });
  const seg = s.slice(from, end);
  const marks: Array<{ at: number; word: string }> = [];
  walk(seg, (i, depth) => {
    if (depth !== 0) return;
    const w = wordAt(seg, i);
    if (w !== null && CLAUSE_END.has(w)) marks.push({ at: i, word: w });
  });
  const conds: string[] = [];
  marks.forEach((m, k) => {
    if (m.word !== "where" && m.word !== "on") return;
    const stop = k + 1 < marks.length ? marks[k + 1].at : seg.length;
    conds.push(seg.slice(m.at + m.word.length, stop).trim());
  });
  return conds;
}

/** Why this SQL breaks the edge-scope rule, or null. */
export function edgeScopeViolation(sql: string): string | null {
  const s = norm(sql);
  if (!/\bagent_bindings\b/.test(s)) return null;

  const idx = /^create\s+(unique\s+)?index\b.*?\bon\s+(main\.)?agent_bindings\s*\(\s*([a-z_]+)/.exec(s);
  if (idx) return idx[3] === "edge_id" ? null : `index does not start with edge_id: ${s}`;
  if (!/^(select|update|delete|with|insert)\b/.test(s)) return null;

  // Every reference to the table, at whatever nesting level it sits.
  const ref = /\b(?:from|join|update)\s+(?:main\.)?agent_bindings\b(?:\s+(?:as\s+)?([a-z_][a-z0-9_]*))?/g;
  for (let m = ref.exec(s); m !== null; m = ref.exec(s)) {
    const alias = m[1] && !NOT_AN_ALIAS.has(m[1]) ? m[1] : null;
    const quals = new Set(["agent_bindings", ...(alias ? [alias] : [])]);
    const conds = conditionsAt(s, m.index + m[0].length - (alias ? 0 : (m[1]?.length ?? 0)));
    if (!conds.some((c) => SCOPED_COLUMNS.test(c))) continue;
    // WHERE and ON are ANDed for the rows at this level: one edge-restricting condition suffices.
    if (!conds.some((c) => edgeConstraining(c, quals))) {
      return `name/anchor/binding lookup not restricted to one edge: ${s}`;
    }
  }
  return null;
}

function sqlTexts(fileName: string, source: string): string[] {
  const sf = parseGuardSource(fileName, source);
  const out: string[] = [];
  const text = (n: any): string | null => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
    if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map((sp: any) => "?" + sp.literal.text).join("");
    if (ts.isParenthesizedExpression(n)) return text(n.expression);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const l = text(n.left);
      const r = text(n.right);
      if (l === null && r === null) return null;
      return (l ?? "?") + (r ?? "?");
    }
    return null;
  };
  const visit = (n: any, insidePlus: boolean): void => {
    const isPlus = ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken;
    if (!insidePlus) {
      const t = text(n);
      if (t !== null) out.push(t);
    }
    ts.forEachChild(n, (c: any) => visit(c, insidePlus || isPlus || ts.isTemplateExpression(n)));
  };
  visit(sf, false);
  return out;
}

function violations(fileName: string, source: string): string[] {
  return sqlTexts(fileName, source)
    .map(edgeScopeViolation)
    .filter((v): v is string => v !== null);
}

function srcFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return srcFiles(p);
    return e.name.endsWith(".ts") && !e.name.endsWith(".d.ts") ? [p] : [];
  });
}

describe("ADR-0043 rule 3 — agent_bindings keys and lookups are edge-scoped", () => {
  it("src/ has ZERO unscoped agent_bindings lookups and ZERO indexes not led by edge_id", () => {
    const found: string[] = [];
    for (const f of srcFiles(path.join(REPO, "src"))) {
      for (const v of violations(f, fs.readFileSync(f, "utf-8"))) found.push(`${path.relative(REPO, f)}: ${v}`);
    }
    expect(found).toEqual([]);
  });

  it("NON-VACUOUS: the scan SEES the real anchor lookup, the list query and all four indexes in src/db.ts", () => {
    const texts = sqlTexts("db.ts", fs.readFileSync(path.join(REPO, "src", "db.ts"), "utf-8")).map(norm);
    const lookups = texts.filter((t) => /^select\b.*\bfrom agent_bindings\b.*\bwhere\b/.test(t));
    expect(lookups.some((t) => /window_pid_start = \?/.test(t)), "the anchor lookup").toBe(true);
    expect(lookups.some((t) => /superseded_at is null order by bound_at desc, binding_id/.test(t)), "the list query").toBe(true);
    const indexes = texts.filter((t) => /^create (unique )?index\b.*\bon agent_bindings\s*\(/.test(t));
    expect(indexes).toHaveLength(4);
  });

  it.each([
    ["anchor lookup, no edge", 'db.prepare("SELECT * FROM agent_bindings WHERE host_id = ? AND window_pid = ? AND window_pid_start = ?")'],
    ["name lookup, no edge", "db.prepare('select binding_id from agent_bindings where agent_name = ? and superseded_at is null')"],
    ["conversation lookup in a template", "db.prepare(`SELECT * FROM agent_bindings WHERE conversation_id = ${c}`)"],
    ["split by +", 'db.prepare("UPDATE agent_bindings SET end_reason = ? " + "WHERE agent_name = ?")'],
    ["a DELETE by anchor", 'db.prepare("DELETE FROM agent_bindings WHERE window_pid = ?")'],
    ["edge only in the projection, not the filter", 'db.prepare("SELECT edge_id FROM agent_bindings WHERE agent_name = ?")'],
    ["a name index without the edge", 'db.exec("CREATE INDEX IF NOT EXISTS i ON agent_bindings(agent_name)")'],
    ["a unique anchor index with edge_id NOT first", 'db.exec("CREATE UNIQUE INDEX u ON agent_bindings(host_id, window_pid, edge_id)")'],
    ["a join on name", 'db.prepare("SELECT * FROM agents a JOIN agent_bindings b ON b.agent_name = a.name")'],
    // Round-2 audit: an edge comparison that does not CONSTRAIN the binding rows.
    ["edge only in an OR branch", 'db.prepare("SELECT * FROM agent_bindings WHERE agent_name = ? OR edge_id = ?")'],
    ["edge only in an unrelated EXISTS subquery", 'db.prepare("SELECT * FROM agent_bindings WHERE agent_name = ? AND EXISTS (SELECT 1 FROM relay_edge WHERE edge_id = ?)")'],
    ["edge inside a parenthesised OR", 'db.prepare("SELECT * FROM agent_bindings WHERE (edge_id = ? OR agent_name = ?)")'],
    ["one OR branch scoped, the other not", 'db.prepare("SELECT * FROM agent_bindings WHERE (edge_id = ? AND agent_name = ?) OR host_id = ?")'],
    ["a binding_id update without the edge (binding_id is no longer a key alone)", 'db.prepare("UPDATE agent_bindings SET end_reason = ? WHERE binding_id = ?")'],
    ["agent_bindings nested in another table's query", 'db.prepare("SELECT * FROM agents WHERE name IN (SELECT agent_name FROM agent_bindings WHERE host_id = ?)")'],
    ["edge compared on the OTHER table of a join", 'db.prepare("SELECT * FROM agents a JOIN agent_bindings b ON b.agent_name = a.name WHERE a.edge_id = ?")'],
    ["a quoted table name, no edge", `db.prepare('SELECT * FROM "agent_bindings" WHERE agent_name = ?')`],
  ])("FLAGS a form absent from the repo: %s", (_label, code) => {
    expect(violations("x.ts", `const x = 1; ${code};`)).toHaveLength(1);
  });

  it.each([
    ["an edge-scoped anchor lookup", 'db.prepare("SELECT * FROM agent_bindings WHERE edge_id = ? AND host_id = ? AND window_pid = ?")'],
    ["an edge-led index", 'db.exec("CREATE INDEX IF NOT EXISTS i ON agent_bindings(edge_id, agent_name)")'],
    ["the sqlite_master probe (name, not agent_name)", `db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_bindings'")`],
    ["another table's name lookup", 'db.prepare("SELECT * FROM agents WHERE name = ? AND host_id = ?")'],
    ["prose that mentions agent_bindings and agent_name", 'const d = "agent_bindings rows carry agent_name"'],
    ["edge ANDed inside a wrapping paren", 'db.prepare("SELECT * FROM agent_bindings WHERE (edge_id = ? AND agent_name = ?)")'],
    ["edge ANDed with an OR of scoped columns", 'db.prepare("SELECT * FROM agent_bindings WHERE edge_id = ? AND (agent_name = ? OR conversation_id = ?)")'],
    ["every OR branch scoped", 'db.prepare("SELECT * FROM agent_bindings WHERE (edge_id = ? AND agent_name = ?) OR (edge_id = ? AND host_id = ?)")'],
    ["a join scoped on the binding alias", 'db.prepare("SELECT * FROM agents a JOIN agent_bindings b ON b.agent_name = a.name AND b.edge_id = ?")'],
    ["an edge-scoped binding_id update", 'db.prepare("UPDATE agent_bindings SET end_reason = ? WHERE edge_id = ? AND binding_id = ?")'],
    ["nested and scoped", 'db.prepare("SELECT * FROM agents WHERE name IN (SELECT agent_name FROM agent_bindings WHERE edge_id = ? AND host_id = ?)")'],
    ["a quoted edge column, scoped", `db.prepare('SELECT * FROM agent_bindings WHERE "edge_id" = ? AND agent_name = ?')`],
  ])("does NOT flag: %s", (label, code) => {
    expect(violations("x.ts", `const x = 1; ${code};`), label).toEqual([]);
  });
});
