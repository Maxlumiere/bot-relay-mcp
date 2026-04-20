// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-presence-test-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
// v2.1.3 I8: scrub inherited RELAY_AGENT_* env vars so isolated tests
// do not auth against a parent-shell spawn-agent.sh token.
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;

const {
  registerAgent,
  getAgents,
  getMessages,
  getTasks,
  sendMessage,
  postTask,
  closeDb,
} = await import("../src/db.js");

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) {
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  }
}

function lastSeenOf(name: string): string {
  const agents = getAgents();
  const agent = agents.find((a) => a.name === name);
  if (!agent) throw new Error(`Agent ${name} not found`);
  return agent.last_seen;
}

async function wait(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

beforeEach(() => cleanup());
afterEach(() => cleanup());

describe("presence integrity (v1.3)", () => {
  it("getMessages does NOT bump last_seen", async () => {
    registerAgent("alice", "r", []);
    registerAgent("bob", "r", []);
    sendMessage("alice", "bob", "hi", "normal");

    const before = lastSeenOf("bob");
    await wait(15);
    getMessages("bob", "pending", 20);
    const after = lastSeenOf("bob");

    expect(after).toBe(before);
  });

  it("getTasks does NOT bump last_seen", async () => {
    registerAgent("boss", "r", []);
    registerAgent("worker", "r", []);
    postTask("boss", "worker", "T", "D", "normal");

    const before = lastSeenOf("worker");
    await wait(15);
    getTasks("worker", "assigned", "all", 20);
    const after = lastSeenOf("worker");

    expect(after).toBe(before);
  });

  it("sendMessage DOES bump sender last_seen (real action)", async () => {
    registerAgent("alice", "r", []);
    registerAgent("bob", "r", []);

    const before = lastSeenOf("alice");
    await wait(15);
    sendMessage("alice", "bob", "hi", "normal");
    const after = lastSeenOf("alice");

    expect(after).not.toBe(before);
  });

  it("postTask DOES bump poster last_seen (real action)", async () => {
    registerAgent("boss", "r", []);
    registerAgent("worker", "r", []);

    const before = lastSeenOf("boss");
    await wait(15);
    postTask("boss", "worker", "T", "D", "normal");
    const after = lastSeenOf("boss");

    expect(after).not.toBe(before);
  });
});
