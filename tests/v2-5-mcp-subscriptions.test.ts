// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.5.0 Tether Phase 1 — Part S — MCP resource subscription contract.
 *
 * Real Client ↔ real Server via the SDK's InMemoryTransport. The Client
 * subscribes to relay://inbox/<X>, the Server's handlers fire on a real
 * sendMessage tool call, and the Client's notification handler must
 * actually receive a notifications/resources/updated frame.
 *
 * Per memory/feedback_test_asserts_contract_not_proxy.md: every assertion
 * must answer "if the contract drifted, would this fail?" with yes. So:
 *   - We exercise the SDK's subscribeResource() (not a private setter).
 *   - We assert via setNotificationHandler that a real frame arrives
 *     (not just that subscribe() returned).
 *   - We assert isolation across agents (subscribers for X must NOT see
 *     events for Y) — the failure mode that would slip through a "did
 *     subscribe get called?" proxy test.
 *
 * Q1 — single subscriber receives notification on send_message
 * Q2 — unsubscribe stops further notifications
 * Q3 — multiple subscribers all receive the same event
 * Q4 — subscriber for X is NOT woken by message to Y (isolation)
 * Q5 — readResource returns the current snapshot regardless of subscription
 * Q6 — read-side drain (get_messages pending → read) fires message_read event
 * Q7 — disconnect cleans up: a closed Server is dropped from the registry
 * Q8 — broadcast fans out one notification per recipient subscriber
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

// Pin DB to a tmp file BEFORE importing modules that read getDbPath().
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bot-relay-v250-subs-"));
process.env.RELAY_DB_PATH = path.join(TEST_DIR, "relay.db");
delete process.env.RELAY_INSTANCE_ID;
delete process.env.RELAY_HOME;
process.env.RELAY_TRANSPORT = "stdio";

const {
  initializeDb,
  closeDb,
  registerAgent,
  sendMessage,
  broadcastMessage,
  getMessages,
} = await import("../src/db.js");
const { createServer } = await import("../src/server.js");
const { _resetSubscriptionsForTests, _subscriberCountForTests, inboxUriFor } =
  await import("../src/mcp-subscriptions.js");
const { _resetInboxEventBusForTests } = await import("../src/inbox-events.js");

await initializeDb();

interface TestPair {
  client: Client;
  serverHandle: Awaited<ReturnType<typeof spinUpServer>>;
  notifications: { uri: string }[];
}

async function spinUpServer(): Promise<{
  close: () => Promise<void>;
  serverTransport: InMemoryTransport;
  clientTransport: InMemoryTransport;
}> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);
  return {
    close: async () => {
      await server.close();
    },
    serverTransport,
    clientTransport,
  };
}

async function makePair(): Promise<TestPair> {
  const serverHandle = await spinUpServer();
  const client = new Client(
    { name: "v2.5-sub-test", version: "0.0.0" },
    { capabilities: {} },
  );
  const notifications: { uri: string }[] = [];
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
    notifications.push({ uri: n.params.uri });
  });
  await client.connect(serverHandle.clientTransport);
  return { client, serverHandle, notifications };
}

/**
 * Wait until a predicate becomes true or the timeout elapses. Avoids
 * test flakiness from racing the SDK's notification dispatch (which is
 * async — sendResourceUpdated returns a Promise the writer doesn't await).
 */
