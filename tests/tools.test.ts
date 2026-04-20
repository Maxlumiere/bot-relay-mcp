// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

// Set test DB path before importing
const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-tools-test-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;

const { handleRegisterAgent, handleDiscoverAgents } = await import("../src/tools/identity.js");
const { handleSendMessage, handleGetMessages, handleBroadcast } = await import("../src/tools/messaging.js");
const { handlePostTask, handleUpdateTask, handleGetTasks, handleGetTask } = await import("../src/tools/tasks.js");
const { closeDb } = await import("../src/db.js");
const { requestContext } = await import("../src/request-context.js");

/**
 * Direct-handler tests for `handleGetTask` bypass the server dispatcher, so
 * the v2.1 Phase 4k authz check (caller must be a party to the task) has no
 * request-context to consult. Wrap the call in a synthesized context to
 * mirror what the dispatcher would set up in production.
 */
function withCaller<T>(callerName: string | undefined, fn: () => T): T {
  return requestContext.run(
    { transport: "stdio" as const, callerName },
    fn
  );
}

function parseResult(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) {
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  }
}

beforeEach(() => cleanup());
afterEach(() => cleanup());

describe("identity tools", () => {
  it("register returns success with agent data", () => {
    const result = handleRegisterAgent({ name: "test", role: "builder", capabilities: ["build"] });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.agent.name).toBe("test");
    expect(data.message).toContain("test");
  });

  it("discover returns registered agents", () => {
    handleRegisterAgent({ name: "a", role: "r1", capabilities: [] });
    handleRegisterAgent({ name: "b", role: "r2", capabilities: [] });
    const result = handleDiscoverAgents({});
    const data = parseResult(result);
    expect(data.count).toBe(2);
  });
});

describe("messaging tools", () => {
  it("send and receive message flow", () => {
    handleRegisterAgent({ name: "sender", role: "r", capabilities: [] });
    handleRegisterAgent({ name: "receiver", role: "r", capabilities: [] });

    const sendResult = handleSendMessage({
      from: "sender",
      to: "receiver",
      content: "hello",
      priority: "normal",
    });
    const sendData = parseResult(sendResult);
    expect(sendData.success).toBe(true);

    const getResult = handleGetMessages({
      agent_name: "receiver",
      status: "pending",
      limit: 20,
    });
    const getData = parseResult(getResult);
    expect(getData.count).toBe(1);
    expect(getData.messages[0].content).toBe("hello");
  });

  it("broadcast sends to all except sender", () => {
    handleRegisterAgent({ name: "broadcaster", role: "r", capabilities: [] });
    handleRegisterAgent({ name: "r1", role: "r", capabilities: [] });
    handleRegisterAgent({ name: "r2", role: "r", capabilities: [] });

    const result = handleBroadcast({
      from: "broadcaster",
      content: "attention everyone",
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.count).toBe(2);
  });
});

describe("task tools", () => {
  it("full task lifecycle: post -> accept -> complete", () => {
    handleRegisterAgent({ name: "boss", role: "r", capabilities: [] });
    handleRegisterAgent({ name: "worker", role: "r", capabilities: [] });

    // Post
    const postResult = handlePostTask({
      from: "boss",
      to: "worker",
      title: "Build feature",
      description: "Build the login page",
      priority: "high",
    });
    const postData = parseResult(postResult);
    expect(postData.success).toBe(true);
    const taskId = postData.task_id;

    // Get tasks
    const tasksResult = handleGetTasks({
      agent_name: "worker",
      role: "assigned",
      status: "posted",
      limit: 20,
    });
    const tasksData = parseResult(tasksResult);
    expect(tasksData.count).toBe(1);

    // Accept
    const acceptResult = handleUpdateTask({
      task_id: taskId,
      agent_name: "worker",
      action: "accept",
    });
    const acceptData = parseResult(acceptResult);
    expect(acceptData.success).toBe(true);
    expect(acceptData.status).toBe("accepted");

    // Complete
    const completeResult = handleUpdateTask({
      task_id: taskId,
      agent_name: "worker",
      action: "complete",
      result: "Login page built with tests",
    });
    const completeData = parseResult(completeResult);
    expect(completeData.success).toBe(true);
    expect(completeData.status).toBe("completed");

    // Verify via get_task (caller must be a party — boss is the from_agent).
    const getResult = withCaller("boss", () => handleGetTask({ task_id: taskId }));
    const getData = parseResult(getResult);
    expect(getData.success).toBe(true);
    expect(getData.task.status).toBe("completed");
    expect(getData.task.result).toBe("Login page built with tests");
  });

  it("get_task returns error for missing task", () => {
    const result = handleGetTask({ task_id: "nonexistent" });
    const data = parseResult(result);
    expect(data.success).toBe(false);
    expect((result as any).isError).toBe(true);
  });

  it("update_task returns error for invalid transition", () => {
    handleRegisterAgent({ name: "boss", role: "r", capabilities: [] });
    handleRegisterAgent({ name: "worker", role: "r", capabilities: [] });

    const postResult = handlePostTask({
      from: "boss",
      to: "worker",
      title: "Task",
      description: "Desc",
      priority: "normal",
    });
    const taskId = parseResult(postResult).task_id;

    // Try to complete without accepting first
    const result = handleUpdateTask({
      task_id: taskId,
      agent_name: "worker",
      action: "complete",
    });
    const data = parseResult(result);
    expect(data.success).toBe(false);
    expect((result as any).isError).toBe(true);
  });
});
