// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Audit HIGH #2 — post_task_auto must route ONLY to a live agent, and a task
 * posted to an agent whose session drops before it accepts must be requeued
 * LOUDLY, not black-holed.
 *
 * ADR-0015 test rule: attempt the HARM through the real shipped functions
 * (assert refused) AND its INNOCENT TWIN (assert the legitimate path still
 * works). "Alive" here is the authorization-grade session column (session_id),
 * NOT the argv/PID presence verdict — see postTaskAuto's predicate comment.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-high2-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;

const { registerAgent, postTaskAuto, runHealthMonitorTick, getTask, getDb, closeDb } = await import(
  "../src/db.js"
);

/** Simulate a closed terminal: the session lifecycle nulls session_id and sets
 *  a terminal status on every close/offline/signal path. */
function dropSession(name: string): void {
  getDb().prepare("UPDATE agents SET session_id = NULL, agent_status = 'closed' WHERE name = ?").run(name);
}

/** Age a task's updated_at past any orphan grace, deterministically (no sleeps). */
function ageTask(id: string): void {
  getDb().prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", id);
}

function cleanup(): void {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  delete process.env.RELAY_POSTED_ORPHAN_GRACE_SECONDS;
  delete process.env.RELAY_HEALTH_DISABLED;
}
beforeEach(cleanup);
afterEach(cleanup);

describe("audit HIGH #2 — post_task_auto routes only to a live-session agent", () => {
  it("(harm) the only capable agent has a dropped session → task is QUEUED, not posted to the corpse", () => {
    registerAgent("requester", "user", ["tasks"]);
    registerAgent("auditor-1", "auditor", ["audit"]);
    dropSession("auditor-1"); // terminal closed after registering yesterday
    const r = postTaskAuto("requester", "audit the thing", "desc", ["audit"], "normal");
    expect(r.routed).toBe(false); // NOT a false routed=true to a dead agent
    expect(r.assigned_to).toBeNull();
    expect(r.task.status).toBe("queued");
  });

  it("(harm) a dead agent with load 0 must NOT be picked ahead of a live capable agent", () => {
    registerAgent("requester", "user", ["tasks"]);
    registerAgent("dead-owner", "auditor", ["audit"]); // load 0 but session dropped
    dropSession("dead-owner");
    registerAgent("live-owner", "auditor", ["audit"]); // live
    const r = postTaskAuto("requester", "audit y", "desc", ["audit"], "normal");
    expect(r.routed).toBe(true);
    expect(r.assigned_to).toBe("live-owner");
  });

  it("(twin) a live capable agent is routed to normally", () => {
    registerAgent("requester", "user", ["tasks"]);
    registerAgent("live-owner", "auditor", ["audit"]);
    const r = postTaskAuto("requester", "audit z", "desc", ["audit"], "normal");
    expect(r.routed).toBe(true);
    expect(r.assigned_to).toBe("live-owner");
    expect(r.task.status).toBe("posted");
  });
});

describe("audit HIGH #2 — health monitor requeues posted-but-never-accepted orphans (loud)", () => {
  it("(harm) a task posted to an agent whose session then dropped is requeued to the pool", () => {
    process.env.RELAY_POSTED_ORPHAN_GRACE_SECONDS = "1";
    registerAgent("requester", "user", ["tasks"]);
    registerAgent("worker", "builder", ["build"]);
    const r = postTaskAuto("requester", "build", "desc", ["build"], "normal");
    expect(r.routed).toBe(true);
    expect(r.assigned_to).toBe("worker");

    dropSession("worker"); // closed before ever accepting
    ageTask(r.task.id); // past the 1s grace

    const requeued = runHealthMonitorTick("test-tick");
    const mine = requeued.find((x) => x.task_id === r.task.id);
    expect(mine).toBeDefined();
    expect(mine!.reason).toBe("assignee-gone-before-accept"); // distinct, surfaced
    expect(mine!.previous_agent).toBe("worker");

    const t = getTask(r.task.id)!;
    expect(t.status).toBe("queued"); // back in the routable pool, not dead-ended
    expect(t.to_agent).toBeNull();
  });

  it("(twin) a posted task whose agent is still live is NOT requeued", () => {
    registerAgent("requester", "user", ["tasks"]);
    registerAgent("worker", "builder", ["build"]);
    const r = postTaskAuto("requester", "build", "desc", ["build"], "normal");
    ageTask(r.task.id); // old, but the worker still holds its session

    const requeued = runHealthMonitorTick("test-tick");
    expect(requeued.find((x) => x.task_id === r.task.id)).toBeUndefined();
    const t = getTask(r.task.id)!;
    expect(t.status).toBe("posted");
    expect(t.to_agent).toBe("worker");
  });

  it("(twin) a freshly-posted orphan within grace is NOT requeued yet — grace honored", () => {
    process.env.RELAY_POSTED_ORPHAN_GRACE_SECONDS = "3600"; // 1h
    registerAgent("requester", "user", ["tasks"]);
    registerAgent("worker", "builder", ["build"]);
    const r = postTaskAuto("requester", "build", "desc", ["build"], "normal");
    dropSession("worker"); // gone, but the task was just posted (inside grace)

    const requeued = runHealthMonitorTick("test-tick");
    expect(requeued.find((x) => x.task_id === r.task.id)).toBeUndefined();
    expect(getTask(r.task.id)!.status).toBe("posted");
  });
});
