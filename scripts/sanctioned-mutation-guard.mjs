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
 *     NEVER structural; only unquoted `id` is. Dropping this was the @509a368 P1
 *     (a quoted keyword hijacked the block/CTE/trigger passes). Preserved.
 *   • idAt IDENTIFIER RESOLUTION → DEFAULT-DENY. The @b5aae98 P1 lived here: idAt
 *     ALLOWLISTED the quote forms we knew (id|qid), so SQLite's SINGLE-quoted
 *     identifier (`str`, a MySQL-compat form we had not enumerated) walked past —
 *     six EXECUTED under-detections. An allowlist of what is RECOGNISED fails
 *     OPEN. Inverted: in identifier position anything that is not a PROVABLE
 *     non-identifier (a `punct`) is resolved, so the NEXT unforeseen quote form
 *     over-flags loudly instead of silently passing.
 *   • tokenizeSql WHITESPACE → stripped, but ONLY SQLite's five ASCII whitespace
 *     code points (isSqliteWs). The @2e69d16 P1 lived here: JS `/\s/` ALSO matches
 *     the Unicode whitespace set (NBSP U+00A0, U+1680, U+2000…), which SQLite
 *     treats as IDENTIFIER chars — so `/\s/` DROPPED the `<NBSP>` before isIdStart
 *     could see it, and `DELETE FROM <NBSP>.agents` executed and walked past. `/\s/`
 *     is JAVASCRIPT's whitespace, not SQLite's (see the CLASSIFIER CENSUS below).
 *     Now ASCII-exact → a Unicode-space survives to isIdStart and over-flags.
 *   • tokenizeSql COMMENTS → stripped. SAFE: does not change which statement a
 *     token belongs to (a line `--` or a block comment that appears inside a '…'
 *     literal is kept as string content, never stripped).
 *   • kwAt CASE → folds keywords to UPPER. SAFE + correct: SQL keywords are
 *     case-insensitive, and only UNQUOTED tokens reach kwAt.
 *   • isGuarded CASE → folds the table name to lower. OVER-detects a case-distinct
 *     quoted table (`"AGENTS"`), but SQLite identifier comparison is itself
 *     case-insensitive so this matches SQLite — residual is OVER-flag (safe).
 *   • resolveTable SCHEMA → `schema.agents` → `agents`. OVER-detects (any schema's
 *     agents is still an agents mutation). Safe direction.
 *   FOUR discards UNDER-flagged and all four are fixed: quote provenance in the
 *   structure passes (@509a368), the resolution allowlist (@b5aae98), the
 *   ASCII-only identifier CHARACTER class (@e2d7607 — `α.agents` executed), and the
 *   JS-vs-SQLite WHITESPACE class (@2e69d16 — `<NBSP>.agents` executed and walked
 *   past because `/\s/` dropped the NBSP one classifier BEFORE the fixed isIdStart
 *   could see it). Each was an ENUMERATION of an EXTERNAL grammar we do NOT control
 *   and cannot close by reading our own code — hence default-deny / match-SQLite,
 *   not lists. Direction-of-failure: under-detection is the only dangerous
 *   direction — when in doubt, over-flag.
 *
 *   ── THE TERMINAL FORM — CLASSIFIER CENSUS ────────────────────────────────────
 *   The generalisation the first three P1s were groping toward: EVERY classifier
 *   this guard BORROWS FROM JAVASCRIPT to make a SQLite decision is an implicit
 *   enumeration of a FOREIGN grammar. `/\s/`, `.toUpperCase()`, `.toLowerCase()`,
 *   `[0-9]` are JavaScript's notions, not SQLite's; where they diverge AND the
 *   divergence points the wrong way, a mutation walks past. Unlike the previous
 *   layers this set is FINITE — the classifiers in one file are countable — so
 *   enumerating it TERMINATES the layer-by-layer arc. Each is stated with its
 *   direction vs SQLite (WIDER → can spuriously match → over-flag = safe; NARROWER
 *   → can miss a real one → under-flag = the danger):
 *   A. `/\s/` WHITESPACE (now isSqliteWs) — was WIDER (matched Unicode whitespace
 *      SQLite treats as identifier chars) → UNDER-flag, the @2e69d16 P1. FIXED:
 *      ASCII-exact to SQLite's five (U+0009/0A/0C/0D/20).
 *   B. `.toUpperCase()` KEYWORD fold (kwAt, splitStatements, classifyStatement) —
 *      WIDER than SQLite's ASCII-only keyword fold; only a NON-ASCII token can be
 *      spuriously promoted to a keyword (SQLite rejects it as syntax) → OVER-flag.
 *      No real ASCII keyword ever folds AWAY. Safe. (codex: no case bypass.)
 *   C. `.toLowerCase()` TABLE-NAME fold (isGuarded) — WIDER than SQLite's ASCII-only
 *      identifier case-insensitivity; every name SQLite treats as guarded is ASCII
 *      and folds correctly, and a non-ASCII name folding INTO a guarded name is a
 *      table SQLite treats as DISTINCT → OVER-flag. Safe. (codex: no case bypass.)
 *   D. `isIdStart`/`isId` CHARACTER class — MATCHES SQLite (any code point >= 0x80
 *      is an identifier char); the ASCII set matches. isIdStart omits `$`-as-first,
 *      but guarded names never start with `$` (assertGuardedNamesProvable) so that
 *      narrowing is unreachable.
 *   E. `[0-9]` NUMERIC start (only entered when NOT isIdStart) — EXACT to SQLite's
 *      ASCII digits; a non-ASCII "digit" (U+0660…) is >= 0x80 so isIdStart claims it
 *      first, exactly as SQLite treats it (identifier, not number). Consistent.
 *   F. PUNCT equality `=== "." / "(" / ")" / ";"` — EXACT ASCII; SQLite accepts only
 *      ASCII for the schema dot, statement `;`, and parens (a fullwidth `．`/`；` is
 *      > 0x7F → an identifier char to BOTH tokenizers). Matches.
 *   G. COMMENT delimiters — the `--` line form (terminated at `\n` = U+000A) and the
 *      block form opened by slash-star — EXACT ASCII, matching SQLite (which ends a
 *      line comment at LF or EOF only).
 *   NON-classifiers (borrow JS notions but make NO SQLite decision, so excluded):
 *   the path `.replace(/\\/g,"/")` (filesystem); the display `.replace(/\s+/g," ")`
 *   (cosmetic, AFTER mutatesAgentsTable already decided); the `// ALLOWLIST:` regex
 *   `\s` (parses THIS guard's own TS-source directive — JS whitespace is correct
 *   there); TS `node.text` (decodes escapes to the exact runtime string SQLite sees).
 *
 *   The quoted-identifier / character-class proof (by the guarded-name assertion
 *   below) therefore rests on FOUR premises, each stated with its direction:
 *   (1) guarded names are bare identifiers — ENFORCED at module load
 *       (assertGuardedNamesProvable): the premise is CHECKED, not assumed;
 *   (2) the quote-form enumeration — OPEN; default-deny in idAt makes its failure a
 *       loud OVER-flag (an unforeseen quote form resolves), not a silent miss;
 *   (3) the identifier CHARACTER classes — CLOSED to SQLite's rule (any code point
 *       >= 0x80 is an identifier char), so an unrecognised code point OVER-flags
 *       rather than being silently made punct;
 *   (4) the host-language classifier census (A–G) — FINITE and enumerated here; each
 *       classifier either MATCHES SQLite or diverges only in the OVER-flag (safe)
 *       direction. This is the premise that TERMINATES the arc: there is no further
 *       layer beneath it, because the borrowed classifiers are a bounded, listed set.
 *   Each earlier P1 was this same lesson one layer deeper; the census names the
 *   floor — closed by matching SQLite at that layer, never by extending a list.
 *
 * ── L2 — FRESHNESS ───────────────────────────────────────────────────────────
 * N/A: a STATIC scan of committed source; no observe→decide→act, no TOCTOU.
 *
 * ── L3 — BYPASS INVENTORY (each closed; codex-executed items marked ⚑) ────────
 *   • CASE / VERB COVERAGE — case-insensitive verbs+tables; INSERT (incl.
 *     OR-clause), REPLACE, UPDATE, DELETE all classified (the grep did only U/D).
 *   • TABLE ALIAS — `UPDATE agents AS a` / bare alias. CLOSED.
 *   • SCHEMA-QUALIFIED — `UPDATE main.agents …` → resolves the table component.
 *   • QUOTED IDENTIFIER — `"agents"` / `` `agents` `` / `[agents]` / SINGLE-quoted
 *     `'agents'` (SQLite's MySQL-compat form; @b5aae98 P1, missed at first) →
 *     bare name. NOTE: identifier resolution is DEFAULT-DENY, not this list — a
 *     fifth form resolves too; the list is illustrative, not the contract.
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
import { ts, parseGuardSource } from "./lib/guard-parse.mjs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// The two tables whose mutation IS an agent-identity change.
const GUARDED_TABLES = new Set(["agents", "agent_capabilities"]);

// GUARD ON THE GUARD — the quoted-identifier equivalence proof in this header
// rests on a PREMISE: every guarded name is a bare identifier that needs NO
// quoting (so no quoting edge can PRODUCE it). True today; enforced NOWHERE — so
// the day a guarded name with a quote / dot / semicolon / space / uppercase is
// added, the proof silently stops holding while the header still asserts it (a
// gate resting on a fact that does not record the dependency). Check it at module
// load and FAIL LOUD on whoever adds such a name. Over-strict here refuses a
// legal-but-unproven name loudly — the safe way to be wrong.
const SAFE_GUARDED_NAME = /^[a-z_][a-z0-9_]*$/;
export function assertGuardedNamesProvable(names) {
  for (const n of names) {
    if (!SAFE_GUARDED_NAME.test(n)) {
      throw new Error(
        `sanctioned-mutation-guard: guarded name ${JSON.stringify(n)} is not a bare identifier ` +
          `(${SAFE_GUARDED_NAME}). The quoted-identifier equivalence proof in this file's header assumes ` +
          `guarded names need NO quoting — this one does, so re-derive that proof before adding it.`,
      );
    }
  }
}
assertGuardedNamesProvable(GUARDED_TABLES);
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
  // SQLite treats ANY byte >= 0x80 (any non-ASCII code point) as an identifier
  // character — `α`, `名`, etc. are legal BARE identifiers, so `DELETE FROM
  // α.agents` executes. codex re-audit @e2d7607: the ASCII-only isIdStart labelled
  // `α` as `punct`, and idAt's default-deny rejects punct → under-flag. This is
  // PREMISE (3) — character classes, the enumeration one layer UNDER the
  // default-deny "provable non-identifier = punct" test. Conservative + matches
  // SQLite: any code point >= 128 is an identifier char, so an unrecognised code
  // point resolves as a POSSIBLE identifier and OVER-flags, never silently punct.
  const isIdStart = (c) => /[A-Za-z_]/.test(c) || c.charCodeAt(0) >= 128;
  const isId = (c) => /[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) >= 128;
  // SQLite whitespace (sqlite3Isspace) is EXACTLY these five ASCII code points:
  // tab U+0009, LF U+000A, FF U+000C, CR U+000D, space U+0020 — NOT U+000B (VT),
  // and NOTHING >= 0x80. JS `/\s/` is WIDER on BOTH counts: it also matches VT and
  // the whole Unicode whitespace set (NBSP U+00A0, U+1680, U+2000–U+200A, U+2028,
  // U+2029, U+202F, U+205F, U+3000, U+FEFF). SQLite treats every char > U+007F as
  // an IDENTIFIER char, so `DELETE FROM <NBSP>.agents` is a real mutation — but
  // `/\s/` DROPPED the NBSP before isIdStart (@2e69d16 P1). The fix to isIdStart
  // above was correct AND unreachable for those code points: a correct predicate
  // BEHIND a wrong one is not a correct classifier. The terminal lesson (see the
  // CLASSIFIER CENSUS in the header): `/\s/` is JAVASCRIPT's idea of whitespace,
  // not SQLite's — every host-language classifier is an implicit enumeration of a
  // FOREIGN grammar. Match SQLite EXACTLY here; borrow nothing from JS. Direction:
  // ASCII-whitespace-only is NARROWER than `/\s/`, so a Unicode-whitespace code
  // point now survives to isIdStart and OVER-flags rather than being silently
  // dropped — the safe direction, consistent with the rest of the lexer.
  const isSqliteWs = (c) => c === "\t" || c === "\n" || c === "\f" || c === "\r" || c === " ";
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
    if (isSqliteWs(c)) { i++; continue; }
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
// Identifier RESOLUTION is DEFAULT-DENY (codex re-audit @b5aae98). A table
// identifier may be unquoted (agents), double/backtick/bracket-quoted, OR — a
// SQLite MySQL-compat MISFEATURE — a SINGLE-QUOTED token (our `str`) where the
// grammar requires an identifier (`DELETE FROM 'agents'` deletes the rows). We do
// NOT allowlist the quote forms we KNOW: that fails OPEN when SQLite has a form we
// did not enumerate (it had a fourth, and six mutations walked past). Instead, in
// IDENTIFIER POSITION any token that is not a PROVABLE non-identifier — a `punct`
// separator/operator — is treated as a POSSIBLE identifier and resolved, so an
// unforeseen quoting form OVER-flags loudly instead of silently under-flagging.
// (An allowlist of what is RECOGNISED fails open; excluding what is PROVABLY
// not-an-identifier fails closed — the same inversion the value-allowlist uses.)
// Keyword/structure readers stay STRICT: kwAt takes UNQUOTED `id` only, so a
// single-quoted `'DELETE'` is NEVER a verb.
const idAt = (tk, j) => (tk[j] && tk[j].t !== "punct" ? tk[j].v : null);
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
  // PINNED PARSER + FAIL-CLOSED via the shared #47 gate (scripts/lib/guard-parse.mjs).
  // A guard must NEVER own its parser — that is the ADR-0015 anti-pattern ONE LEVEL UP from
  // the text-proxy this guard removes; owning the predicate is the guard's job, owning the
  // grammar is not (#47). parseGuardSource parses with the PINNED `typescript-legacy` (so the
  // build's `typescript` is free to bump to 7 without breaking this guard) and THROWS
  // GuardParseError on ANY parse diagnostic — createSourceFile is error-TOLERANT and returns a
  // partial tree the guard cannot trust (a mutation may or may not survive error recovery). It
  // parses with the SAME args the inline gate used (ScriptTarget.Latest, setParentNodes=true,
  // ScriptKind.TS), so the tree here is identical. main()'s catch maps the throw to exit 2,
  // identical to the prior inline `throw new Error(...)`: FAIL-CLOSED IS PRESERVED. The only
  // observable change is a DECLARED contract change on the FAILURE PATH — the throw is now
  // GuardParseError with a pinned-parser message, not `Error("unparseable TypeScript …")`
  // (asserted in the test's FAIL-CLOSED case; before/after stated in the PR body).
  const sf = parseGuardSource(fileName, source);
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
