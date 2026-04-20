// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v213-sender-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
// v2.1.3 I8: scrub parent env.
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;

const {
  registerAgent,
  sendMessage,
  teardownAgent,
  SenderNotRegisteredError,
  closeDb,
} = await import("../src/db.js");
const { handleSendMessage } = await import("../src/tools/messaging.js");
const { ERROR_CODES } = await import("../src/error-codes.js");

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) {
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  }
}

beforeEach(cleanup);
afterEach(cleanup);

// ============================================================================
// v2.1.3 — sendMessage must refuse to insert when the sender row is missing.
//
// Pre-v2.1.3: sendMessage called touchAgent(from) which silently no-op'd on a
// missing row, then INSERTed the message with from_agent=<deleted name>. The
// sender's last_seen never moved and the recipient saw a message from a ghost.
// This masked the post-recover curl-wedge symptom during 2026-04-20's session.
//
// v2.1.3: verify the sender row exists BEFORE INSERT; throw
// SenderNotRegisteredError on miss. handleSendMessage classifies that as
// SENDER_NOT_REGISTERED in the response envelope.
// ============================================================================

describe("v2.1.3 sendMessage — sender existence guard", () => {
  it("throws SenderNotRegisteredError when the sender row was never created", () => {
    registerAgent("recipient", "r", []);
    expect(() => sendMessage("never-existed", "recipient", "hi", "normal")).toThrowError(
      SenderNotRegisteredError
    );
  });

  it("throws SenderNotRegisteredError when the sender row was deleted after registration", () => {
    registerAgent("sender", "r", []);
    registerAgent("recipient", "r", []);
    teardownAgent("sender", "recover");

    expect(() => sendMessage("sender", "recipient", "ghost message", "normal")).toThrowError(
      SenderNotRegisteredError
    );
  });

  it("succeeds for a registered sender (happy path regression)", () => {
    registerAgent("alice", "r", []);
    registerAgent("bob", "r", []);
    const msg = sendMessage("alice", "bob", "hello", "normal");
    expect(msg.id).toBeTruthy();
    expect(msg.from_agent).toBe("alice");
    expect(msg.to_agent).toBe("bob");
  });

  it("`system` sentinel bypasses sender verification (used by spawn initial_message)", () => {
    registerAgent("child", "r", []);
    const msg = sendMessage("system", "child", "welcome", "normal");
    expect(msg.id).toBeTruthy();
    expect(msg.from_agent).toBe("system");
  });
});

describe("v2.1.3 handleSendMessage — classifies SENDER_NOT_REGISTERED", () => {
  it("returns error envelope with error_code=SENDER_NOT_REGISTERED when sender is missing", () => {
    registerAgent("target", "r", []);
    const result = handleSendMessage({
      from: "ghost-sender",
      to: "target",
      content: "attempt from deleted row",
      priority: "normal",
    });
    expect((result as any).isError).toBe(true);
    const body = JSON.parse((result as any).content[0].text);
    expect(body.success).toBe(false);
    expect(body.error_code).toBe(ERROR_CODES.SENDER_NOT_REGISTERED);
    expect(body.error).toMatch(/not a registered agent/i);
  });

  it("returns success envelope for a live sender (regression)", () => {
    registerAgent("live-a", "r", []);
    registerAgent("live-b", "r", []);
    const result = handleSendMessage({
      from: "live-a",
      to: "live-b",
      content: "happy path",
      priority: "normal",
    });
    expect((result as any).isError).toBeUndefined();
    const body = JSON.parse((result as any).content[0].text);
    expect(body.success).toBe(true);
    expect(body.from).toBe("live-a");
    expect(body.to).toBe("live-b");
  });
});
