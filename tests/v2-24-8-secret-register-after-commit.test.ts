// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.24.8 — register-after-commit behaviour (PR C v2), through the REAL db.ts
 * mutators and the REAL registry.
 *
 * The v1 registry updated BEFORE the CAS/commit, so a failed or retried mutation
 * planted a throwaway value as the principal's `current`; four failures for one
 * name evicted its live token from the 4-slot window, silently dropping a live
 * credential out of redact-by-value. These tests assert the PROPERTY the fix
 * delivers — the placement the static guard cannot check:
 *   1. a failed mutation registers nothing;
 *   2. a live token survives four consecutive same-principal failures;
 *   3. innocent twin — a successful mint still registers and still redacts.
 * Tests 1 and 2 FAIL against the v1 (register-before-CAS) code.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-secret-aftercommit-" + process.pid);
fs.mkdirSync(TEST_DB_DIR, { recursive: true });
process.env.RELAY_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_ALLOW_LEGACY = "1";
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;

const db = await import("../src/db.js");
const { redactRegisteredValues, _resetSecretRegistryForTests, _identityCountForTests } = await import(
  "../src/secret-registry.js"
);

beforeEach(() => {
  _resetSecretRegistryForTests();
});

afterAll(() => {
  db.closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

describe("v2.24.8 register-after-commit (PR C v2)", () => {
  it("a FAILED mutation registers nothing — a rotate against a nonexistent principal leaves the registry empty", () => {
    expect(_identityCountForTests()).toBe(0);
    // No active row for this name → the rotate throws before any commit.
    expect(() => db.rotateAgentToken("ghost-never-existed", "0".repeat(60))).toThrow();
    // Post-fix: register is on the success path only, so the failure planted no
    // throwaway. The v1 (register-before-CAS) code would leave this at 1.
    expect(_identityCountForTests()).toBe(0);
  });

  it("a LIVE token survives four consecutive same-principal failures (the eviction the guarantee promised to prevent)", () => {
    const { plaintext_token: tLive } = db.registerAgent("victim", "role", []);
    expect(tLive).toBeTruthy();
    const line = `authorization: Bearer ${tLive} trailing`;
    // Registered on the successful first-registration.
    expect(redactRegisteredValues(line)).not.toContain(tLive as string);
    expect(redactRegisteredValues(line)).toContain("***");

    // Four failed rotations on the SAME live principal (wrong expected hash → the
    // CAS matches 0 rows → throws). v1 planted a distinct throwaway as `current`
    // on each, evicting tLive from the 4-slot window; v2 registers nothing on a
    // failure.
    for (let i = 0; i < 4; i++) {
      expect(() => db.rotateAgentToken("victim", "deadbeef".repeat(8))).toThrow();
    }

    // The guarantee holds: tLive is still redacted.
    expect(redactRegisteredValues(line)).not.toContain(tLive as string);
    expect(redactRegisteredValues(line)).toContain("***");
  });

  it("INNOCENT TWIN: a SUCCESSFUL mint still registers and still redacts", () => {
    const { plaintext_token } = db.mintAgentToken("freshly-minted", "role", []);
    expect(plaintext_token).toBeTruthy();
    const line = `token=${plaintext_token}`;
    expect(redactRegisteredValues(line)).not.toContain(plaintext_token);
    expect(redactRegisteredValues(line)).toContain("***");
  });
});
