// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.23.x #140 — probe-cache eviction drift guard: test the GUARD, not just the
 * code (mirrors the ADR-0003 auth-gen guard test).
 *
 * The braced fifth site (`endAgentSessionOnSignal`) proved that four reviewers
 * missed the class because it was framed by SYNTAX (`unbraced if`). The guard
 * reframes it by BEHAVIOUR: any function that CREATEs / REPLACEs / DELETEs a
 * name's liveness identity must evict BOTH probe caches as TOP-LEVEL (=
 * unconditional) statements. These fixtures prove the guard actually FLAGS the
 * drift shapes — including the braced one — and does not false-flag the shapes
 * it must spare.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const { findProbeCacheViolations } = await import("../scripts/probe-cache-guard.mjs");
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

  it("NEGATIVE: flags a CREATE / DELETE / REPLACE writer that omits eviction entirely", () => {
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

  it("NEGATIVE: flags the BRACED fifth-site shape — evictions present but gated on r.changes", () => {
    // This is EXACTLY the shape all four reviewers accepted as correct: both
    // deletes present, both inside `if (r.changes === 1)`. Behaviourally broken
    // (skipped on the CAS loser). The guard must catch it though it "looks" fine.
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
    // and the reason names it as nested/conditional, not "missing"
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

  it("POSITIVE: a writer with both top-level evictions passes", () => {
    const good = `
      export function properReplace(name: string, s: string): { changed: boolean } {
        const r = getDb().prepare("UPDATE agents SET session_id = NULL, agent_pid = NULL WHERE name = ? AND session_id = ?").run(name, s);
        _negativeProbeCache.delete(name);
        _positiveProbeCache.delete(name);
        return { changed: r.changes === 1 };
      }`;
    expect(findProbeCacheViolations(good, "good.ts")).toEqual([]);
  });

  it("PRECISION: a status-only UPDATE with session_id only in the WHERE is NOT a false match", () => {
    // The migrateSchemaToV2_19 shape: writes agent_status, keys on session_id in
    // the WHERE. It mutates no identity column → no eviction owed → not flagged.
    const statusOnly = `
      export function clearStaleStatus(): void {
        getDb().prepare("UPDATE agents SET agent_status = 'idle' WHERE agent_status = 'offline' AND session_id IS NULL").run();
      }`;
    expect(findProbeCacheViolations(statusOnly, "status.ts")).toEqual([]);
  });

  it("PRECISION: an INSERT INTO agents_new (schema rebuild) is NOT matched by the agents word-boundary", () => {
    const rebuild = `
      export function rebuildTable(): void {
        getDb().exec("INSERT INTO agents_new (id, name) SELECT id, name FROM agents");
      }`;
    expect(findProbeCacheViolations(rebuild, "rebuild.ts")).toEqual([]);
  });

  it("EVASION: the init-only allowlist exempts ONLY the named migration, not a lookalike", () => {
    // The genuinely init-only session backfill is exempt (caches are empty at init).
    const allowed = `
      function migrateSchemaToV2_0(db: any): void {
        db.prepare("UPDATE agents SET session_id = ? WHERE name = ?").run("u", "n");
      }`;
    expect(findProbeCacheViolations(allowed, "mig0.ts")).toEqual([]);
    // A runtime writer cannot evade merely by naming itself migrateSchemaTo….
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
        getDb().prepare("UPDATE agents SET agent_pid = NULL WHERE name = ? AND session_id = ?").run(name, s);
      };
      class Store {
        methodCreate(name: string): void {
          getDb().prepare("INSERT INTO agents (id, name) VALUES (?, ?)").run("i", name);
        }
      }`;
    const v = names(evasion, "ev.ts");
    expect(v).toContain("arrowDelete");
    expect(v).toContain("exprReplace");
    expect(v).toContain("methodCreate");
  });
});
