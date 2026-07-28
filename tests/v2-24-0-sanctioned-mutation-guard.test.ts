// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.24.0 — sanctioned-mutation guard, tested to ADR-0015's rule: attempt the
 * ACTUAL harm through the real shipped path (assert REFUSED) and its INNOCENT
 * TWIN (assert PASSES). Tests written from the implementation defend its holes;
 * only tests written from the harm make green mean safe.
 *
 * The harm: an agent's identity is created / replaced / deleted OUTSIDE the
 * single sanctioned mutation site (src/db.ts), bypassing the invariants that
 * live only there. The predicate: any INSERT / REPLACE / UPDATE / DELETE of the
 * `agents` or `agent_capabilities` table in a src/ file other than db.ts.
 *
 * The prior guard was a case-sensitive grep that classified TEXT; it covered no
 * INSERT/REPLACE and missed main.agents / aliases / comments / case. Each of
 * those evasions is a harm case below, and one (INSERT) is proven to walk past
 * the LEGACY grep so the gap is demonstrable, not asserted.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const { findSanctionedMutationViolations, mutatesAgentsTable, assertGuardedNamesProvable } = await import(
  "../scripts/sanctioned-mutation-guard.mjs"
);

// A synthetic non-db.ts source that prepares `sql`.
const inFile = (sql: string) => `
  export function raw(db: any, name: string) {
    db.prepare(${JSON.stringify(sql)}).run(name);
  }`;
const flagged = (sql: string, file = "src/transport/http.ts") =>
  (findSanctionedMutationViolations(inFile(sql), file) as Array<{ line: number }>).length > 0;

// The LEGACY grep, reproduced, so we can SEE the gap it left.
const LEGACY_GREP =
  /(UPDATE\s+agents|DELETE\s+FROM\s+agents|UPDATE\s+agent_capabilities|DELETE\s+FROM\s+agent_capabilities)/;

