// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0036 S1 — the `agent_bindings` record (schema v25).
 *
 * The binding record is the fleet list: which window holds which name, on which
 * Claude Code conversation, where to reopen it. S1 records and lists; it changes
 * no auth. This file pins the SCHEMA contract only (the writers and `relay fleet`
 * have their own tests):
 *   - the schema is v25 and `agent_bindings` exists with every ADR-0036 §2.2 field,
 *     with §8a's split of `end_reason` (Claude Code's verbatim SessionEnd reason)
 *     from `supersede_reason` (relay-authored);
 *   - status is DERIVED at read time, never stored (§2.2) — no status column;
 *   - cardinality is one current row per WINDOW ANCHOR (§8a D1): the anchor,
 *     agent_name and conversation_id are indexed, and there is NO unique-per-name
 *     constraint (per-name exclusivity is S3's claim-time job, never schema);
 *   - the migration is additive and idempotent, and a v24 DB gains the table
 *     without losing existing rows.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-adr0036-s1-schema-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
delete process.env.RELAY_ALLOW_LEGACY;

const { closeDb, getDb, getSchemaVersion, registerAgent, CURRENT_SCHEMA_VERSION } = await import("../src/db.js");

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
}
beforeEach(() => cleanup());
afterEach(() => cleanup());

/** ADR-0036 §2.2 fields, plus §8a D2's supersede_reason. */
const BINDING_COLUMNS = [
  "binding_id",
  "binding_version",
  "agent_name",
  "agent_class",
  "conversation_id",
  "conversation_title",
  "cwd",
  "host_id",
  "window_pid",
  "window_pid_start",
  "bound_via",
  "bound_at",
  "last_verified_at",
  "superseded_at",
  "superseded_by",
  "end_reason",
  "supersede_reason",
];

function columnsOf(table: string): string[] {
  return (getDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

function tableExists(table: string): boolean {
  return !!getDb().prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

/** Every index on a table with its ordered column list and uniqueness. */
function indexesOf(table: string): Array<{ name: string; unique: boolean; columns: string[] }> {
  const db = getDb();
  const list = db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string; unique: number }>;
  return list.map((ix) => ({
    name: ix.name,
    unique: ix.unique === 1,
    columns: (db.prepare(`PRAGMA index_info(${JSON.stringify(ix.name)})`).all() as Array<{ seqno: number; name: string }>)
      .sort((a, b) => a.seqno - b.seqno)
      .map((c) => c.name),
  }));
}

describe("ADR-0036 S1 — schema v25", () => {
  it("the schema migrated to v25", () => {
    getDb();
    expect(CURRENT_SCHEMA_VERSION).toBe(25);
    expect(getSchemaVersion()).toBe(25);
  });
});

describe("ADR-0036 S1 — the agent_bindings table", () => {
  it("exists with every §2.2 field", () => {
    expect(tableExists("agent_bindings"), "agent_bindings table").toBe(true);
    const cols = columnsOf("agent_bindings");
    for (const c of BINDING_COLUMNS) expect(cols, `column ${c}`).toContain(c);
  });

  it("keeps Claude Code's end_reason and the relay's supersede_reason as separate columns (§8a D2)", () => {
    const cols = columnsOf("agent_bindings");
    expect(cols).toContain("end_reason");
    expect(cols).toContain("supersede_reason");
  });

  it("stores no status: status is derived at read time from the anchor (§2.2)", () => {
    expect(tableExists("agent_bindings"), "agent_bindings table").toBe(true);
    const cols = columnsOf("agent_bindings");
    for (const forbidden of ["status", "binding_status", "needs_resume", "is_live"]) {
      expect(cols, `a stored ${forbidden} would drift from the live anchor`).not.toContain(forbidden);
    }
  });

  it("indexes the window anchor, agent_name and conversation_id", () => {
    const ix = indexesOf("agent_bindings");
    const anchor = ["host_id", "window_pid", "window_pid_start"];
    expect(ix.some((i) => JSON.stringify(i.columns) === JSON.stringify(anchor)), "index on the window anchor").toBe(true);
    expect(ix.some((i) => i.columns[0] === "agent_name"), "index leading with agent_name").toBe(true);
    expect(ix.some((i) => i.columns[0] === "conversation_id"), "index leading with conversation_id").toBe(true);
  });

  it("has NO unique-per-name constraint: two windows may record the same name in S1 (§8a D1)", () => {
    expect(tableExists("agent_bindings"), "agent_bindings table").toBe(true);
    const uniqueOnName = indexesOf("agent_bindings").filter(
      (i) => i.unique && i.columns.length === 1 && i.columns[0] === "agent_name",
    );
    expect(uniqueOnName, "per-name exclusivity is S3's claim-time rule, never schema").toEqual([]);
  });
});

describe("ADR-0036 S1 — migration is additive and idempotent", () => {
  it("re-opening an already-migrated DB changes nothing and does not throw", () => {
    getDb();
    const before = { version: getSchemaVersion(), cols: columnsOf("agent_bindings"), ix: indexesOf("agent_bindings") };
    closeDb();
    getDb();
    expect(getSchemaVersion()).toBe(before.version);
    expect(columnsOf("agent_bindings")).toEqual(before.cols);
    expect(indexesOf("agent_bindings")).toEqual(before.ix);
    expect(getSchemaVersion()).toBe(25);
  });

  it("a v24-shaped DB gains agent_bindings on open, keeps its existing agents rows, and records v25", () => {
    // Simulate a DB last written by v24 code: no agent_bindings, schema_info at 24.
    registerAgent("keeper", "builder", []);
    const db = getDb();
    db.exec("DROP TABLE IF EXISTS agent_bindings");
    db.prepare("UPDATE schema_info SET version = ?, last_migrated_at = ? WHERE id = 1").run(24, new Date().toISOString());
    closeDb();

    getDb();
    expect(tableExists("agent_bindings"), "agent_bindings recreated by the v25 migration").toBe(true);
    expect(getSchemaVersion()).toBe(25);
    const kept = getDb().prepare("SELECT name, role FROM agents WHERE name = ?").get("keeper") as
      | { name: string; role: string }
      | undefined;
    expect(kept, "existing agents rows survive the migration").toEqual({ name: "keeper", role: "builder" });
  });
});
