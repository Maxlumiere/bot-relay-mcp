// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0043 — edge identity. One random ID per DATABASE, and every agent_bindings
 * key starts with it. (Review item F7: key the per-name view by (edge, name) while
 * the table is still empty, so federation needs no migration later.)
 *
 *   relay_edge  singleton (id = 1), edge_id = a fresh random UUID v4 (lowercase),
 *               created ONCE at schema setup, never derived from instance_id, host_id,
 *               hostname or a path; IMMUTABLE; validated on read.
 *   agent_bindings.edge_id NOT NULL, stamped from relay_edge ONLY: never from tool
 *               args, env, stdin or the network. Before v2.3 there is no federation
 *               ingress, so a row with a FOREIGN edge_id is refused at the database.
 *   every key and uniqueness constraint on agent_bindings STARTS with edge_id.
 *
 * #276's v25 is merged but NOT released or deployed, so this lands IN v25 (no v26
 * bump). A dev database that already holds the pre-F7 v25 shape is brought forward
 * idempotently on open.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELAY_BIN = path.join(REPO_ROOT, "bin", "relay");
const ROOT = path.join(os.tmpdir(), `bot-relay-adr0043-${process.pid}`);
const DB = path.join(ROOT, "relay.db");
const HOME_DIR = path.join(ROOT, "home");
process.env.RELAY_DB_PATH = DB;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FOREIGN = "00000000-0000-4000-8000-000000000000";
const DETECTED = (await import("../src/liveness.js")).detectAgentProcess();
const ANCHOR_PID = DETECTED?.pid ?? process.pid;

async function freshSchema(): Promise<void> {
  const { getDb, closeDb } = await import("../src/db.js");
  closeDb();
  process.env.RELAY_DB_PATH = DB;
  getDb();
  closeDb();
}

async function raw<T>(fn: (db: import("better-sqlite3").Database) => T): Promise<Awaited<T>> {
  const Better = (await import("better-sqlite3")).default;
  const db = new Better(DB);
  try {
    // AWAIT before closing: an async callback must finish on an open handle.
    return await fn(db);
  } finally {
    db.close();
  }
}

const edgeRow = () => raw((db) => db.prepare("SELECT edge_id, created_at FROM relay_edge WHERE id = 1").get() as { edge_id: string } | undefined);

function anchor(pid: number, host = "h-1") {
  return { hostId: host, windowPid: pid, windowPidStart: "Mon Sep 15 10:00:00 2026" };
}

async function bindRow(db: unknown, a: ReturnType<typeof anchor>, name: string | null, conv: string, extra: Record<string, unknown> = {}) {
  const { upsertAgentBinding } = await import("../src/db.js");
  return upsertAgentBinding(db as never, {
    ...a,
    agentName: name,
    agentClass: null,
    conversationId: conv,
    conversationTitle: null,
    cwd: "/tmp/e",
    boundVia: "launch-intent",
    ...extra,
  } as never);
}

