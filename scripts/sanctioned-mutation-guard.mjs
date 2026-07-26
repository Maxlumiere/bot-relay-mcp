#!/usr/bin/env node
// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Sanctioned-mutation guard (ADR-0015). Rebuilt from a case-sensitive grep that
 * covered almost nothing (missed INSERT/REPLACE entirely, `main.agents`, table
 * aliases, and inline comments) into a guard that enforces the HARM predicate.
 *
 * ── L1 — HARM + PREDICATE DECLARED ───────────────────────────────────────────
 * HARM: an agent's identity is CREATED, REPLACED, or DELETED outside the single
 *   sanctioned mutation site (src/db.ts). The db.ts helpers are the only place
 *   the load-bearing invariants live — probe-cache eviction, auth-generation
 *   bump, the agent_capabilities cascade, the session/anchor CAS. A raw
 *   `agents` / `agent_capabilities` write anywhere else silently bypasses ALL of
 *   them; the bug is not "a string appears", it is "the table is mutated off the
 *   sanctioned path."
 * PREDICATE: no SQL statement that mutates the `agents` or `agent_capabilities`
 *   table — INSERT (incl. INSERT OR …/UPSERT), REPLACE, UPDATE, or DELETE —
 *   appears in a src/ TypeScript file other than src/db.ts, unless the line
 *   carries an explicit `// ALLOWLIST: <reason>` acknowledgement.
 * WHY predicate ⟹ harm-prevented: agent-identity mutation is *definitionally*
 *   one of those four verbs against one of those two tables. Confining all four
 *   verbs on both tables to db.ts means every identity change goes through a
 *   helper that maintains the invariants. The predicate is the harm, not a proxy
 *   for it — it classifies the actual statement, so widening the SQL surface
 *   (aliases, case, comments, schema qualifiers, split strings) cannot slip past.
 *
 * ── L2 — FRESHNESS ───────────────────────────────────────────────────────────
 * N/A by construction: this is a STATIC scan of committed source at build time,
 * not a runtime observe→decide→act. There is no TOCTOU window to CAS against —
 * the artifact it judges (the source tree) does not change between the read and
 * the verdict within a run.
 *
 * ── L3 — BYPASS INVENTORY (every way to weaken the check, closed) ─────────────
 *   • CASE — SQLite keywords + identifiers are case-insensitive; the old grep
 *     was `-E` case-sensitive. CLOSED: verbs compared upper-cased, table names
 *     compared case-insensitively.
 *   • VERB COVERAGE — the old grep matched only UPDATE/DELETE. CLOSED: INSERT
 *     (incl. `INSERT OR REPLACE|IGNORE|ABORT|FAIL|ROLLBACK`), REPLACE (the verb
 *     form), UPDATE, DELETE all classified.
 *   • TABLE ALIAS — `UPDATE agents AS a SET …` / `UPDATE agents a SET …`. CLOSED:
 *     the parser consumes an optional `AS <alias>` / bare alias before SET.
 *   • SCHEMA-QUALIFIED — `UPDATE main.agents …`, `DELETE FROM temp.agents …`.
 *     CLOSED: `schema.table` resolves to the table component.
 *   • QUOTED IDENTIFIER — `"agents"`, `` `agents` ``, `[agents]`. CLOSED: quoted
 *     identifiers tokenize to the same bare name.
 *   • INLINE COMMENTS — a block comment or a `--` line comment sitting between
 *     the verb and the table (e.g. `UPDATE <block-comment> agents …`). CLOSED:
 *     block and line comments are stripped during tokenization (string-aware, so
 *     a `--` inside a '…' literal is preserved).
 *   • STRING-SPLIT SQL — `"UPDATE agents " + "SET …"`. CLOSED: `+`-concatenation
 *     of literals is reconstructed before classification; template quasis too.
 *   • HIDING IN A VARIABLE — the guard scans every string/template LITERAL in the
 *     file (not only `.prepare(...)` args), so `const q = "DELETE FROM agents…"`
 *     is caught even before it reaches prepare/exec. (SQL in a line or block code
 *     comment is NOT a string literal and is correctly ignored — a commented-out
 *     statement does not execute, so it is not the harm.)
 *   • AMBIENT DISABLE — none. No env var, CI flag, or network position weakens
 *     this guard; it is a static scan. The ONLY escape is the per-line
 *     `// ALLOWLIST: <reason>` — a visible, reviewable, reason-bearing
 *     acknowledgement in the diff, never ambient state.
 *   • FAIL-OPEN ON UNPARSEABLE INPUT — the `audit-state-freshness.sh` disease
 *     (exit 0 when it cannot read its own input). CLOSED: a file that fails to
 *     parse exits 2 (error), never 0; the guard refuses rather than waves through.
 *
 *   OUT (documented, not a hidden gap): SQL assembled by runtime operations that
 *   produce no classifiable literal — `[...].join(' ')`, char-by-char building,
 *   or a fully computed identifier. That is beyond "an adversary who knows the
 *   grep" (valid-SQL evasion) and into arbitrary obfuscation; this guard defends
 *   accidental drift + the known evasion forms. A new dynamic-SQL mutator must
 *   route through db.ts or carry an ALLOWLIST.
 *
 * ── L4 — SIGNAL CONTRACT ─────────────────────────────────────────────────────
 * One predicate, one source: the same `mutatesAgentsTable()` classifier decides
 * BOTH the violation and the message — no split-brain between what is detected
 * and what is reported. The classifier is exported and driven by the harm/
 * innocent-twin test, so the gate and the test consume the identical predicate.
 *
 * TEST (green-by-construction): tests/v2-24-0-sanctioned-mutation-guard.test.ts
 * attempts the ACTUAL harm through each evasion form (assert flagged) and the
 * innocent twin — a real mutation inside db.ts, a SELECT, a different table
 * (assert NOT flagged) — and includes a case that the LEGACY grep let through.
 *
 * Exit: 0 = clean · 1 = violations (stderr) · 2 = usage/parse error
 * Usage: node scripts/sanctioned-mutation-guard.mjs <src-dir-or-file> [...]
 */
