// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * db.test.ts critical subset run on the sql.js (wasm) driver (v1.11).
 *
 * Proves the CompatDatabase adapter produces identical behavior for the
 * most-used operations. The full 21-test native suite stays separate and
 * untouched — this file is additive.
 *
 * Plus 3 wasm-specific tests:
 *   - getDb works after initializeDb(wasm)
 *   - WAL pragma handled gracefully (silently degrades to DELETE)
 *   - Sequential writes don't corrupt data (no WAL, single-process)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-wasm-test-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
process.env.RELAY_SQLITE_DRIVER = "wasm";

const {
  initializeDb,
  registerAgent,
  getAgents,
  sendMessage,
  getMessages,
  broadcastMessage,
  postTask,
  updateTask,
  getTasks,
  getTask,
  closeDb,
  getDb,
} = await import("../src/db.js");

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) {
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  }
}

beforeEach(async () => {
  cleanup();
  await initializeDb();
});

afterEach(() => {
  cleanup();
});

// --- Critical subset (mirrors db.test.ts native) ---

describe("wasm driver — agent operations", () => {
  it("creates a new agent", () => {
    const { agent, plaintext_token } = registerAgent("alice", "chief", ["a", "b"]);
    expect(agent.name).toBe("alice");
    expect(agent.role).toBe("chief");
    expect(agent.capabilities).toEqual(["a", "b"]);
    expect(agent.status).toBe("online");
    expect(plaintext_token).toBeTruthy();
    expect(agent.has_token).toBe(true);
  });

  it("re-register preserves capabilities (v1.7.1 immutability)", () => {
    const { agent: first } = registerAgent("bob", "r1", ["x"]);
    const { agent: second } = registerAgent("bob", "r2", ["y", "z"]);
    expect(first.id).toBe(second.id);
    expect(second.role).toBe("r2");
    expect(second.capabilities).toEqual(["x"]);
  });

  it("returns agents filtered by role", () => {
    registerAgent("a", "builder", []);
    registerAgent("b", "ops", []);
    registerAgent("c", "builder", []);
    const builders = getAgents("builder");
    expect(builders.length).toBe(2);
  });
});

describe("wasm driver — messaging", () => {
  it("sends and retrieves a message", () => {
    registerAgent("s", "r", []);
    registerAgent("r", "r", []);
    sendMessage("s", "r", "hello wasm", "normal");
    const msgs = getMessages("r", "pending", 20);
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toBe("hello wasm");
  });

  it("marks messages as read after retrieval", () => {
    registerAgent("a", "r", []);
    registerAgent("b", "r", []);
    sendMessage("a", "b", "hi", "normal");
    getMessages("b", "pending", 20);
    const pending = getMessages("b", "pending", 20);
    expect(pending.length).toBe(0);
    const read = getMessages("b", "read", 20);
    expect(read.length).toBe(1);
  });

  it("broadcast sends to all agents except sender", () => {
    registerAgent("x", "r", []);
    registerAgent("y", "r", []);
    registerAgent("z", "r", []);
    const result = broadcastMessage("x", "broadcast msg", undefined);
    expect(result.sent_to.length).toBe(2);
    expect(result.sent_to).not.toContain("x");
  });
});

describe("wasm driver — tasks", () => {
  it("post + accept + complete lifecycle", () => {
    registerAgent("boss", "r", []);
    registerAgent("worker", "r", []);
    const task = postTask("boss", "worker", "Do it", "Details", "normal");
    expect(task.status).toBe("posted");
    const accepted = updateTask(task.id, "worker", "accept");
    expect(accepted.status).toBe("accepted");
    const completed = updateTask(task.id, "worker", "complete", "Done!");
    expect(completed.status).toBe("completed");
    expect(completed.result).toBe("Done!");
  });

  it("get_tasks returns assigned tasks", () => {
    registerAgent("boss", "r", []);
    registerAgent("worker", "r", []);
    postTask("boss", "worker", "T1", "D1", "normal");
    postTask("boss", "worker", "T2", "D2", "high");
    const tasks = getTasks("worker", "assigned", "all", 20);
    expect(tasks.length).toBe(2);
  });
});

