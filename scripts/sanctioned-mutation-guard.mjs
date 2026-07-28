#!/usr/bin/env node
// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Sanctioned-mutation guard (ADR-0015). A grep → text-parser → statement-parser
 * chain: the grep missed INSERT/REPLACE/aliases/case; the first parser classified
 * only TOKEN 0, which codex broke by executing `SELECT 1; DELETE FROM agents`, a
 * leading `;`, a WITH-CTE, and identity-destroying DDL. This version enumerates
 * and classifies EVERY statement, covers DDL + trigger bodies, and fails closed.
 *
 * ── L1 — HARM + PREDICATE DECLARED ───────────────────────────────────────────
 * HARM: an agent's identity is CREATED, REPLACED, DELETED, DROPPED, or RENAMED
 *   outside the single sanctioned site (src/db.ts), where the load-bearing
 *   invariants live — probe-cache eviction, auth-generation bump, the
 *   agent_capabilities cascade, the session/anchor CAS. A raw `agents` /
 *   `agent_capabilities` mutation anywhere else bypasses all of them.
 * PREDICATE: in a src/ TypeScript file other than THE project's one src/db.ts, no
 *   string literal contains SQL that, in ANY of its (possibly many, `db.exec`
 *   accepts multiple) statements, mutates a guarded table — by INSERT
 *   (incl. OR-clause/UPSERT) / REPLACE / UPDATE / DELETE, by `DROP TABLE` or
 *   `ALTER TABLE` of it, or by a `CREATE TRIGGER … BEGIN <mutation> END` whose
 *   body does — unless the line carries `// ALLOWLIST: <reason>`.
 * WHY predicate ⟹ harm-prevented, stated HONESTLY (the prior "definitionally only
 *   four DML verbs" claim was FALSE — codex executed DROP/ALTER/trigger, and
 *   src/db.ts itself uses `ALTER TABLE agents`): the guard tokenizes each string
 *   with a string/comment-aware lexer, splits it into statements, and classifies
 *   each. It is a BEST-EFFORT SQL statement classifier over static literals — NOT
 *   a full SQLite grammar, and NOT "the harm itself". What it does not cover is in
 *   the OUT list below; the durable, non-re-expressible anchor is what SQLite
 *   resolves at execution (a runtime prepare()+exec() probe), tracked separately.
 *
 * ── NORMALIZATION AUDIT ──────────────────────────────────────────────────────
 *   codex re-audit lesson (@509a368): a normalizer that discards the exact
 *   attribute the predicate depends on defects EVERY downstream pass at once —
 *   the quoted-vs-unquoted collapse broke all THREE parser passes. So each
 *   normalization step is stated with WHAT it discards and the DIRECTION:
 *   • tokenizeSql QUOTE PROVENANCE → distinct `qid` vs `id`. A quoted keyword is
 *     NEVER structural; only unquoted `id` is. Dropping this was the P1
 *     under-detection. NOW PRESERVED (see the tokenizer + idAt notes).
 *   • tokenizeSql WHITESPACE + COMMENTS → stripped. SAFE: neither changes which
 *     statement a token belongs to (a line `--` or a block comment that appears
 *     inside a '…' literal is kept as string content, never stripped).
 *   • kwAt CASE → folds keywords to UPPER. SAFE + correct: SQL keywords are
 *     case-insensitive, and post-fix only UNQUOTED tokens reach kwAt.
 *   • isGuarded CASE → folds the table name to lower. OVER-detects a case-distinct
 *     quoted table (`"AGENTS"`), but SQLite identifier comparison is itself
 *     case-insensitive so this matches SQLite — residual is OVER-flag (safe).
 *   • resolveTable SCHEMA → `schema.agents` → `agents`. OVER-detects (any schema's
 *     agents is still an agents mutation). Safe direction.
 *   Every remaining discard OVER-flags; the only one that UNDER-flagged (quote
 *   provenance) is fixed. Direction-of-failure: under-detection is the only
 *   dangerous direction — when a normalizer must choose, it over-flags.
 *
 * ── L2 — FRESHNESS ───────────────────────────────────────────────────────────
 * N/A: a STATIC scan of committed source; no observe→decide→act, no TOCTOU.
 *
 * ── L3 — BYPASS INVENTORY (each closed; codex-executed items marked ⚑) ────────
 *   • CASE / VERB COVERAGE — case-insensitive verbs+tables; INSERT (incl.
 *     OR-clause), REPLACE, UPDATE, DELETE all classified (the grep did only U/D).
 *   • TABLE ALIAS — `UPDATE agents AS a` / bare alias. CLOSED.
 *   • SCHEMA-QUALIFIED — `UPDATE main.agents …` → resolves the table component.
 *   • QUOTED IDENTIFIER — `"agents"` / `` `agents` `` / `[agents]` → bare name.
 *   • INLINE COMMENTS — a block/line comment between the verb and the table is
 *     stripped during tokenization (string-aware: a `--` inside '…' is preserved).
 *   • STRING-SPLIT / VARIABLE — `+`-concat + template quasis reconstructed; every
 *     string literal is scanned, not only `.prepare()` args.
 *   • ⚑ MULTI-STATEMENT — `db.exec` runs many statements; token-0 classification
 *     hid every statement after the first. CLOSED: enumerate ALL statements by
 *     splitting the LEXED token stream on top-level `;` (paren- and BEGIN/END-
 *     aware; a `;` inside a string/comment is a token, never a separator — the
 *     split is sound BECAUSE the lexer already resolved that context).
 *   • ⚑ LEADING SEPARATOR — `; DELETE …` (empty first statement). CLOSED by the
 *     same enumeration.
 *   • ⚑ CTE — `WITH x AS (…) DELETE FROM agents` hides the verb behind WITH.
 *     CLOSED: resolve the real DML verb at paren-depth 0 after the CTE list.
 *   • ⚑ IDENTITY DDL + TRIGGERS — `DROP TABLE agents`, `ALTER TABLE agents RENAME
 *     …`, and `CREATE TRIGGER … BEGIN DELETE FROM agents … END` were all
 *     executed. CLOSED: DROP TABLE / ALTER TABLE classified; a trigger's BEGIN…END
 *     body is enumerated and each body statement classified.
 *   • ⚑ NESTED src/db.ts SELF-EXEMPTION — `endsWith("/src/db.ts")` exempted a
 *     nested src/<sub>/src/db.ts (TypeScript compiles it), a bypass anyone could
 *     build. CLOSED: EXACT project-root-relative match to the one src/db.ts.
 *   • ⚑ FAIL-OPEN ON PARSE — the old code CLAIMED it exited 2 on a parse failure
 *     but never checked `parseDiagnostics`, so malformed TS ran on an
 *     error-recovery tree (fail-closed on READ, fail-OPEN on PARSE — the exact
 *     audit-state-freshness.sh split). CLOSED: parseDiagnostics non-empty → exit 2.
 *   • AMBIENT DISABLE — none; the only escape is the per-line `// ALLOWLIST:
 *     <reason>`. The reason check enforces a SHAPE ONLY — it rejects a trivially
 *     empty / one-token reason but does NOT verify JUSTIFICATION (it accepts
 *     `// ALLOWLIST: aaaaaaaa` and rejects `// ALLOWLIST: aa`: a spelling gate,
 *     not a meaning gate; codex T5 correctly refuted the stronger claim).
 *     MEANING IS HUMAN-REVIEWED ONLY — the actual authority is that EVERY
 *     exemption is EMITTED to stderr (file:line + SQL + reason) for a reviewer to
 *     confirm. A structured OWNER/ticket registry that mechanically justifies an
 *     exemption is a real, SEPARATE piece of work, scoped later — NOT claimed
 *     closed here.
 *
 *   OUT — HONEST BOUNDARIES (things not yet shown reachable, or deliberately
 *   deferred), never captions over demonstrated harm:
 *   • FALSE POSITIVE on PROSE — ACCEPTED + STATED (codex bar 4; a stated proxy is
 *     honest, an unstated one is the defect). The guard classifies string LITERALS
 *     by structure, so a diagnostic constant that lexes as a mutation prefix (e.g.
 *     "DELETE FROM agents is forbidden; call teardownAgent") is OVER-flagged,
 *     though SQLite rejects that text as a syntax error. This is DELIBERATELY not
 *     "fixed": both cures are worse than the FP. A hand-rolled continuation grammar
 *     UNDER-blocks silently — `IS` is itself a SQL keyword, so "…agents is
 *     forbidden" defeats a next-token check, and "my continuation list is complete"
 *     is a NEW proxy for "valid SQL" (a false NEGATIVE — the dangerous direction).
 *     A `db.prepare()` validator puts a live SQL engine inside the lint script (new
 *     audit surface in the thing that audits). ADR-0015 direction-of-failure: a
 *     LOUD safe over-block with an escape beats a SILENT under-block. ESCAPE for a
 *     legitimate such string: route via src/db.ts, or add a reason-bearing
 *     `// ALLOWLIST:`. (The guard passes clean on real src today — this FP is
 *     latent, not active.)
 *   • RUNTIME-ASSEMBLED SQL — `[...].join(' ')`, char-building, a fully computed
 *     identifier: no classifiable literal. Route through db.ts or ALLOWLIST.
 *   • NOVEL GRAMMAR — a statement form the classifier does not enumerate. This is
 *     the residual the durable RUNTIME anchor (SQLite's own parse at prepare/exec)
 *     exists to close; the static guard is the broad net over all source
 *     (cold paths included), the runtime probe is authoritative over executed
 *     paths — neither alone is complete, they compose.
 *
 * ── L4 — SIGNAL CONTRACT ─────────────────────────────────────────────────────
 * One predicate, one source: `mutatesAgentsTable()` decides both the violation
 * and the message, exported + driven by the harm/innocent-twin test, so gate and
 * test consume the identical predicate.
 *
 * TEST: tests/v2-24-0-sanctioned-mutation-guard.test.ts attempts the ACTUAL harm
 * through each executed bypass (assert flagged, each red against the token-0
 * version) + innocent twins (assert NOT flagged) + the tokenizer's string/comment
 * lexing directly (the statement split's soundness rests on it).
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
// The single sanctioned mutation site — EXACTLY the project's one src/db.ts.
// codex P1: the prior `endsWith("/src/db.ts")` let a NESTED src/<sub>/src/db.ts
// exempt itself (TypeScript compiles nested src trees), so anyone could bypass
// the guard by adding a file at that path. Match is now EXACT: with a srcRoot
// (the scanned dir, passed by the CLI) the file's path RELATIVE to it must be
// exactly "db.ts"; without one, the bare relative form must be "db.ts" /
// "src/db.ts" (the test fixtures). No suffix match anywhere.
const SANCTIONED = (fileName, srcRoot) => {
  const rel = (srcRoot ? path.relative(srcRoot, fileName) : fileName).replace(/\\/g, "/");
  return rel === "db.ts" || rel === "src/db.ts";
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
    // QUOTED identifiers get a DISTINCT token type `qid` — NEVER `id`. codex P1
    // (@509a368): collapsing quoted + unquoted words into one `id` type let a
    // quoted keyword HIJACK the three structural passes — `"CASE"`/`"BEGIN"` read
    // as block openers, `"delete"` as a CTE's real DML verb, `"BEGIN"` as a
    // trigger-body opener — each an EXECUTED under-detection. Keyword + structure
    // passes (kwAt / splitStatements / firstTopLevelDml / trigger discovery)
    // consume UNQUOTED `id` only; identifier RESOLUTION (idAt) accepts both, so a
    // quoted TABLE name like `"agents"` / `[agents]` still resolves and is caught.
    if (c === '"') { toks.push({ t: "qid", v: readQuoted('"') }); continue; } // "identifier"
    if (c === "`") { toks.push({ t: "qid", v: readQuoted("`") }); continue; }
    if (c === "[") { toks.push({ t: "qid", v: readQuoted("]") }); continue; }
    if (isIdStart(c)) { let v = ""; while (i < n && isId(sql[i])) v += sql[i++]; toks.push({ t: "id", v }); continue; }
    if (/[0-9]/.test(c)) { let v = ""; while (i < n && /[0-9.]/.test(sql[i])) v += sql[i++]; toks.push({ t: "num", v }); continue; }
    toks.push({ t: "punct", v: c });
    i++;
  }
  return toks;
}

const kwAt = (tk, j) => (tk[j] && tk[j].t === "id" ? tk[j].v.toUpperCase() : null);
// Identifier RESOLUTION accepts a quoted OR unquoted identifier (a table may be
// written `agents`, `"agents"`, `[agents]`, or `` `agents` ``). Keyword/structure
// reads use kwAt (UNQUOTED `id` only) — see the tokenizer's `qid` note above.
const idAt = (tk, j) => (tk[j] && (tk[j].t === "id" || tk[j].t === "qid") ? tk[j].v : null);
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

const DML_VERBS = new Set(["DELETE", "INSERT", "REPLACE", "UPDATE"]);

/**
 * Split a token stream into TOP-LEVEL statements on `;` — where "top level" is
 * paren depth 0 AND outside a BEGIN…END / CASE…END block, so a `;` inside a
 * trigger body (or a CASE) does not terminate the outer statement. `db.exec`
 * accepts MANY statements in one string; each must be classified, not just the
 * first (codex P1: token-0-only classification let `SELECT 1; DELETE FROM
 * agents`, a leading `;`, and a CTE all hide the mutation). The `;` split is
 * sound because the tokenizer already resolved string/comment context — a `;`
 * inside a '…' / "…" / `…` / […] literal is part of that token, never a punct.
 */
function splitStatements(tk) {
  const out = [];
  let cur = [];
  let depth = 0;
  for (const t of tk) {
    if (t.t === "punct" && t.v === "(") depth++;
    else if (t.t === "punct" && t.v === ")") { if (depth > 0) depth--; }
    else if (t.t === "id") {
      const kw = t.v.toUpperCase();
      if (kw === "BEGIN" || kw === "CASE") depth++;
      else if (kw === "END") { if (depth > 0) depth--; }
    }
    if (t.t === "punct" && t.v === ";" && depth === 0) { out.push(cur); cur = []; continue; }
    cur.push(t);
  }
  if (cur.length) out.push(cur);
  return out;
}

/** First DML verb at paren-depth 0 from `from` — used to skip a WITH … CTE list,
 *  whose subquery bodies live inside `AS ( … )` at depth ≥ 1. */
function firstTopLevelDml(tk, from) {
  let depth = 0;
  for (let i = from; i < tk.length; i++) {
    const t = tk[i];
    if (t.t === "punct" && t.v === "(") depth++;
    else if (t.t === "punct" && t.v === ")") { if (depth > 0) depth--; }
    else if (depth === 0 && t.t === "id" && DML_VERBS.has(t.v.toUpperCase())) return i;
  }
  return -1;
}

/**
 * Does ONE statement CREATE / REPLACE / DELETE / DROP / RENAME the guarded table,
 * or install a trigger whose body mutates it? Covers, beyond DML: `DROP TABLE
 * agents`, `ALTER TABLE agents …` (incl. RENAME), and `CREATE TRIGGER … BEGIN
 * <mutation> END` — all EXECUTED by codex, and `src/db.ts` itself uses `ALTER
 * TABLE agents`, so identity destruction is NOT "definitionally only DML".
 */
function classifyStatement(tk) {
  let i = 0;
  while (i < tk.length && tk[i].t === "punct") i++; // leading empties / stray `;`
  if (i >= tk.length) return false;
  let verb = kwAt(tk, i);

  // WITH [RECURSIVE] <cte>… <verb …> — resolve to the real DML verb after the CTE.
  if (verb === "WITH") {
    const vi = firstTopLevelDml(tk, i + 1);
    if (vi < 0) return false; // WITH … SELECT is a read
    i = vi;
    verb = kwAt(tk, i);
  }

  if (verb === "DELETE") return kwAt(tk, i + 1) === "FROM" && isGuarded(resolveTable(tk, i + 2).table);
  if (verb === "INSERT") {
    let j = i + 1;
    if (kwAt(tk, j) === "OR" && OR_ACTIONS.has(kwAt(tk, j + 1))) j += 2;
    return kwAt(tk, j) === "INTO" && isGuarded(resolveTable(tk, j + 1).table);
  }
  if (verb === "REPLACE") return kwAt(tk, i + 1) === "INTO" && isGuarded(resolveTable(tk, i + 2).table);
  if (verb === "UPDATE") {
    let j = i + 1;
    if (kwAt(tk, j) === "OR" && OR_ACTIONS.has(kwAt(tk, j + 1))) j += 2;
    return isGuarded(resolveTable(tk, j).table); // any UPDATE of the table
  }
  if (verb === "DROP") {
    if (kwAt(tk, i + 1) !== "TABLE") return false; // DROP TRIGGER/INDEX/VIEW are not table mutations
    let j = i + 2;
    if (kwAt(tk, j) === "IF" && kwAt(tk, j + 1) === "EXISTS") j += 2;
    return isGuarded(resolveTable(tk, j).table);
  }
  if (verb === "ALTER") {
    return kwAt(tk, i + 1) === "TABLE" && isGuarded(resolveTable(tk, i + 2).table);
  }
  if (verb === "CREATE") {
    // CREATE [TEMP|TEMPORARY] TRIGGER … BEGIN <body> END — flag if the body
    // mutates a guarded table. (CREATE TABLE/VIEW/INDEX before any TRIGGER kw → not us.)
    let isTrigger = false;
    for (let k = i + 1; k < tk.length; k++) {
      const kw = kwAt(tk, k);
      if (kw === "TRIGGER") { isTrigger = true; break; }
      if (kw === "TABLE" || kw === "VIEW" || kw === "INDEX" || kw === "BEGIN") break;
    }
    if (!isTrigger) return false;
    const bi = tk.findIndex((t, idx) => idx > i && t.t === "id" && t.v.toUpperCase() === "BEGIN");
    if (bi < 0) return false;
    let depth = 0, ei = -1;
    for (let k = bi; k < tk.length; k++) {
      const kw = tk[k].t === "id" ? tk[k].v.toUpperCase() : null;
      if (kw === "BEGIN" || kw === "CASE") depth++;
      else if (kw === "END") { depth--; if (depth === 0) { ei = k; break; } }
    }
    const body = tk.slice(bi + 1, ei < 0 ? tk.length : ei);
    return splitStatements(body).some(classifyStatement);
  }
  return false;
}

/** Does this SQL string CREATE / REPLACE / DELETE / DROP / RENAME / trigger-mutate
 *  a guarded table in ANY of its (possibly many) statements? */
export function mutatesAgentsTable(sql) {
  const tk = tokenizeSql(sql);
  if (tk.length === 0) return false;
  return splitStatements(tk).some(classifyStatement);
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
export function findSanctionedMutationViolations(source, fileName = "file.ts", opts = {}) {
  if (SANCTIONED(fileName, opts.srcRoot)) return [];
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  // FAIL CLOSED on a parse failure. createSourceFile does NOT throw on malformed
  // TS — it records syntax errors in `parseDiagnostics` and returns an
  // error-recovery tree the guard cannot trust (a mutation may or may not survive
  // recovery, input-dependent). The guard already exits 2 when it cannot READ a
  // file; an unreadable-vs-unparseable split (fail-closed on read, fail-OPEN on
  // parse) is the exact audit-state-freshness.sh defect. Throw so main() maps it
  // to exit 2. Real source that compiles under tsc has zero parseDiagnostics.
  if (sf.parseDiagnostics && sf.parseDiagnostics.length > 0) {
    throw new Error(`unparseable TypeScript (${sf.parseDiagnostics.length} syntax error(s)) — cannot soundly scan`);
  }
  const lines = source.split("\n");
  const violations = [];
  const seen = new Set();

  // A per-line `// ALLOWLIST: <reason>` exempts the line. The reason check is a
  // SHAPE gate only — it rejects a trivially empty / one-token reason but does
  // NOT verify justification (codex T5). Meaning is HUMAN-REVIEWED via the emitted
  // report. Returns the reason when a shape-valid exemption is present, else null.
  const allowlistReason = (node) => {
    const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
    const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line;
    for (let ln = start; ln <= end && ln < lines.length; ln++) {
      const m = lines[ln].match(/\/\/\s*ALLOWLIST:\s*(.+?)\s*$/);
      if (m) {
        const reason = m[1].trim();
        // Shape gate (NOT justification): ≥8 chars OR two+ words. `x` / `aa` fail.
        if (reason.length >= 8 || /\S+\s+\S+/.test(reason)) return reason;
      }
    }
    return null;
  };

  const visit = (node) => {
    // Process each string expression at its OUTERMOST point (skip sub-parts of a
    // `+` chain so concatenated SQL is judged once, reconstructed whole).
    if (isStringExpr(node) && !isConcatParent(node)) {
      const sql = reconstructString(node);
      if (sql && mutatesAgentsTable(sql)) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        const key = `${line}:${sql.slice(0, 40)}`;
        if (!seen.has(key)) {
          seen.add(key);
          const trimmed = sql.replace(/\s+/g, " ").trim().slice(0, 90);
          const reason = allowlistReason(node);
          if (reason !== null) {
            // Exempted by a valid reason — RECORD it so main() emits it (codex T5),
            // rather than a silent skip only a diff-reader would catch.
            if (Array.isArray(opts.allowlisted)) opts.allowlisted.push({ line, sql: trimmed, reason });
          } else {
            violations.push({ line, sql: trimmed });
          }
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

function walkTs(target, acc, root) {
  const st = fs.statSync(target);
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(target)) {
      if (e === "node_modules" || e === "dist" || e.startsWith(".")) continue;
      walkTs(path.join(target, e), acc, root);
    }
  } else if (target.endsWith(".ts") && !target.endsWith(".d.ts")) {
    // Carry the scan root so SANCTIONED can match src/db.ts by EXACT relative
    // path (a nested src/db.ts must NOT self-exempt — codex P1).
    acc.push({ file: target, root });
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
      const root = fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
      walkTs(abs, files, root);
    }
  } catch (err) {
    process.stderr.write(`sanctioned-mutation-guard: walk error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
  const all = [];
  const allowlisted = [];
  for (const { file: f, root } of files) {
    let src;
    try {
      src = fs.readFileSync(f, "utf-8");
    } catch (err) {
      // FAIL CLOSED — an unreadable file is an error, never a silent pass.
      process.stderr.write(`sanctioned-mutation-guard: cannot read ${f}: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(2);
    }
    let vios;
    const fileAllow = [];
    try {
      vios = findSanctionedMutationViolations(src, f, { srcRoot: root, allowlisted: fileAllow });
    } catch (err) {
      // FAIL CLOSED — a parse failure is an error, never a silent pass.
      process.stderr.write(`sanctioned-mutation-guard: parse error in ${f}: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(2);
    }
    for (const v of vios) all.push({ file: f, ...v });
    for (const a of fileAllow) allowlisted.push({ file: f, ...a });
  }
  // codex T5 — EMIT every allowlist exemption to stderr, so an unjustified one is
  // LOUD in CI, never "detectable only by a human noticing the diff". These do
  // NOT fail the gate on their own; each is printed for review.
  if (allowlisted.length > 0) {
    process.stderr.write(`sanctioned-mutation-guard: ${allowlisted.length} ALLOWLIST exemption(s) in effect — reasons are HUMAN-REVIEWED, not machine-verified; confirm each is justified:\n`);
    for (const a of allowlisted) process.stderr.write(`  ALLOWLIST ${a.file}:${a.line}  ${a.sql}  — reason: ${a.reason}\n`);
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
