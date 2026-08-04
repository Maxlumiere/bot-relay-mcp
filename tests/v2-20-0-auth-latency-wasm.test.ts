// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0003 (v2.20.0) parity on the sql.js (wasm) driver — proves the schema
 * v20 migration (token_lookup / previous_token_lookup columns + index +
 * auth_meta counter), the O(1) locator, and the revoke-trap invalidation all
 * behave identically to the native driver.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-adr0003-wasm-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_ALLOW_LEGACY;
delete process.env.RELAY_ENCRYPTION_KEYRING;
delete process.env.RELAY_ENCRYPTION_KEY;
process.env.RELAY_SQLITE_DRIVER = "wasm";

const {
  initializeDb,
  closeDb,
  getDb,
  registerAgent,
  revokeAgentToken,
  rotateAgentToken,
  resolveAgentByToken,
  getAgentAuthData,
} = await import("../src/db.js");
const { computeTokenLookup, _resetTokenLookupCacheForTests } = await import("../src/token-lookup.js");
const { authCacheClear } = await import("../src/auth-cache.js");

function cleanup() {
  closeDb();
  authCacheClear();
  _resetTokenLookupCacheForTests();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
}
beforeEach(async () => {
  cleanup();
  await initializeDb();
});
afterEach(() => cleanup());

describe("wasm driver — ADR-0003 parity", () => {
  it("schema v20 columns + auth_meta counter exist", () => {
    const cols = (getDb().prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("token_lookup");
    expect(cols).toContain("previous_token_lookup");
    const meta = getDb().prepare("SELECT generation FROM auth_meta WHERE id = 1").get() as { generation: number };
    expect(meta.generation).toBeGreaterThanOrEqual(0);
  });

  it("register populates the digest + resolveAgentByToken works", () => {
    const { plaintext_token } = registerAgent("w-alice", "worker", ["tasks"]);
    expect(getAgentAuthData("w-alice")!.token_lookup).toBe(computeTokenLookup(plaintext_token!));
    expect(resolveAgentByToken(plaintext_token!)).toEqual({ name: "w-alice", capabilities: ["tasks"] });
  });

  it("revoke-trap: revoked token denied on next call", () => {
    const { plaintext_token } = registerAgent("w-bob", "worker", []);
    expect(resolveAgentByToken(plaintext_token!)).not.toBeNull();
    revokeAgentToken("w-bob");
    expect(resolveAgentByToken(plaintext_token!)).toBeNull();
  });

  it("rotate: old token dies, new token works", () => {
    const { plaintext_token } = registerAgent("w-carol", "worker", []);
    const { newPlaintextToken } = rotateAgentToken("w-carol", getAgentAuthData("w-carol")!.token_hash!);
    expect(resolveAgentByToken(plaintext_token!)).toBeNull();
    expect(resolveAgentByToken(newPlaintextToken)).not.toBeNull();
  });
});
