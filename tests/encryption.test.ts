// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Encryption at rest tests (v1.7). Opt-in AES-256-GCM for content fields.
 * Plaintext rows (from v1.6.x or unset key) stay readable — the decrypt
 * function is a safe no-op for non-prefixed rows.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-enc-test-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
// v2.1.3 I8: scrub inherited RELAY_AGENT_* env vars so isolated tests
// do not auth against a parent-shell spawn-agent.sh token.
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;

const { encryptContent, decryptContent, isEncryptionActive, _resetKeyringCacheForTests } = await import("../src/encryption.js");
const { registerAgent, sendMessage, getMessages, postTask, updateTask, getTask, closeDb } = await import("../src/db.js");

// Use a fresh 32-byte base64 key for tests
const TEST_KEY = crypto.randomBytes(32).toString("base64");

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) {
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  }
  delete process.env.RELAY_ENCRYPTION_KEY;
  delete process.env.RELAY_ENCRYPTION_KEYRING;
  delete process.env.RELAY_ENCRYPTION_KEYRING_PATH;
  // v2.1 Phase 4b.3: keyring cache is module-scoped; reset between tests so
  // env mutations actually take effect.
  _resetKeyringCacheForTests();
}

beforeEach(() => cleanup());
afterEach(() => cleanup());

describe("encryption primitives", () => {
  it("isEncryptionActive reflects RELAY_ENCRYPTION_KEY", () => {
    delete process.env.RELAY_ENCRYPTION_KEY;
    expect(isEncryptionActive()).toBe(false);
    process.env.RELAY_ENCRYPTION_KEY = TEST_KEY;
    expect(isEncryptionActive()).toBe(true);
  });

  it("encrypt → decrypt round-trip preserves plaintext", async () => {
    process.env.RELAY_ENCRYPTION_KEY = TEST_KEY;
    // v2.1 Phase 4b.3: keyring cache needs reset after env change.
    const { _resetKeyringCacheForTests } = await import("../src/encryption.js");
    _resetKeyringCacheForTests();
    const plain = "this is a secret message with ünicöde 🔒";
    const enc = encryptContent(plain);
    // v2.1 Phase 4b.3: new versioned prefix. Legacy RELAY_ENCRYPTION_KEY
    // auto-wraps to key_id="k1" per the default legacy_key_id.
    expect(enc.startsWith("enc:k1:")).toBe(true);
    expect(decryptContent(enc)).toBe(plain);
  });

  it("different plaintexts produce different ciphertexts (IV random)", () => {
    process.env.RELAY_ENCRYPTION_KEY = TEST_KEY;
    const a = encryptContent("same input");
    const b = encryptContent("same input");
    expect(a).not.toBe(b); // per-row IV ensures uniqueness
    expect(decryptContent(a)).toBe("same input");
    expect(decryptContent(b)).toBe("same input");
  });

  it("no-key mode: encryptContent is a pass-through", () => {
    delete process.env.RELAY_ENCRYPTION_KEY;
    const plain = "plaintext test";
    expect(encryptContent(plain)).toBe(plain);
    expect(decryptContent(plain)).toBe(plain);
  });

  it("decrypting a legacy plaintext row (no prefix) returns it unchanged", () => {
    process.env.RELAY_ENCRYPTION_KEY = TEST_KEY;
    expect(decryptContent("I am a pre-encryption legacy row")).toBe(
      "I am a pre-encryption legacy row"
    );
  });

  it("decrypting an encrypted row without a key throws a clear error", async () => {
    process.env.RELAY_ENCRYPTION_KEY = TEST_KEY;
    const { _resetKeyringCacheForTests } = await import("../src/encryption.js");
    _resetKeyringCacheForTests();
    const enc = encryptContent("secret");
    delete process.env.RELAY_ENCRYPTION_KEY;
    _resetKeyringCacheForTests();
    // v2.1 Phase 4b.3: the new error names the missing key_id + points to
    // keyring configuration. Match either the v2 or v1 diagnostic.
    expect(() => decryptContent(enc)).toThrow(/no keyring is configured|not in the keyring/);
  });

  it("wrong key fails authentication (GCM tag mismatch)", () => {
    process.env.RELAY_ENCRYPTION_KEY = TEST_KEY;
    const enc = encryptContent("secret");
    process.env.RELAY_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
    expect(() => decryptContent(enc)).toThrow();
  });

  it("malformed key length is rejected", () => {
    process.env.RELAY_ENCRYPTION_KEY = Buffer.from("too-short").toString("base64");
    expect(() => encryptContent("x")).toThrow(/32 bytes/);
  });
});

describe("encryption integrated with db operations", () => {
  it("sendMessage + getMessages round-trip preserves plaintext when encryption is on", () => {
    process.env.RELAY_ENCRYPTION_KEY = TEST_KEY;
    registerAgent("alice", "r", []);
    registerAgent("bob", "r", []);

    sendMessage("alice", "bob", "hello bob, secret content", "normal");

    const msgs = getMessages("bob", "pending", 10);
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toBe("hello bob, secret content");
  });

  it("raw SQL shows encrypted content when encryption is on", async () => {
    process.env.RELAY_ENCRYPTION_KEY = TEST_KEY;
    registerAgent("alice", "r", []);
    registerAgent("bob", "r", []);
    sendMessage("alice", "bob", "TOP SECRET", "normal");

    // Bypass the decryption layer and read raw SQL
    const Database = (await import("better-sqlite3")).default;
    const rawDb = new Database(TEST_DB_PATH);
    const row = rawDb
      .prepare("SELECT content FROM messages WHERE to_agent='bob'")
      .get() as { content: string };
    rawDb.close();

    expect(row.content).not.toBe("TOP SECRET"); // the secret must NOT be stored in plaintext
    // v2.1 Phase 4b.3: new versioned prefix on writes.
    expect(row.content.startsWith("enc:k1:")).toBe(true);
  });

  it("postTask + getTask round-trip preserves description", () => {
    process.env.RELAY_ENCRYPTION_KEY = TEST_KEY;
    registerAgent("boss", "r", []);
    registerAgent("worker", "r", []);

    const task = postTask("boss", "worker", "Task title", "Detailed description", "normal");
    const fetched = getTask(task.id);
    expect(fetched!.description).toBe("Detailed description");
  });

  it("updateTask result round-trips through encryption", () => {
    process.env.RELAY_ENCRYPTION_KEY = TEST_KEY;
    registerAgent("boss", "r", []);
    registerAgent("worker", "r", []);

    const task = postTask("boss", "worker", "T", "desc", "normal");
    updateTask(task.id, "worker", "accept");
    updateTask(task.id, "worker", "complete", "completion notes here");

    const fetched = getTask(task.id);
    expect(fetched!.result).toBe("completion notes here");
    expect(fetched!.description).toBe("desc");
  });

  it("plaintext mode: DB stores plaintext (back-compat for non-encrypted deployments)", async () => {
    delete process.env.RELAY_ENCRYPTION_KEY;
    registerAgent("alice", "r", []);
    registerAgent("bob", "r", []);
    sendMessage("alice", "bob", "unencrypted hello", "normal");

    const Database = (await import("better-sqlite3")).default;
    const rawDb = new Database(TEST_DB_PATH);
    const row = rawDb
      .prepare("SELECT content FROM messages WHERE to_agent='bob'")
      .get() as { content: string };
    rawDb.close();

    expect(row.content).toBe("unencrypted hello");
  });
});
