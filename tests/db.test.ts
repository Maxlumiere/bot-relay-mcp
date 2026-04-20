// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

// Set test DB path before importing db module
const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-test-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
// v2.1.3 I8: scrub inherited RELAY_AGENT_* env vars so isolated tests
// do not auth against a parent-shell spawn-agent.sh token.
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;

// Dynamic import to pick up the env var
const {
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
  // v2.1 Phase 7q sanctioned helpers:
  teardownAgent,
  applyAuthStateTransition,
  updateAgentMetadata,
  getAgentAuthData,
  getDb,
} = await import("../src/db.js");

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) {
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  }
}

beforeEach(() => {
  cleanup();
});

afterEach(() => {
  cleanup();
});

// --- Agent tests ---

describe("registerAgent", () => {
  it("creates a new agent", () => {
    const { agent, plaintext_token } = registerAgent("victra", "chief-of-staff", ["triage", "orchestration"]);
    expect(agent.name).toBe("victra");
    expect(agent.role).toBe("chief-of-staff");
    expect(agent.capabilities).toEqual(["triage", "orchestration"]);
    expect(agent.status).toBe("online");
    expect(agent.id).toBeTruthy();
    // v1.7: first registration returns a plaintext token
    expect(plaintext_token).toBeTruthy();
    expect(agent.has_token).toBe(true);
  });

  it("upserts on duplicate name — role updates, capabilities preserved (v1.7.1)", () => {
    const { agent: first } = registerAgent("ops", "builder", ["build"]);
    const { agent: second, plaintext_token: secondToken } = registerAgent("ops", "deployer", ["deploy", "spawn"]);
    expect(first.id).toBe(second.id);
    // Role DOES update on re-register (operators may legitimately rename roles)
    expect(second.role).toBe("deployer");
    // v1.7.1 capability immutability: requested caps ["deploy","spawn"] are IGNORED,
    // preserved caps ["build"] remain. This is the defense-in-depth guard against
    // the v1.7 re-register capability-escalation CVE.
    expect(second.capabilities).toEqual(["build"]);
    // v1.7: re-register of an already-tokened agent does NOT rotate the token
    expect(secondToken).toBeNull();
  });

  it("capabilities remain immutable even across many re-registers (v1.7.1)", () => {
    const { agent: first } = registerAgent("foo", "r", ["cap-a"]);
    registerAgent("foo", "r2", ["cap-b", "cap-c"]);
    registerAgent("foo", "r3", []);
    const { agent: final } = registerAgent("foo", "r4", ["anything"]);
    expect(final.id).toBe(first.id);
    expect(final.capabilities).toEqual(["cap-a"]);
  });
});

describe("getAgents", () => {
  it("returns all agents", () => {
    registerAgent("a", "role1", []);
    registerAgent("b", "role2", []);
    const agents = getAgents();
    expect(agents.length).toBe(2);
  });

  it("filters by role", () => {
    registerAgent("a", "builder", []);
    registerAgent("b", "ops", []);
    registerAgent("c", "builder", []);
    const builders = getAgents("builder");
    expect(builders.length).toBe(2);
    expect(builders.every((a) => a.role === "builder")).toBe(true);
  });
});

// --- Message tests ---

describe("sendMessage", () => {
  it("creates a pending message", () => {
    registerAgent("sender", "role", []);
    registerAgent("receiver", "role", []);
    const msg = sendMessage("sender", "receiver", "hello", "normal");
    expect(msg.from_agent).toBe("sender");
    expect(msg.to_agent).toBe("receiver");
    expect(msg.content).toBe("hello");
    expect(msg.status).toBe("pending");
  });
});

