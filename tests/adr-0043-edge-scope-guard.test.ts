// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0043 rule 3 — DRIFT GUARD: every agent_bindings key starts with edge_id,
 * and every query that looks a binding up by NAME, ANCHOR or CONVERSATION also
 * filters by edge_id.
 *
 * Why a guard and not care: in hub mode (v2.3) this table holds rows from many
 * edges. A lookup by (host_id, window_pid, window_pid_start) or by agent_name
 * without the edge would silently match another relay's `architect`, which is the
 * name-keyed identity F7 exists to prevent. Today every row is local, so such a
 * query would pass every runtime test; only a static rule catches it.
 *
 * Parsed, not grepped: sources go through the PINNED parser
 * (scripts/lib/guard-parse.mjs). String literals, templates and `+` chains are
 * assembled into the SQL they build. A lookup by binding_id (the primary key) is
 * not a name/anchor lookup and is allowed.
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

/** Columns that make a lookup a NAME / ANCHOR / CONVERSATION lookup. */
const SCOPED_COLUMNS = /\b(agent_name|host_id|window_pid|window_pid_start|conversation_id)\b/;

function norm(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Why this SQL breaks the edge-scope rule, or null. */
export function edgeScopeViolation(sql: string): string | null {
  const s = norm(sql);
  if (!/\bagent_bindings\b/.test(s)) return null;

  const idx = /^create\s+(unique\s+)?index\b.*?\bon\s+(main\.)?agent_bindings\s*\(\s*([a-z_]+)/.exec(s);
  if (idx) return idx[3] === "edge_id" ? null : `index does not start with edge_id: ${s}`;

  // A lookup: the part after the first WHERE / ON. Only a decision on a
  // name / anchor / conversation column needs the edge beside it.
  const m = /\b(where|on)\b/.exec(s);
  if (!m || !/^(select|update|delete|with|insert)\b/.test(s)) return null;
  const cond = s.slice(m.index);
  if (!SCOPED_COLUMNS.test(cond)) return null;
  return /\bedge_id\s*(=|is\b|in\s*\()/.test(cond) ? null : `name/anchor lookup without edge_id: ${s}`;
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
  ])("FLAGS a form absent from the repo: %s", (_label, code) => {
    expect(violations("x.ts", `const x = 1; ${code};`)).toHaveLength(1);
  });

  it.each([
    ["a primary-key lookup", 'db.prepare("UPDATE agent_bindings SET last_verified_at = ? WHERE binding_id = ?")'],
    ["an edge-scoped anchor lookup", 'db.prepare("SELECT * FROM agent_bindings WHERE edge_id = ? AND host_id = ? AND window_pid = ?")'],
    ["an edge-led index", 'db.exec("CREATE INDEX IF NOT EXISTS i ON agent_bindings(edge_id, agent_name)")'],
    ["the sqlite_master probe (name, not agent_name)", `db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_bindings'")`],
    ["another table's name lookup", 'db.prepare("SELECT * FROM agents WHERE name = ? AND host_id = ?")'],
    ["prose that mentions agent_bindings and agent_name", 'const d = "agent_bindings rows carry agent_name"'],
  ])("does NOT flag: %s", (label, code) => {
    expect(violations("x.ts", `const x = 1; ${code};`), label).toEqual([]);
  });
});
