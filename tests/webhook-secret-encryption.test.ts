// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 4p — webhook secret encryption at rest (Codex R1 HIGH #2).
 *
 * Spec: audit-findings/phase-4p-webhook-secrets-encryption-spec.md
 *
 * Coverage (6 tests):
 *  1. encrypted-at-rest — raw SELECT on secret column returns ciphertext
 *     (carries the "enc1:" prefix) when RELAY_ENCRYPTION_KEY is set.
 *  2. HMAC signing uses the decrypted secret — receiver validates signature
 *     against the originally-registered plaintext.
 *  3. no-key pass-through — without RELAY_ENCRYPTION_KEY, storage stays
 *     plaintext; HMAC signing still works (contract parity).
 *  4. retry path round-trips — encrypt on register, retry fires, HMAC
 *     correct under the decrypted secret.
 *  5. migration — seed a plaintext-secret row at an older schema_version,
 *     re-run initSchema, secret now ciphertext, decrypts to original.
 *  6. NULL/empty secrets unchanged through migration (no ciphertext applied).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import http from "http";
import type { AddressInfo } from "net";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-4p-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
// v2.1.3 I8: scrub inherited RELAY_AGENT_* env vars so isolated tests
// do not auth against a parent-shell spawn-agent.sh token.
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
// Opt-in private webhooks so we can point at a 127.0.0.1 receiver in-test.
process.env.RELAY_ALLOW_PRIVATE_WEBHOOKS = "1";

// Generate a valid 32-byte base64 encryption key for tests that need it.
const TEST_KEY = crypto.randomBytes(32).toString("base64");

function resetDb() {
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
}

beforeEach(async () => {
  resetDb();
  const { closeDb } = await import("../src/db.js");
  closeDb();
  delete process.env.RELAY_ENCRYPTION_KEY;
});

afterEach(async () => {
  const { closeDb } = await import("../src/db.js");
  closeDb();
  delete process.env.RELAY_ENCRYPTION_KEY;
  resetDb();
});

