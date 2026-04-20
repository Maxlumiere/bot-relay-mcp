// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-spawn-test-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;

// Mock child_process.spawn before importing the tool
vi.mock("child_process", () => ({
  spawn: vi.fn(() => ({
    unref: vi.fn(),
  })),
}));

const { handleSpawnAgent } = await import("../src/tools/spawn.js");
const { getMessages, registerAgent, closeDb } = await import("../src/db.js");
const cp = await import("child_process");

function parseResult(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

function cleanup() {
  vi.clearAllMocks();
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) {
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  }
}

beforeEach(() => cleanup());
afterEach(() => cleanup());

describe("spawn_agent tool", () => {
  it("returns success and calls the spawn script", () => {
    const result = parseResult(
      handleSpawnAgent({
        name: "new-worker",
        role: "builder",
        capabilities: ["build", "test"],
      })
    );

    expect(result.success).toBe(true);
    expect(result.name).toBe("new-worker");
    expect(result.role).toBe("builder");
    expect(cp.spawn).toHaveBeenCalledOnce();
  });

  it("passes name, role, caps, cwd to the spawn script", () => {
    handleSpawnAgent({
      name: "agent-x",
      role: "reviewer",
      capabilities: ["review", "security"],
      cwd: "/tmp/project",
    });

    const call = (cp.spawn as any).mock.calls[0];
    const scriptPath = call[0];
    const args = call[1];

    expect(scriptPath).toMatch(/bin\/spawn-agent\.sh$/);
    // v2.1 Phase 4j: first four args are name/role/caps/cwd; a 5th arg is the
    // parent-issued token. Token presence + shape asserted separately.
    expect(args.slice(0, 4)).toEqual(["agent-x", "reviewer", "review,security", "/tmp/project"]);
    expect(args.length).toBe(5);
    expect(args[4]).toMatch(/^[A-Za-z0-9_=.-]{8,128}$/);
  });

  it("queues an initial message when provided", () => {
    // v2.1 Phase 4j: handleSpawnAgent now pre-registers the agent itself. A
    // prior registerAgent in the test would trigger the name_collision guard.
    handleSpawnAgent({
      name: "new-worker",
      role: "builder",
      capabilities: [],
      initial_message: "Welcome! Check bot-relay-mcp/roles/builder.md for your role spec.",
    });

    const msgs = getMessages("new-worker", "pending", 10);
    expect(msgs.length).toBe(1);
    expect(msgs[0].from_agent).toBe("system");
    expect(msgs[0].content).toContain("Welcome!");
  });

  it("does not queue a message when initial_message is omitted", () => {
    handleSpawnAgent({
      name: "new-worker",
      role: "builder",
      capabilities: [],
    });

    const msgs = getMessages("new-worker", "pending", 10);
    expect(msgs.length).toBe(0);
  });

  it("uses HOME as default cwd when not provided", () => {
    handleSpawnAgent({
      name: "homeboy",
      role: "builder",
      capabilities: [],
    });

    const call = (cp.spawn as any).mock.calls[0];
    const args = call[1];
    expect(args[3]).toBe(process.env.HOME || "/");
  });
});