import ts from "typescript";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// The two tables whose mutation IS an agent-identity change.
const GUARDED_TABLES = new Set(["agents", "agent_capabilities"]);
// The single sanctioned mutation site — EXACTLY src/db.ts (not any */db.ts, so a
// future src/<sub>/db.ts cannot auto-exempt itself). Normalize separators so the
// check holds on Windows paths too; the bare "db.ts" form is the test's fixture.
const SANCTIONED = (fileName) => {
  const norm = fileName.replace(/\\/g, "/");
  return norm === "db.ts" || norm === "src/db.ts" || norm.endsWith("/src/db.ts");
};
// Mutating verbs. REPLACE is a verb in SQLite; INSERT may carry an OR-clause.
const OR_ACTIONS = new Set(["REPLACE", "IGNORE", "ABORT", "FAIL", "ROLLBACK"]);

// ── SQL tokenizer (comment-stripping, string-aware) ──────────────────────────

function tokenizeSql(sql) {
  const toks = [];
  const n = sql.length;
  let i = 0;
  const isIdStart = (c) => /[A-Za-z_]/.test(c);
  const isId = (c) => /[A-Za-z0-9_$]/.test(c);
  const readQuoted = (close) => {
    i++;
    let v = "";
    while (i < n) {
      if (sql[i] === close) {
        if (close !== "]" && sql[i + 1] === close) { v += close; i += 2; continue; } // "" `` '' escape
        i++;
        break;
      }
      v += sql[i++];
    }
    return v;
  };
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) { i++; continue; }
    // Comments — stripped like whitespace, but only OUTSIDE a string literal
    // (we are at top level here; string literals are consumed whole below).
    if (c === "/" && sql[i + 1] === "*") { i += 2; while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++; i += 2; continue; }
    if (c === "-" && sql[i + 1] === "-") { i += 2; while (i < n && sql[i] !== "\n") i++; continue; }
    if (c === "'") { toks.push({ t: "str", v: readQuoted("'") }); continue; }
    if (c === '"') { toks.push({ t: "id", v: readQuoted('"') }); continue; } // "identifier"
    if (c === "`") { toks.push({ t: "id", v: readQuoted("`") }); continue; }
    if (c === "[") { toks.push({ t: "id", v: readQuoted("]") }); continue; }
    if (isIdStart(c)) { let v = ""; while (i < n && isId(sql[i])) v += sql[i++]; toks.push({ t: "id", v }); continue; }
    if (/[0-9]/.test(c)) { let v = ""; while (i < n && /[0-9.]/.test(sql[i])) v += sql[i++]; toks.push({ t: "num", v }); continue; }
    toks.push({ t: "punct", v: c });
    i++;
  }
  return toks;
}