async function waitFor<T>(check: () => T | null, timeoutMs = 1000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  const final = check();
  if (final) return final;
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe("v2.5.0 Tether Phase 1 — Part S — MCP resource subscriptions", () => {
  beforeEach(async () => {
    // Clean DB rows (keep schema) so each test starts from a known state
    // without paying schema-recreate cost.
    const { getDb } = await import("../src/db.js");
    const db = getDb();
    db.prepare("DELETE FROM messages").run();
    db.prepare("DELETE FROM agent_capabilities").run();
    db.prepare("DELETE FROM agents").run();
    db.prepare("DELETE FROM mailbox").run();
    _resetSubscriptionsForTests();
    _resetInboxEventBusForTests();
    registerAgent("alice", "test", []);
    registerAgent("bob", "test", []);
    registerAgent("carol", "test", []);
  });

  afterEach(() => {
    _resetSubscriptionsForTests();
    _resetInboxEventBusForTests();
  });

  it("(Q1) a single subscriber receives notifications/resources/updated when a message arrives", async () => {
    const { client, serverHandle, notifications } = await makePair();
    try {
      const uri = inboxUriFor("bob");
      await client.subscribeResource({ uri });
      expect(_subscriberCountForTests(uri)).toBe(1);

      sendMessage("alice", "bob", "hi-bob", "normal");

      const got = await waitFor(() =>
        notifications.find((n) => n.uri === uri) ?? null,
      );
      expect(got.uri).toBe(uri);
    } finally {
      await serverHandle.close();
    }
  });

  it("(Q2) unsubscribe stops further notifications", async () => {
    const { client, serverHandle, notifications } = await makePair();
    try {
      const uri = inboxUriFor("bob");
      await client.subscribeResource({ uri });
      sendMessage("alice", "bob", "first", "normal");
      await waitFor(() => notifications.find((n) => n.uri === uri) ?? null);
      const beforeUnsub = notifications.filter((n) => n.uri === uri).length;

      await client.unsubscribeResource({ uri });
      expect(_subscriberCountForTests(uri)).toBe(0);

      sendMessage("alice", "bob", "second", "normal");
      // No notification should arrive — wait long enough for one to be
      // dispatched if the unsubscribe failed.
      await new Promise((r) => setTimeout(r, 100));
      const afterUnsub = notifications.filter((n) => n.uri === uri).length;
      expect(afterUnsub).toBe(beforeUnsub);
    } finally {
      await serverHandle.close();
    }
  });

  it("(Q3) multiple subscribers each receive the same event", async () => {
    const a = await makePair();
    const b = await makePair();
    try {
      const uri = inboxUriFor("bob");
      await a.client.subscribeResource({ uri });
      await b.client.subscribeResource({ uri });
      expect(_subscriberCountForTests(uri)).toBe(2);

      sendMessage("alice", "bob", "fan-out", "normal");

      await waitFor(() => a.notifications.find((n) => n.uri === uri) ?? null);
      await waitFor(() => b.notifications.find((n) => n.uri === uri) ?? null);
      expect(a.notifications.filter((n) => n.uri === uri).length).toBeGreaterThanOrEqual(1);
      expect(b.notifications.filter((n) => n.uri === uri).length).toBeGreaterThanOrEqual(1);
    } finally {
      await a.serverHandle.close();
      await b.serverHandle.close();
    }
  });

  it("(Q4) a subscriber for inbox X does NOT receive events for inbox Y (isolation)", async () => {
    const { client, serverHandle, notifications } = await makePair();
    try {
      const uriBob = inboxUriFor("bob");
      const uriCarol = inboxUriFor("carol");
      await client.subscribeResource({ uri: uriBob });

      sendMessage("alice", "carol", "for-carol", "normal");
      // Settle delay — long enough for any cross-talk to surface.
      await new Promise((r) => setTimeout(r, 100));

      const carolMatches = notifications.filter((n) => n.uri === uriCarol);
      const bobMatches = notifications.filter((n) => n.uri === uriBob);
      expect(carolMatches.length).toBe(0);
      expect(bobMatches.length).toBe(0);
    } finally {
      await serverHandle.close();
    }
  });

  it("(Q5) reading the inbox resource returns the current snapshot regardless of subscription", async () => {
    const { client, serverHandle } = await makePair();
    try {
      sendMessage("alice", "bob", "first", "normal");
      // ISO timestamps have ms resolution — without a delay the two
      // inserts share a created_at, making ORDER BY non-deterministic.
      // The DB-level last-message ordering is "most recent wins"; the
      // delay is what makes "most recent" well-defined for the test.
      await new Promise((r) => setTimeout(r, 5));
      sendMessage("alice", "bob", "second", "high");

      const result = await client.readResource({ uri: inboxUriFor("bob") });
      const text = result.contents[0].text as string;
      const snapshot = JSON.parse(text);
      expect(snapshot.agent_name).toBe("bob");
      expect(snapshot.agent_known).toBe(true);
      expect(snapshot.pending_count).toBe(2);
      expect(snapshot.total_count).toBe(2);
      expect(snapshot.last_message_from).toBe("alice");
      expect(snapshot.last_message_priority).toBe("high");
      expect(snapshot.last_message_preview).toBe("second");
      expect(snapshot.last_message_truncated).toBe(false);
    } finally {
      await serverHandle.close();
    }
  });

  it("(Q6) draining pending → read fires a message_read event for the recipient", async () => {
    const { client, serverHandle, notifications } = await makePair();
    try {
      const uri = inboxUriFor("bob");
      await client.subscribeResource({ uri });

      sendMessage("alice", "bob", "drain-me", "normal");
      await waitFor(() => notifications.find((n) => n.uri === uri) ?? null);
      const beforeDrain = notifications.filter((n) => n.uri === uri).length;

      // Call db.getMessages directly with peek=false. registerAgent (in
      // beforeEach) seeds a session_id on bob, which getMessages reads
      // before the UPDATE. Hitting the MCP tool path would also work
      // but adds a token-resolution dependency this test doesn't need
      // to exercise — the contract under test is "drain fires the
      // event", which is db-layer.
      const drained = getMessages("bob", "pending", 50, false);
      expect(drained.length).toBe(1);

      await waitFor(
        () => (notifications.filter((n) => n.uri === uri).length > beforeDrain ? true : null),
      );
    } finally {
      await serverHandle.close();
    }
  });

  it("(Q7) closing the server removes its subscriptions from the registry", async () => {
    const { client, serverHandle } = await makePair();
    const uri = inboxUriFor("bob");
    await client.subscribeResource({ uri });
    expect(_subscriberCountForTests(uri)).toBe(1);
    await serverHandle.close();
    // Closing transports + servers wires the onclose handler we patched
    // in src/server.ts → unsubscribeAllForServer should drop the entry.
    await waitFor(() => (_subscriberCountForTests(uri) === 0 ? true : null));
    expect(_subscriberCountForTests(uri)).toBe(0);
  });

  it("(Q8) broadcast fans out one notification per recipient subscriber", async () => {
    const a = await makePair();
    const b = await makePair();
    try {
      const uriBob = inboxUriFor("bob");
      const uriCarol = inboxUriFor("carol");
      await a.client.subscribeResource({ uri: uriBob });
      await b.client.subscribeResource({ uri: uriCarol });

      broadcastMessage("alice", "fleet-wide");

      await waitFor(() => a.notifications.find((n) => n.uri === uriBob) ?? null);
      await waitFor(() => b.notifications.find((n) => n.uri === uriCarol) ?? null);
      // Each subscriber sees its own URI exactly once for this broadcast.
      expect(a.notifications.filter((n) => n.uri === uriBob).length).toBe(1);
      expect(b.notifications.filter((n) => n.uri === uriCarol).length).toBe(1);
      // Cross-talk: a's notifications should not include carol's URI.
      expect(a.notifications.filter((n) => n.uri === uriCarol).length).toBe(0);
      expect(b.notifications.filter((n) => n.uri === uriBob).length).toBe(0);
    } finally {
      await a.serverHandle.close();
      await b.serverHandle.close();
    }
  });
});