beforeEach(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME_DIR), { recursive: true });
  await freshSchema();
});
afterEach(async () => {
  const { closeDb } = await import("../src/db.js");
  closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("ADR-0043 — relay_edge: one random, immutable ID per database", () => {
  it("INNOCENT TWIN: a fresh DB gets a canonical lowercase UUID v4", async () => {
    const r = await edgeRow();
    expect(r?.edge_id).toMatch(UUID_V4);
  });

  it("HARM: a second setup / migration run leaves edge_id UNCHANGED", async () => {
    const first = (await edgeRow())!.edge_id;
    await freshSchema();
    await freshSchema();
    expect((await edgeRow())!.edge_id).toBe(first);
  });

  it("carries no information: two fresh databases differ, and neither contains the instance id, host id or hostname", async () => {
    const a = (await edgeRow())!.edge_id;
    fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(HOME_DIR, { recursive: true });
    await freshSchema();
    const b = (await edgeRow())!.edge_id;
    expect(a).not.toBe(b);
    const { getOwnHostId } = await import("../src/liveness.js");
    for (const leak of [getOwnHostId() ?? "__none__", os.hostname()]) {
      expect(b.toLowerCase()).not.toContain(String(leak).toLowerCase().slice(0, 8));
    }
  });

  it("IMMUTABLE: an UPDATE or DELETE of relay_edge is refused by the database", async () => {
    const before = (await edgeRow())!.edge_id;
    await expect(raw((db) => db.prepare("UPDATE relay_edge SET edge_id = ? WHERE id = 1").run(FOREIGN))).rejects.toThrow(/relay_edge is immutable/i);
    await expect(raw((db) => db.prepare("DELETE FROM relay_edge").run())).rejects.toThrow(/relay_edge is immutable/i);
    expect((await edgeRow())!.edge_id).toBe(before);
  });

  it("IMMUTABLE: INSERT OR REPLACE (whose implicit delete fires no DELETE trigger) is refused too", async () => {
    const before = (await edgeRow())!.edge_id;
    await expect(
      raw((db) => db.prepare("INSERT OR REPLACE INTO relay_edge (id, edge_id, created_at) VALUES (1, ?, 't')").run(FOREIGN)),
    ).rejects.toThrow(/relay_edge is immutable/i);
    expect((await edgeRow())!.edge_id).toBe(before);
  });

  it("the table itself refuses a malformed edge_id (CHECK), independent of the triggers", async () => {
    await expect(
      raw((db) => {
        db.exec("DROP TRIGGER relay_edge_immutable_update");
        db.prepare("UPDATE relay_edge SET edge_id = 'NOT-A-UUID' WHERE id = 1").run();
      }),
    ).rejects.toThrow(/CHECK constraint failed/i);
  });

  it("the table's GLOB accepts exactly what the read validator accepts", async () => {
    const { EDGE_ID_GLOB } = await import("../src/db.js");
    const cases = [
      "0f8fad5b-d9cb-469f-a165-70867728950e", // valid v4
      FOREIGN, // valid v4
      "0F8FAD5B-D9CB-469F-A165-70867728950E", // uppercase
      "0f8fad5b-d9cb-169f-a165-70867728950e", // v1
      "0f8fad5b-d9cb-469f-c165-70867728950e", // wrong variant
      "0f8fad5bd9cb469fa16570867728950e", // no dashes
      "0f8fad5b-d9cb-469f-a165-70867728950e0", // too long
      "",
    ];
    const viaGlob = await raw((db) => cases.map((c) => (db.prepare("SELECT ? GLOB ? AS m").get(c, EDGE_ID_GLOB) as { m: number }).m === 1));
    expect(viaGlob).toEqual(cases.map((c) => UUID_V4.test(c)));
    expect(viaGlob.filter(Boolean)).toHaveLength(2);
  });

  it("validated on read: a malformed stored edge_id fails LOUDLY, never used", async () => {
    await raw((db) => {
      // Past BOTH write-side defences (trigger and CHECK), to prove the read side
      // holds on its own: a DB edited outside SQLite's constraints still fails loud.
      db.exec("DROP TRIGGER IF EXISTS relay_edge_immutable_update");
      db.pragma("ignore_check_constraints = ON");
      db.prepare("UPDATE relay_edge SET edge_id = 'not-a-uuid' WHERE id = 1").run();
    });
    const { getLocalEdgeId } = await import("../src/db.js");
    await expect(raw((db) => getLocalEdgeId(db as never))).rejects.toThrow(/malformed edge_id/i);
  });
});

describe("ADR-0043 — agent_bindings.edge_id is the LOCAL edge, stamped only from relay_edge", () => {
  it("the writer stamps the local edge_id on every row, including a reused anchor (startup → resume-switch → clear)", async () => {
    const local = (await edgeRow())!.edge_id;
    await raw(async (db) => {
      await bindRow(db, anchor(4001), "edge-a", "c1111111-1111-1111-1111-111111111111");
      await bindRow(db, anchor(4001), "edge-a", "c2222222-2222-2222-2222-222222222222");
      await bindRow(db, anchor(4001), "edge-a", "c3333333-3333-3333-3333-333333333333", { boundVia: "clear-carry" });
    });
    const rows = await raw((db) => db.prepare("SELECT edge_id, superseded_at FROM agent_bindings").all() as Array<{ edge_id: string; superseded_at: string | null }>);
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.edge_id).toBe(local);
    expect(rows.filter((r) => r.superseded_at === null)).toHaveLength(1);
  });

  it("HARM: an edge_id smuggled into the write (edgeId / edge_id fields) is IGNORED; the local one is stamped", async () => {
    const local = (await edgeRow())!.edge_id;
    await raw((db) => bindRow(db, anchor(4002), "edge-b", "c4444444-4444-4444-4444-444444444444", { edgeId: FOREIGN, edge_id: FOREIGN }));
    const r = await raw((db) => db.prepare("SELECT edge_id FROM agent_bindings").get() as { edge_id: string });
    expect(r.edge_id).toBe(local);
  });

  it("HARM: `relay bind` given a foreign edge through env AND stdin still stamps the local edge", async () => {
    const local = (await edgeRow())!.edge_id;
    const r = spawnSync("node", [RELAY_BIN, "bind"], {
      encoding: "utf-8",
      timeout: 30_000,
      input: JSON.stringify({
        session_id: "c5555555-5555-5555-5555-555555555555",
        cwd: ROOT,
        hook_event_name: "SessionStart",
        source: "startup",
        edge_id: FOREIGN,
      }),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: HOME_DIR,
        RELAY_HOME: HOME_DIR,
        RELAY_DB_PATH: DB,
        CLAUDE_PID: String(ANCHOR_PID),
        RELAY_AGENT_NAME: "edge-cli",
        RELAY_EDGE_ID: FOREIGN,
      },
    });
    expect(r.status, r.stderr).toBe(0);
    const row = await raw((db) => db.prepare("SELECT edge_id FROM agent_bindings WHERE agent_name = 'edge-cli'").get() as { edge_id: string });
    expect(row.edge_id).toBe(local);
  }, 30_000);

  it("HARM: a raw INSERT of a row with a FOREIGN edge_id is refused by the database (no federation ingress before v2.3)", async () => {
    await expect(
      raw((db) =>
        db
          .prepare(
            "INSERT INTO agent_bindings (binding_id, binding_version, agent_name, conversation_id, host_id, window_pid, " +
              "window_pid_start, bound_via, bound_at, edge_id) VALUES ('x', 1, 'n', 'c', 'h', 1, 's', 'v', 't', ?)",
          )
          .run(FOREIGN),
      ),
    ).rejects.toThrow(/foreign edge_id/i);
  });
});