const kwAt = (tk, j) => (tk[j] && tk[j].t === "id" ? tk[j].v.toUpperCase() : null);
const idAt = (tk, j) => (tk[j] && tk[j].t === "id" ? tk[j].v : null);
const isGuarded = (name) => name != null && GUARDED_TABLES.has(name.toLowerCase());

/** Resolve a (possibly schema-qualified) table reference at index i.
 *  Returns { table, next }. `main.agents` → table 'agents'. */
function resolveTable(tk, i) {
  const first = idAt(tk, i);
  if (first == null) return { table: null, next: i };
  if (tk[i + 1] && tk[i + 1].t === "punct" && tk[i + 1].v === "." && idAt(tk, i + 2) != null) {
    return { table: idAt(tk, i + 2), next: i + 3 }; // schema.table
  }
  return { table: first, next: i + 1 };
}

/** Does this statement INSERT / REPLACE / UPDATE / DELETE a guarded table? */
export function mutatesAgentsTable(sql) {
  const tk = tokenizeSql(sql);
  if (tk.length === 0) return false;
  const verb = kwAt(tk, 0);
  if (verb === "DELETE") {
    if (kwAt(tk, 1) !== "FROM") return false;
    return isGuarded(resolveTable(tk, 2).table);
  }
  if (verb === "INSERT") {
    let i = 1;
    if (kwAt(tk, i) === "OR" && OR_ACTIONS.has(kwAt(tk, i + 1))) i += 2;
    if (kwAt(tk, i) !== "INTO") return false;
    return isGuarded(resolveTable(tk, i + 1).table);
  }
  if (verb === "REPLACE") {
    if (kwAt(tk, 1) !== "INTO") return false;
    return isGuarded(resolveTable(tk, 2).table);
  }
  if (verb === "UPDATE") {
    let i = 1;
    if (kwAt(tk, i) === "OR" && OR_ACTIONS.has(kwAt(tk, i + 1))) i += 2;
    const { table } = resolveTable(tk, i);
    return isGuarded(table); // any UPDATE of the table (alias/SET checked implicitly by SQLite)
  }
  return false;
}

// ── AST extraction of static SQL string expressions ──────────────────────────

/** Reconstruct a static string from a literal / `+`-concatenation / template
 *  (interpolations → a space gap). null when fully opaque. */
function reconstructString(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let s = node.head.text;
    for (const span of node.templateSpans) s += " " + span.literal.text;
    return s;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = reconstructString(node.left);
    const r = reconstructString(node.right);
    if (l === null && r === null) return null;
    return (l ?? " ") + (r ?? " ");
  }
  if (ts.isParenthesizedExpression(node)) return reconstructString(node.expression);
  return null;
}

const isStringExpr = (node) =>
  ts.isStringLiteral(node) ||
  ts.isNoSubstitutionTemplateLiteral(node) ||
  ts.isTemplateExpression(node) ||
  (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken);

