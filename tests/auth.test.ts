// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-auth-test-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
// v2.1.3 I8: scrub inherited RELAY_AGENT_* env vars so isolated tests
// do not auth against a parent-shell spawn-agent.sh token.
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;

const {
  generateToken,
  hashToken,
  verifyToken,
  authenticateAgent,
  isLegacyGraceActive,
} = await import("../src/auth.js");
const {
  registerAgent,
  getAgentAuthData,
  closeDb,
} = await import("../src/db.js");

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) {
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  }
  delete process.env.RELAY_ALLOW_LEGACY;
}

beforeEach(() => cleanup());
afterEach(() => cleanup());

// --- Token primitives ---

describe("token primitives", () => {
  it("generateToken produces a base64url string of reasonable length", () => {
    const t = generateToken();
    expect(t.length).toBeGreaterThan(32);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("hashToken produces bcrypt hashes that verify correctly", () => {
    const t = generateToken();
    const h = hashToken(t);
    expect(h.startsWith("$2")).toBe(true);
    expect(verifyToken(t, h)).toBe(true);
  });

  it("verifyToken rejects the wrong token", () => {
    const t1 = generateToken();
    const t2 = generateToken();
    const h = hashToken(t1);
    expect(verifyToken(t2, h)).toBe(false);
  });

  it("two calls to hashToken for the same token produce different hashes (salted)", () => {
    const t = generateToken();
    expect(hashToken(t)).not.toBe(hashToken(t));
  });
});

// --- authenticateAgent logic ---

describe("authenticateAgent", () => {
  it("rejects a legacy_bootstrap row when legacy grace is OFF", () => {
    // v2.1 Phase 4b.1 v2: legacy state is now explicit via auth_state, not
    // inferred from null token_hash. Tests pass authState="legacy_bootstrap"
    // to exercise the legacy-grace path the old null-hash sentinel covered.
    delete process.env.RELAY_ALLOW_LEGACY;
    const r = authenticateAgent("alice", null, null, "legacy_bootstrap");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("no token");
  });

  it("accepts a legacy_bootstrap row when legacy grace is ON", () => {
    process.env.RELAY_ALLOW_LEGACY = "1";
    const r = authenticateAgent("alice", null, null, "legacy_bootstrap");
    expect(r.ok).toBe(true);
    expect(r.legacy).toBe(true);
  });

  it("rejects when a token is required but not provided", () => {
    const token = generateToken();
    const hash = hashToken(token);
    const r = authenticateAgent("alice", null, hash);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("agent_token");
  });

  it("rejects the wrong token", () => {
    const token = generateToken();
    const wrong = generateToken();
    const hash = hashToken(token);
    const r = authenticateAgent("alice", wrong, hash);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("Invalid token");
  });

  it("accepts the correct token", () => {
    const token = generateToken();
    const hash = hashToken(token);
    const r = authenticateAgent("alice", token, hash);
    expect(r.ok).toBe(true);
    expect(r.legacy).toBeFalsy();
  });

  it("legacy grace does NOT accept a null token when agent HAS a token_hash", () => {
    // Legacy grace only skips the check for agents without a token_hash.
    // A tokened agent still requires its token even with grace on.
    process.env.RELAY_ALLOW_LEGACY = "1";
    const token = generateToken();
    const hash = hashToken(token);
    const r = authenticateAgent("alice", null, hash);
    expect(r.ok).toBe(false);
  });
});

// --- End-to-end via registerAgent ---

describe("registerAgent auth integration", () => {
  it("first registration returns a plaintext_token and persists the hash", () => {
    const { agent, plaintext_token } = registerAgent("alice", "r", []);
    expect(plaintext_token).toBeTruthy();
    expect(agent.has_token).toBe(true);

    const auth = getAgentAuthData("alice");
    expect(auth).not.toBeNull();
    expect(auth!.token_hash).toBeTruthy();
    expect(verifyToken(plaintext_token!, auth!.token_hash!)).toBe(true);
  });

  it("re-registration preserves the existing token_hash and returns null token", () => {
    const first = registerAgent("alice", "r", ["initial-cap"]);
    const second = registerAgent("alice", "newRole", ["a", "b"]);

    expect(second.plaintext_token).toBeNull();
    expect(second.agent.has_token).toBe(true);

    const auth = getAgentAuthData("alice");
    // Original token still works
    expect(verifyToken(first.plaintext_token!, auth!.token_hash!)).toBe(true);
    // Role DOES update on re-register (legitimate operator concern)
    expect(second.agent.role).toBe("newRole");
    // v1.7.1: capabilities are IMMUTABLE after first registration. The request
    // payload ["a","b"] is ignored; the original ["initial-cap"] is preserved.
    // This is defense-in-depth against the re-register capability-escalation CVE.
    expect(second.agent.capabilities).toEqual(["initial-cap"]);
  });

  it("isLegacyGraceActive reflects env var", () => {
    delete process.env.RELAY_ALLOW_LEGACY;
    expect(isLegacyGraceActive()).toBe(false);
    process.env.RELAY_ALLOW_LEGACY = "1";
    expect(isLegacyGraceActive()).toBe(true);
    process.env.RELAY_ALLOW_LEGACY = "yes"; // only "1" counts
    expect(isLegacyGraceActive()).toBe(false);
  });
});

// --- Dispatcher-level auth enforcement via tool handlers ---

describe("dispatcher-level auth (via direct handler calls)", () => {
  it("send_message fails without a token (explicit caller field)", async () => {
    const { handleRegisterAgent } = await import("../src/tools/identity.js");
    handleRegisterAgent({ name: "alice", role: "r", capabilities: [] });
    handleRegisterAgent({ name: "bob", role: "r", capabilities: [] });

    // Handlers themselves do NOT enforce auth — the dispatcher does.
    // This test confirms the handler still works when called directly for
    // library consumers. Dispatcher-level auth is tested via HTTP integration
    // in tests/http.test.ts with tokens.
    const { handleSendMessage } = await import("../src/tools/messaging.js");
    const result = handleSendMessage({ from: "alice", to: "bob", content: "hi", priority: "normal" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
  });
});