describe("ADR-0043 — every key on agent_bindings starts with edge_id", () => {
  it("every index on agent_bindings (unique included) leads with edge_id", async () => {
    const idx = await raw((db) =>
      db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'agent_bindings' AND sql IS NOT NULL").all() as Array<{ name: string; sql: string }>,
    );
    expect(idx.length, "precondition: the table has indexes").toBeGreaterThan(0);
    for (const i of idx) expect(i.sql, i.name).toMatch(/ON agent_bindings\s*\(\s*edge_id\b/i);
  });

  it("two bindings with the SAME name and the SAME anchor on DIFFERENT edges do not collide (the hub-mode shape)", async () => {
    // Simulates the future signature-verified ingress: the foreign-edge guard is
    // lifted for this one insert, so only the KEYS are under test.
    const local = (await edgeRow())!.edge_id;
    await raw(async (db) => {
      await bindRow(db, anchor(4003), "architect", "c6666666-6666-6666-6666-666666666666");
      db.exec("DROP TRIGGER IF EXISTS agent_bindings_local_edge_insert");
      db.prepare(
        "INSERT INTO agent_bindings (binding_id, binding_version, agent_name, conversation_id, host_id, window_pid, " +
          "window_pid_start, bound_via, bound_at, edge_id) VALUES ('foreign-1', 1, 'architect', 'c7', ?, ?, ?, 'launch-intent', 't', ?)",
      ).run("h-1", 4003, "Mon Sep 15 10:00:00 2026", FOREIGN);
    });
    const { listAgentBindings } = await import("../src/db.js");
    const listed = await raw((db) => listAgentBindings(db as never));
    expect(listed.map((r: { agent_name: string | null }) => r.agent_name)).toEqual(["architect"]);
    expect((listed[0] as unknown as { edge_id: string }).edge_id, "the local view shows only the local edge").toBe(local);
  });

  it("INNOCENT TWIN: on the SAME edge, one current binding per anchor is still enforced", async () => {
    await raw(async (db) => {
      await bindRow(db, anchor(4004), "solo", "c8888888-8888-8888-8888-888888888888");
      await bindRow(db, anchor(4004), "solo", "c9999999-9999-9999-9999-999999999999");
    });
    const current = await raw((db) => (db.prepare("SELECT COUNT(*) AS c FROM agent_bindings WHERE window_pid = 4004 AND superseded_at IS NULL").get() as { c: number }).c);
    expect(current).toBe(1);
  });
});

describe("ADR-0043 — a pre-F7 v25 database is brought forward in v25 (no v26 bump)", () => {
  it("adds edge_id, backfills it with the local edge, and rebuilds the indexes with edge_id first", async () => {
    // The shape #276 shipped to main: agent_bindings with no edge_id, no relay_edge.
    await raw((db) => {
      db.exec("DROP TABLE agent_bindings; DROP TABLE IF EXISTS relay_edge;");
      db.exec(`CREATE TABLE agent_bindings (binding_id TEXT PRIMARY KEY, binding_version INTEGER NOT NULL DEFAULT 1,
        agent_name TEXT, agent_class TEXT, conversation_id TEXT NOT NULL, conversation_title TEXT, cwd TEXT,
        host_id TEXT NOT NULL, window_pid INTEGER NOT NULL, window_pid_start TEXT NOT NULL, bound_via TEXT NOT NULL,
        bound_at TEXT NOT NULL, last_verified_at TEXT, superseded_at TEXT, superseded_by TEXT, end_reason TEXT, supersede_reason TEXT)`);
      db.exec("CREATE UNIQUE INDEX idx_agent_bindings_current_anchor ON agent_bindings(host_id, window_pid, window_pid_start) WHERE superseded_at IS NULL");
      db.prepare("INSERT INTO agent_bindings (binding_id, conversation_id, host_id, window_pid, window_pid_start, bound_via, bound_at) VALUES ('old', 'c', 'h', 1, 's', 'v', 't')").run();
    });
    await freshSchema();
    const local = (await edgeRow())!.edge_id;
    expect(local).toMatch(UUID_V4);
    const r = await raw((db) => db.prepare("SELECT edge_id FROM agent_bindings WHERE binding_id = 'old'").get() as { edge_id: string });
    expect(r.edge_id).toBe(local);
    const v = await raw((db) => (db.prepare("SELECT version FROM schema_info WHERE id = 1").get() as { version: number }).version);
    expect(v, "no v26 bump").toBe(25);
    const idx = await raw((db) => db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'agent_bindings' AND sql IS NOT NULL").all() as Array<{ sql: string }>);
    for (const i of idx) expect(i.sql).toMatch(/\(\s*edge_id\b/i);
  });
});

describe("ADR-0043 — edge_id is visible locally (whoami / health_check)", () => {
  it("health_check reports this relay's edge_id", async () => {
    const local = (await edgeRow())!.edge_id;
    const { handleHealthCheck } = await import("../src/tools/status.js");
    const r = JSON.parse((handleHealthCheck({} as never) as { content: { text: string }[] }).content[0].text);
    expect(r.edge_id).toBe(local);
  });

  it("whoami reports this relay's edge_id", async () => {
    const local = (await edgeRow())!.edge_id;
    const { registerAgent } = await import("../src/db.js");
    registerAgent("edge-whoami", "r", []);
    const { handleWhoami } = await import("../src/tools/status.js");
    const { requestContext } = await import("../src/request-context.js");
    const res = requestContext.run({ transport: "stdio", callerName: "edge-whoami" } as never, () => handleWhoami());
    expect(JSON.parse(res.content[0].text).edge_id).toBe(local);
  });
});
