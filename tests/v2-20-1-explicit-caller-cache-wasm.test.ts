// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.20.1 parity on the sql.js (wasm) driver — the explicit-caller cache
 * functions (impersonation gate + generation invalidation + Q1 self-heal)
 * behave identically to the native driver.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-2201-wasm-" + process.pid);
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
  bumpAuthGeneration,
  getAgentAuthData,
  explicitCallerCacheGet,
  explicitCallerCachePut,
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

describe("wasm driver — v2.20.1 explicit-caller cache parity", () => {
  it("put → get, impersonation gate, generation invalidation", () => {
    const { plaintext_token } = registerAgent("w-x", "r", ["tasks"]);
    explicitCallerCachePut(plaintext_token!, getAgentAuthData("w-x")!, ["tasks"]);
    expect(explicitCallerCacheGet(plaintext_token!, "w-x")).toEqual({ name: "w-x", capabilities: ["tasks"] });
    expect(explicitCallerCacheGet(plaintext_token!, "w-y")).toBeNull(); // impersonation
    bumpAuthGeneration();
    expect(explicitCallerCacheGet(plaintext_token!, "w-x")).toBeNull(); // invalidated
  });

  it("Q1 self-heal populates token_lookup on a NULL-digest row", () => {
    const { plaintext_token } = registerAgent("w-heal", "r", []);
    getDb().prepare("UPDATE agents SET token_lookup = NULL WHERE name = ?").run("w-heal");
    authCacheClear();
    explicitCallerCachePut(plaintext_token!, getAgentAuthData("w-heal")!, []);
    expect(getAgentAuthData("w-heal")!.token_lookup).toBe(computeTokenLookup(plaintext_token!));
  });
});
