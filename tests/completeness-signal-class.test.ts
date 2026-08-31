// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

// #completeness-signal (victra, delivery review, 2026-08-31) — the get_messages(pending) subset
// defect (#1a) had live SIBLINGS: every LIMIT-capped list surface returned `count` with no signal
// that more matched. This closes the CLASS via #1a's SAME shared-predicate mechanism: each surface's
// WHERE lives in ONE builder (buildMessageWhere / buildTaskWhere / resolveChannelReadScope) that both
// the capped read and its count derive from, so has_more/total can never count different rows.
// RED-first: each assertion fails on a bare capped list (no has_more/total).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-classfix-" + process.pid);
process.env.RELAY_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;

const { registerAgent, sendMessage, createChannel, joinChannel, postToChannel, postTask, closeDb } =
  await import("../src/db.js");
const { handleGetChannelMessages } = await import("../src/tools/channels.js");
const { handleGetTasks } = await import("../src/tools/tasks.js");
const { handleGetMessagesSummary, handleGetMessages } = await import("../src/tools/messaging.js");

function cleanup(): void {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
}
beforeEach(cleanup);
afterEach(cleanup);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function body(res: any): any {
  return JSON.parse(res.content[0].text);
}

describe("#completeness-signal — LIMIT-capped sibling surfaces cannot look complete", () => {
  it("get_channel_messages: busy channel + limit 1 → has_more=true, total=5", () => {
    registerAgent("alice", "r", []);
    registerAgent("bob", "r", []);
    createChannel("gen", null, "alice");
    joinChannel("gen", "alice");
    joinChannel("gen", "bob");
    for (let i = 0; i < 5; i++) postToChannel("gen", "alice", `msg ${i}`, "normal");
    const r = body(handleGetChannelMessages({ channel_name: "gen", agent_name: "bob", limit: 1 } as never));
    expect(r.count).toBe(1);
    expect(r.has_more).toBe(true);
    expect(r.total).toBe(5);
  });

  it("get_tasks: busy board + limit 1 → has_more=true, total=4", () => {
    registerAgent("poster", "r", []);
    registerAgent("worker", "r", []);
    for (let i = 0; i < 4; i++) postTask("poster", "worker", `t${i}`, "d", "normal");
    const r = body(handleGetTasks({ agent_name: "worker", role: "received", status: "all", limit: 1 } as never));
    expect(r.count).toBe(1);
    expect(r.has_more).toBe(true);
    expect(r.total).toBe(4);
  });

  it("get_messages_summary: >limit pending + limit 1 → has_more=true, total=6", () => {
    registerAgent("s", "r", []);
    registerAgent("recip", "r", []);
    for (let i = 0; i < 6; i++) sendMessage("s", "recip", `m${i}`, "normal");
    const r = body(handleGetMessagesSummary({ agent_name: "recip", status: "pending", limit: 1 } as never));
    expect(r.count).toBe(1);
    expect(r.has_more).toBe(true);
    expect(r.total).toBe(6);
  });

  it("get_messages NON-pending (history) + limit 1 → has_more=true, total=3 (closes #1a's pending-only scope)", () => {
    registerAgent("s", "r", []);
    registerAgent("recip2", "r", []);
    for (let i = 0; i < 3; i++) sendMessage("s", "recip2", `h${i}`, "normal");
    const r = body(handleGetMessages({ agent_name: "recip2", status: "all", limit: 1, since: "all" } as never));
    expect(r.count).toBe(1);
    expect(r.has_more).toBe(true);
    expect(r.total).toBe(3);
  });

  it("CONTROL: under the cap, has_more=false and total==count", () => {
    registerAgent("s", "r", []);
    registerAgent("q", "r", []);
    sendMessage("s", "q", "only", "normal");
    const sum = body(handleGetMessagesSummary({ agent_name: "q", status: "pending", limit: 20 } as never));
    expect(sum.has_more).toBe(false);
    expect(sum.total).toBe(1);
    expect(sum.count).toBe(1);
  });
});
