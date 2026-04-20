// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import type { Server as HttpServer } from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-http-test-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
// v1.7: legacy grace for tests predating the token flow
process.env.RELAY_ALLOW_LEGACY = "1";
// v2.1.3 I8: scrub parent-shell RELAY_AGENT_* env vars. Otherwise the
// spawn-agent.sh parent exports RELAY_AGENT_TOKEN for victra-build (or
// whatever agent is running the test) and the server's token resolver
// picks it up when test calls omit agent_token. That token won't exist
// in this fresh isolated DB → auth rejection → tests get garbage envelopes.
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;

const { startHttpServer } = await import("../src/transport/http.js");
const { closeDb } = await import("../src/db.js");

let server: HttpServer;
let baseUrl: string;

beforeAll(async () => {
  server = startHttpServer(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 100));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) {
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  }
});

/**
 * Helper: POST a JSON-RPC request to /mcp and parse the SSE response.
 * StreamableHTTP returns Server-Sent Events formatted as "event: message\ndata: <json>\n\n"
 */
async function mcpCall(method: string, params: any, id = 1): Promise<any> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });

  const text = await res.text();
  // Parse SSE format: find the data: line
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  if (!dataLine) {
    // Maybe direct JSON response
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Unexpected response: ${text}`);
    }
  }
  return JSON.parse(dataLine.slice(5).trim());
}

describe("HTTP transport", () => {
  it("health check responds", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.transport).toBe("http");
  });

  it("tools/list returns all 27 tools (25 from v2.1.3 + get_standup + expand_capabilities [v2.1.4])", async () => {
    const result = await mcpCall("tools/list", {});
    expect(result.result.tools.length).toBe(27);
    const names = result.result.tools.map((t: any) => t.name);
    expect(names).toContain("register_agent");
    expect(names).toContain("unregister_agent");
    expect(names).toContain("spawn_agent");
    expect(names).toContain("register_webhook");
    expect(names).toContain("list_webhooks");
    expect(names).toContain("delete_webhook");
    expect(names).toContain("post_task_auto");
    expect(names).toContain("set_status");
    expect(names).toContain("health_check");
    // v2.1.4 additions
    expect(names).toContain("get_standup");
    expect(names).toContain("expand_capabilities");
  });

  it("registers and discovers an agent via HTTP", async () => {
    const register = await mcpCall("tools/call", {
      name: "register_agent",
      arguments: { name: "http-agent", role: "tester", capabilities: ["http"] },
    });
    const registerData = JSON.parse(register.result.content[0].text);
    expect(registerData.success).toBe(true);
    expect(registerData.agent.name).toBe("http-agent");

    const discover = await mcpCall("tools/call", {
      name: "discover_agents",
      arguments: {},
    });
    const discoverData = JSON.parse(discover.result.content[0].text);
    expect(discoverData.count).toBeGreaterThanOrEqual(1);
    expect(discoverData.agents.some((a: any) => a.name === "http-agent")).toBe(true);
  });

  it("GET /mcp returns 405", async () => {
    const res = await fetch(`${baseUrl}/mcp`);
    expect(res.status).toBe(405);
  });

  it("GET / serves the dashboard HTML", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("bot-relay dashboard");
  });

  it("GET /api/snapshot returns relay state as JSON", async () => {
    const res = await fetch(`${baseUrl}/api/snapshot`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty("agents");
    expect(data).toHaveProperty("messages");
    expect(data).toHaveProperty("active_tasks");
    expect(data).toHaveProperty("webhooks");
    expect(data).toHaveProperty("timestamp");
    expect(Array.isArray(data.agents)).toBe(true);
  });
});
