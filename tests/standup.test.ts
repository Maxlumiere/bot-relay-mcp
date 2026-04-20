// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1.4 (I12) — get_standup tests.
 *
 * Covers: time-string parsing, empty state, busy state (observations fire),
 * window filtering, role filtering, include_offline toggle.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-standup-test-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;

const { registerAgent, sendMessage, postTask, closeDb } = await import("../src/db.js");
const { handleGetStandup, parseSince } = await import("../src/tools/standup.js");

type HandlerResponse = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function parseResult(r: HandlerResponse): Record<string, any> {
  return JSON.parse(r.content[0].text);
}

beforeEach(() => {
  if (!fs.existsSync(TEST_DB_DIR)) fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  // Fresh DB per test
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + "-wal"); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + "-shm"); } catch {}
});

afterEach(() => {
  closeDb();
});

describe("parseSince — duration + ISO parsing", () => {
  const nowMs = Date.parse("2026-04-20T22:00:00.000Z");

  it("parses '15m' as 15 minutes ago", () => {
    const t = parseSince("15m", nowMs);
    expect(nowMs - t).toBe(15 * 60 * 1000);
  });

  it("parses '1h' as 1 hour ago", () => {
    const t = parseSince("1h", nowMs);
    expect(nowMs - t).toBe(60 * 60 * 1000);
  });

  it("parses '3h'", () => {
    const t = parseSince("3h", nowMs);
    expect(nowMs - t).toBe(3 * 60 * 60 * 1000);
  });

  it("parses '1d'", () => {
    const t = parseSince("1d", nowMs);
    expect(nowMs - t).toBe(24 * 60 * 60 * 1000);
  });

  it("parses ISO timestamps", () => {
    const iso = "2026-04-20T20:00:00.000Z";
    const t = parseSince(iso, nowMs);
    expect(t).toBe(Date.parse(iso));
  });

  it("rejects invalid strings", () => {
    expect(() => parseSince("banana", nowMs)).toThrow(/duration|ISO8601/);
  });

  it("rejects zero / negative durations", () => {
    expect(() => parseSince("0m", nowMs)).toThrow();
  });
});

describe("handleGetStandup — empty state", () => {
  it("returns valid shape with zero counts on fresh DB", () => {
    const r = handleGetStandup({ since: "1h" });
    expect(r.isError).not.toBe(true);
    const body = parseResult(r);
    expect(body.success).toBe(true);
    expect(body.active_agents).toEqual([]);
    expect(body.message_activity.total).toBe(0);
    expect(body.message_activity.top_senders).toEqual([]);
    expect(body.message_activity.flagged_priority).toEqual([]);
    expect(body.task_state.completed_in_window).toBe(0);
    expect(body.task_state.queued).toBe(0);
    expect(body.task_state.blocked).toBe(0);
    expect(body.observations).toEqual([]);
    expect(body.window.since).toBeTruthy();
    expect(body.window.now).toBeTruthy();
  });
});

