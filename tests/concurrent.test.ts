// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import cp from "child_process";
import Database from "better-sqlite3";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-concurrent-test-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
// v2.1.3 I8: scrub inherited RELAY_AGENT_* env vars so isolated tests
// do not auth against a parent-shell spawn-agent.sh token.
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;

const { registerAgent, sendMessage, closeDb, getDb } = await import("../src/db.js");

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) {
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  }
}

beforeEach(() => cleanup());
afterEach(() => cleanup());

describe("concurrent writes (busy_timeout)", () => {
  it("two writers racing via Promise.all don't lose updates", async () => {
    // Force schema creation in the main connection
    getDb();
    registerAgent("alice", "r", []);
    registerAgent("bob", "r", []);

    // Open a SECOND raw connection to the same DB file
    const conn2 = new Database(TEST_DB_PATH);
    conn2.pragma("journal_mode = WAL");
    conn2.pragma("busy_timeout = 5000");

    // Two write streams scheduled via microtasks so they actually interleave
    // on the event loop rather than alternating inside one synchronous loop.
    // Better-sqlite3 is synchronous so true JS concurrency is not possible
    // in one process — the genuine contention test lives in the child-process
    // test below. This test verifies the in-process Promise.all pattern still
    // completes without data loss.
    const writer1 = (async () => {
      for (let i = 0; i < 50; i++) {
        sendMessage("alice", "bob", `from-main-${i}`, "normal");
        if (i % 5 === 0) await new Promise((r) => setImmediate(r));
      }
    })();

    const writer2 = (async () => {
      // 4 placeholders matches 4 columns with real values; the rest are literals.
      const stmt = conn2.prepare(
        "INSERT INTO messages (id, from_agent, to_agent, content, priority, status, created_at) VALUES (?, ?, ?, ?, 'normal', 'pending', datetime('now'))"
      );
      for (let i = 0; i < 50; i++) {
        stmt.run(`conn2-${i}`, "bob", "alice", `from-conn2-${i}`);
        if (i % 5 === 0) await new Promise((r) => setImmediate(r));
      }
    })();

    await Promise.all([writer1, writer2]);

    const aliceCount = conn2.prepare("SELECT COUNT(*) as n FROM messages WHERE to_agent = 'alice'").get() as { n: number };
    const bobCount = conn2.prepare("SELECT COUNT(*) as n FROM messages WHERE to_agent = 'bob'").get() as { n: number };

    expect(aliceCount.n).toBe(50);
    expect(bobCount.n).toBe(50);

    conn2.close();
  });

  it("two OS processes writing concurrently — busy_timeout handles real contention", async () => {
    // Real contention requires OS-level parallelism. Spawn a child Node
    // process that hammers the same SQLite file while this process also writes.
    // If busy_timeout is working, every write lands with no data loss and no
    // SQLITE_BUSY errors propagate out.
    getDb();
    registerAgent("alice", "r", []);
    registerAgent("bob", "r", []);
    closeDb(); // Release our connection so the child can open its own cleanly.

    const WRITES_PER_SIDE = 100;
    // process.argv in the child: [node, '[eval]', '--', TEST_DB_PATH]
    // So the DB path lands at argv[3] (after the '--' separator).
    const childScript = `
      const Database = require('better-sqlite3');
      const dbPath = process.argv[process.argv.length - 1];
      const db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 5000');
      const stmt = db.prepare(
        "INSERT INTO messages (id, from_agent, to_agent, content, priority, status, created_at) VALUES (?, ?, ?, ?, 'normal', 'pending', datetime('now'))"
      );
      for (let i = 0; i < ${WRITES_PER_SIDE}; i++) {
        stmt.run('child-' + i, 'child', 'parent', 'msg-' + i);
      }
      db.close();
    `;

    // Kick off the child. Force CommonJS input type so `require` works
    // regardless of the parent package's ESM/CJS setting.
    const childPromise = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = cp.spawn(process.execPath, ["--input-type=commonjs", "-e", childScript, "--", TEST_DB_PATH]);
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("exit", (code) => resolve({ code, stderr }));
      child.on("error", reject);
    });

    // In parallel, the parent also writes using a fresh connection
    const parentWrites = (async () => {
      const parentDb = new Database(TEST_DB_PATH);
      parentDb.pragma("journal_mode = WAL");
      parentDb.pragma("busy_timeout = 5000");
      const stmt = parentDb.prepare(
        "INSERT INTO messages (id, from_agent, to_agent, content, priority, status, created_at) VALUES (?, ?, ?, ?, 'normal', 'pending', datetime('now'))"
      );
      for (let i = 0; i < WRITES_PER_SIDE; i++) {
        stmt.run(`parent-${i}`, "parent", "child", `msg-${i}`);
        // Yield occasionally so the child gets scheduling time
        if (i % 10 === 0) await new Promise((r) => setImmediate(r));
      }
      parentDb.close();
    })();

    const [childResult] = await Promise.all([childPromise, parentWrites]);
    expect(childResult.code, `child failed with stderr: ${childResult.stderr}`).toBe(0);

    // Verify every write landed (no data loss under real contention)
    const verifyDb = new Database(TEST_DB_PATH);
    const parentCount = verifyDb
      .prepare("SELECT COUNT(*) as n FROM messages WHERE from_agent = 'parent'")
      .get() as { n: number };
    const childCount = verifyDb
      .prepare("SELECT COUNT(*) as n FROM messages WHERE from_agent = 'child'")
      .get() as { n: number };
    verifyDb.close();

    expect(parentCount.n).toBe(WRITES_PER_SIDE);
    expect(childCount.n).toBe(WRITES_PER_SIDE);
  }, 30000);

  it("busy_timeout pragma is set on the singleton", () => {
    const db = getDb();
    const result = db.pragma("busy_timeout") as Array<{ timeout: number }>;
    expect(result[0].timeout).toBeGreaterThanOrEqual(5000);
  });

  it("WAL journal mode is set on the singleton", () => {
    const db = getDb();
    const result = db.pragma("journal_mode") as Array<{ journal_mode: string }>;
    expect(result[0].journal_mode).toBe("wal");
  });
});

