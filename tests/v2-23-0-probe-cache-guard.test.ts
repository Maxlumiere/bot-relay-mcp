// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.23.x #140 — probe-cache eviction drift guard: test the GUARD, not just the
 * code (mirrors the ADR-0003 auth-gen guard test).
 *
 * The braced fifth site proved the class must be framed by BEHAVIOUR, not syntax.
 * Then codex EVADED the first (text-matching) guard with ordinary SQLite —
 * `UPDATE agents AS a SET …` and `INSERT OR REPLACE INTO agents …`. The guard now
 * PARSES the static SQL literals, so these fixtures bind the whole-class
 * guarantee: every form the parser's grammar admits is exercised RED here, and
 * the precision cases it must spare are exercised GREEN. A form that cannot be
 * made red is not covered — and belongs in the guard's documented OUT list.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const { findProbeCacheViolations, mutatesAgentsIdentity } = await import("../scripts/probe-cache-guard.mjs");
const names = (src: string, f = "fx.ts") =>
  (findProbeCacheViolations(src, f) as Array<{ name: string; reason: string }>).map((v) => v.name);

describe("#140 probe-cache eviction drift guard", () => {
  const dbSource = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/db.ts"),
    "utf-8",
  );

  it("real src/db.ts passes — every liveness-identity writer evicts both caches unconditionally", () => {
    expect(findProbeCacheViolations(dbSource, "db.ts")).toEqual([]);
  });

  it("NEGATIVE: flags a plain CREATE / DELETE / REPLACE writer that omits eviction entirely", () => {
    const bad = `
      export function createNoEvict(name: string): void {
        getDb().prepare("INSERT INTO agents (id, name) VALUES (?, ?)").run("i", name);
      }
      export function deleteNoEvict(name: string): void {
        getDb().prepare("DELETE FROM agents WHERE name = ?").run(name);
      }
      export function replaceNoEvict(name: string, s: string): void {
        getDb().prepare("UPDATE agents SET session_id = NULL, agent_pid = NULL WHERE name = ? AND session_id = ?").run(name, s);
      }`;
    const v = names(bad);
    expect(v).toContain("createNoEvict");
    expect(v).toContain("deleteNoEvict");
    expect(v).toContain("replaceNoEvict");
  });

  // ── The codex evasions — ordinary SQLite that slipped past the text matcher ──
  it("EVASION (codex): flags `UPDATE agents AS a SET …` (aliased) with no eviction", () => {
    const aliased = `
      export function aliasedUpdate(name: string, s: string): void {
        getDb().prepare("UPDATE agents AS a SET session_id = NULL, agent_pid = NULL WHERE a.name = ? AND a.session_id = ?").run(name, s);
      }`;
    expect(names(aliased, "alias.ts")).toContain("aliasedUpdate");
  });

  it("EVASION (codex): flags `INSERT OR REPLACE INTO agents …` with no eviction", () => {
    const orReplace = `
      export function insertOrReplace(name: string): void {
        getDb().prepare("INSERT OR REPLACE INTO agents (id, name) VALUES (?, ?)").run("i", name);
      }`;
    expect(names(orReplace, "orrep.ts")).toContain("insertOrReplace");
  });

  it("GRAMMAR: flags every admitted form — bare alias, INSERT OR IGNORE, UPDATE OR ROLLBACK, qualified/quoted column, concatenated SQL", () => {
    const forms = `
      export function bareAlias(name: string, s: string): void {
        getDb().prepare("UPDATE agents a SET session_id = NULL WHERE a.name = ? AND a.session_id = ?").run(name, s);
      }
      export function insertOrIgnore(name: string): void {
        getDb().prepare("INSERT OR IGNORE INTO agents (id, name) VALUES (?, ?)").run("i", name);
      }
      export function updateOrRollback(name: string): void {
        getDb().prepare("UPDATE OR ROLLBACK agents SET agent_pid = NULL WHERE name = ?").run(name);
      }
      export function qualifiedCol(name: string, s: string): void {
        getDb().prepare("UPDATE agents AS a SET a.agent_pid_start = NULL WHERE a.session_id = ?").run(s);
      }
      export function quotedCol(name: string): void {
        getDb().prepare('UPDATE agents SET "session_id" = NULL WHERE name = ?').run(name);
      }
      export function concatSplitAlias(name: string, s: string): void {
        getDb().prepare("UPDATE agents AS a " + "SET session_id = NULL " + "WHERE a.name = ? AND a.session_id = ?").run(name, s);
      }`;
    const v = names(forms, "forms.ts");
    for (const fn of ["bareAlias", "insertOrIgnore", "updateOrRollback", "qualifiedCol", "quotedCol", "concatSplitAlias"]) {
      expect(v, `grammar form ${fn} must be flagged`).toContain(fn);
    }
  });

  it("NEGATIVE: flags the BRACED fifth-site shape — evictions present but gated on r.changes", () => {
    const braced = `
      export function endSessionBraced(name: string, s: string): { changed: boolean } {
        const r = getDb().prepare("UPDATE agents SET session_id = NULL, agent_pid = NULL WHERE name = ? AND session_id = ?").run(name, s);
        if (r.changes === 1) {
          _negativeProbeCache.delete(name);
          _positiveProbeCache.delete(name);
        }
        return { changed: r.changes === 1 };
      }`;
    const found = findProbeCacheViolations(braced, "braced.ts") as Array<{ name: string; reason: string }>;
    expect(found.map((x) => x.name)).toContain("endSessionBraced");
    expect(found.find((x) => x.name === "endSessionBraced")!.reason).toMatch(/nested\/conditional|not top-level/i);
  });

  it("NEGATIVE: flags a writer that evicts only ONE of the two caches", () => {
    const partial = `
      export function halfEvict(name: string, s: string): void {
        getDb().prepare("UPDATE agents SET session_id = NULL WHERE name = ? AND session_id = ?").run(name, s);
        _negativeProbeCache.delete(name);
      }`;
    const found = findProbeCacheViolations(partial, "partial.ts") as Array<{ name: string; reason: string }>;
    expect(found.map((x) => x.name)).toContain("halfEvict");
    expect(found.find((x) => x.name === "halfEvict")!.reason).toMatch(/_positiveProbeCache\.delete is missing/);
  });

  it("POSITIVE: an aliased identity writer WITH both top-level evictions passes", () => {
    const good = `
      export function properAliasedReplace(name: string, s: string): { changed: boolean } {
        const r = getDb().prepare("UPDATE agents AS a SET a.session_id = NULL, a.agent_pid = NULL WHERE a.name = ? AND a.session_id = ?").run(name, s);
        _negativeProbeCache.delete(name);
        _positiveProbeCache.delete(name);
        return { changed: r.changes === 1 };
      }`;
    expect(findProbeCacheViolations(good, "good.ts")).toEqual([]);
  });

  it("PRECISION: a status-only UPDATE (even aliased) with session_id only in the WHERE is NOT a false match", () => {
    const statusOnly = `
      export function clearStaleStatus(): void {
        getDb().prepare("UPDATE agents AS a SET agent_status = 'idle' WHERE a.agent_status = 'offline' AND a.session_id IS NULL").run();
      }`;
    expect(findProbeCacheViolations(statusOnly, "status.ts")).toEqual([]);
  });

  it("PRECISION: INSERT INTO agents_new / DELETE FROM agents_new (schema rebuild) are NOT the agents table", () => {
    const rebuild = `
      export function rebuildTable(): void {
        getDb().exec("INSERT INTO agents_new (id, name) SELECT id, name FROM agents");
        getDb().prepare("DELETE FROM agents_new WHERE name = ?").run("x");
      }`;
    expect(findProbeCacheViolations(rebuild, "rebuild.ts")).toEqual([]);
  });

  it("BOUNDARY (documented OUT): runtime-assembled SQL in a variable is not parsed → not flagged", () => {
    // Honest limit: a value the parser doesn't have can't be classified. db.ts
    // uses literals; a future dynamic-SQL identity writer must evict or be added
    // consciously. This asserts the boundary is where the header says it is.
    const dynamic = `
      export function dynamicSql(name: string, col: string): void {
        const sql = "UPDATE agents SET " + col + " = NULL WHERE name = ?";
        getDb().prepare(sql).run(name);
      }`;
    expect(findProbeCacheViolations(dynamic, "dyn.ts")).toEqual([]);
  });

  it("EVASION: the init-only allowlist exempts ONLY the named migration, not a lookalike", () => {
    const allowed = `
      function migrateSchemaToV2_0(db: any): void {
        db.prepare("UPDATE agents SET session_id = ? WHERE name = ?").run("u", "n");
      }`;
    expect(findProbeCacheViolations(allowed, "mig0.ts")).toEqual([]);
    const evil = `
      export function migrateSchemaToEvil(name: string, s: string): void {
        getDb().prepare("UPDATE agents SET session_id = NULL WHERE name = ? AND session_id = ?").run(name, s);
      }`;
    expect(names(evil, "evil.ts")).toContain("migrateSchemaToEvil");
  });

  it("EVASION: arrow / function-expression / method writers do NOT evade the visitor", () => {
    const evasion = `
      export const arrowDelete = (name: string): void => {
        getDb().prepare("DELETE FROM agents WHERE name = ?").run(name);
      };
      const exprReplace = function (name: string, s: string) {
        getDb().prepare("UPDATE agents AS a SET a.agent_pid = NULL WHERE a.name = ? AND a.session_id = ?").run(name, s);
      };
      class Store {
        methodCreate(name: string): void {
          getDb().prepare("INSERT OR REPLACE INTO agents (id, name) VALUES (?, ?)").run("i", name);
        }
      }`;
    const v = names(evasion, "ev.ts");
    expect(v).toContain("arrowDelete");
    expect(v).toContain("exprReplace");
    expect(v).toContain("methodCreate");
  });

  it("classifier unit: the exact codex bypasses are true; precision cases are false", () => {
    expect(mutatesAgentsIdentity("UPDATE agents AS a SET session_id = NULL WHERE a.name = ?")).toBe(true);
    expect(mutatesAgentsIdentity("INSERT OR REPLACE INTO agents (id) VALUES (?)")).toBe(true);
    expect(mutatesAgentsIdentity("UPDATE agents SET agent_status = ? WHERE session_id = ?")).toBe(false);
    expect(mutatesAgentsIdentity("INSERT INTO agents_new (id) SELECT id FROM agents")).toBe(false);
    expect(mutatesAgentsIdentity("SELECT * FROM agents WHERE session_id = ?")).toBe(false);
  });
});
