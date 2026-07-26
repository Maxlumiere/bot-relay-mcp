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

const { findSanctionedMutationViolations, mutatesAgentsTable } = await import(
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
      (findSanctionedMutationViolations(fs.readFileSync(f, "utf-8"), f) as unknown[]).map((v) => ({ f, v })),
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