describe("getMessages", () => {
  it("retrieves pending messages", () => {
    registerAgent("a", "role", []);
    registerAgent("b", "role", []);
    sendMessage("a", "b", "msg1", "normal");
    sendMessage("a", "b", "msg2", "high");

    const msgs = getMessages("b", "pending", 20);
    expect(msgs.length).toBe(2);
  });

  it("marks pending messages as read", () => {
    registerAgent("a", "role", []);
    registerAgent("b", "role", []);
    sendMessage("a", "b", "hello", "normal");

    getMessages("b", "pending", 20);
    const pending = getMessages("b", "pending", 20);
    expect(pending.length).toBe(0);

    const read = getMessages("b", "read", 20);
    expect(read.length).toBe(1);
  });

  it("respects limit", () => {
    registerAgent("a", "role", []);
    registerAgent("b", "role", []);
    for (let i = 0; i < 5; i++) {
      sendMessage("a", "b", `msg${i}`, "normal");
    }
    const msgs = getMessages("b", "pending", 3);
    expect(msgs.length).toBe(3);
  });
});

describe("broadcastMessage", () => {
  it("sends to all agents except sender", () => {
    registerAgent("sender", "role", []);
    registerAgent("r1", "role", []);
    registerAgent("r2", "role", []);

    const result = broadcastMessage("sender", "broadcast test");
    expect(result.sent_to.sort()).toEqual(["r1", "r2"]);
    expect(result.message_ids.length).toBe(2);
  });

  it("filters by role", () => {
    registerAgent("sender", "ops", []);
    registerAgent("r1", "builder", []);
    registerAgent("r2", "ops", []);

    const result = broadcastMessage("sender", "ops only", "ops");
    expect(result.sent_to).toEqual(["r2"]);
  });
});

// --- Task tests ---

describe("postTask", () => {
  it("creates a posted task", () => {
    registerAgent("boss", "role", []);
    registerAgent("worker", "role", []);
    const task = postTask("boss", "worker", "Do thing", "Details here", "high");
    expect(task.from_agent).toBe("boss");
    expect(task.to_agent).toBe("worker");
    expect(task.status).toBe("posted");
    expect(task.priority).toBe("high");
  });
});

describe("updateTask", () => {
  it("accepts a posted task", () => {
    registerAgent("boss", "role", []);
    registerAgent("worker", "role", []);
    const task = postTask("boss", "worker", "Task", "Desc", "normal");
    const updated = updateTask(task.id, "worker", "accept");
    expect(updated.status).toBe("accepted");
  });

  it("completes an accepted task", () => {
    registerAgent("boss", "role", []);
    registerAgent("worker", "role", []);
    const task = postTask("boss", "worker", "Task", "Desc", "normal");
    updateTask(task.id, "worker", "accept");
    const completed = updateTask(task.id, "worker", "complete", "Done!");
    expect(completed.status).toBe("completed");
    expect(completed.result).toBe("Done!");
  });

  it("rejects a posted task", () => {
    registerAgent("boss", "role", []);
    registerAgent("worker", "role", []);
    const task = postTask("boss", "worker", "Task", "Desc", "normal");
    const rejected = updateTask(task.id, "worker", "reject", "Not my job");
    expect(rejected.status).toBe("rejected");
    expect(rejected.result).toBe("Not my job");
  });

  it("prevents invalid state transitions", () => {
    registerAgent("boss", "role", []);
    registerAgent("worker", "role", []);
    const task = postTask("boss", "worker", "Task", "Desc", "normal");
    expect(() => updateTask(task.id, "worker", "complete")).toThrow();
  });

  it("prevents unauthorized updates", () => {
    registerAgent("boss", "role", []);
    registerAgent("worker", "role", []);
    registerAgent("intruder", "role", []);
    const task = postTask("boss", "worker", "Task", "Desc", "normal");
    expect(() => updateTask(task.id, "intruder", "accept")).toThrow();
  });
});

