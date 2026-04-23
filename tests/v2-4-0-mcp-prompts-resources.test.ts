// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.4.0 Part F — MCP prompts/resources split.
 *
 * F.1.1  listPrompts returns 3 prompts with argument schemas.
 * F.1.2  getPrompt(recover-lost-token) substitutes the agent_name
 *        parameter into the rendered text.
 * F.1.3  getPrompt with missing required arg throws a clear error.
 * F.1.4  getPrompt with unknown name throws.
 * F.2.1  listResources returns 3 resources with stable URIs.
 * F.2.2  readResource(relay://current-state) returns agents/tasks/
 *        pending-count JSON.
 * F.2.3  readResource with unknown URI throws.
 * F.2.4  Server advertises prompts + resources in capabilities.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v240-prompts-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_HTTP_SECRET;

const { listPrompts, getPrompt, ALL_PROMPTS } = await import("../src/mcp-prompts.js");
const { listResources, readResource, RESOURCE_DESCRIPTORS } =
  await import("../src/mcp-resources.js");
const { closeDb, registerAgent, sendMessage } = await import("../src/db.js");
const { createServer } = await import("../src/server.js");

beforeEach(() => {
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
});
afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

describe("v2.4.0 F.1 — MCP prompts", () => {
  it("(F.1.1) listPrompts returns the 3 shipped prompts with argument schemas", () => {
    const list = listPrompts();
    expect(list.length).toBe(3);
    const names = list.map((p) => p.name).sort();
    expect(names).toEqual(["invite-worker", "recover-lost-token", "rotate-compromised-agent"]);
    for (const p of list) {
      expect(typeof p.description).toBe("string");
      expect(p.description.length).toBeGreaterThan(10);
      expect(Array.isArray(p.arguments)).toBe(true);
    }
  });

  it("(F.1.2) getPrompt(recover-lost-token, {agent_name}) substitutes the arg into rendered text", () => {
    const result = getPrompt("recover-lost-token", { agent_name: "alice" });
    expect(result.messages.length).toBe(1);
    expect(result.messages[0].role).toBe("user");
    const text = result.messages[0].content.text;
    expect(text).toContain("alice");
    expect(text).toContain("relay recover alice");
    // Should NOT contain the placeholder — render must substitute.
    expect(text).not.toContain("<agent>");
  });

  it("(F.1.3) getPrompt with missing required arg throws a clear error", () => {
    expect(() => getPrompt("recover-lost-token", {})).toThrow(/agent_name/);
  });

  it("(F.1.4) getPrompt with unknown name throws listing available names", () => {
    expect(() => getPrompt("nonexistent", {})).toThrow(
      /not found.*recover-lost-token.*invite-worker.*rotate-compromised-agent/,
    );
  });

  it("(F.1.5) all prompts render successfully with their required args", () => {
    for (const p of ALL_PROMPTS) {
      const args: Record<string, string> = {};
      for (const a of p.arguments) {
        if (a.required) args[a.name] = a.name + "-value";
      }
      const result = getPrompt(p.name, args);
      expect(result.messages[0].content.text.length).toBeGreaterThan(50);
    }
  });
});

describe("v2.4.0 F.2 — MCP resources", () => {
  it("(F.2.1) listResources returns 3 resources with stable URIs", () => {
    const list = listResources();
    expect(list.length).toBe(3);
    const uris = list.map((r) => r.uri).sort();
    expect(uris).toEqual([
      "relay://agent-graph",
      "relay://current-state",
      "relay://recent-activity",
    ]);
    for (const r of list) {
      expect(r.mimeType).toBe("application/json");
    }
  });

  it("(F.2.2) readResource(relay://current-state) returns agents + tasks + pending JSON", () => {
    registerAgent("alice", "r", []);
    registerAgent("bob", "r", []);
    sendMessage("alice", "bob", "hi", "normal");
    const r = readResource("relay://current-state");
    expect(r.uri).toBe("relay://current-state");
    expect(r.mimeType).toBe("application/json");
    const body = JSON.parse(r.text);
    expect(Array.isArray(body.agents)).toBe(true);
    expect(body.agents.length).toBe(2);
    const bob = body.agents.find((a: any) => a.name === "bob");
    expect(bob.pending_count).toBe(1);
    expect(typeof body.schema_version).toBe("number");
    expect(body.total_pending_messages).toBe(1);
  });

  it("(F.2.3) readResource(relay://agent-graph) returns nodes + edges", () => {
    registerAgent("alice", "r", []);
    registerAgent("bob", "r", []);
    sendMessage("alice", "bob", "hi", "normal");
    sendMessage("alice", "bob", "again", "normal");
    const r = readResource("relay://agent-graph");
    const body = JSON.parse(r.text);
    expect(body.nodes.length).toBe(2);
    const edge = body.message_edges.find(
      (e: any) => e.from === "alice" && e.to === "bob",
    );
    expect(edge.count).toBe(2);
  });

  it("(F.2.4) readResource with unknown URI throws", () => {
    expect(() => readResource("relay://bogus")).toThrow(/not found/);
  });

  it("(F.2.5) readResource(relay://recent-activity) returns audit entries", () => {
    registerAgent("alice", "r", []);
    // registerAgent writes audit entries via the dispatcher when called
    // through MCP; calling it directly doesn't. So we verify the
    // read-side shape, not a specific audit count.
    const r = readResource("relay://recent-activity");
    const body = JSON.parse(r.text);
    expect(Array.isArray(body.entries)).toBe(true);
    // Each entry (if any) has the expected shape.
    for (const e of body.entries.slice(0, 3)) {
      expect(typeof e.id).toBe("string");
      expect(typeof e.tool).toBe("string");
      expect(typeof e.source).toBe("string");
      expect(typeof e.success).toBe("boolean");
    }
  });
});

describe("v2.4.0 F — server capabilities advertise prompts + resources", () => {
  it("(F.3.1) createServer declares prompts + resources capabilities", () => {
    const server = createServer();
    // Internal API per MCP SDK. The same path tests/http.test.ts uses
    // for tools/list access.
    const handlers = (server as unknown as { _requestHandlers: Map<string, unknown> })
      ._requestHandlers;
    expect(handlers.has("prompts/list")).toBe(true);
    expect(handlers.has("prompts/get")).toBe(true);
    expect(handlers.has("resources/list")).toBe(true);
    expect(handlers.has("resources/read")).toBe(true);
    // Sanity: tools/list still present.
    expect(handlers.has("tools/list")).toBe(true);
    expect(handlers.has("tools/call")).toBe(true);
  });
});
