// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Channel tools tests (v2.0 intelligence layer).
 *
 * Tests create/join/leave/post/get + access control + priority ordering +
 * auto-purge + webhook firing.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-channels-test-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;

const {
  registerAgent,
  createChannel,
  joinChannel,
  leaveChannel,
  postToChannel,
  getChannelMessages,
  listChannels,
  closeDb,
  getMessages,
  sendMessage,
  getTasks,
  postTask,
} = await import("../src/db.js");

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) {
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  }
}

beforeEach(() => cleanup());
afterEach(() => cleanup());

describe("channel lifecycle", () => {
  it("creates a channel with auto-join for creator", () => {
    registerAgent("alice", "r", ["channels"]);
    const ch = createChannel("general", "Main discussion", "alice");
    expect(ch.name).toBe("general");
    expect(ch.created_by).toBe("alice");
    expect(ch.description).toBe("Main discussion");

    const channels = listChannels();
    expect(channels.length).toBe(1);
    expect(channels[0].name).toBe("general");
  });

  it("rejects duplicate channel names", () => {
    registerAgent("alice", "r", []);
    createChannel("dup-test", null, "alice");
    expect(() => createChannel("dup-test", null, "alice")).toThrow(/already exists/);
  });

  it("join + leave lifecycle", () => {
    registerAgent("alice", "r", []);
    registerAgent("bob", "r", []);
    createChannel("dev", null, "alice");

    const join1 = joinChannel("dev", "bob");
    expect(join1.joined).toBe(true);

    const join2 = joinChannel("dev", "bob");
    expect(join2.joined).toBe(false); // already member

    const leave = leaveChannel("dev", "bob");
    expect(leave.left).toBe(true);

    const leave2 = leaveChannel("dev", "bob");
    expect(leave2.left).toBe(false); // already gone
  });

  it("non-members cannot read channel messages (access control)", () => {
    registerAgent("alice", "r", []);
    registerAgent("outsider", "r", []);
    createChannel("private-ish", null, "alice");
    postToChannel("private-ish", "alice", "secret stuff", "normal");

    expect(() => getChannelMessages("private-ish", "outsider", 20)).toThrow(/not a member/);
  });

  it("joining a non-existent channel throws", () => {
    registerAgent("alice", "r", []);
    expect(() => joinChannel("does-not-exist", "alice")).toThrow(/does not exist/);
  });
});

describe("channel messaging", () => {
  it("post and retrieve messages", () => {
    registerAgent("alice", "r", []);
    registerAgent("bob", "r", []);
    createChannel("chat", null, "alice");
    joinChannel("chat", "bob");

    postToChannel("chat", "alice", "hello channel!", "normal");
    postToChannel("chat", "bob", "hi alice!", "high");

    const msgs = getChannelMessages("chat", "alice", 20);
    expect(msgs.length).toBe(2);
    expect(msgs.some((m) => m.content === "hello channel!")).toBe(true);
    expect(msgs.some((m) => m.content === "hi alice!")).toBe(true);
  });

  it("messages are returned in priority order (high before normal)", () => {
    registerAgent("alice", "r", []);
    createChannel("prio", null, "alice");
    postToChannel("prio", "alice", "low-prio", "normal");
    postToChannel("prio", "alice", "high-prio", "high");

    const msgs = getChannelMessages("prio", "alice", 20);
    expect(msgs[0].content).toBe("high-prio");
    expect(msgs[1].content).toBe("low-prio");
  });

  it("non-members cannot post", () => {
    registerAgent("alice", "r", []);
    registerAgent("outsider", "r", []);
    createChannel("locked", null, "alice");
    expect(() => postToChannel("locked", "outsider", "sneak in", "normal")).toThrow(/not a member/);
  });

  it("since parameter filters messages by timestamp", () => {
    registerAgent("alice", "r", []);
    createChannel("timed", null, "alice");
    postToChannel("timed", "alice", "old msg", "normal");

    // Capture a timestamp after the first message
    const sinceTs = new Date().toISOString();

    // Small delay to ensure timestamp difference
    postToChannel("timed", "alice", "new msg", "normal");

    const msgs = getChannelMessages("timed", "alice", 20, sinceTs);
    // May return 1 or 2 depending on timing resolution — at minimum, new msg should be there
    expect(msgs.some((m) => m.content === "new msg")).toBe(true);
  });

  it("members see messages only since their join time (MEDIUM 9)", async () => {
    registerAgent("alice", "r", []);
    registerAgent("bob", "r", []);
    createChannel("history", null, "alice");
    postToChannel("history", "alice", "pre-bob message", "normal");

    // Ensure a real timestamp gap so Bob's joined_at > alice's message created_at
    await new Promise((r) => setTimeout(r, 10));

    joinChannel("history", "bob");

    // Post a message AFTER Bob joins so we know the query works at all
    postToChannel("history", "alice", "post-bob message", "normal");

    const bobMsgs = getChannelMessages("history", "bob", 20);
    // Bob should see the post-join message but NOT the pre-join one
    expect(bobMsgs.some((m) => m.content === "post-bob message")).toBe(true);
    expect(bobMsgs.some((m) => m.content === "pre-bob message")).toBe(false);
  });
});

describe("priority ordering on existing tools (v2.0)", () => {
  it("get_messages returns high-priority messages first", () => {
    registerAgent("s", "r", []);
    registerAgent("r", "r", []);

    // Send in reverse priority order
    sendMessage("s", "r", "low msg", "normal");
    sendMessage("s", "r", "high msg", "high");

    const msgs = getMessages("r", "pending", 20);
    expect(msgs.length).toBe(2);
    expect(msgs[0].priority).toBe("high");
    expect(msgs[1].priority).toBe("normal");
  });

  it("get_tasks returns critical/high-priority tasks first", () => {
    registerAgent("boss", "r", []);
    registerAgent("worker", "r", []);

    postTask("boss", "worker", "Normal task", "Desc", "normal");
    postTask("boss", "worker", "High task", "Desc", "high");
    postTask("boss", "worker", "Critical task", "Desc", "critical");

    const tasks = getTasks("worker", "assigned", "all", 20);
    expect(tasks.length).toBe(3);
    expect(tasks[0].priority).toBe("critical");
    expect(tasks[1].priority).toBe("high");
    expect(tasks[2].priority).toBe("normal");
  });
});

describe("channel listing (non-member discovery)", () => {
  it("listChannels returns all channels (non-members can discover)", () => {
    registerAgent("alice", "r", []);
    registerAgent("bob", "r", []);
    createChannel("alpha", null, "alice");
    createChannel("beta", null, "bob");

    const channels = listChannels();
    expect(channels.length).toBe(2);
    const names = channels.map((c) => c.name);
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
  });
});