describe("v2.24.0 — sanctioned-mutation guard (ADR-0015)", () => {
  it("real src/ passes — every agents/agent_capabilities mutation already funnels through db.ts", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const srcDir = path.resolve(here, "..", "src");
    // Walk src/ the way the CLI does, minus db.ts, and assert zero violations.
    const walk = (d: string): string[] => {
      const out: string[] = [];
      for (const e of fs.readdirSync(d)) {
        if (e === "node_modules" || e === "dist" || e.startsWith(".")) continue;
        const p = path.join(d, e);
        if (fs.statSync(p).isDirectory()) out.push(...walk(p));
        else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
      }
      return out;
    };
    const violations = walk(srcDir).flatMap((f) =>
      // Pass srcRoot the way the CLI does, so the ONE real src/db.ts is exempt by
      // exact relative path (a nested src/db.ts would not be — codex P1 #2).
      (findSanctionedMutationViolations(fs.readFileSync(f, "utf-8"), f, { srcRoot: srcDir }) as unknown[]).map((v) => ({ f, v })),
    );
    expect(violations).toEqual([]);
  });

  // ── HARM LEG — the actual mutation through the shipped prepare() path ────────
  const HARM: Array<[string, string]> = [
    ["INSERT (the verb the legacy grep never covered)", "INSERT INTO agents (id, name) VALUES (?, ?)"],
    ["INSERT OR REPLACE", "INSERT OR REPLACE INTO agents (id, name) VALUES (?, ?)"],
    ["INSERT OR IGNORE", "INSERT OR IGNORE INTO agents (id) VALUES (?)"],
    ["REPLACE verb", "REPLACE INTO agents (id, name) VALUES (?, ?)"],
    ["UPDATE", "UPDATE agents SET agent_status = 'offline' WHERE name = ?"],
    ["DELETE", "DELETE FROM agents WHERE name = ?"],
    ["lowercase (legacy grep is case-sensitive)", "update agents set agent_status = 'x' where name = ?"],
    ["table alias AS", "UPDATE agents AS a SET a.agent_status = 'x' WHERE a.name = ?"],
    ["bare table alias", "UPDATE agents a SET a.agent_status = 'x' WHERE a.name = ?"],
    ["schema-qualified main.agents", "UPDATE main.agents SET agent_status = 'x' WHERE name = ?"],
    ["schema-qualified DELETE", "DELETE FROM main.agents WHERE name = ?"],
    ["inline block comment between verb and table", "UPDATE /* sneaky */ agents SET agent_status = 'x' WHERE name = ?"],
    ["quoted identifier", 'UPDATE "agents" SET agent_status = \'x\' WHERE name = ?'],
    ["agent_capabilities table", "DELETE FROM agent_capabilities WHERE agent_name = ?"],
    ["agent_capabilities INSERT", "INSERT INTO agent_capabilities (agent_name, capability) VALUES (?, ?)"],
  ];
  for (const [label, sql] of HARM) {
    it(`HARM flagged: ${label}`, () => {
      expect(flagged(sql), `guard must flag: ${sql}`).toBe(true);
    });
  }

  it("HARM flagged: string-SPLIT SQL reconstructed before classification", () => {
    const src = `
      export function raw(db: any, name: string) {
        db.prepare("UPDATE agents " + "SET agent_status = 'x' " + "WHERE name = ?").run(name);
      }`;
    expect((findSanctionedMutationViolations(src, "src/transport/http.ts") as unknown[]).length).toBeGreaterThan(0);
  });

  it("HARM flagged: SQL hidden in a variable literal (not only prepare() args)", () => {
    const src = `
      export function raw(db: any, name: string) {
        const q = "DELETE FROM agents WHERE name = ?";
        db.prepare(q).run(name);
      }`;
    expect((findSanctionedMutationViolations(src, "src/cli/recover.ts") as unknown[]).length).toBeGreaterThan(0);
  });

  // ── THE GAP — a case that walks past TODAY's guard, caught by this one ───────
  it("THE GAP: an INSERT the legacy grep misses is caught here", () => {
    const insert = "INSERT INTO agents (id, name) VALUES (?, ?)";
    expect(LEGACY_GREP.test(insert), "legacy grep must MISS the INSERT (that is the gap)").toBe(false);
    expect(mutatesAgentsTable(insert), "new guard must CATCH the INSERT").toBe(true);
    // and the other legacy blind spots
    expect(LEGACY_GREP.test("UPDATE main.agents SET x=1 WHERE id=?")).toBe(false);
    expect(mutatesAgentsTable("UPDATE main.agents SET x=1 WHERE id=?")).toBe(true);
    expect(LEGACY_GREP.test("update agents set x=1 where id=?")).toBe(false);
    expect(mutatesAgentsTable("update agents set x=1 where id=?")).toBe(true);
  });

  // ── INNOCENT TWIN — legitimate code must PASS ───────────────────────────────
  it("INNOCENT: the same mutation INSIDE src/db.ts is sanctioned (not flagged)", () => {
    const src = inFile("DELETE FROM agents WHERE name = ?");
    expect(findSanctionedMutationViolations(src, "src/db.ts")).toEqual([]);
    expect(findSanctionedMutationViolations(src, "db.ts")).toEqual([]);
  });

  it("INNOCENT: a SELECT of agents is not a mutation", () => {
    expect(flagged("SELECT * FROM agents WHERE name = ?")).toBe(false);
  });

  it("INNOCENT: a mutation of a DIFFERENT table is not flagged", () => {
    expect(flagged("UPDATE messages SET read = 1 WHERE id = ?")).toBe(false);
    expect(flagged("INSERT INTO tasks (id) VALUES (?)")).toBe(false);
  });

  it("INNOCENT: agents_new / a name merely CONTAINING agents is not the guarded table", () => {
    expect(flagged("INSERT INTO agents_new (id) SELECT id FROM agents")).toBe(false);
    expect(flagged("DELETE FROM agents_new WHERE id = ?")).toBe(false);
    expect(mutatesAgentsTable("INSERT INTO agentsxyz (id) VALUES (?)")).toBe(false);
  });

  it("INNOCENT: a per-line `// ALLOWLIST: <reason>` acknowledgement exempts the line", () => {
    const src = `
      export function raw(db: any, name: string) {
        db.prepare("DELETE FROM agents WHERE name = ?").run(name); // ALLOWLIST: one-off migration backfill, see #999
      }`;
    expect(findSanctionedMutationViolations(src, "src/cli/recover.ts")).toEqual([]);
    // ...but a bare ALLOWLIST with no reason does NOT exempt (must be authenticated)
    const noReason = `
      export function raw(db: any, name: string) {
        db.prepare("DELETE FROM agents WHERE name = ?").run(name); // ALLOWLIST:
      }`;
    expect((findSanctionedMutationViolations(noReason, "src/cli/recover.ts") as unknown[]).length).toBeGreaterThan(0);
  });

  // ── DOCUMENTED OUT BOUNDARY (honest, not a hidden gap) ───────────────────────
  it("OUT: SQL assembled by a runtime .join() produces no classifiable literal (documented, not silently missed)", () => {
    const src = `
      export function raw(db: any, name: string) {
        const q = ["UPDATE", "agents", "SET x=1", "WHERE name=?"].join(" ");
        db.prepare(q).run(name);
      }`;
    // Beyond "an adversary who knows the grep"; the guard does not claim to catch
    // it, and the header names it OUT. A new dynamic-SQL mutator routes through
    // db.ts or carries an ALLOWLIST.
    expect(findSanctionedMutationViolations(src, "src/x.ts")).toEqual([]);
  });

  it("ROBUST: the classifier never throws on malformed SQL (returns false)", () => {
    for (const junk of ["", "   ", "-- just a comment", "/* only a comment */", "UPDATE", "DELETE FROM", "INSERT INTO", "gibberish ((("]) {
      expect(() => mutatesAgentsTable(junk)).not.toThrow();
      expect(mutatesAgentsTable(junk)).toBe(false);
    }
  });
});

