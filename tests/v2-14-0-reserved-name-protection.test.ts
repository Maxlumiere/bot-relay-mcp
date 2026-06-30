// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.14.0 — reserved-name / impersonation protection (Part 1, the security
 * fast-track of the transient-identity governance).
 *
 * Background: gate 6 (v2.12.0 schemaCallerKeys) already made `from`/actor
 * fields authenticate against the caller's token, so impersonating a
 * token-bearing agent via send_message is already blocked. This gate closes
 * the REGISTER side + three narrow holes:
 *   A. a reserved persona/sentinel name cannot be self-registered via the
 *      auth-free bootstrap path (it must be operator-provisioned).
 *   B. reserved names are exempt from the 30-day dead-agent purge (their
 *      row+token IS their protection).
 *   C. the `system` sentinel is reserved.
 *   D. legacy grace cannot authenticate an actor identity.
 * Adversarial coverage, plus the operator provisioning path (relay mint-token).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v2140-test-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
delete process.env.RELAY_ALLOW_LEGACY;
// Operator-configured persona reservation (private names live ONLY in the
// operator's env, never in the repo — here a generic test name).
process.env.RELAY_RESERVED_NAMES = "test-persona";
process.env.RELAY_HTTP_PORT = "54992";

const {
  closeDb,
  getDb,
  registerAgent,
  mintAgentToken,
  purgeOldRecords,
  getAgents,
} = await import("../src/db.js");
const { createServer } = await import("../src/server.js");
const { isReservedName, getReservedNames, RELAY_SENTINEL_NAMES } = await import("../src/reserved-names.js");

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
  const client = new Client({ name: "v2140", version: "0.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return { client, server };
}
const body = (res: any) => JSON.parse(res.content[0].text);

// --- isReservedName / getReservedNames ---

describe("v2.14.0 — reserved-name set", () => {
  it("hardcodes the relay 'system' sentinel + honors RELAY_RESERVED_NAMES, case-insensitively", () => {
    expect(RELAY_SENTINEL_NAMES).toContain("system");
    expect(isReservedName("system")).toBe(true);
    expect(isReservedName("SYSTEM")).toBe(true); // case-insensitive
    expect(isReservedName("test-persona")).toBe(true); // from env
    expect(isReservedName("Test-Persona")).toBe(true);
    expect(isReservedName("ordinary-agent")).toBe(false);
    expect(isReservedName(null)).toBe(false);
  });
  it("parses RELAY_RESERVED_NAMES via the injected env (comma-separated)", () => {
    const set = getReservedNames({ RELAY_RESERVED_NAMES: "alpha, Beta ,," });
    expect(set.has("system")).toBe(true); // hardcoded always present
    expect(set.has("alpha")).toBe(true);
    expect(set.has("beta")).toBe(true); // trimmed + lowercased
    expect(set.has("")).toBe(false);
  });
});

// --- A + C: bootstrap-register of a reserved name is rejected ---

describe("v2.14.0 — (A/C) reserved names can't be self-registered", () => {
  it("registering the 'system' sentinel is rejected (AUTH_FAILED)", async () => {
    const { client, server } = await connectClient();
    try {
      const res: any = await client.callTool({ name: "register_agent", arguments: { name: "system", role: "x", capabilities: [] } });
      expect(res.isError).toBe(true);
      const b = body(res);
      expect(b.error_code).toBe("AUTH_FAILED");
      expect(b.error).toMatch(/reserved/i);
    } finally {
      await server.close();
    }
  });

  it("registering an env-reserved persona name is rejected", async () => {
    const { client, server } = await connectClient();
    try {
      const res: any = await client.callTool({ name: "register_agent", arguments: { name: "test-persona", role: "x", capabilities: [] } });
      expect(res.isError).toBe(true);
      expect(body(res).error_code).toBe("AUTH_FAILED");
      // The rejected name has NO row — the claim was blocked, not recorded.
      expect(getAgents().some((a) => a.name === "test-persona")).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("an ordinary name still self-registers (zero-config preserved)", async () => {
    const { client, server } = await connectClient();
    try {
      const res: any = await client.callTool({ name: "register_agent", arguments: { name: "ordinary-agent", role: "x", capabilities: [] } });
      expect(res.isError).toBeFalsy();
      expect(body(res).success).toBe(true);
    } finally {
      await server.close();
    }
  });
});

// --- Provisioning path: relay mint-token provisions a reserved name ---

describe("v2.14.0 — operator provisioning (relay mint-token)", () => {
  it("mintAgentToken provisions a reserved name; the holder then ACTS with the minted token", async () => {
    // Operator (filesystem authority) provisions the reserved name directly —
    // bypassing the dispatcher's bootstrap-claim block. This is the sanctioned
    // way a reserved name first gets a row + token.
    const minted = mintAgentToken("test-persona", "researcher", [], { description: null, force: false });
    expect(minted.created).toBe(true);
    expect(minted.plaintext_token).toBeTruthy();

    // The persona authenticates via the minted token on its actual calls (the
    // mint-token flow: no register_agent needed — the token authenticates
    // directly). It can now legitimately send AS itself.
    registerAgent("alice", "r", []);
    const { client, server } = await connectClient();
    try {
      const ok: any = await client.callTool({
        name: "send_message",
        arguments: { from: "test-persona", to: "alice", content: "hi", agent_token: minted.plaintext_token },
      });
      expect(ok.isError).toBeFalsy();
      expect(body(ok).success).toBe(true);
    } finally {
      await server.close();
    }
  });
});

// --- send-from impersonation (pin gate-6 + reserved) ---

describe("v2.14.0 — send-from requires the actor's token", () => {
  it("(pin) sending as an active agent WITHOUT its token is rejected", async () => {
    registerAgent("bob", "r", []); // bob has a token
    registerAgent("alice", "r", []);
    const { client, server } = await connectClient();
    try {
      const res: any = await client.callTool({
        name: "send_message",
        arguments: { from: "bob", to: "alice", content: "spoof" }, // no token
      });
      expect(res.isError).toBe(true);
      expect(body(res).error_code).toBe("AUTH_FAILED");
    } finally {
      await server.close();
    }
  });

  it("sending as a provisioned reserved persona without its token is rejected", async () => {
    mintAgentToken("test-persona", "r", [], { description: null, force: false });
    registerAgent("alice", "r", []);
    const { client, server } = await connectClient();
    try {
      const res: any = await client.callTool({
        name: "send_message",
        arguments: { from: "test-persona", to: "alice", content: "spoof" }, // no token
      });
      expect(res.isError).toBe(true);
      expect(body(res).error_code).toBe("AUTH_FAILED");
    } finally {
      await server.close();
    }
  });
});

// --- D: legacy grace cannot authenticate an actor identity ---

describe("v2.14.0 — (D) legacy grace can't authenticate an actor", () => {
  it("under RELAY_ALLOW_LEGACY=1, from=<legacy persona> on send_message is rejected", async () => {
    registerAgent("legacy-agent", "r", []);
    registerAgent("alice", "r", []);
    // Demote legacy-agent to a token-less legacy_bootstrap row.
    getDb()
      .prepare("UPDATE agents SET token_hash = NULL, auth_state = 'legacy_bootstrap' WHERE name = ?")
      .run("legacy-agent");

    process.env.RELAY_ALLOW_LEGACY = "1";
    const { client, server } = await connectClient();
    try {
      const res: any = await client.callTool({
        name: "send_message",
        arguments: { from: "legacy-agent", to: "alice", content: "spoof-via-grace" },
      });
      expect(res.isError).toBe(true);
      const b = body(res);
      expect(b.error_code).toBe("AUTH_FAILED");
      expect(b.error).toMatch(/legacy/i);
    } finally {
      await server.close();
      delete process.env.RELAY_ALLOW_LEGACY;
    }
  });
});

// --- B: reserved names are exempt from the dead-agent purge ---

describe("v2.14.0 — (B) reserved names survive the 30-day purge", () => {
  it("a stale reserved name is kept; a stale ordinary agent is purged", () => {
    mintAgentToken("test-persona", "r", [], { description: null, force: false });
    registerAgent("stale-bob", "r", []);
    const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(); // 40d
    getDb().prepare("UPDATE agents SET last_seen = ? WHERE name IN ('test-persona','stale-bob')").run(longAgo);

    purgeOldRecords(getDb());

    const names = getAgents().map((a) => a.name);
    expect(names).toContain("test-persona"); // reserved → exempt
    expect(names).not.toContain("stale-bob"); // ordinary → purged
  });
});
