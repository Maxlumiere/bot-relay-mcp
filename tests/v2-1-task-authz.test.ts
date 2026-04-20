// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 4k — task subsystem authorization fixes.
 *
 * F-3a.1 (post_task_auto self-assignment):
 *   - sender is excluded from candidates by default
 *   - allow_self_assign=true opts in
 *   - when only the sender has the required cap, task queues (does not self-assign)
 *   - queued-task reassignment on register still works (non-regression)
 *
 * F-3a.2 (get_task info disclosure):
 *   - from_agent can read the task
 *   - to_agent can read the task
 *   - third-party authenticated agent cannot read (auth_error, no content leak)
 *   - legacy-grace is NOT a get_task bypass — party membership still required
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import type { Server as HttpServer } from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-task-authz-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
// v2.1.3 I8: scrub inherited RELAY_AGENT_* env vars so isolated tests
// do not auth against a parent-shell spawn-agent.sh token.
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
delete process.env.RELAY_ALLOW_LEGACY;
delete process.env.RELAY_HTTP_SECRET;

const { startHttpServer } = await import("../src/transport/http.js");
const { closeDb } = await import("../src/db.js");

let server: HttpServer;
let baseUrl: string;

async function mcpCall(tool: string, args: any): Promise<any> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  const rpc = dataLine ? JSON.parse(dataLine.slice(5).trim()) : JSON.parse(text);
  const inner = JSON.parse(rpc.result.content[0].text);
  return inner;
}

async function register(name: string, caps: string[] = []): Promise<string> {
  const r = await mcpCall("register_agent", { name, role: "r", capabilities: caps });
  return r.agent_token;
}