// A source that db.exec's `sql` — the multi-statement path (prepare() is single-
// statement; exec() is where codex's bypasses actually executed).
const inExec = (sql: string) => `export function raw(db: any){ db.exec(${JSON.stringify(sql)}); }`;
const execFlagged = (sql: string) =>
  (findSanctionedMutationViolations(inExec(sql), "src/transport/http.ts") as Array<{ line: number }>).length > 0;

describe("#143 P1 hardening — codex's EXECUTED bypasses (each red against the token-0 version)", () => {
  // ── P1: token-0-only classification → multi-statement / leading-sep / CTE ──
  const MULTI: Array<[string, string]> = [
    ["SELECT-then-DELETE (token 0 = SELECT)", "SELECT 1; DELETE FROM agents WHERE name='victim'"],
    ["leading separator (token 0 empty)", "; DELETE FROM agents WHERE name='victim'"],
    ["CTE hides the verb (token 0 = WITH)", "WITH doomed(x) AS (SELECT 1) DELETE FROM agents WHERE name='victim'"],
    ["mutation is the SECOND statement", "INSERT INTO agents (id) VALUES (?); SELECT 2"],
  ];
  for (const [label, sql] of MULTI) {
    it(`HARM flagged (db.exec): ${label}`, () => expect(execFlagged(sql), sql).toBe(true));
  }

  // ── P1 #2: identity-destroying DDL + trigger bodies (all executed) ──
  const DDL: Array<[string, string]> = [
    ["DROP TABLE agents", "DROP TABLE agents"],
    ["DROP TABLE IF EXISTS agent_capabilities", "DROP TABLE IF EXISTS agent_capabilities"],
    ["ALTER TABLE agents RENAME", "ALTER TABLE agents RENAME TO former_agents"],
    ["ALTER schema-qualified", "ALTER TABLE main.agents ADD COLUMN x TEXT"],
    ["CREATE TRIGGER w/ DELETE body", "CREATE TRIGGER trg AFTER INSERT ON t BEGIN DELETE FROM agents WHERE name='v'; END"],
    ["CREATE TEMP TRIGGER w/ UPDATE body", "CREATE TEMP TRIGGER trg AFTER INSERT ON t BEGIN UPDATE agents SET x=1; END"],
  ];
  for (const [label, sql] of DDL) {
    it(`HARM flagged: ${label}`, () => expect(execFlagged(sql), sql).toBe(true));
  }

  // ── P1 #2 (second P1): nested src/db.ts must NOT self-exempt ──
  it("P1: a nested src/<sub>/src/db.ts does NOT exempt itself; only the real src/db.ts does", () => {
    const del = inExec("DELETE FROM agents WHERE name='victim'");
    // relative-form (no srcRoot): exact match only
    expect((findSanctionedMutationViolations(del, "src/audit-nested/src/db.ts") as unknown[]).length, "nested self-exempt").toBeGreaterThan(0);
    expect(findSanctionedMutationViolations(del, "src/db.ts"), "the one real db.ts stays exempt").toEqual([]);
    expect(findSanctionedMutationViolations(del, "db.ts")).toEqual([]);
    // srcRoot form (how the CLI calls it): relative to the scanned dir
    expect((findSanctionedMutationViolations(del, "/p/src/audit-nested/src/db.ts", { srcRoot: "/p/src" }) as unknown[]).length).toBeGreaterThan(0);
    expect(findSanctionedMutationViolations(del, "/p/src/db.ts", { srcRoot: "/p/src" })).toEqual([]);
  });

  // ── Fail-closed on parse failure (was fail-OPEN — audit-state-freshness split) ──
  it("FAIL-CLOSED: malformed TypeScript makes the guard THROW (→ exit 2), never silently pass", () => {
    const malformed = `export function broken(db {  db.exec("SELECT 1")  `; // unbalanced parens
    expect(() => findSanctionedMutationViolations(malformed, "src/bad.ts")).toThrow(/unparseable/i);
  });

  // ── Tokenizer soundness — the statement split's whole correctness rests here ──
  it("TOKENIZER: a `;` inside a string/quoted-identifier does NOT split a statement", () => {
    expect(mutatesAgentsTable("SELECT '; DELETE FROM agents'"), "; inside '…' is string content").toBe(false);
    expect(mutatesAgentsTable('SELECT "a;b" FROM x'), "; inside a quoted identifier").toBe(false);
    // but a REAL top-level ; after a string still splits and catches the mutation
    expect(mutatesAgentsTable("INSERT INTO t VALUES ('a;b'); DELETE FROM agents")).toBe(true);
  });
  it("TOKENIZER: SQLite `''` escaped quote inside a literal doesn't break classification", () => {
    expect(mutatesAgentsTable("INSERT INTO agents (n) VALUES ('o''brien')")).toBe(true);
    expect(mutatesAgentsTable("SELECT 'can''t; DELETE FROM agents'"), "escaped-quote-then-; still all one string").toBe(false);
  });
  it("TOKENIZER: an (even unterminated) comment is not a statement", () => {
    expect(mutatesAgentsTable("/* commented out DELETE FROM agents"), "unterminated block comment").toBe(false);
    expect(mutatesAgentsTable("SELECT 1 -- ; DELETE FROM agents"), "line comment swallows the rest").toBe(false);
  });

  // ── Innocent twins for the new coverage (assert NOT flagged) ──
  it("INNOCENT: multi-statement reads, WITH…SELECT, and other-table DDL/triggers are not flagged", () => {
    expect(execFlagged("SELECT 1; SELECT 2")).toBe(false);
    expect(execFlagged("WITH x AS (SELECT 1) SELECT * FROM x")).toBe(false);
    expect(execFlagged("DROP TABLE agents_new")).toBe(false);
    expect(execFlagged("ALTER TABLE messages ADD COLUMN x TEXT")).toBe(false);
    expect(execFlagged("DROP TRIGGER some_trigger")).toBe(false);
    expect(execFlagged("CREATE TRIGGER t AFTER INSERT ON u BEGIN DELETE FROM messages; END")).toBe(false);
  });

  // ── BAR 4 — the PROSE false positive, ACCEPTED + STATED (codex bar 4). Not a
  //    "deferred" limitation — a DECIDED, documented over-block. Both "fixes" are
  //    worse: a hand-rolled continuation grammar UNDER-blocks silently (`IS` is a
  //    SQL keyword, so "…agents is forbidden" defeats a next-token check = a false
  //    NEGATIVE, the dangerous direction), and a db.prepare() validator puts a live
  //    SQL engine in the lint script. ADR-0015 direction-of-failure: a loud safe
  //    over-block with an escape beats a silent under-block. Covered BOTH ways:
  it("BAR4 — a benign PROSE constant that lexes as a mutation IS flagged (the ACCEPTED, documented over-block)", () => {
    const prose = `export const MSG = "DELETE FROM agents is forbidden; call teardownAgent instead";`;
    // SQLite rejects this text as a syntax error, but the guard classifies by
    // structure. Over-flag is the SAFE direction; this pins the accepted behaviour.
    expect((findSanctionedMutationViolations(prose, "src/transport/http.ts") as unknown[]).length).toBeGreaterThan(0);
  });

  it("BAR4 ESCAPE — the same prose string with a reason-bearing `// ALLOWLIST:` PASSES", () => {
    // The documented escape for a legitimate string that trips the FP: route via
    // db.ts, OR acknowledge it with a real reason. This makes the accepted
    // over-block livable rather than a wall.
    const prose = `export const MSG = "DELETE FROM agents is forbidden; call teardownAgent instead"; // ALLOWLIST: diagnostic message, not executed SQL`;
    expect(findSanctionedMutationViolations(prose, "src/transport/http.ts")).toEqual([]);
  });

  // ── BAR 5 — allowlist authority: a trivial reason no longer exempts, and every
  //    exemption is emitted (kills "detectable only by a human noticing the diff").
  it("BAR5 — a TRIVIAL allowlist reason does NOT exempt; a real one exempts AND is recorded for emission", () => {
    // codex T5: `// ALLOWLIST: x` (a single throwaway token) must not authorize —
    // the 1-char escape was the pre-existing weakness.
    const trivial = `
      export function raw(db: any, name: string) {
        db.prepare("DELETE FROM agents WHERE name = ?").run(name); // ALLOWLIST: x
      }`;
    expect(
      (findSanctionedMutationViolations(trivial, "src/cli/recover.ts") as unknown[]).length,
      "trivial reason must NOT exempt",
    ).toBeGreaterThan(0);

    // A real reason exempts AND is COLLECTED for emission (main() prints each).
    const real = `
      export function raw(db: any, name: string) {
        db.prepare("DELETE FROM agents WHERE name = ?").run(name); // ALLOWLIST: legacy teardown path, see #143
      }`;
    const allowlisted: Array<{ line: number; reason: string }> = [];
    expect(findSanctionedMutationViolations(real, "src/cli/recover.ts", { allowlisted })).toEqual([]);
    expect(allowlisted.length, "the exemption is recorded for emission").toBe(1);
    expect(allowlisted[0].reason).toMatch(/legacy teardown/);
  });
});

