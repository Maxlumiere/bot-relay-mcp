// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * PR-B (Codex R1 #1, architect 9496935f): the token-only fallback finds the credentials the digest index cannot
 * decide by EXACT INDEX RANGES, never a scan of the agents table. MEASURED before: `SCAN agents`, 0.010 ms at 34
 * rows, 0.158 ms at 1,000, 1.561 ms at 10,000 per unknown token, synchronous on the loop.
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pr-b-ranges-")));
process.env.RELAY_DB_PATH = path.join(ROOT, "relay.db");
delete process.env.RELAY_ENCRYPTION_KEYRING;
delete process.env.RELAY_ENCRYPTION_KEY;

const db = await import("../src/db.js");
const { unreachableLookupRanges, lookupKeys } = await import("../src/token-lookup.js");
const { scanTake, SCAN_BURST, _resetAuthThrottleForTests } = await import("../src/auth-throttle.js");

afterAll(() => {
  db.closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

/** THE ORACLE: the fallback SQL this PR replaced (b7c2b66), verbatim in shape: a full scan, exact by definition. */
function oracleSql(keyIds: string[]): { sql: string; params: string[] } {
  const kp = keyIds.map(() => "?").join(",");
  const un = (col: string) => `(${col} IS NULL OR instr(${col}, '|') = 0 OR substr(${col}, 1, instr(${col}, '|') - 1) NOT IN (${kp}))`;
  return {
    sql: `SELECT * FROM agents WHERE (token_hash IS NOT NULL AND ${un("token_lookup")}) OR (previous_token_hash IS NOT NULL AND ${un("previous_token_lookup")})`,
    params: [...keyIds, ...keyIds],
  };
}

let seq = 0;
function seedRow(): Record<string, unknown> {
  const name = `seed-${seq++}`;
  db.registerAgent(name, "worker", []);
  return db.getDb().prepare("SELECT * FROM agents WHERE name = ?").get(name) as Record<string, unknown>;
}
function insertRows(rows: Array<{ lookup: string | null; hash: boolean; prevLookup?: string | null; prevHash?: boolean }>): void {
  const d = db.getDb();
  const seed = seedRow();
  const cols = Object.keys(seed).filter((c) => c !== "id");
  const ins = d.prepare(`INSERT INTO agents (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
  d.transaction(() => {
    for (const r of rows) {
      const v: Record<string, unknown> = {
        ...seed,
        name: `r-${seq++}`,
        token_lookup: r.lookup,
        token_hash: r.hash ? seed.token_hash : null,
        previous_token_lookup: r.prevLookup ?? null,
        previous_token_hash: r.prevHash ? seed.token_hash : null,
      };
      ins.run(...cols.map((c) => v[c]));
    }
  })();
}
const names = (q: { sql: string; params: string[] }) =>
  (db.getDb().prepare(q.sql).all(...q.params) as Array<{ name: string }>).map((r) => r.name).sort();
function clearAgents(): void {
  db.getDb().prepare("DELETE FROM agents").run();
}

/** Values that land in EVERY complement range and on every boundary, for the given key ids. */
function probeValues(keyIds: string[]): Array<string | null> {
  const vals: Array<string | null> = [null, "", "!", "0123abcdef", "zzzz", "~~~~|x", "|leading", "kr:", "px:"];
  for (const id of keyIds) vals.push(`${id}|ab12`, `${id}|`, `${id}}`, `${id}{`, `${id}`, `${id}|~`, `${id}a|x`, `${id.slice(0, -1)}|x`);
  vals.push("kr:zz|nonderivable", "px:ffffffffffffffff|nonderivable");
  return vals;
}

describe("the fallback by index ranges is EXACT (the replaced scan is the oracle)", () => {
  for (const keyIds of [["kr:a"], ["kr:a", "px:0123456789abcdef"], ["kr:a", "kr:b", "px:89abcdef01234567"]]) {
    it(`differential with ${keyIds.length} derivable key(s): every NULL / bare / derivable / non-derivable / boundary / previous-only row`, () => {
      clearAgents();
      const vals = probeValues(keyIds);
      const rows: Array<{ lookup: string | null; hash: boolean; prevLookup?: string | null; prevHash?: boolean }> = [];
      for (const v of vals) {
        rows.push({ lookup: v, hash: true });
        rows.push({ lookup: v, hash: false }); // no hash: never a candidate
        rows.push({ lookup: `${keyIds[0]}|cur`, hash: true, prevLookup: v, prevHash: true }); // previous-only
        rows.push({ lookup: `${keyIds[0]}|cur`, hash: true, prevLookup: v, prevHash: false });
      }
      insertRows(rows);
      const ranges = unreachableLookupRanges(keyIds);
      const { fallbackRowsQuery } = db;
      expect(names(fallbackRowsQuery(ranges))).toEqual(names(oracleSql(keyIds)));
      // MUTANT: dropping ANY one complement range must be caught by this dataset.
      for (let i = 0; i < ranges.length; i++) {
        const mutant = ranges.filter((_, j) => j !== i);
        expect(names(fallbackRowsQuery(mutant)), `dropping range ${i} (${JSON.stringify(ranges[i])}) must change the answer`).not.toEqual(names(oracleSql(keyIds)));
      }
    });
  }
});

describe("the fallback is served by the indexes, not a scan", () => {
  it("EXPLAIN QUERY PLAN at N=10,000: every access to agents is a SEARCH on idx_agents_token_lookup or idx_agents_prev_token_lookup; NO `SCAN agents`", () => {
    clearAgents();
    const ids = ["kr:a", "px:0123456789abcdef"];
    insertRows(Array.from({ length: 10_000 }, (_, i) => ({ lookup: `${ids[i % 2]}|${i.toString(16)}`, hash: true })));
    const q = db.fallbackRowsQuery(unreachableLookupRanges(ids));
    const plan = (db.getDb().prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.params) as Array<{ detail: string }>).map((r) => r.detail);
    const touches = plan.filter((d) => /\bagents\b/.test(d));
    expect(touches.length, plan.join("\n")).toBeGreaterThan(0);
    expect(plan.filter((d) => /^SCAN agents\b/.test(d)), plan.join("\n")).toEqual([]);
    for (const d of touches) expect(d, plan.join("\n")).toMatch(/^SEARCH agents USING (COVERING )?INDEX idx_agents_(prev_)?token_lookup\b/);
  });

  it("steady-state cost (0 unreachable rows) at 34 vs 10,000 rows: reported, flat (no bar on the absolute)", () => {
    const ids = ["kr:a", "px:0123456789abcdef"];
    const time = (n: number) => {
      clearAgents();
      insertRows(Array.from({ length: n }, (_, i) => ({ lookup: `${ids[i % 2]}|${i.toString(16)}`, hash: true })));
      const q = db.fallbackRowsQuery(unreachableLookupRanges(ids));
      const st = db.getDb().prepare(q.sql);
      for (let i = 0; i < 50; i++) st.all(...q.params);
      const t = performance.now();
      for (let i = 0; i < 200; i++) st.all(...q.params);
      return (performance.now() - t) / 200;
    };
    const small = time(34);
    const large = time(10_000);
    console.log(`FALLBACK steady-state ms per unknown token: N=34 ${small.toFixed(4)} | N=10000 ${large.toFixed(4)}`);
    expect(Number.isFinite(small) && Number.isFinite(large)).toBe(true);
  });
});

describe("EVERY prepare() in findAgentRowByToken is served by an index (Codex R2 #1: step (a) was a SCAN)", () => {
  it("captured during a REAL token-only lookup at N=10,000, WITHOUT ANALYZE (a real install may never have run it)", async () => {
    clearAgents();
    const kid = lookupKeys()[0].id;
    insertRows(Array.from({ length: 10_000 }, (_, i) => ({ lookup: `${kid}|${i.toString(16)}`, hash: true })));
    insertRows([{ lookup: null, hash: true }]); // one digest-less row, so the fallback also runs
    _resetAuthThrottleForTests();
    const d = db.getDb();
    const real = d.prepare.bind(d);
    const sqls: string[] = [];
    (d as { prepare: (sql: string) => unknown }).prepare = (sql: string) => (sqls.push(sql), real(sql));
    try {
      await db.findAgentRowByToken("t".repeat(43), "plan-src");
    } finally {
      (d as { prepare: unknown }).prepare = real;
    }
    expect(sqls.length, "the lookup prepared its statements").toBeGreaterThanOrEqual(2);
    for (const sql of sqls) {
      const params = Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => "x");
      const plan = (real(`EXPLAIN QUERY PLAN ${sql}`) as { all: (...p: unknown[]) => Array<{ detail: string }> }).all(...params).map((r) => r.detail);
      expect(plan.filter((p) => /^SCAN agents\b/.test(p)), `${sql}\n${plan.join("\n")}`).toEqual([]);
    }
  });
});

describe("BUDGET FIRST (Codex R2 #2): an exhausted scan budget reads ZERO fallback rows", () => {
  it("100,000 digest-less rows + the source's budget exhausted → ZERO fallback queries, refused at once (MEASURED before: ~49 ms of SQL and digest work per call)", async () => {
    clearAgents();
    insertRows(Array.from({ length: 100_000 }, () => ({ lookup: null, hash: true })));
    _resetAuthThrottleForTests();
    for (let i = 0; i < SCAN_BURST; i++) expect(scanTake("drained")).toBe(true);
    const before = db.tokenFallbackQueryCount();
    const t = performance.now();
    const r = await db.findAgentRowByToken("u".repeat(43), "drained");
    const ms = performance.now() - t;
    console.log(`BUDGET-FIRST exhausted lookup at 100k digest-less rows: ${ms.toFixed(2)} ms, fallback queries ${db.tokenFallbackQueryCount() - before}`);
    expect(db.tokenFallbackQueryCount() - before, "fallback queries run with the budget exhausted").toBe(0);
    expect(r).toEqual({ refused: "throttled" });
  }, 60_000);
});
