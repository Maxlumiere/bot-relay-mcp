#!/usr/bin/env node
// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.23.x #140 — probe-cache eviction drift guard (TS-AST + SQL PARSER).
 *
 * The two liveness probe caches (src/db.ts `_negativeProbeCache` /
 * `_positiveProbeCache`) are keyed by agent NAME and cache the ANCHOR-liveness
 * verdict computed by `computeLivenessVerdict`. They are only safe if EVERY
 * writer that CREATES, REPLACES, or DELETES a name's liveness identity evicts
 * BOTH caches UNCONDITIONALLY — otherwise a stale entry outlives the binding it
 * described and mislabels the next one (a live row read `dead`, or an argv-scan
 * alive signal suppressed by a stale negative) until the ~5s TTL.
 *
 * ── WHY THIS GUARD PARSES SQL INSTEAD OF MATCHING TEXT ───────────────────────
 * The chain that produced this guard is a lesson in proxies (worth ADR-0015):
 *   1. the sweep grepped for the *unbraced if* (syntax) — missed the braced 5th
 *      site (the defect is CONDITIONALITY on a CAS writer, not a missing brace);
 *   2. the first predicate was "mutates session/anchor state" — too narrow;
 *      codex widened it to create/replace/delete of a liveness identity;
 *   3. the first implementation matched literal SQL TEXT (`UPDATE agents SET`) as
 *      a proxy for "this statement mutates agents identity" — codex EVADED it
 *      with ordinary, valid SQLite: `UPDATE agents AS a SET …` (aliased) and
 *      `INSERT OR REPLACE INTO agents …`. Broadening the regex would be the same
 *      mistake, wider — complete for nothing.
 * So this guard PARSES. The SQL in src/db.ts is STATIC LITERAL text passed to
 * `.prepare(...)` / `.exec(...)`, which makes a real (small) statement parser
 * tractable: it tokenizes each statement and answers ONE question — does it
 * mutate the `agents` table's identity columns? A parser is complete for the
 * grammar it implements; that grammar is written down below.
 *
 * ── GRAMMAR: WHAT IS IN (parsed, and thus GUARDED) ───────────────────────────
 *   • `DELETE FROM agents …`
 *   • `INSERT [OR REPLACE|OR IGNORE|OR ABORT|OR FAIL|OR ROLLBACK] INTO agents …`
 *   • `UPDATE [OR …] agents [AS <alias> | <alias>] SET <assignments> …`, where an
 *     assignment target is one of the identity columns (session_id / agent_pid /
 *     agent_pid_start), possibly qualified (`a.session_id`) or quoted
 *     (`"session_id"`, `` `session_id` ``, `[session_id]`). The table name is
 *     matched EXACTLY, so `agents_new` / `agent_capabilities` are not the table.
 *   • SQL provided as a string literal, a `+`-concatenation of string literals,
 *     or a template literal (static quasis; `${…}` interpolations are treated as
 *     opaque gaps — the statement head is always a static prefix in this code).
 *
 * ── WHAT IS OUT (deliberately unhandled — an HONEST boundary, not a guarantee) ─
 *   • SQL assembled at RUNTIME into a variable and then prepared (the parser
 *     can't see a value it doesn't have). db.ts uses literals today; a future
 *     dynamic-SQL identity writer must either evict or be added consciously.
 *   • SQL executed through a method other than `.prepare` / `.exec`.
 *   • Row-value SET syntax `SET (a, b) = (…)` (SQLite-rare; unused here).
 *   • The malicious-insider model (eval / reflection / string obfuscation /
 *     dynamically-named mutators). This guard defends against ACCIDENTAL DRIFT.
 *   It also does not prove every EARLY-RETURN path evicts — the per-site
 *   CAS-loser tests (tests/v2-23-0-cache-invalidation.test.ts) do that, one case
 *   per shipped writer. Anything in this OUT list that needs coverage is a
 *   conscious follow-up, not an implied promise.
 *
 * REQUIREMENT. An identity writer MUST evict BOTH caches, and each eviction must
 * be a TOP-LEVEL STATEMENT of the function body — the semantic encoding of
 * "unconditional": the braced fifth site put its evictions inside
 * `if (r.changes === 1) { … }`, so they were NOT top-level. A writer with two SQL
 * forms in separate branches hoists a SINGLE eviction to the common tail (as
 * `closeAgentSession` does) so the guard verifies it on every path.
 *
 * INIT-ONLY ALLOWLIST. Schema migrations run ONCE at DB initialization, before
 * the daemon serves any read — the probe caches are empty then, so a one-time
 * backfill of an identity column has nothing to evict. EXPLICIT set (not a
 * `migrateSchemaTo*` wildcard): a runtime writer cannot evade by naming itself
 * one. Add a migration here CONSCIOUSLY, and only if it is genuinely init-only.
 *
 * Exit: 0 = clean · 1 = violations (stderr) · 2 = usage/parse error
 * Usage: node scripts/probe-cache-guard.mjs <db.ts> [<file> ...]
 */