// codex re-audit @509a368 P1 (all EXECUTED in real SQLite — rows died): the
// tokenizer collapsed quoted + unquoted words into ONE `id` type, so a quoted
// keyword hijacked the three structural passes. Fix: quoted → `qid`; keyword +
// structure passes consume UNQUOTED `id` only; identifier resolution accepts both.
describe("#143 re-audit — quoted-identifier provenance (codex @509a368)", () => {
  // ── the three EXECUTED harms (each got=false / seeded row-count → 0 on the old head) ──
  const HARM: Array<[string, string]> = [
    ["quoted CASE defeats the `;` split", `SELECT 1 AS "CASE"; DELETE FROM agents WHERE name='victim'`],
    ["quoted `delete` masquerades as the CTE verb", `WITH "delete"(x) AS (SELECT 1) DELETE FROM agents WHERE name='victim'`],
    ["quoted BEGIN steals the trigger-body opener", `CREATE TRIGGER "BEGIN" AFTER INSERT ON t BEGIN DELETE FROM agents WHERE name='victim'; END`],
  ];
  for (const [label, sql] of HARM) it(`HARM flagged: ${label}`, () => expect(execFlagged(sql), sql).toBe(true));

  // ── the three innocent twins codex ran (must still PASS) ──
  it("TWIN: quoted CASE as a read-only alias is not a mutation", () => expect(execFlagged(`SELECT 1 AS "CASE"`)).toBe(false));
  it("TWIN: a quoted `delete` CTE consumed by a SELECT is a read", () =>
    expect(execFlagged(`WITH "delete"(x) AS (SELECT 1) SELECT * FROM "delete"`)).toBe(false));
  it("TWIN: a trigger named `BEGIN` mutating a DIFFERENT table is not flagged", () =>
    expect(execFlagged(`CREATE TRIGGER "BEGIN" AFTER INSERT ON t BEGIN DELETE FROM messages WHERE name='v'; END`)).toBe(false));

  // ── BEYOND codex — shapes it did not write (the MIRROR + resolution coverage) ──
  it("HARM flagged: a quoted `END` inside a trigger body does NOT falsely CLOSE the block early", () => {
    // The mirror of the quoted-BEGIN harm: a quoted keyword must not close a block
    // either. The real DELETE lives AFTER the fake `"END"`.
    expect(execFlagged(`CREATE TRIGGER trg AFTER INSERT ON u BEGIN SELECT 1 AS "END"; DELETE FROM agents WHERE name='v'; END`)).toBe(true);
  });
  it("HARM flagged: a quoted GUARDED table resolves through every quote style", () => {
    for (const sql of [`DELETE FROM "agents" WHERE x=1`, `DELETE FROM [agents]`, "DELETE FROM `agents`", `UPDATE "agents" SET x=1`, `INSERT INTO "agents" (id) VALUES (1)`]) {
      expect(mutatesAgentsTable(sql), sql).toBe(true);
    }
  });
  it("HARM flagged: quoted-keyword COLUMN names in an INSERT do not hide the guarded table", () =>
    expect(mutatesAgentsTable(`INSERT INTO agents ("SELECT", "FROM", "WHERE") VALUES (1, 2, 3)`)).toBe(true));
  it("HARM flagged: a quoted keyword as a false block-opener (a different keyword) still splits", () =>
    expect(execFlagged(`SELECT 1 AS "BEGIN"; DELETE FROM agents WHERE name='v'`)).toBe(true));
  it("HARM flagged: a quoted mixed-CASE guarded table (SQLite identifiers are case-insensitive)", () =>
    expect(mutatesAgentsTable(`DELETE FROM "AGENTS" WHERE x=1`)).toBe(true));
  it("TWIN: a quoted keyword used as a READ column is not a mutation", () =>
    expect(mutatesAgentsTable(`SELECT "DELETE" FROM agents WHERE x=1`)).toBe(false));
  it("TWIN: a quoted DIFFERENT table (incl. agents_new) is not flagged", () => {
    expect(mutatesAgentsTable(`DELETE FROM "messages" WHERE x=1`)).toBe(false);
    expect(mutatesAgentsTable(`DELETE FROM [agents_new]`)).toBe(false);
  });
});

