// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 4i — protocol version negotiation.
 *
 * Verifies PROTOCOL_VERSION is surfaced via both register_agent and
 * health_check responses, matches the authoritative constant, and holds
 * SemVer shape. Regression guard for the "2.x" line so a future accidental
 * downgrade to "1.x" in the constant fails the gate.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-proto-ver-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_ALLOW_LEGACY;

const { handleRegisterAgent } = await import("../src/tools/identity.js");
const { handleHealthCheck } = await import("../src/tools/status.js");
const { PROTOCOL_VERSION } = await import("../src/protocol.js");
const { closeDb } = await import("../src/db.js");
const { requestContext } = await import("../src/request-context.js");

function parseResult(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

function cleanup() {
  closeDb();
  delete process.env.RELAY_AGENT_NAME;
  if (fs.existsSync(TEST_DB_DIR)) {
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  }
}
beforeEach(cleanup);
afterEach(cleanup);

function withStdio<T>(fn: () => T): T {
  return requestContext.run({ transport: "stdio" }, fn);
}

describe("v2.1 Phase 4i — protocol version negotiation", () => {
  it("(1) register_agent response includes protocol_version matching PROTOCOL_VERSION", () => {
    const r = withStdio(() =>
      handleRegisterAgent({ name: "pv-a", role: "r", capabilities: [] })
    );
    const body = parseResult(r);
    expect(body.success).toBe(true);
    expect(body.protocol_version).toBe(PROTOCOL_VERSION);
  });

  it("(2) health_check response includes protocol_version matching PROTOCOL_VERSION", () => {
    const r = handleHealthCheck({});
    const body = parseResult(r);
    expect(body.protocol_version).toBe(PROTOCOL_VERSION);
    // Also confirm the existing `version` field (package version) is still
    // present and separate — they must be distinct.
    expect(body.version).toBeDefined();
  });

  it("(3) PROTOCOL_VERSION matches strict SemVer shape", () => {
    expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("(4) PROTOCOL_VERSION starts with '2.' (v2-line regression guard)", () => {
    expect(PROTOCOL_VERSION.startsWith("2.")).toBe(true);
  });
});