import ts from "typescript";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const IDENTITY_COLS = new Set(["session_id", "agent_pid", "agent_pid_start"]);
const NEG = "_negativeProbeCache";
const POS = "_positiveProbeCache";
// INSERT/UPDATE conflict clauses: `INSERT OR REPLACE`, `UPDATE OR ROLLBACK`, …
const OR_ACTIONS = new Set(["REPLACE", "IGNORE", "ABORT", "FAIL", "ROLLBACK"]);
const INIT_ONLY_ALLOWLIST = new Set(["migrateSchemaToV2_0"]);

// ── SQL statement classifier ────────────────────────────────────────────────

/** Tokenize a single SQL statement into {t, v}. t ∈ id | dqid | str | num |
 *  punct. Quoted identifiers ("x" / `x` / [x]) become dqid so a column named via
 *  a quoted form is still recognised. String literals ('x') become str (never a
 *  column target). */
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
        if (close !== "]" && sql[i + 1] === close) { v += close; i += 2; continue; } // "" `` escape
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
    if (c === "'") { toks.push({ t: "str", v: readQuoted("'") }); continue; }
    if (c === '"') { toks.push({ t: "dqid", v: readQuoted('"') }); continue; }
    if (c === "`") { toks.push({ t: "dqid", v: readQuoted("`") }); continue; }
    if (c === "[") { toks.push({ t: "dqid", v: readQuoted("]") }); continue; }
    if (isIdStart(c)) { let v = ""; while (i < n && isId(sql[i])) v += sql[i++]; toks.push({ t: "id", v }); continue; }
    if (/[0-9]/.test(c)) { let v = ""; while (i < n && /[0-9.]/.test(sql[i])) v += sql[i++]; toks.push({ t: "num", v }); continue; }
    toks.push({ t: "punct", v: c });
    i++;
  }
  return toks;
}

const kwAt = (tk, j) => (tk[j] && tk[j].t === "id" ? tk[j].v.toUpperCase() : null);
const identAt = (tk, j) => (tk[j] && (tk[j].t === "id" || tk[j].t === "dqid") ? tk[j].v : null);

/** The last identifier token of a SET-target — resolves `a.session_id` → session_id,
 *  `"session_id"` → session_id, `session_id` → session_id. */
function lastIdent(toks) {
  for (let j = toks.length - 1; j >= 0; j--) {
    if (toks[j].t === "id" || toks[j].t === "dqid") return toks[j].v;
  }
  return null;
}

/** Does the SET clause (starting at `start`, up to a depth-0 WHERE or end) assign
 *  to any identity column? Depth-aware so a `COALESCE(host_id, ?)` comma / `=`
 *  inside parens is not mistaken for a SET separator or an assignment. */