describe("getTasks", () => {
  it("returns tasks assigned to agent", () => {
    registerAgent("boss", "role", []);
    registerAgent("worker", "role", []);
    postTask("boss", "worker", "Task 1", "D1", "normal");
    postTask("boss", "worker", "Task 2", "D2", "high");

    const tasks = getTasks("worker", "assigned", "all", 20);
    expect(tasks.length).toBe(2);
  });

  it("returns tasks posted by agent", () => {
    registerAgent("boss", "role", []);
    registerAgent("w1", "role", []);
    registerAgent("w2", "role", []);
    postTask("boss", "w1", "Task 1", "D1", "normal");
    postTask("boss", "w2", "Task 2", "D2", "normal");

    const tasks = getTasks("boss", "posted", "all", 20);
    expect(tasks.length).toBe(2);
  });

  it("filters by status", () => {
    registerAgent("boss", "role", []);
    registerAgent("worker", "role", []);
    const t1 = postTask("boss", "worker", "Task 1", "D1", "normal");
    postTask("boss", "worker", "Task 2", "D2", "normal");
    updateTask(t1.id, "worker", "accept");

    const posted = getTasks("worker", "assigned", "posted", 20);
    expect(posted.length).toBe(1);
    const accepted = getTasks("worker", "assigned", "accepted", 20);
    expect(accepted.length).toBe(1);
  });
});

describe("getTask", () => {
  it("returns a task by ID", () => {
    registerAgent("boss", "role", []);
    registerAgent("worker", "role", []);
    const task = postTask("boss", "worker", "Task", "Desc", "normal");
    const found = getTask(task.id);
    expect(found).not.toBeNull();
    expect(found!.title).toBe("Task");
  });

  it("returns null for missing task", () => {
    const found = getTask("nonexistent-id");
    expect(found).toBeNull();
  });
});

// ===========================================================================
// v2.1 Phase 7q — sanctioned mutation helpers
// ===========================================================================

describe("teardownAgent (Phase 7q)", () => {
  it("deletes agents row + agent_capabilities sidecar in one transaction", () => {
    registerAgent("to-teardown", "r", ["spawn", "tasks"]);
    // Pre: row + caps present.
    expect(getAgentAuthData("to-teardown")).not.toBeNull();
    const preCaps = getDb()
      .prepare("SELECT capability FROM agent_capabilities WHERE agent_name = ?")
      .all("to-teardown");
    expect(preCaps.length).toBe(2);

    teardownAgent("to-teardown", "recover");

    expect(getAgentAuthData("to-teardown")).toBeNull();
    const postCaps = getDb()
      .prepare("SELECT capability FROM agent_capabilities WHERE agent_name = ?")
      .all("to-teardown");
    expect(postCaps.length).toBe(0);
  });

  it("idempotent on missing row — no throw, no side effects", () => {
    expect(() => teardownAgent("never-registered", "stale_purge")).not.toThrow();
    expect(getAgentAuthData("never-registered")).toBeNull();
  });

  it("does NOT touch other agents when removing one", () => {
    registerAgent("keep-me", "r", ["tasks"]);
    registerAgent("kill-me", "r", ["spawn"]);
    teardownAgent("kill-me", "recover");
    expect(getAgentAuthData("keep-me")).not.toBeNull();
    const keepCaps = getDb()
      .prepare("SELECT capability FROM agent_capabilities WHERE agent_name = ?")
      .all("keep-me");
    expect(keepCaps.length).toBe(1);
  });
});

