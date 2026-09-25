// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0044 (b) — NO DECISION MAY KEY ON `seq`.
 *
 * `messages.seq` is the OBSERVED axis. It is stamped by ANY view, including a
 * non-consuming peek. The metadata-only PostToolUse notice peeks, so it stamps
 * `seq` although it observed no message (the known residual that F1 removes). That
 * is harmless only while nothing decides on `seq`: wake runs on total_unread_count,
 * the drain on the delivered axis (read_by_session), and epoch serves only
 * backup/restore (MEASURED by the design review on dbdbf48). The next consumer that
 * asks "has the recipient seen this?" of `seq` would inherit a lying column.
 *
 * So the rule is enforced, not just written down: no SQL in src/ may use `seq` in a
 * condition or ordering clause (WHERE / ON / HAVING / ORDER BY / GROUP BY), except
 * the ONE stamping statement that assigns it.
 *
 * Parsed, not grepped. Sources go through the PINNED parser (scripts/lib/guard-parse.mjs).
 * Every string literal, template and `+`-concatenation chain is assembled into the
 * SQL text it builds, and SQL comments are stripped, so a split
 * "WHERE " + "seq" or a template cannot hide from it. SCOPE, stated honestly: SQL
 * assembled across variables or function calls (e.g. a WHERE fragment held in a
 * const and interpolated) is seen only through its literal parts. That is how the
 * codebase builds predicates today (pendingForSessionClause etc. are literals), and
 * those helpers are scanned too.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
// @ts-expect-error — .mjs helper without types
import { parseGuardSource, ts } from "../scripts/lib/guard-parse.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The one statement allowed to mention seq in a condition: it ASSIGNS seq, guarded on "not yet observed". */
const ALLOWED = ["update messages set seq = ?, epoch = ? where id = ? and seq is null"];

function norm(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Does this SQL (a full statement OR a predicate fragment) key a decision on seq?
 * Predicate-shaped only: `seq IS [NOT] NULL`, a comparison, IN, BETWEEN, or seq in
 * an ORDER BY / GROUP BY. For a full statement only the part after its first
 * WHERE / ON / HAVING / ORDER BY / GROUP BY counts, so `SET seq = ?` (an
 * assignment, not a decision) does not. DDL (CREATE / ALTER / DROP) is not a
 * decision. Prose that merely mentions seq is not predicate-shaped.
 */
export function keysOnSeq(sql: string): boolean {
  const s = norm(sql);
  if (/^(create|alter|drop)\b/.test(s)) return false;
  const isStatement = /^(select|update|delete|insert|with)\b/.test(s);
  const m = /\b(where|on|having|order by|group by)\b/.exec(s);
  const scope = isStatement ? (m ? s.slice(m.index) : "") : s;
  return (
    /\bseq\s*(is\s+(not\s+)?null\b|=|<>|!=|<=?|>=?|in\s*\(|between\b)/.test(scope) ||
    /\b(order|group)\s+by\b[^;]*\bseq\b/.test(scope)
  );
}

/** Every SQL-ish text a source builds from literals, templates and + chains. */
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
    .filter((t) => keysOnSeq(t))
    .map(norm)
    .filter((t) => !ALLOWED.includes(t));
}

function srcFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return srcFiles(p);
    return e.name.endsWith(".ts") && !e.name.endsWith(".d.ts") ? [p] : [];
  });
}

describe("ADR-0044 (b) — no decision in src/ keys on seq", () => {
  it("src/ has ZERO seq-keyed SQL outside the one stamping statement", () => {
    const found: string[] = [];
    for (const f of srcFiles(path.join(REPO, "src"))) {
      for (const v of violations(f, fs.readFileSync(f, "utf-8"))) found.push(`${path.relative(REPO, f)}: ${v}`);
    }
    expect(found).toEqual([]);
  });

  it("NON-VACUOUS: the scan actually SEES the allowed stamping statement in src/db.ts", () => {
    const db = fs.readFileSync(path.join(REPO, "src", "db.ts"), "utf-8");
    const seen = sqlTexts("db.ts", db).map(norm).filter((t) => keysOnSeq(t));
    expect(seen).toEqual(ALLOWED);
  });

  it.each([
    ["plain WHERE", 'db.prepare("SELECT * FROM messages WHERE seq > ?")'],
    ["lowercase + AND", "db.prepare('select id from messages where to_agent = ? and seq is null')"],
    ["template", "db.prepare(`SELECT id FROM messages WHERE to_agent = ${x} AND seq IS NULL`)"],
    ["split by +", 'db.prepare("SELECT id FROM messages " + "WHERE seq IS NOT NULL")'],
    ["ORDER BY", 'db.prepare("SELECT id FROM messages WHERE to_agent = ? ORDER BY seq DESC")'],
    ["a WHERE FRAGMENT built on its own (the pre-3.0.1 escape shape)", 'const escape = " AND seq IS NULL"'],
    ["a fragment in a + chain", 'const where = "to_agent = ?" + " AND seq > ?"'],
  ])("FLAGS a form absent from the repo: %s", (_label, code) => {
    expect(violations("x.ts", `const x = 1; ${code};`)).toHaveLength(1);
  });

  it.each([
    ["projection only", 'db.prepare("SELECT seq, epoch FROM messages WHERE id = ?")'],
    ["mailbox next_seq", 'db.prepare("UPDATE mailbox SET next_seq = ? WHERE next_seq < ?")'],
    ["seq in a SQL comment", "db.prepare(`SELECT id FROM messages -- not seq IS NULL\n WHERE id = ?`)"],
    ["the stamping statement itself", 'db.prepare("UPDATE messages SET seq = ?, epoch = ? WHERE id = ? AND seq IS NULL")'],
    ["DDL: an index that includes seq", 'db.exec("CREATE INDEX IF NOT EXISTS idx_messages_to_seq ON messages(to_agent, seq)")'],
    ["prose that mentions seq", 'const d = "peek stamps the observation cursor (`seq`) on any view"'],
  ])("does NOT flag: %s", (label, code) => {
    const v = violations("x.ts", `const x = 1; ${code};`);
    // The stamping statement is flagged by keysOnSeq but removed by the allowlist.
    expect(v, label).toEqual([]);
  });
});
