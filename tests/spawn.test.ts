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
// v2.1.3 I8: scrub inherited RELAY_AGENT_* env vars so isolated tests
// do not auth against a parent-shell spawn-agent.sh token.
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;

// Mock child_process.spawn before importing the tool
vi.mock("child_process", () => ({
  spawn: vi.fn(() => ({
    unref: vi.fn(),
  })),
}));

const { handleSpawnAgent } = await import("../src/tools/spawn.js");
const { getMessages, registerAgent, getAgents, closeDb } = await import("../src/db.js");
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

// v2.1 Phase 8 (CI-fix): these tests assert macOS-specific dispatcher behavior
// (shells to bin/spawn-agent.sh). The cross-platform spawn drivers are tested
// platform-agnostically in tests/spawn-drivers.test.ts (53 mock tests covering
// Linux + Windows). On non-darwin CI runners, the Linux driver probes for
// gnome-terminal / konsole / xterm / tmux — none installed on bare Ubuntu —
// and the dispatcher returns success=false before the mocked spawn fires.
// Skip on non-darwin to keep this file as the macOS-integration checkpoint.
describe.skipIf(os.platform() !== "darwin")("spawn_agent tool", () => {
  it("returns success and calls the spawn script", async () => {
    const result = parseResult(
      await handleSpawnAgent({
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

  it("passes name, role, caps, cwd to the spawn script", async () => {
    await handleSpawnAgent({
      name: "agent-x",
      role: "reviewer",
      capabilities: ["review", "security"],
      cwd: "/tmp/project",
    });

    const call = (cp.spawn as any).mock.calls[0];
    const scriptPath = call[0];
    const args = call[1];

    expect(scriptPath).toMatch(/bin\/spawn-agent\.sh$/);
    // v2.6.1: token CLI arg removed. Only name/role/caps/cwd remain (+ brief
    // when supplied). The parent-issued token now flows through the per-
    // instance file vault, not the spawn dispatcher.
    expect(args).toEqual(["agent-x", "reviewer", "review,security", "/tmp/project"]);
  });

  it("queues an initial message when provided", async () => {
    // v2.1 Phase 4j: handleSpawnAgent now pre-registers the agent itself. A
    // prior registerAgent in the test would trigger the name_collision guard.
    await handleSpawnAgent({
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

  it("(v2.14.1) pre-registers the child OFFLINE so its first hook run captures PIDs without a name-collision", async () => {
    await handleSpawnAgent({
      name: "spawned-child",
      role: "builder",
      capabilities: [],
      initial_message: "hello child",
    });

    // The parent-side pre-register RESERVES name+token but leaves the row
    // OFFLINE (session cleared) — so the child's SessionStart hook re-register
    // is not blocked by the name-collision guard and can fill its PIDs.
    const row = getAgents().find((a) => a.name === "spawned-child");
    expect(row).toBeTruthy();
    expect(row!.session_id).toBeNull();
    expect(row!.agent_status).toBe("offline");

    // Mail queued to the offline pre-registered row STILL delivers to the child.
    const msgs = getMessages("spawned-child", "pending", 10);
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toBe("hello child");
  });

  it("does not queue a message when initial_message is omitted", async () => {
    await handleSpawnAgent({
      name: "new-worker",
      role: "builder",
      capabilities: [],
    });

    const msgs = getMessages("new-worker", "pending", 10);
    expect(msgs.length).toBe(0);
  });

  it("uses HOME as default cwd when not provided", async () => {
    await handleSpawnAgent({
      name: "homeboy",
      role: "builder",
      capabilities: [],
    });

    const call = (cp.spawn as any).mock.calls[0];
    const args = call[1];
    expect(args[3]).toBe(process.env.HOME || "/");
  });
});
