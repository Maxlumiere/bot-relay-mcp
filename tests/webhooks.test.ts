// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import crypto from "crypto";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-webhook-test-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
// v2.1.3 I8: scrub inherited RELAY_AGENT_* env vars so isolated tests
// do not auth against a parent-shell spawn-agent.sh token.
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
// Tests use 127.0.0.1 receivers; opt in to private webhook targets.
process.env.RELAY_ALLOW_PRIVATE_WEBHOOKS = "1";

const { handleRegisterAgent } = await import("../src/tools/identity.js");
const { handleSendMessage, handleBroadcast } = await import("../src/tools/messaging.js");
const { handlePostTask, handleUpdateTask } = await import("../src/tools/tasks.js");
const { handleRegisterWebhook, handleListWebhooks, handleDeleteWebhook } = await import(
  "../src/tools/webhooks.js"
);
const { closeDb } = await import("../src/db.js");

function parseResult(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) {
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  }
}

beforeEach(() => cleanup());
afterEach(() => cleanup());

/**
 * Start a tiny HTTP receiver that records every incoming request.
 * Returns { url, received, close }.
 */
function startReceiver(): Promise<{
  url: string;
  received: Array<{ headers: http.IncomingHttpHeaders; body: any }>;
  close: () => void;
}> {
  return new Promise((resolve) => {
    const received: Array<{ headers: http.IncomingHttpHeaders; body: any }> = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received.push({
          headers: req.headers,
          body: body ? JSON.parse(body) : null,
        });
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/hook`,
        received,
        close: () => server.close(),
      });
    });
  });
}

async function waitForWebhooks(receiver: { received: any[] }, count: number, timeoutMs = 2000) {
  const start = Date.now();
  while (receiver.received.length < count && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("webhook registration", () => {
  it("registers a webhook", async () => {
    const result = await handleRegisterWebhook({
      url: "http://example.com/hook",
      event: "message.sent",
    });
    const data = parseResult(result);
    expect(data.success).toBe(true);
    expect(data.webhook_id).toBeTruthy();
    expect(data.event).toBe("message.sent");
  });

  it("lists registered webhooks", async () => {
    await handleRegisterWebhook({ url: "http://example.com/a-hook", event: "message.sent" });
    await handleRegisterWebhook({ url: "http://example.com/b-hook", event: "task.completed" });

    const result = handleListWebhooks();
    const data = parseResult(result);
    expect(data.count).toBe(2);
  });

  it("deletes a webhook", async () => {
    const reg = parseResult(
      await handleRegisterWebhook({ url: "http://example.com/a-hook", event: "*" })
    );
    const del = parseResult(handleDeleteWebhook({ webhook_id: reg.webhook_id }));
    expect(del.success).toBe(true);

    const list = parseResult(handleListWebhooks());
    expect(list.count).toBe(0);
  });

  it("reports webhooks without exposing secrets", async () => {
    await handleRegisterWebhook({
      url: "http://example.com/a-hook",
      event: "*",
      secret: "dontleakme",
    });
    const list = parseResult(handleListWebhooks());
    expect(list.webhooks[0].has_secret).toBe(true);
    expect(list.webhooks[0]).not.toHaveProperty("secret");
  });
});

describe("webhook firing", () => {
  it("fires on message.sent", async () => {
    const receiver = await startReceiver();
    try {
      handleRegisterAgent({ name: "alice", role: "r", capabilities: [] });
      handleRegisterAgent({ name: "bob", role: "r", capabilities: [] });
      await handleRegisterWebhook({ url: receiver.url, event: "message.sent" });

      handleSendMessage({ from: "alice", to: "bob", content: "hi", priority: "normal" });

      await waitForWebhooks(receiver, 1);
      expect(receiver.received.length).toBe(1);
      expect(receiver.received[0].headers["x-relay-event"]).toBe("message.sent");
      expect(receiver.received[0].body.from_agent).toBe("alice");
      expect(receiver.received[0].body.to_agent).toBe("bob");
      expect(receiver.received[0].body.content).toBe("hi");
    } finally {
      receiver.close();
    }
  });

  it("fires on * event for all events", async () => {
    const receiver = await startReceiver();
    try {
      handleRegisterAgent({ name: "a", role: "r", capabilities: [] });
      handleRegisterAgent({ name: "b", role: "r", capabilities: [] });
      await handleRegisterWebhook({ url: receiver.url, event: "*" });

      handleSendMessage({ from: "a", to: "b", content: "m1", priority: "normal" });
      const postResult = parseResult(
        handlePostTask({
          from: "a",
          to: "b",
          title: "T1",
          description: "D",
          priority: "normal",
        })
      );
      handleUpdateTask({ task_id: postResult.task_id, agent_name: "b", action: "accept" });

      await waitForWebhooks(receiver, 3);
      const events = receiver.received.map((r) => r.body.event);
      expect(events).toContain("message.sent");
      expect(events).toContain("task.posted");
      expect(events).toContain("task.accepted");
    } finally {
      receiver.close();
    }
  });

  it("signs payload with HMAC when secret is set", async () => {
    const receiver = await startReceiver();
    try {
      handleRegisterAgent({ name: "a", role: "r", capabilities: [] });
      handleRegisterAgent({ name: "b", role: "r", capabilities: [] });
      await handleRegisterWebhook({
        url: receiver.url,
        event: "message.sent",
        secret: "testsecret",
      });

      handleSendMessage({ from: "a", to: "b", content: "signed", priority: "normal" });

      await waitForWebhooks(receiver, 1);
      const sig = receiver.received[0].headers["x-relay-signature"] as string;
      expect(sig).toBeTruthy();
      expect(sig.startsWith("sha256=")).toBe(true);

      // Verify signature
      const rawBody = JSON.stringify(receiver.received[0].body);
      const expected = "sha256=" + crypto.createHmac("sha256", "testsecret").update(rawBody).digest("hex");
      expect(sig).toBe(expected);
    } finally {
      receiver.close();
    }
  });

  it("applies agent filter", async () => {
    const receiver = await startReceiver();
    try {
      handleRegisterAgent({ name: "a", role: "r", capabilities: [] });
      handleRegisterAgent({ name: "b", role: "r", capabilities: [] });
      handleRegisterAgent({ name: "c", role: "r", capabilities: [] });
      // Only fire for messages involving "a"
      await handleRegisterWebhook({
        url: receiver.url,
        event: "message.sent",
        filter: "a",
      });

      handleSendMessage({ from: "a", to: "b", content: "1", priority: "normal" });
      handleSendMessage({ from: "b", to: "c", content: "2", priority: "normal" });

      await waitForWebhooks(receiver, 1, 1000);
      expect(receiver.received.length).toBe(1);
      expect(receiver.received[0].body.from_agent).toBe("a");
    } finally {
      receiver.close();
    }
  });

  it("fires task.posted and task.completed", async () => {
    const receiver = await startReceiver();
    try {
      handleRegisterAgent({ name: "boss", role: "r", capabilities: [] });
      handleRegisterAgent({ name: "worker", role: "r", capabilities: [] });
      await handleRegisterWebhook({ url: receiver.url, event: "*" });

      const post = parseResult(
        handlePostTask({
          from: "boss",
          to: "worker",
          title: "T",
          description: "D",
          priority: "high",
        })
      );
      handleUpdateTask({ task_id: post.task_id, agent_name: "worker", action: "accept" });
      handleUpdateTask({
        task_id: post.task_id,
        agent_name: "worker",
        action: "complete",
        result: "Done",
      });

      await waitForWebhooks(receiver, 3);
      const events = receiver.received.map((r) => r.body.event);
      expect(events).toEqual(["task.posted", "task.accepted", "task.completed"]);

      const completed = receiver.received.find((r) => r.body.event === "task.completed");
      expect(completed?.body.task.result).toBe("Done");
    } finally {
      receiver.close();
    }
  });

  it("fires broadcast webhook once per recipient", async () => {
    const receiver = await startReceiver();
    try {
      handleRegisterAgent({ name: "broadcaster", role: "r", capabilities: [] });
      handleRegisterAgent({ name: "r1", role: "r", capabilities: [] });
      handleRegisterAgent({ name: "r2", role: "r", capabilities: [] });
      await handleRegisterWebhook({ url: receiver.url, event: "message.broadcast" });

      handleBroadcast({ from: "broadcaster", content: "hi all" });

      await waitForWebhooks(receiver, 2);
      expect(receiver.received.length).toBe(2);
      const recipients = receiver.received.map((r) => r.body.to_agent).sort();
      expect(recipients).toEqual(["r1", "r2"]);
    } finally {
      receiver.close();
    }
  });

  it("does not block or throw when webhook URL is unreachable", async () => {
    handleRegisterAgent({ name: "a", role: "r", capabilities: [] });
    handleRegisterAgent({ name: "b", role: "r", capabilities: [] });
    await handleRegisterWebhook({
      url: "http://127.0.0.1:1/nonexistent",
      event: "message.sent",
    });

    // Should not throw
    expect(() => {
      handleSendMessage({ from: "a", to: "b", content: "x", priority: "normal" });
    }).not.toThrow();
  });
});
