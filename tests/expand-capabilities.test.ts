// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1.4 (I11) — expand_capabilities tests.
 *
 * Covers: additive success, reduction rejection, no-op rejection, not-found,
 * and agent_capabilities sidecar consistency.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-expandcaps-test-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;

const { registerAgent, expandAgentCapabilities, getAgents, getDb, closeDb } = await import(
  "../src/db.js"
);
const { handleExpandCapabilities } = await import("../src/tools/identity.js");

type HandlerResponse = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function parseResult(r: HandlerResponse): Record<string, any> {
  return JSON.parse(r.content[0].text);
}

beforeEach(() => {
  if (!fs.existsSync(TEST_DB_DIR)) fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + "-wal"); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + "-shm"); } catch {}
});

afterEach(() => {
  closeDb();
});

describe("expandAgentCapabilities — direct helper", () => {
  it("adds a new cap and keeps existing caps", () => {
    registerAgent("alice", "orchestrator", ["tasks"]);
    const result = expandAgentCapabilities("alice", ["tasks", "spawn"]);
    expect(result.added).toEqual(["spawn"]);
    expect(result.current.sort()).toEqual(["spawn", "tasks"]);
  });

  it("throws NOT_FOUND for missing agent", () => {
    expect(() => expandAgentCapabilities("ghost", ["tasks"])).toThrow("NOT_FOUND");
  });

  it("throws REDUCTION_NOT_ALLOWED if an existing cap is missing from the request", () => {
    registerAgent("alice", "orchestrator", ["tasks", "broadcast"]);
    // Request omits 'broadcast' — reduction attempt.
    expect(() => expandAgentCapabilities("alice", ["tasks"])).toThrow("REDUCTION_NOT_ALLOWED");
  });

  it("throws NO_OP_EXPANSION when request is a subset of current caps", () => {
    registerAgent("alice", "orchestrator", ["tasks", "broadcast"]);
    expect(() => expandAgentCapabilities("alice", ["tasks", "broadcast"])).toThrow(
      "NO_OP_EXPANSION"
    );
  });

  it("updates agent_capabilities sidecar atomically", () => {
    registerAgent("alice", "orchestrator", ["tasks"]);
    expandAgentCapabilities("alice", ["tasks", "spawn", "webhooks"]);
    const db = getDb();
    const rows = db
      .prepare("SELECT capability FROM agent_capabilities WHERE agent_name = ? ORDER BY capability")
      .all("alice") as Array<{ capability: string }>;
    expect(rows.map((r) => r.capability)).toEqual(["spawn", "tasks", "webhooks"]);
  });
});

describe("handleExpandCapabilities — handler surface", () => {
  it("returns structured success + added + capabilities array", () => {
    registerAgent("alice", "orchestrator", ["tasks"]);
    const r = handleExpandCapabilities({
      agent_name: "alice",
      new_capabilities: ["tasks", "spawn"],
    });
    expect(r.isError).not.toBe(true);
    const body = parseResult(r);
    expect(body.success).toBe(true);
    expect(body.agent).toBe("alice");
    expect(body.added).toEqual(["spawn"]);
    expect(body.capabilities.sort()).toEqual(["spawn", "tasks"]);
  });

  it("REDUCTION_NOT_ALLOWED maps to structured error", () => {
    registerAgent("alice", "orchestrator", ["tasks", "broadcast"]);
    const r = handleExpandCapabilities({
      agent_name: "alice",
      new_capabilities: ["tasks"],
    });
    expect(r.isError).toBe(true);
    const body = parseResult(r);
    expect(body.success).toBe(false);
    expect(body.error_code).toBe("REDUCTION_NOT_ALLOWED");
  });

  it("NO_OP_EXPANSION maps to structured error", () => {
    registerAgent("alice", "orchestrator", ["tasks"]);
    const r = handleExpandCapabilities({
      agent_name: "alice",
      new_capabilities: ["tasks"],
    });
    expect(r.isError).toBe(true);
    const body = parseResult(r);
    expect(body.error_code).toBe("NO_OP_EXPANSION");
  });

  it("unknown agent → NOT_FOUND", () => {
    const r = handleExpandCapabilities({
      agent_name: "ghost",
      new_capabilities: ["tasks"],
    });
    expect(r.isError).toBe(true);
    const body = parseResult(r);
    expect(body.error_code).toBe("NOT_FOUND");
  });

  it("post-expand: discover_agents reflects the union", () => {
    registerAgent("alice", "orchestrator", ["tasks"]);
    handleExpandCapabilities({
      agent_name: "alice",
      new_capabilities: ["tasks", "spawn"],
    });
    const agents = getAgents();
    const alice = agents.find((a) => a.name === "alice");
    expect(alice?.capabilities.sort()).toEqual(["spawn", "tasks"]);
  });
});