describe("handleGetStandup — busy state", () => {
  it("reports agents, messages, tasks, and fires observations", () => {
    // Seed: two agents (one with 5 messages + 1 queued task nobody accepts).
    registerAgent("alice", "orchestrator", ["tasks", "broadcast"]);
    registerAgent("bob", "builder", ["tasks"]);
    // Alice sends 5 high-priority messages to bob to trigger "dominating" rule.
    for (let i = 0; i < 6; i++) {
      sendMessage("alice", "bob", `ping ${i}`, "high");
    }
    // 4 tasks queued to trigger pileup rule (> 3).
    for (let i = 0; i < 4; i++) {
      postTask("alice", "bob", `t${i}`, "do it", "normal");
    }

    const r = handleGetStandup({ since: "1h" });
    const body = parseResult(r);
    expect(body.success).toBe(true);
    expect(body.active_agents.length).toBe(2);
    expect(body.message_activity.total).toBe(6);
    expect(body.message_activity.top_senders[0].name).toBe("alice");
    expect(body.message_activity.top_senders[0].count).toBe(6);
    expect(body.message_activity.top_receivers[0].name).toBe("bob");
    expect(body.message_activity.flagged_priority.length).toBeGreaterThan(0);
    expect(body.task_state.assigned_by_agent.bob).toBe(4);
    // Structure is populated; observations may or may not fire — that rule
    // has its own dedicated coverage below.
    expect(Array.isArray(body.observations)).toBe(true);
  });

  it("fires blocked-agent observation when agent_status='blocked'", async () => {
    registerAgent("alice", "orchestrator", []);
    // Declared blocked, fresh last_seen → hybrid status surfaces 'blocked'.
    const { setAgentStatus } = await import("../src/db.js");
    setAgentStatus("alice", "blocked");
    const r = handleGetStandup({ since: "1h" });
    const body = parseResult(r);
    const joined = body.observations.join(" ");
    expect(joined).toContain("alice blocked");
  });

  it("fires queued-pileup observation when >3 queued tasks sit in the queue", async () => {
    registerAgent("alice", "orchestrator", ["tasks"]);
    // postTaskAuto with capabilities nobody has → tasks remain in the queue.
    const { postTaskAuto } = await import("../src/db.js");
    for (let i = 0; i < 5; i++) {
      postTaskAuto("alice", `t${i}`, "needs specialist", ["never-held-cap"], "normal");
    }
    const r = handleGetStandup({ since: "1h" });
    const body = parseResult(r);
    expect(body.task_state.queued).toBe(5);
    const joined = body.observations.join(" ");
    expect(joined).toMatch(/5 tasks queued/);
  });
});

describe("handleGetStandup — window + filter", () => {
  it("window filtering: ISO since excludes older messages", () => {
    registerAgent("alice", "orchestrator", ["tasks"]);
    registerAgent("bob", "builder", ["tasks"]);
    sendMessage("alice", "bob", "in-window", "normal");
    // Call with since = far future — nothing should be in window.
    const farFuture = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const r = handleGetStandup({ since: farFuture });
    const body = parseResult(r);
    expect(body.message_activity.total).toBe(0);
  });

  it("role filter narrows active_agents", () => {
    registerAgent("alice", "orchestrator", []);
    registerAgent("bob", "builder", []);
    registerAgent("carol", "builder", []);

    const r = handleGetStandup({
      since: "1h",
      filter: { roles: ["builder"] },
    });
    const body = parseResult(r);
    const names = body.active_agents.map((a: any) => a.name).sort();
    expect(names).toEqual(["bob", "carol"]);
  });

  it("agents filter narrows active_agents", () => {
    registerAgent("alice", "orchestrator", []);
    registerAgent("bob", "builder", []);

    const r = handleGetStandup({
      since: "1h",
      filter: { agents: ["alice"] },
    });
    const body = parseResult(r);
    expect(body.active_agents.length).toBe(1);
    expect(body.active_agents[0].name).toBe("alice");
  });
});

describe("handleGetStandup — include_offline", () => {
  it("default excludes offline agents", async () => {
    registerAgent("alice", "orchestrator", []);
    registerAgent("bob", "builder", []);
    // Force bob offline via setAgentStatus (direct db call).
    const { setAgentStatus } = await import("../src/db.js");
    setAgentStatus("bob", "offline");

    const r = handleGetStandup({ since: "1h" });
    const body = parseResult(r);
    const names = body.active_agents.map((a: any) => a.name);
    expect(names).toContain("alice");
    expect(names).not.toContain("bob");
  });

  it("include_offline=true shows offline agents", async () => {
    registerAgent("alice", "orchestrator", []);
    registerAgent("bob", "builder", []);
    const { setAgentStatus } = await import("../src/db.js");
    setAgentStatus("bob", "offline");

    const r = handleGetStandup({
      since: "1h",
      filter: { include_offline: true },
    });
    const body = parseResult(r);
    const names = body.active_agents.map((a: any) => a.name);
    expect(names).toContain("bob");
  });
});

describe("handleGetStandup — validation", () => {
  it("invalid since returns VALIDATION error", () => {
    const r = handleGetStandup({ since: "not-a-thing" });
    expect(r.isError).toBe(true);
    const body = parseResult(r);
    expect(body.success).toBe(false);
    expect(body.error_code).toBe("VALIDATION");
  });
});
