// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-unregister-test-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
process.env.RELAY_ALLOW_PRIVATE_WEBHOOKS = "1";

const { handleRegisterAgent, handleUnregisterAgent, handleDiscoverAgents } = await import(
  "../src/tools/identity.js"
);
const { handleRegisterWebhook } = await import("../src/tools/webhooks.js");
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

function startReceiver(): Promise<{
  url: string;
  received: any[];
  close: () => void;
}> {
  return new Promise((resolve) => {
    const received: any[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ headers: req.headers, body: body ? JSON.parse(body) : null });
        res.statusCode = 200;
        res.end("{}");
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

async function waitFor(receiver: { received: any[] }, n: number, timeoutMs = 2000) {
  const start = Date.now();
  while (receiver.received.length < n && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeEach(() => cleanup());
afterEach(() => cleanup());

describe("unregister_agent (v1.3)", () => {
  it("removes a registered agent", () => {
    handleRegisterAgent({ name: "temp", role: "r", capabilities: [] });
    expect(parseResult(handleDiscoverAgents({})).count).toBe(1);

    const result = parseResult(handleUnregisterAgent({ name: "temp" }));
    expect(result.success).toBe(true);
    expect(result.removed).toBe(true);

    expect(parseResult(handleDiscoverAgents({})).count).toBe(0);
  });

  it("is idempotent for missing agents", () => {
    const result = parseResult(handleUnregisterAgent({ name: "nonexistent" }));
    expect(result.success).toBe(true);
    expect(result.removed).toBe(false);
  });

  it("fires agent.unregistered webhook on removal", async () => {
    const receiver = await startReceiver();
    try {
      handleRegisterAgent({ name: "leaving", role: "r", capabilities: [] });
      await handleRegisterWebhook({ url: receiver.url, event: "agent.unregistered" });

      handleUnregisterAgent({ name: "leaving" });

      await waitFor(receiver, 1);
      expect(receiver.received.length).toBe(1);
      expect(receiver.received[0].body.event).toBe("agent.unregistered");
      expect(receiver.received[0].body.from_agent).toBe("leaving");
      expect(receiver.received[0].body.to_agent).toBe("leaving");
    } finally {
      receiver.close();
    }
  });

  it("does NOT fire webhook if agent was not registered", async () => {
    const receiver = await startReceiver();
    try {
      await handleRegisterWebhook({ url: receiver.url, event: "agent.unregistered" });

      handleUnregisterAgent({ name: "never-existed" });

      // Poll instead of a hardcoded sleep. The webhook should NOT fire, so
      // we check every 20ms up to 500ms that the count stays 0. If it ever
      // becomes non-zero before the deadline, the assertion fails immediately.
      const deadline = Date.now() + 500;
      while (Date.now() < deadline) {
        if (receiver.received.length !== 0) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(receiver.received.length).toBe(0);
    } finally {
      receiver.close();
    }
  });
});