describe("applyAuthStateTransition (Phase 7q)", () => {
  it("CAS succeeds when state matches: active → active with token rotation", () => {
    const { plaintext_token } = registerAgent("rotator", "r", []);
    expect(plaintext_token).toBeTruthy();
    // Simulate rotation: keep current hash, clear previous/grace fields.
    const r = applyAuthStateTransition("rotator", "active", "active", {
      previous_token_hash: null,
      rotation_grace_expires_at: null,
    });
    expect(r.changed).toBe(true);
  });

  it("CAS fails when state drift: expectedFromState does not match", () => {
    registerAgent("stable", "r", []);
    // Row is 'active'; ask for 'rotation_grace' → CAS miss, changes=0.
    const r = applyAuthStateTransition("stable", "rotation_grace", "active", {
      previous_token_hash: null,
    });
    expect(r.changed).toBe(false);
    // Row untouched.
    const row = getAgentAuthData("stable");
    expect(row?.auth_state).toBe("active");
  });

  it("CAS with expectedTokenHash: rejects when hash drifted", () => {
    registerAgent("hashcas", "r", []);
    const rowBefore = getAgentAuthData("hashcas");
    const wrongHash = "$2a$10$XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
    expect(rowBefore?.token_hash).not.toBe(wrongHash);

    const r = applyAuthStateTransition(
      "hashcas",
      "active",
      "active",
      { previous_token_hash: null },
      wrongHash  // wrong anchor → CAS miss
    );
    expect(r.changed).toBe(false);
  });
});

describe("updateAgentMetadata (Phase 7q)", () => {
  it("updates last_seen + agent_status in one call", () => {
    registerAgent("meta", "r", []);
    const future = new Date(Date.now() + 60_000).toISOString();
    const r = updateAgentMetadata("meta", {
      last_seen: future,
      agent_status: "busy",
    });
    expect(r).toBe(true);
    const row = getAgentAuthData("meta");
    expect(row?.last_seen).toBe(future);
    expect(row?.agent_status).toBe("busy");
  });

  it("empty-fields call is a safe no-op (no throw, no SQL)", () => {
    registerAgent("emptyfields", "r", []);
    const rowBefore = getAgentAuthData("emptyfields");
    const result = updateAgentMetadata("emptyfields", {});
    // Contract: returns true (no-op is a success, not a failure).
    expect(result).toBe(true);
    const rowAfter = getAgentAuthData("emptyfields");
    // Verify truly untouched — last_seen didn't silently bump.
    expect(rowAfter?.last_seen).toBe(rowBefore?.last_seen);
  });

  it("missing agent returns false (no throw)", () => {
    const result = updateAgentMetadata("ghost", { last_seen: new Date().toISOString() });
    expect(result).toBe(false);
  });
});

describe("v2.1 Phase 7q — design-freeze schema", () => {
  it("mailbox + agent_cursor tables exist (empty, reserved for v2.2 Phase 4s)", () => {
    // Touch the DB at least once so migrations run.
    registerAgent("schema-probe", "r", []);
    const tables = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("mailbox");
    expect(names).toContain("agent_cursor");
    // Both empty in v2.1.0 — no code reads or writes them.
    const mailboxCount = (getDb()
      .prepare("SELECT COUNT(*) AS c FROM mailbox")
      .get() as { c: number }).c;
    const cursorCount = (getDb()
      .prepare("SELECT COUNT(*) AS c FROM agent_cursor")
      .get() as { c: number }).c;
    expect(mailboxCount).toBe(0);
    expect(cursorCount).toBe(0);
  });

  it("agents.visibility column exists with default 'local' + CHECK constraint", () => {
    const { agent } = registerAgent("visibility-probe", "r", []);
    expect(agent.name).toBe("visibility-probe");
    const row = getDb()
      .prepare("SELECT visibility FROM agents WHERE name = ?")
      .get("visibility-probe") as { visibility: string };
    // Default is 'local' — no v2.1.0 code sets this.
    expect(row.visibility).toBe("local");
    // CHECK enforces on direct INSERT attempt (should reject 'invalid').
    expect(() =>
      getDb()
        .prepare(
          "INSERT INTO agents (id, name, role, capabilities, last_seen, created_at, visibility) " +
            "VALUES (?, ?, 'r', '[]', ?, ?, 'invalid')"
        )
        .run(
          "bad-viz-id",
          "bad-viz",
          new Date().toISOString(),
          new Date().toISOString()
        )
    ).toThrow(/CHECK constraint/);
  });
});