function setListWritesIdentity(tk, start) {
  let depth = 0;
  let lhs = [];
  let seenEq = false;
  for (let i = start; i < tk.length; i++) {
    const t = tk[i];
    if (depth === 0 && t.t === "id" && t.v.toUpperCase() === "WHERE") break;
    if (t.t === "punct") {
      if (t.v === "(") { depth++; if (!seenEq) lhs.push(t); continue; }
      if (t.v === ")") { depth--; if (!seenEq) lhs.push(t); continue; }
      if (depth === 0 && t.v === ",") { lhs = []; seenEq = false; continue; }
      if (depth === 0 && t.v === "=" && !seenEq) {
        const col = lastIdent(lhs);
        if (col && IDENTITY_COLS.has(col)) return true;
        seenEq = true;
        continue;
      }
    }
    if (!seenEq) lhs.push(t);
  }
  return false;
}

/** Does this statement CREATE / REPLACE / DELETE the `agents` table's identity? */
export function mutatesAgentsIdentity(sql) {
  const tk = tokenizeSql(sql);
  if (tk.length === 0) return false;
  const verb = kwAt(tk, 0);
  if (verb === "DELETE") {
    return kwAt(tk, 1) === "FROM" && identAt(tk, 2) === "agents";
  }
  if (verb === "INSERT") {
    let i = 1;
    if (kwAt(tk, i) === "OR" && OR_ACTIONS.has(kwAt(tk, i + 1))) i += 2;
    return kwAt(tk, i) === "INTO" && identAt(tk, i + 1) === "agents";
  }
  if (verb === "UPDATE") {
    let i = 1;
    if (kwAt(tk, i) === "OR" && OR_ACTIONS.has(kwAt(tk, i + 1))) i += 2;
    if (identAt(tk, i) !== "agents") return false;
    i++;
    // optional table alias: `AS x` or a bare identifier that is not SET
    if (kwAt(tk, i) === "AS") i += 2;
    else if (tk[i] && tk[i].t === "id" && kwAt(tk, i) !== "SET") i++;
    if (kwAt(tk, i) !== "SET") return false;
    return setListWritesIdentity(tk, i + 1);
  }
  return false;
}

// ── SQL extraction from the AST (static literals only) ───────────────────────

/** Reconstruct a static SQL string from a `.prepare(...)` / `.exec(...)` argument:
 *  string literal, `+`-concatenation of literals, or template literal (static
 *  quasis; interpolations → a space gap). Returns null when the argument is
 *  opaque (a variable / call result) — see the OUT boundary. */
function reconstructSql(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let s = node.head.text;
    for (const span of node.templateSpans) s += " " + span.literal.text;
    return s;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = reconstructSql(node.left);
    const r = reconstructSql(node.right);
    if (l === null && r === null) return null;
    return (l ?? " ") + (r ?? " ");
  }
  if (ts.isParenthesizedExpression(node)) return reconstructSql(node.expression);
  return null;
}

/** All static SQL strings prepared/exec'd anywhere in a function body (incl.
 *  nested transaction closures). */