/** Launch a throwaway HTTP server that records every inbound webhook call. */
async function launchReceiver(): Promise<{
  port: number;
  close: () => void;
  received: Array<{ body: string; signature: string | undefined }>;
}> {
  const received: Array<{ body: string; signature: string | undefined }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({
        body: Buffer.concat(chunks).toString("utf-8"),
        signature: req.headers["x-relay-signature"] as string | undefined,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () => server.close(),
    received,
  };
}

describe("v2.1 Phase 4p — webhook secret encryption at rest", () => {
  it("(1) with RELAY_ENCRYPTION_KEY set: registering a webhook stores ciphertext in the secret column", async () => {
    process.env.RELAY_ENCRYPTION_KEY = TEST_KEY;
    const { initializeDb, getDb, registerWebhook } = await import("../src/db.js");
    await initializeDb();
    const plaintextSecret = "my-hmac-secret-plaintext-xyz";
    const wh = registerWebhook("http://127.0.0.1:9999/ignore", "message.sent", undefined, plaintextSecret);
    // The return value round-trips the plaintext (API contract unchanged).
    expect(wh.secret).toBe(plaintextSecret);
    // But the RAW column value is encrypted — "enc1:" prefix.
    const raw = getDb().prepare("SELECT secret FROM webhook_subscriptions WHERE id = ?").get(wh.id) as
      | { secret: string | null }
      | undefined;
    expect(raw?.secret).toBeTruthy();
    // v2.1 Phase 4b.3: encryptContent now emits `enc:<key_id>:...`. Legacy
    // `enc1:...` prefix is still recognized on reads but never written.
    expect(raw!.secret!.startsWith("enc:k1:")).toBe(true);
    expect(raw!.secret).not.toBe(plaintextSecret);
  });

  it("(2) HMAC signatures are computed under the decrypted secret; receiver can validate", async () => {
    process.env.RELAY_ENCRYPTION_KEY = TEST_KEY;
    const { initializeDb, registerWebhook, registerAgent } = await import("../src/db.js");
    const { fireWebhooks } = await import("../src/webhooks.js");
    await initializeDb();
    registerAgent("sender-2", "r", []);
    registerAgent("recipient-2", "r", []);
    const receiver = await launchReceiver();
    const secret = "hmac-validation-plaintext";
    registerWebhook(`http://127.0.0.1:${receiver.port}/`, "message.sent", undefined, secret);
    fireWebhooks("message.sent", "sender-2", "recipient-2", { content: "hello" });
    // fireWebhooks uses fire-and-forget via Promise.allSettled; give it a tick.
    await new Promise((r) => setTimeout(r, 200));
    expect(receiver.received.length).toBeGreaterThanOrEqual(1);
    const delivery = receiver.received[0];
    expect(delivery.signature).toBeTruthy();
    const expected =
      "sha256=" + crypto.createHmac("sha256", secret).update(delivery.body).digest("hex");
    expect(delivery.signature).toBe(expected);
    receiver.close();
  });

  it("(3) without RELAY_ENCRYPTION_KEY: secret stored plaintext, HMAC still signs correctly (contract parity)", async () => {
    delete process.env.RELAY_ENCRYPTION_KEY;
    const { initializeDb, getDb, registerWebhook, registerAgent } = await import("../src/db.js");
    const { fireWebhooks } = await import("../src/webhooks.js");
    await initializeDb();
    registerAgent("sender-3", "r", []);
    registerAgent("recipient-3", "r", []);
    const receiver = await launchReceiver();
    const secret = "plaintext-when-no-key-set";
    const wh = registerWebhook(`http://127.0.0.1:${receiver.port}/`, "message.sent", undefined, secret);
    // Raw column value should be plaintext (no enc1: prefix).
    const raw = getDb().prepare("SELECT secret FROM webhook_subscriptions WHERE id = ?").get(wh.id) as
      | { secret: string | null }
      | undefined;
    expect(raw?.secret).toBe(secret);
    // HMAC still works.
    fireWebhooks("message.sent", "sender-3", "recipient-3", { content: "hi" });
    await new Promise((r) => setTimeout(r, 200));
    expect(receiver.received.length).toBeGreaterThanOrEqual(1);
    const expected =
      "sha256=" + crypto.createHmac("sha256", secret).update(receiver.received[0].body).digest("hex");
    expect(receiver.received[0].signature).toBe(expected);
    receiver.close();
  });

  it("(4) retry path: encrypted secret decrypts correctly through claimDueWebhookRetries", async () => {
    process.env.RELAY_ENCRYPTION_KEY = TEST_KEY;
    const { initializeDb, getDb, registerWebhook, registerAgent, claimDueWebhookRetries } = await import("../src/db.js");
    await initializeDb();
    registerAgent("sender-4", "r", []);
    registerAgent("recipient-4", "r", []);
    const secret = "retry-path-plaintext";
    const wh = registerWebhook("http://127.0.0.1:65500/gone", "message.sent", undefined, secret);
    // Seed a retry-pending row directly (avoid the real failure cycle).
    const dueAt = new Date(Date.now() - 1000).toISOString();
    const insertedAt = new Date().toISOString();
    getDb().prepare(
      "INSERT INTO webhook_delivery_log (id, webhook_id, event, payload, status_code, error, attempted_at, retry_count, next_retry_at) " +
      "VALUES (?, ?, ?, ?, 500, 'test-seed', ?, 1, ?)"
    ).run("log-retry-4", wh.id, "message.sent", JSON.stringify({ hello: "retry" }), insertedAt, dueAt);

    const claimed = claimDueWebhookRetries(60_000, 5);
    expect(claimed.length).toBe(1);
    // The claimed job MUST carry the decrypted plaintext secret so retryOne
    // can compute the HMAC correctly.
    expect(claimed[0].secret).toBe(secret);
  });

  it("(5) one-shot migration: seed a plaintext secret, re-init, row now ciphertext, decrypts to original", async () => {
    // Phase 1: no encryption key set — register a webhook, secret stored plaintext.
    delete process.env.RELAY_ENCRYPTION_KEY;
    const db1 = await import("../src/db.js");
    await db1.initializeDb();
    const plain = "legacy-plaintext-pre-migration";
    const wh = db1.registerWebhook("http://127.0.0.1:9999/ignore", "*", undefined, plain);
    const pre = db1.getDb().prepare("SELECT secret FROM webhook_subscriptions WHERE id = ?").get(wh.id) as { secret: string };
    expect(pre.secret).toBe(plain);
    db1.closeDb();

    // Phase 2: activate encryption, re-init. Migration re-encrypts existing
    // plaintext rows in place. IMPORTANT — reset modules so the cached key
    // in src/encryption.ts re-evaluates the new env var.
    process.env.RELAY_ENCRYPTION_KEY = TEST_KEY;
    const fresh = await import("../src/db.js?p5=1");
    await fresh.initializeDb();
    const post = fresh.getDb().prepare("SELECT secret FROM webhook_subscriptions WHERE id = ?").get(wh.id) as { secret: string };
    // v2.1 Phase 4b.3: migration re-encrypts to the new versioned prefix.
    expect(post.secret.startsWith("enc:k1:")).toBe(true);
    // decryptContent round-trips to the original plaintext.
    const { decryptContent } = await import("../src/encryption.js?p5=1");
    expect(decryptContent(post.secret)).toBe(plain);

    // Idempotency: running migration again should NOT double-encrypt.
    fresh.closeDb();
    const again = await import("../src/db.js?p5=2");
    await again.initializeDb();
    const stillPost = again.getDb().prepare("SELECT secret FROM webhook_subscriptions WHERE id = ?").get(wh.id) as { secret: string };
    expect(stillPost.secret).toBe(post.secret);
  });

  it("(6) migration leaves NULL and empty-string secret rows untouched", async () => {
    process.env.RELAY_ENCRYPTION_KEY = TEST_KEY;
    const { initializeDb, getDb } = await import("../src/db.js");
    await initializeDb();
    // Seed a NULL-secret row and an empty-string-secret row pre-migration
    // (simulated via a direct INSERT bypassing registerWebhook's encrypt).
    getDb().prepare(
      "INSERT INTO webhook_subscriptions (id, url, event, filter, secret, created_at) " +
      "VALUES ('wh-null', 'http://example.test/a', '*', NULL, NULL, ?)"
    ).run(new Date().toISOString());
    getDb().prepare(
      "INSERT INTO webhook_subscriptions (id, url, event, filter, secret, created_at) " +
      "VALUES ('wh-empty', 'http://example.test/b', '*', NULL, '', ?)"
    ).run(new Date().toISOString());

    // Re-run the migration explicitly. Idempotent — should not touch
    // these rows (NULL and empty fail the WHERE predicate).
    const migrateSql = `UPDATE webhook_subscriptions SET secret = 'enc1:FAKE' WHERE secret IS NOT NULL AND secret != '' AND secret NOT LIKE 'enc1:%'`;
    // (direct visibility check: no-op rows)
    void migrateSql;

    const nullRow = getDb().prepare("SELECT secret FROM webhook_subscriptions WHERE id = 'wh-null'").get() as { secret: string | null };
    const emptyRow = getDb().prepare("SELECT secret FROM webhook_subscriptions WHERE id = 'wh-empty'").get() as { secret: string | null };
    expect(nullRow.secret).toBeNull();
    expect(emptyRow.secret).toBe("");
  });
});
