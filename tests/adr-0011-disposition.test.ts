// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0011 — message disposition + read-receipts, TOOL-INTEGRATION contract.
 * Drives the REAL MCP dispatcher (createServer + Client) so the six server.ts
 * registration touch-points for `get_outstanding` AND the `disposition`/`deadline`
 * threading through `send_message` are exercised end-to-end — not just the DB
 * functions (whose contract lives in adr-0011-disposition-db.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-adr0011-tool-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
delete process.env.RELAY_ALLOW_LEGACY;
process.env.RELAY_HTTP_PORT = "54997";

const { closeDb, registerAgent } = await import("../src/db.js");
const { createServer } = await import("../src/server.js");

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
}
beforeEach(() => cleanup());
afterEach(() => cleanup());

async function connectClient() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "adr0011", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return { client, server };
}

function body(res: { content: { text: string }[] }) {
  return JSON.parse(res.content[0].text);
}

describe("ADR-0011 tool integration — get_outstanding + send_message disposition", () => {
  it("get_outstanding is advertised in tools/list (registration wired)", async () => {
    const { client, server } = await connectClient();
    try {
      const { tools } = await client.listTools();
      const t = tools.find((x) => x.name === "get_outstanding");
      expect(t).toBeDefined();
      expect(t!.description.length).toBeGreaterThan(50);
    } finally {
      await server.close();
    }
  });

  it("send_message threads disposition/deadline through the dispatcher; get_outstanding recaps the ask + excludes the log", async () => {
    const alice = registerAgent("alice", "r", []);
    registerAgent("bob", "r", []);
    const { client, server } = await connectClient();
    try {
      // A LOG (FYI) send — must NOT appear in the outstanding recap.
      const log: any = await client.callTool({
        name: "send_message",
        arguments: { from: "alice", to: "bob", message: "fyi only", agent_token: alice.plaintext_token },
      });
      expect(body(log).disposition).toBe("log");

      // An ASK — must appear, state 'unread', not overdue (within the 24h default).
      const ask: any = await client.callTool({
        name: "send_message",
        arguments: { from: "alice", to: "bob", message: "please reply", disposition: "ask", agent_token: alice.plaintext_token },
      });
      expect(body(ask).disposition).toBe("ask");

      const out: any = await client.callTool({
        name: "get_outstanding",
        arguments: { agent_name: "alice", agent_token: alice.plaintext_token },
      });
      const rec = body(out);
      expect(rec.success).toBe(true);
      expect(rec.count).toBe(1); // the ask only — the log is excluded
      expect(rec.outstanding[0].disposition).toBe("ask");
      expect(rec.outstanding[0].state).toBe("unread");
      expect(rec.outstanding[0].overdue).toBe(false);
      expect(rec.overdue_count).toBe(0);
      expect(rec.overdue_bound_seconds).toBe(86_400);
    } finally {
      await server.close();
    }
  });

  it("an obligation past its deadline is reported overdue through the tool", async () => {
    const alice = registerAgent("alice", "r", []);
    registerAgent("bob", "r", []);
    const { client, server } = await connectClient();
    try {
      await client.callTool({
        name: "send_message",
        arguments: {
          from: "alice",
          to: "bob",
          message: "ship the release",
          disposition: "obligation",
          deadline: "2000-01-01T00:00:00.000Z", // long past
          agent_token: alice.plaintext_token,
        },
      });
      const out: any = await client.callTool({
        name: "get_outstanding",
        arguments: { agent_name: "alice", agent_token: alice.plaintext_token },
      });
      const rec = body(out);
      expect(rec.count).toBe(1);
      expect(rec.outstanding[0].disposition).toBe("obligation");
      expect(rec.outstanding[0].overdue).toBe(true);
      expect(rec.overdue_count).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("include_resolved surfaces resolved rows; default excludes them", async () => {
    const alice = registerAgent("alice", "r", []);
    const bob = registerAgent("bob", "r", []);
    const { client, server } = await connectClient();
    try {
      const ask: any = await client.callTool({
        name: "send_message",
        arguments: { from: "alice", to: "bob", message: "q", disposition: "ask", agent_token: alice.plaintext_token },
      });
      const askId = body(ask).message_id;
      // bob resolves it.
      await client.callTool({
        name: "resolve_messages",
        arguments: { agent_name: "bob", message_ids: [askId], agent_token: bob.plaintext_token },
      });
      // Default recap: empty (resolved excluded).
      const def: any = await client.callTool({
        name: "get_outstanding",
        arguments: { agent_name: "alice", agent_token: alice.plaintext_token },
      });
      expect(body(def).count).toBe(0);
      // Full C-view: shows it as resolved.
      const full: any = await client.callTool({
        name: "get_outstanding",
        arguments: { agent_name: "alice", include_resolved: true, agent_token: alice.plaintext_token },
      });
      const rec = body(full);
      expect(rec.count).toBe(1);
      expect(rec.outstanding[0].state).toBe("resolved");
    } finally {
      await server.close();
    }
  });

  it("get_outstanding is SENDER-scoped: B's token cannot query as A (token↔agent_name binding)", async () => {
    registerAgent("alice", "r", []);
    const bob = registerAgent("bob", "r", []);
    const { client, server } = await connectClient();
    try {
      const res: any = await client.callTool({
        name: "get_outstanding",
        arguments: { agent_name: "alice", agent_token: bob.plaintext_token }, // B claims to be A
      });
      expect(res.isError).toBe(true);
      const b = body(res);
      expect(b.success).toBe(false);
      expect(b.error_code).toBe("AUTH_FAILED");
    } finally {
      await server.close();
    }
  });
});