beforeAll(async () => {
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  server = startHttpServer(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 100));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

// Each test cleans + reseeds the agent table so candidate pools are predictable.
beforeEach(async () => {
  const { getDb } = await import("../src/db.js");
  const db = getDb();
  db.prepare("DELETE FROM tasks").run();
  db.prepare("DELETE FROM agent_capabilities").run();
  db.prepare("DELETE FROM agents").run();
});

describe("v2.1 Phase 4k F-3a.1 — post_task_auto sender exclusion", () => {
  it("(1) sender + peer both have cap → routes to peer (sender excluded by default)", async () => {
    // Sender needs "tasks" (to call post_task_auto) + "work" (to match required_capabilities).
    // Peer just needs "work" to match.
    const aTok = await register("auto-a", ["tasks", "work"]);
    await register("auto-b", ["work"]);

    const r = await mcpCall("post_task_auto", {
      from: "auto-a",
      title: "t",
      description: "d",
      required_capabilities: ["work"],
      agent_token: aTok,
    });
    expect(r.success).toBe(true);
    expect(r.routed).toBe(true);
    expect(r.assigned_to).toBe("auto-b");
    expect(r.candidate_count).toBe(1);
  });

  it("(2) only sender has cap → task queues (does NOT self-assign)", async () => {
    const aTok = await register("auto-solo", ["tasks", "work"]);
    // No peer. Default behavior: candidate set is empty after excluding sender.

    const r = await mcpCall("post_task_auto", {
      from: "auto-solo",
      title: "t",
      description: "d",
      required_capabilities: ["work"],
      agent_token: aTok,
    });
    expect(r.success).toBe(true);
    expect(r.routed).toBe(false);
    expect(r.assigned_to).toBeNull();
    expect(r.status).toBe("queued");
    expect(r.candidate_count).toBe(0);
  });

  it("(3) allow_self_assign=true lets sender self-assign (opt-in honored)", async () => {
    const aTok = await register("auto-self", ["tasks", "work"]);

    const r = await mcpCall("post_task_auto", {
      from: "auto-self",
      title: "t",
      description: "d",
      required_capabilities: ["work"],
      allow_self_assign: true,
      agent_token: aTok,
    });
    expect(r.success).toBe(true);
    expect(r.routed).toBe(true);
    expect(r.assigned_to).toBe("auto-self");
  });

  it("(4) queued task auto-assigns on a later capable register (sender-exclusion scoped to post_task_auto)", async () => {
    const aTok = await register("q-sender", ["tasks", "work"]);

    // Sender-only → queue.
    const queued = await mcpCall("post_task_auto", {
      from: "q-sender",
      title: "t",
      description: "d",
      required_capabilities: ["work"],
      agent_token: aTok,
    });
    expect(queued.routed).toBe(false);

    // Later, a peer registers with the cap — the queue-reassignment code path
    // (tryAssignQueuedTasksTo, distinct from postTaskAuto) should pick it up.
    await register("q-peer", ["work"]);

    const { getTask } = await import("../src/db.js");
    const row = getTask(queued.task_id);
    expect(row).toBeTruthy();
    expect(row?.status).toBe("posted");
    expect(row?.to_agent).toBe("q-peer");
  });
});

describe("v2.1 Phase 4k F-3a.2 — get_task party-membership authz", () => {
  it("(5) from_agent can read the task — full content visible", async () => {
    const fromTok = await register("task-from", ["tasks"]);
    const toTok = await register("task-to", []);

    const posted = await mcpCall("post_task", {
      from: "task-from",
      to: "task-to",
      title: "t",
      description: "secret description",
      agent_token: fromTok,
    });
    expect(posted.success).toBe(true);

    const read = await mcpCall("get_task", {
      task_id: posted.task_id,
      agent_token: fromTok,
    });
    expect(read.success).toBe(true);
    expect(read.auth_error).not.toBe(true);
    expect(read.task.description).toBe("secret description");
    void toTok; // registered purely so the task has a valid to_agent
  });

  it("(6) to_agent can read the task — full content visible", async () => {
    const fromTok = await register("task-from-2", ["tasks"]);
    const toTok = await register("task-to-2", []);

    const posted = await mcpCall("post_task", {
      from: "task-from-2",
      to: "task-to-2",
      title: "t",
      description: "another secret",
      agent_token: fromTok,
    });
    expect(posted.success).toBe(true);

    const read = await mcpCall("get_task", {
      task_id: posted.task_id,
      agent_token: toTok,
    });
    expect(read.success).toBe(true);
    expect(read.task.description).toBe("another secret");
  });

  it("(7) uninvolved third-party agent is rejected with auth_error — no content leak", async () => {
    const fromTok = await register("task-from-3", ["tasks"]);
    await register("task-to-3", []);
    const thirdTok = await register("task-eavesdropper", []);

    const posted = await mcpCall("post_task", {
      from: "task-from-3",
      to: "task-to-3",
      title: "t",
      description: "eyes only for the parties",
      agent_token: fromTok,
    });
    expect(posted.success).toBe(true);

    const read = await mcpCall("get_task", {
      task_id: posted.task_id,
      agent_token: thirdTok,
    });
    expect(read.success).toBe(false);
    expect(read.auth_error).toBe(true);
    expect(read.task).toBeUndefined();
    expect(JSON.stringify(read)).not.toContain("eyes only for the parties");
  });

  it("(8) RELAY_ALLOW_LEGACY=1 is NOT a get_task bypass — third-party still rejected", async () => {
    const fromTok = await register("legacy-from", ["tasks"]);
    await register("legacy-to", []);
    const thirdTok = await register("legacy-eaves", []);

    const posted = await mcpCall("post_task", {
      from: "legacy-from",
      to: "legacy-to",
      title: "t",
      description: "party-only",
      agent_token: fromTok,
    });
    expect(posted.success).toBe(true);

    process.env.RELAY_ALLOW_LEGACY = "1";
    try {
      const read = await mcpCall("get_task", {
        task_id: posted.task_id,
        agent_token: thirdTok,
      });
      expect(read.success).toBe(false);
      expect(read.auth_error).toBe(true);
      expect(JSON.stringify(read)).not.toContain("party-only");
    } finally {
      delete process.env.RELAY_ALLOW_LEGACY;
    }
  });
});