// --- Wasm-specific tests ---

describe("wasm driver — wasm-specific behavior", () => {
  it("getDb() returns a working handle after initializeDb()", () => {
    const db = getDb();
    expect(db).toBeTruthy();
    const result = db.prepare("SELECT 1 + 1 AS sum").get();
    expect(result).toBeTruthy();
    expect((result as any).sum).toBe(2);
  });

  it("WAL pragma is handled gracefully (skipped, returns 'memory')", () => {
    const db = getDb();
    const result = db.pragma("journal_mode = WAL");
    expect(String(result).toLowerCase()).toBe("memory");
  });

  it("sequential writes don't corrupt data (no WAL, no concurrent processes)", () => {
    registerAgent("w1", "r", []);
    registerAgent("w2", "r", []);
    for (let i = 0; i < 20; i++) {
      sendMessage("w1", "w2", `msg-${i}`, "normal");
    }
    const msgs = getMessages("w2", "pending", 100);
    expect(msgs.length).toBe(20);
    for (let i = 0; i < 20; i++) {
      expect(msgs.some((m) => m.content === `msg-${i}`)).toBe(true);
    }
  });
});

// v1.11.1 — test gaps surfaced by dual-model audit (Codex/GPT)
describe("wasm driver — v1.11.1 audit fixes", () => {
  it("reopen persistence: write data, close, reopen, data still there", async () => {
    registerAgent("persist-test", "r", ["cap1"]);
    sendMessage("persist-test", "persist-test", "persist-check", "normal");
    // Close the DB (flushes to disk)
    closeDb();
    // Reopen from the same file
    await initializeDb();
    const agents = getAgents();
    const found = agents.find((a) => a.name === "persist-test");
    expect(found).toBeTruthy();
    expect(found!.capabilities).toEqual(["cap1"]);
    const msgs = getMessages("persist-test", "pending", 10);
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toBe("persist-check");
  });

  it("nested transactions: outer tx + inner tx both commit", () => {
    const db = getDb();
    registerAgent("nest-outer", "r", []);
    registerAgent("nest-inner", "r", []);
    // Simulate nested transactions manually
    const outerTx = db.transaction(() => {
      sendMessage("nest-outer", "nest-inner", "outer-msg", "normal");
      const innerTx = db.transaction(() => {
        sendMessage("nest-inner", "nest-outer", "inner-msg", "normal");
      });
      innerTx();
    });
    outerTx();
    // Both messages should be persisted
    const outerMsgs = getMessages("nest-inner", "pending", 10);
    expect(outerMsgs.length).toBe(1);
    expect(outerMsgs[0].content).toBe("outer-msg");
    const innerMsgs = getMessages("nest-outer", "pending", 10);
    expect(innerMsgs.length).toBe(1);
    expect(innerMsgs[0].content).toBe("inner-msg");
  });

  it("concurrent initializeDb calls return the same instance", async () => {
    closeDb();
    const { initializeDb: initFresh, getInitializedDb } = await import("../src/sqlite-compat.js");
    const dbPath = process.env.RELAY_DB_PATH!;
    // Fire 10 concurrent init calls
    const promises = Array.from({ length: 10 }, () => initFresh(dbPath));
    const results = await Promise.all(promises);
    // All should resolve to the same reference
    for (let i = 1; i < results.length; i++) {
      expect(results[i]).toBe(results[0]);
    }
  });

  it("lastInsertRowid returns a real value (not hardcoded 0)", () => {
    const db = getDb();
    db.exec("CREATE TABLE IF NOT EXISTS rowid_test (val TEXT)");
    const result = db.prepare("INSERT INTO rowid_test (val) VALUES (?)").run("hello");
    // lastInsertRowid should be a positive integer, not 0
    expect(Number(result.lastInsertRowid)).toBeGreaterThan(0);
  });
});