// codex re-audit @b5aae98 P1 — a FOURTH SQLite identifier-quoting form: a SINGLE
// quoted token used where the grammar wants an identifier (a MySQL-compat
// misfeature). `'agents'` tokenizes as `str`; idAt allow-listed id|qid, so SIX
// mutations walked past (all EXECUTED in real SQLite). FIX = DEFAULT-DENY in
// identifier position (idAt resolves anything that is not a `punct`), so the NEXT
// unforeseen quote form OVER-flags loudly instead of silently under-flagging.
describe("#143 re-audit @b5aae98 — single-quote-as-identifier (default-deny in identifier position)", () => {
  const HARM: Array<[string, string]> = [
    ["DELETE FROM 'agents'", `DELETE FROM 'agents' WHERE name='v'`],
    ["UPDATE 'agents' SET", `UPDATE 'agents' SET x=1 WHERE name='v'`],
    ["INSERT INTO 'agents'", `INSERT INTO 'agents' (id) VALUES (1)`],
    ["DROP TABLE 'agents'", `DROP TABLE 'agents'`],
    ["ALTER TABLE 'agents' RENAME", `ALTER TABLE 'agents' RENAME TO gone`],
    ["schema-qualified main.'agents'", `DELETE FROM main.'agents' WHERE name='v'`],
    ["single-quoted schema 'main'.agents", `DELETE FROM 'main'.agents WHERE name='v'`],
  ];
  for (const [l, sql] of HARM) it(`HARM flagged: ${l}`, () => expect(execFlagged(sql), sql).toBe(true));
  it("TWIN: a single-quoted DIFFERENT table is not flagged", () => {
    expect(execFlagged(`DELETE FROM 'messages' WHERE x=1`)).toBe(false);
    expect(mutatesAgentsTable(`DELETE FROM 'agents_new'`)).toBe(false);
  });
  it("KEYWORD readers stay STRICT — a single-quoted `'DELETE'` is NEVER a verb (default-deny is identifier POSITION only)", () => {
    expect(mutatesAgentsTable(`'DELETE' FROM agents`)).toBe(false);
    expect(mutatesAgentsTable(`SELECT 1 WHERE x = 'DELETE FROM agents'`)).toBe(false); // a string VALUE, not a stmt
  });
  it("DEFAULT-DENY: the single-quote form is caught WITHOUT teaching the guard about single-quotes as a special case", () => {
    // The guard was not given a `'…'`-is-an-identifier rule; idAt rejects only
    // `punct`, so `str` (and any future quote form) resolves → over-flags, never
    // silently passes. This is the property, proven by the harms above.
    expect(mutatesAgentsTable(`DELETE FROM 'agents'`)).toBe(true);
  });
});