const isConcatParent = (node) =>
  node.parent && ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken;

/**
 * Find raw guarded-table mutations in one file's source. Sanctioned file
 * (src/db.ts) is exempt. A line carrying `// ALLOWLIST: <reason>` is exempt.
 * Exported for the harm / innocent-twin test.
 */
export function findSanctionedMutationViolations(source, fileName = "file.ts") {
  if (SANCTIONED(fileName)) return [];
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = source.split("\n");
  const violations = [];
  const seen = new Set();

  const hasAllowlist = (node) => {
    const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
    const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line;
    for (let ln = start; ln <= end && ln < lines.length; ln++) {
      if (/\/\/\s*ALLOWLIST:\s*\S/.test(lines[ln])) return true;
    }
    return false;
  };

  const visit = (node) => {
    // Process each string expression at its OUTERMOST point (skip sub-parts of a
    // `+` chain so concatenated SQL is judged once, reconstructed whole).
    if (isStringExpr(node) && !isConcatParent(node)) {
      const sql = reconstructString(node);
      if (sql && mutatesAgentsTable(sql)) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        const key = `${line}:${sql.slice(0, 40)}`;
        if (!seen.has(key) && !hasAllowlist(node)) {
          seen.add(key);
          violations.push({ line, sql: sql.replace(/\s+/g, " ").trim().slice(0, 90) });
        }
      }
      return; // don't descend into an already-classified string expression
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function walkTs(target, acc) {
  const st = fs.statSync(target);
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(target)) {
      if (e === "node_modules" || e === "dist" || e.startsWith(".")) continue;
      walkTs(path.join(target, e), acc);
    }
  } else if (target.endsWith(".ts") && !target.endsWith(".d.ts")) {
    acc.push(target);
  }
  return acc;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stderr.write("usage: sanctioned-mutation-guard.mjs <src-dir-or-file> [...]\n");
    process.exit(2);
  }
  const files = [];
  try {
    for (const a of args) {
      const abs = path.resolve(a);
      if (!fs.existsSync(abs)) { process.stderr.write(`sanctioned-mutation-guard: no such path: ${abs}\n`); process.exit(2); }
      walkTs(abs, files);
    }
  } catch (err) {
    process.stderr.write(`sanctioned-mutation-guard: walk error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
  const all = [];
  for (const f of files) {
    let src;
    try {
      src = fs.readFileSync(f, "utf-8");
    } catch (err) {
      // FAIL CLOSED — an unreadable file is an error, never a silent pass.
      process.stderr.write(`sanctioned-mutation-guard: cannot read ${f}: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(2);
    }
    let vios;
    try {
      vios = findSanctionedMutationViolations(src, f);
    } catch (err) {
      // FAIL CLOSED — a parse failure is an error, never a silent pass.
      process.stderr.write(`sanctioned-mutation-guard: parse error in ${f}: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(2);
    }
    for (const v of vios) all.push({ file: f, ...v });
  }
  if (all.length > 0) {
    process.stderr.write(
      "Raw agents / agent_capabilities mutations found OUTSIDE src/db.ts (agent identity created/replaced/deleted off the sanctioned path):\n",
    );
    for (const v of all) process.stderr.write(`  ${v.file}:${v.line}  ${v.sql}\n`);
    process.stderr.write(
      "\nFix: route the mutation through a sanctioned helper in src/db.ts (registerAgent / mintAgentToken / teardownAgent /\n" +
      "markAgentOffline / closeAgentSession / endAgentSessionOnSignal / releaseAgentBinding / expandAgentCapabilities /\n" +
      "applyAuthStateTransition / updateAgentMetadata). A genuine one-off may append `// ALLOWLIST: <reason>` to the line.\n",
    );
    process.exit(1);
  }
  process.stdout.write("No raw agents/agent_capabilities mutations outside src/db.ts — invariant surface consolidated\n");
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