function collectPreparedSql(bodyNode) {
  const sqls = [];
  const walk = (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const method = n.expression.name.text;
      if ((method === "prepare" || method === "exec") && n.arguments.length > 0) {
        const sql = reconstructSql(n.arguments[0]);
        if (sql) sqls.push(sql);
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(bodyNode);
  return sqls;
}

// ── Eviction placement (unconditional == top-level statement) ────────────────

function isEvictionCall(expr, cacheName) {
  return (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === cacheName &&
    expr.expression.name.text === "delete"
  );
}

/** Are both evictions present as DIRECT statements of the function body block? A
 *  non-block body (single-expression arrow) has no statements → { false, false }. */
function topLevelEvictions(bodyNode) {
  const found = { neg: false, pos: false };
  if (!bodyNode || !ts.isBlock(bodyNode)) return found;
  for (const stmt of bodyNode.statements) {
    if (!ts.isExpressionStatement(stmt)) continue;
    if (isEvictionCall(stmt.expression, NEG)) found.neg = true;
    if (isEvictionCall(stmt.expression, POS)) found.pos = true;
  }
  return found;
}

/**
 * Return { name, line, reason } for identity writers that don't evict both
 * caches unconditionally (top-level). Exported so the negative-fixture test can
 * prove the guard FAILS on drift — including the aliased/conflict-clause forms.
 */
export function findProbeCacheViolations(source, fileName = "db.ts") {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations = [];

  const analyze = (name, bodyNode, nameNode) => {
    if (!name || INIT_ONLY_ALLOWLIST.has(name)) return;
    if (!collectPreparedSql(bodyNode).some(mutatesAgentsIdentity)) return;
    const { neg, pos } = topLevelEvictions(bodyNode);
    if (neg && pos) return;
    const line = sf.getLineAndCharacterOfPosition(nameNode.getStart(sf)).line + 1;
    const bodyStr = bodyNode.getText(sf);
    // A `.delete` present in the text but NOT top-level is the BRACED-fifth-site
    // shape (nested in a conditional → skipped on the CAS-loser path).
    const label = (cache, atTopLevel) =>
      atTopLevel ? null : bodyStr.includes(`${cache}.delete`) ? `${cache}.delete is nested/conditional (not top-level — skipped on the CAS-loser path)` : `${cache}.delete is missing`;
    const reason = [label(NEG, neg), label(POS, pos)].filter(Boolean).join("; ");
    violations.push({ name, line, reason });
  };

  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      analyze(node.name.text, node.body, node.name);
    } else if (
      ts.isVariableDeclaration(node) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
      node.initializer.body
    ) {
      analyze(node.name.text, node.initializer.body, node.name);
    } else if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.body) {
      analyze(node.name.text, node.body, node.name);
    } else if (
      ts.isPropertyAssignment(node) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
      node.initializer.body
    ) {
      analyze(node.name.text, node.initializer.body, node.name);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}

function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    process.stderr.write("usage: probe-cache-guard.mjs <db.ts> [<file> ...]\n");
    process.exit(2);
  }
  const all = [];
  try {
    for (const f of files) {
      const abs = path.resolve(f);
      if (!fs.existsSync(abs)) {
        process.stderr.write(`probe-cache-guard: no such path: ${abs}\n`);
        process.exit(2);
      }
      const src = fs.readFileSync(abs, "utf-8");
      for (const v of findProbeCacheViolations(src, path.basename(abs))) all.push({ file: abs, ...v });
    }
  } catch (err) {
    process.stderr.write(`probe-cache-guard: parse error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
  if (all.length > 0) {
    process.stderr.write(
      "#140 probe-cache eviction drift: these functions CREATE/REPLACE/DELETE a name's liveness identity but do not evict both probe caches unconditionally (a stale entry outlives the binding it described → the next binding reads a wrong liveness verdict until the TTL):\n",
    );
    for (const v of all) process.stderr.write(`  ${v.file}:${v.line}  ${v.name}()  — ${v.reason}\n`);
    process.stderr.write(
      "\nFix: add `_negativeProbeCache.delete(name); _positiveProbeCache.delete(name);` as TOP-LEVEL statements (unconditional — never inside an `if (r.changes …)`). If this is a genuine init-only migration, add it to INIT_ONLY_ALLOWLIST consciously.\n",
    );
    process.exit(1);
  }
  process.stdout.write("All liveness-identity writers evict both probe caches unconditionally — probe-cache invalidation intact\n");
  process.exit(0);
}

// Run as CLI only when invoked directly (not when imported by the test). Compare
// resolved paths (fileURLToPath decodes %20 etc.) so a working directory with
// spaces — e.g. "…/Claude AI/…" — still triggers main().
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