describe("schema migration (additive only)", () => {
  it("starts cleanly with a v1.0-era schema (only agents/messages/tasks tables)", () => {
    // Pre-create a "v1.0" DB with only the original three tables, no v1.2/v1.3/v1.5 additions
    fs.mkdirSync(TEST_DB_DIR, { recursive: true });
    const seed = new Database(TEST_DB_PATH);
    seed.exec(`
      CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, role TEXT NOT NULL, capabilities TEXT NOT NULL DEFAULT '[]', last_seen TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE messages (id TEXT PRIMARY KEY, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL, content TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'normal', status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'normal', status TEXT NOT NULL DEFAULT 'posted', result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    `);
    // v2.0 final (#2) added dead-agent purge (last_seen < 30 days ago). Seed
    // with a fresh last_seen so this test covers the migration preservation
    // behavior, not the purge. Dead-purge has its own coverage.
    const freshLastSeen = new Date().toISOString();
    seed.exec(`INSERT INTO agents (id, name, role, capabilities, last_seen, created_at) VALUES ('legacy-id', 'legacy-agent', 'old', '[]', '${freshLastSeen}', '2026-01-01T00:00:00Z')`);
    seed.close();

    // Now open via our db module — should add the missing tables (webhook_subscriptions, audit_log, rate_limit_state) without erroring
    const db = getDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain("agents");
    expect(tableNames).toContain("messages");
    expect(tableNames).toContain("tasks");
    expect(tableNames).toContain("webhook_subscriptions");
    expect(tableNames).toContain("webhook_delivery_log");
    expect(tableNames).toContain("audit_log");
    expect(tableNames).toContain("rate_limit_state");

    // Legacy data should still be there
    const legacy = db.prepare("SELECT name FROM agents WHERE id = ?").get("legacy-id") as { name: string };
    expect(legacy.name).toBe("legacy-agent");
  });
});