// GUARD ON THE GUARD — the quoted-identifier class proof rests on the premise that
// guarded names are bare identifiers. Enforced at module load; asserted here so
// the failure case is pinned without planting a bad name in the real set.
describe("#143 — guard on the guard (the class proof's premise, enforced)", () => {
  it("the real GUARDED set passes (bare identifiers)", () => {
    expect(() => assertGuardedNamesProvable(["agents", "agent_capabilities"])).not.toThrow();
  });
  it("a guarded name that would NEED quoting fails LOUD with an actionable message", () => {
    for (const bad of [`agent"s`, "agent.s", "agent;s", "agent s", "Agents", "1agents", "agent[s]", "agent\ns"]) {
      expect(() => assertGuardedNamesProvable([bad]), bad).toThrow(/re-derive that proof/);
    }
  });
});

// DIRECTIONAL-CLAIM CONTRACTS — the normalization audit's four claims, pinned from
// execution (test proves the instance; the header argument proves the class).
describe("#143 — normalization-audit directional contracts", () => {
  const OVER_OR_CORRECT: Array<[string, string, boolean]> = [
    ["C1 lowercase", "delete from agents where x=1", true],
    ["C1 mixed case", "DeLeTe FrOm AgEnTs", true],
    ["C2 UPPER table", "DELETE FROM AGENTS", true],
    ["C2 quoted mixed", `DELETE FROM "AgEnTs"`, true],
    ["C2 agent_capabilities upper", "DELETE FROM AGENT_CAPABILITIES WHERE a=1", true],
    ["C3 main.agents", "DELETE FROM main.agents", true],
    ["C3 whitespace around dot", "DELETE FROM temp . agents WHERE x=1", true],
    ["C3 bracket schema", "DELETE FROM [main].agents", true],
    ["C3 agents.col (schema NAMED agents) NOT flagged", "DELETE FROM agents.col", false],
    ["C4 block comments between tokens", "DELETE/**/FROM/**/agents", true],
    ["C4 line comment + newline + mutation", "SELECT 1 -- c\n; DELETE FROM agents WHERE x=1", true],
    ["C4 -- to EOF (mutation before)", "DELETE FROM agents WHERE x=1 -- tail no newline", true],
    ["C4 -- to EOF hides following DELETE", "SELECT 1 -- ; DELETE FROM agents", false],
    ["C4 all-string is not a mutation", `SELECT '-- ; DELETE FROM agents'`, false],
    ["C4 real ; after a /* */-holding string", "INSERT INTO t VALUES ('/* */'); DELETE FROM agents", true],
  ];
  for (const [l, sql, want] of OVER_OR_CORRECT) it(`${l}`, () => expect(mutatesAgentsTable(sql), sql).toBe(want));
});

// QUOTED-IDENTIFIER EQUIVALENCE EDGES — the bounded equivalence with SQLite's own
// identifier decode. Guarded names have no special chars, so no doubling/embedded
// form can PRODUCE a guarded name; every decorated form decodes to a name-with-the
// -extra-char in BOTH parsers → cannot under-flag by construction.
describe("#143 — quoted-identifier equivalence edges", () => {
  const EDGES: Array<[string, string, boolean]> = [
    [`double-quote id "ag""ents" ≠ agents`, `DELETE FROM "ag""ents" WHERE x=1`, false],
    ["backtick-double id ag``ents ≠ agents", "DELETE FROM `ag``ents` WHERE x=1", false],
    [`simple quoted agents CAUGHT`, `DELETE FROM "agents"`, true],
    ["DROP hidden inside a doubled-quote id is not a mutation", `SELECT 1 AS "a""; DROP TABLE agents; ""z"`, false],
    ["; inside a quoted id ≠ agents", `DELETE FROM "agents;messages"`, false],
    ["; + DELETE inside a quoted alias is not a mutation", `SELECT 1 AS "x; DELETE FROM agents"`, false],
    ["newline inside a quoted id ≠ agents", `DELETE FROM "agents\nx"`, false],
    ["unterminated quoted id → not a mutation, no crash", `DELETE FROM "agents; DELETE FROM agents`, false],
    ["real agents after a closed quoted id CAUGHT", `SELECT 1 AS "note"; DELETE FROM agents WHERE x=1`, true],
  ];
  for (const [l, sql, want] of EDGES) it(`${l}`, () => expect(mutatesAgentsTable(sql), sql).toBe(want));
});
