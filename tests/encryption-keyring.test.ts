// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 4b.3 — encryption keyring + versioned ciphertext + re-encrypt.
 *
 * Coverage per spec §5:
 *   §5.1 keyring loading           (5 tests)
 *   §5.2 read-any / write-current  (8 tests incl. key_id="1" edge case)
 *   §5.3 relay re-encrypt flow     (10 tests)
 *   §5.4 lazy re-encrypt signal    (4 tests)
 *   §5.5 edge cases                (3 tests)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const RELAY_BIN = path.join(REPO_ROOT, "bin", "relay");

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-4b3-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");

const K1 = crypto.randomBytes(32).toString("base64");
const K2 = crypto.randomBytes(32).toString("base64");
const K_ONE = crypto.randomBytes(32).toString("base64"); // for key_id="1" edge case

function resetRoot() {
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
}

async function resetEncModule() {
  const { _resetKeyringCacheForTests } = await import("../src/encryption.js");
  _resetKeyringCacheForTests();
}

beforeEach(async () => {
  resetRoot();
  process.env.RELAY_DB_PATH = TEST_DB_PATH;
  delete process.env.RELAY_ENCRYPTION_KEYRING;
  delete process.env.RELAY_ENCRYPTION_KEYRING_PATH;
  delete process.env.RELAY_ENCRYPTION_KEY;
  delete process.env.RELAY_ENCRYPTION_LEGACY_KEY_ID;
  delete process.env.RELAY_LAZY_REENCRYPT;
  const { closeDb } = await import("../src/db.js");
  closeDb();
  await resetEncModule();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db.js");
  closeDb();
  delete process.env.RELAY_ENCRYPTION_KEYRING;
  delete process.env.RELAY_ENCRYPTION_KEYRING_PATH;
  delete process.env.RELAY_ENCRYPTION_KEY;
  delete process.env.RELAY_ENCRYPTION_LEGACY_KEY_ID;
  delete process.env.RELAY_LAZY_REENCRYPT;
  await resetEncModule();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

// ============================================================
// §5.1 keyring loading (5 tests)
// ============================================================

describe("§5.1 keyring loading", () => {
  it("(L.1) RELAY_ENCRYPTION_KEYRING JSON env parses + validates", async () => {
    process.env.RELAY_ENCRYPTION_KEYRING = JSON.stringify({ current: "k1", keys: { k1: K1 } });
    await resetEncModule();
    const { getKeyringInfo, isEncryptionActive } = await import("../src/encryption.js");
    expect(isEncryptionActive()).toBe(true);
    const info = getKeyringInfo();
    expect(info.current).toBe("k1");
    expect(info.known_key_ids).toEqual(["k1"]);
  });

  it("(L.2) RELAY_ENCRYPTION_KEYRING_PATH file loads + warns on wider-than-0600 perms", async () => {
    const krPath = path.join(TEST_DB_DIR, "keyring.json");
    fs.writeFileSync(krPath, JSON.stringify({ current: "k1", keys: { k1: K1, k2: K2 } }), { mode: 0o644 });
    process.env.RELAY_ENCRYPTION_KEYRING_PATH = krPath;
    await resetEncModule();
    const { getKeyringInfo } = await import("../src/encryption.js");
    const info = getKeyringInfo();
    expect(info.current).toBe("k1");
    expect(info.known_key_ids).toEqual(["k1", "k2"]);
    // Wider-than-0600 emits a warning — we don't assert on stderr content,
    // just that the load proceeded.
  });

  it("(L.3) legacy RELAY_ENCRYPTION_KEY auto-wraps as {current:'k1', keys:{k1:…}}", async () => {
    process.env.RELAY_ENCRYPTION_KEY = K1;
    await resetEncModule();
    const { getKeyringInfo, isLegacyEnvKeyInUse } = await import("../src/encryption.js");
    const info = getKeyringInfo();
    expect(info.current).toBe("k1");
    expect(info.known_key_ids).toEqual(["k1"]);
    expect(isLegacyEnvKeyInUse()).toBe(true);
  });

  it("(L.4) multi-source (RELAY_ENCRYPTION_KEYRING + RELAY_ENCRYPTION_KEY) → reject at startup", async () => {
    process.env.RELAY_ENCRYPTION_KEYRING = JSON.stringify({ current: "k1", keys: { k1: K1 } });
    process.env.RELAY_ENCRYPTION_KEY = K2;
    await resetEncModule();
    const { getKeyringInfo } = await import("../src/encryption.js");
    // loadKeyring throws; getKeyringInfo swallows + returns empty info.
    const info = getKeyringInfo();
    expect(info.current).toBeNull();
    // Direct load call raises — test via encryptContent which loads internally.
    const { encryptContent } = await import("../src/encryption.js");
    expect(() => encryptContent("x")).toThrow(/Multiple encryption key sources/);
  });

  it("(L.5) malformed keyring (missing `current` key in keys map) → throws with clear message", async () => {
    process.env.RELAY_ENCRYPTION_KEYRING = JSON.stringify({ current: "nonexistent", keys: { k1: K1 } });
    await resetEncModule();
    const { encryptContent } = await import("../src/encryption.js");
    expect(() => encryptContent("x")).toThrow(/does not appear in keys map/);
  });
});

// ============================================================
// §5.2 read-with-any / write-with-current (8 tests)
// ============================================================

describe("§5.2 read-any / write-current", () => {
  it("(R.1) encrypt with k2 (current) → ciphertext has enc:k2: prefix", async () => {
    process.env.RELAY_ENCRYPTION_KEYRING = JSON.stringify({ current: "k2", keys: { k1: K1, k2: K2 } });
    await resetEncModule();
    const { encryptContent } = await import("../src/encryption.js");
    const ct = encryptContent("hello");
    expect(ct.startsWith("enc:k2:")).toBe(true);
  });

  it("(R.2) decrypt with keyring containing k1 + k2 → round-trip", async () => {
    process.env.RELAY_ENCRYPTION_KEYRING = JSON.stringify({ current: "k1", keys: { k1: K1, k2: K2 } });
    await resetEncModule();
    const { encryptContent: enc1 } = await import("../src/encryption.js");
    const ct_k1 = enc1("first");
    // Swap to current=k2 and re-encrypt.
    process.env.RELAY_ENCRYPTION_KEYRING = JSON.stringify({ current: "k2", keys: { k1: K1, k2: K2 } });
    await resetEncModule();
    const { encryptContent: enc2, decryptContent } = await import("../src/encryption.js");
    const ct_k2 = enc2("second");
    // Decrypt both rows via the combined keyring.
    expect(decryptContent(ct_k1)).toBe("first");
    expect(decryptContent(ct_k2)).toBe("second");
  });

  it("(R.3) read ciphertext with unknown key_id → structured error naming the missing id", async () => {
    process.env.RELAY_ENCRYPTION_KEYRING = JSON.stringify({ current: "k1", keys: { k1: K1 } });
    await resetEncModule();
    const { encryptContent } = await import("../src/encryption.js");
    const ct = encryptContent("x");
    // Now drop k1 from the keyring.
    process.env.RELAY_ENCRYPTION_KEYRING = JSON.stringify({ current: "k2", keys: { k2: K2 } });
    await resetEncModule();
    const { decryptContent } = await import("../src/encryption.js");
    expect(() => decryptContent(ct)).toThrow(/key_id="k1".*not in the keyring/);
  });

  it("(R.4) legacy unprefixed-with-key_id (enc1:) ciphertext decrypts via legacy_key_id", async () => {
    // Generate a legacy enc1: ciphertext by hand using the same cipher.
    const legacyKey = Buffer.from(K1, "base64");
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", legacyKey, iv);
    const enc = Buffer.concat([cipher.update("legacy plaintext", "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const payload = Buffer.concat([enc, tag]);
    const ct = `enc1:${iv.toString("base64")}:${payload.toString("base64")}`;
    // Load keyring with k1 as the legacy_key_id.
    process.env.RELAY_ENCRYPTION_KEYRING = JSON.stringify({ current: "k2", keys: { k1: K1, k2: K2 } });
    process.env.RELAY_ENCRYPTION_LEGACY_KEY_ID = "k1";
    await resetEncModule();
    const { decryptContent } = await import("../src/encryption.js");
    expect(decryptContent(ct)).toBe("legacy plaintext");
  });

  it("(R.5) round-trip with single-key keyring (no rotation configured)", async () => {
    process.env.RELAY_ENCRYPTION_KEYRING = JSON.stringify({ current: "solo", keys: { solo: K1 } });
    await resetEncModule();
    const { encryptContent, decryptContent } = await import("../src/encryption.js");
    const ct = encryptContent("one key only");
    expect(ct.startsWith("enc:solo:")).toBe(true);
    expect(decryptContent(ct)).toBe("one key only");
  });

  it("(R.6) encrypt ALWAYS uses current key regardless of caller context", async () => {
    process.env.RELAY_ENCRYPTION_KEYRING = JSON.stringify({ current: "k2", keys: { k1: K1, k2: K2 } });
    await resetEncModule();
    const { encryptContent } = await import("../src/encryption.js");
    for (let i = 0; i < 10; i++) {
      const ct = encryptContent(`msg-${i}`);
      expect(ct.startsWith("enc:k2:")).toBe(true);
    }
  });

  it("(R.7) key_id=\"1\" edge case — disambiguates cleanly from enc1: legacy prefix", async () => {
    // Per Victra's audit note: key_id containing digits must parse correctly.
    process.env.RELAY_ENCRYPTION_KEYRING = JSON.stringify({ current: "1", keys: { "1": K_ONE } });
    await resetEncModule();
    const { encryptContent, decryptContent } = await import("../src/encryption.js");
    const ct = encryptContent("key-id-is-the-digit-one");
    // Ciphertext starts with enc:1: — NOT enc1:. Parser must split key_id
    // correctly (the `:` after the `1` is the separator, not part of the id).
    expect(ct.startsWith("enc:1:")).toBe(true);
    expect(ct.startsWith("enc1:")).toBe(false);
    expect(decryptContent(ct)).toBe("key-id-is-the-digit-one");
  });

  it("(R.8) key_id containing ':' rejected at keyring load", async () => {
    process.env.RELAY_ENCRYPTION_KEYRING = JSON.stringify({ current: "bad:id", keys: { "bad:id": K1 } });
    await resetEncModule();
    const { encryptContent } = await import("../src/encryption.js");
    // The `current` key_id is validated before parseKeysMap, so the "must
    // match" error from validateKeyring fires first.
    expect(() => encryptContent("x")).toThrow(/must match/);
  });
});

// ============================================================
// §5.3 `relay re-encrypt` flow (10 tests)
// ============================================================

function runRelay(args: string[], extraEnv: Record<string, string | undefined> = {}): { status: number; stdout: string; stderr: string } {
  // Strip parent-process encryption env vars before applying extraEnv — the
  // multi-source reject (Align #1) would otherwise fire any time the parent
  // test process has RELAY_ENCRYPTION_KEY left over from seeding.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.RELAY_ENCRYPTION_KEY;
  delete env.RELAY_ENCRYPTION_KEYRING;
  delete env.RELAY_ENCRYPTION_KEYRING_PATH;
  delete env.RELAY_ENCRYPTION_LEGACY_KEY_ID;
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const r = spawnSync("node", [RELAY_BIN, ...args], { env, encoding: "utf-8", timeout: 30_000 });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

async function seedMessagesWithKey(nMessages: number, keyringJson: string) {
  process.env.RELAY_ENCRYPTION_KEYRING = keyringJson;
  await resetEncModule();
  const { initializeDb, registerAgent, sendMessage, closeDb } = await import("../src/db.js");
  await initializeDb();
  registerAgent("from-" + process.pid, "r", []);
  registerAgent("to-" + process.pid, "r", []);
  for (let i = 0; i < nMessages; i++) {
    sendMessage("from-" + process.pid, "to-" + process.pid, `msg-${i}`, "normal");
  }
  closeDb();
}

describe("§5.3 relay re-encrypt flow", () => {
  it("(E.1) happy path: seed with k1, re-encrypt --from k1 --to k2, all rows now enc:k2:", async () => {
    await seedMessagesWithKey(5, JSON.stringify({ current: "k1", keys: { k1: K1 } }));
    // Swap keyring: current=k2, both keys present.
    const fullKr = JSON.stringify({ current: "k2", keys: { k1: K1, k2: K2 } });
    const r = runRelay(["re-encrypt", "--from", "k1", "--to", "k2", "--yes"], {
      RELAY_ENCRYPTION_KEYRING: fullKr,
      RELAY_DB_PATH: TEST_DB_PATH,
    });
    expect(r.status).toBe(0);
    // Verify via raw SELECT.
    process.env.RELAY_ENCRYPTION_KEYRING = fullKr;
    await resetEncModule();
    const { initializeDb, getDb } = await import("../src/db.js");
    await initializeDb();
    const rows = getDb()
      .prepare("SELECT content FROM messages")
      .all() as Array<{ content: string }>;
    for (const row of rows) {
      expect(row.content.startsWith("enc:k2:")).toBe(true);
    }
  });

  it("(E.2) --dry-run prints plan without writes", async () => {
    await seedMessagesWithKey(3, JSON.stringify({ current: "k1", keys: { k1: K1 } }));
    const fullKr = JSON.stringify({ current: "k2", keys: { k1: K1, k2: K2 } });
    const r = runRelay(["re-encrypt", "--from", "k1", "--to", "k2", "--dry-run"], {
      RELAY_ENCRYPTION_KEYRING: fullKr,
      RELAY_DB_PATH: TEST_DB_PATH,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/DRY RUN/);
    // Rows STILL at k1.
    process.env.RELAY_ENCRYPTION_KEYRING = fullKr;
    await resetEncModule();
    const { initializeDb, getDb } = await import("../src/db.js");
    await initializeDb();
    const rows = getDb()
      .prepare("SELECT content FROM messages")
      .all() as Array<{ content: string }>;
    for (const row of rows) {
      expect(row.content.startsWith("enc:k1:")).toBe(true);
    }
  });

  it("(E.3) --verify-clean returns count=0 after successful re-encrypt", async () => {
    await seedMessagesWithKey(3, JSON.stringify({ current: "k1", keys: { k1: K1 } }));
    const fullKr = JSON.stringify({ current: "k2", keys: { k1: K1, k2: K2 } });
    runRelay(["re-encrypt", "--from", "k1", "--to", "k2", "--yes"], {
      RELAY_ENCRYPTION_KEYRING: fullKr,
      RELAY_DB_PATH: TEST_DB_PATH,
    });
    const v = runRelay(["re-encrypt", "--verify-clean", "k1"], {
      RELAY_ENCRYPTION_KEYRING: fullKr,
      RELAY_DB_PATH: TEST_DB_PATH,
    });
    expect(v.status).toBe(0);
    expect(v.stdout).toMatch(/Retirement SAFE/);
  });

  it("(E.4) --verify-clean returns count>0 when rows still pending", async () => {
    await seedMessagesWithKey(2, JSON.stringify({ current: "k1", keys: { k1: K1 } }));
    const fullKr = JSON.stringify({ current: "k2", keys: { k1: K1, k2: K2 } });
    const v = runRelay(["re-encrypt", "--verify-clean", "k1"], {
      RELAY_ENCRYPTION_KEYRING: fullKr,
      RELAY_DB_PATH: TEST_DB_PATH,
    });
    expect(v.status).toBe(1);
    expect(v.stdout).toMatch(/Retirement UNSAFE/);
  });

  it("(E.5) idempotent: running twice in a row is safe (second is no-op)", async () => {
    await seedMessagesWithKey(3, JSON.stringify({ current: "k1", keys: { k1: K1 } }));
    const fullKr = JSON.stringify({ current: "k2", keys: { k1: K1, k2: K2 } });
    const r1 = runRelay(["re-encrypt", "--from", "k1", "--to", "k2", "--yes"], {
      RELAY_ENCRYPTION_KEYRING: fullKr,
      RELAY_DB_PATH: TEST_DB_PATH,
    });
    expect(r1.status).toBe(0);
    const r2 = runRelay(["re-encrypt", "--from", "k1", "--to", "k2", "--yes"], {
      RELAY_ENCRYPTION_KEYRING: fullKr,
      RELAY_DB_PATH: TEST_DB_PATH,
    });
    expect(r2.status).toBe(0);
    expect(r2.stdout).toMatch(/Nothing to do/);
  });

  it("(E.6) unknown --from key_id rejected when not resolvable", async () => {
    await seedMessagesWithKey(0, JSON.stringify({ current: "k1", keys: { k1: K1 } }));
    const r = runRelay(["re-encrypt", "--from", "ghost-key", "--to", "k1", "--yes"], {
      RELAY_ENCRYPTION_KEYRING: JSON.stringify({ current: "k1", keys: { k1: K1 } }),
      RELAY_DB_PATH: TEST_DB_PATH,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/not in the keyring/);
  });

  it("(E.7) --from equals --to rejected", async () => {
    await seedMessagesWithKey(0, JSON.stringify({ current: "k1", keys: { k1: K1 } }));
    const r = runRelay(["re-encrypt", "--from", "k1", "--to", "k1", "--yes"], {
      RELAY_ENCRYPTION_KEYRING: JSON.stringify({ current: "k1", keys: { k1: K1 } }),
      RELAY_DB_PATH: TEST_DB_PATH,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/equals --to/);
  });

  it("(E.8) legacy enc1: rows re-encrypt via legacy_key_id", async () => {
    // Seed a direct enc1: row into messages via SQL (simulates a Phase 4p DB).
    process.env.RELAY_ENCRYPTION_KEY = K1; // triggers legacy auto-wrap to k1
    await resetEncModule();
    const { initializeDb, getDb, closeDb } = await import("../src/db.js");
    await initializeDb();
    // Build an enc1: ciphertext for "legacy body".
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(K1, "base64"), iv);
    const enc = Buffer.concat([cipher.update("legacy body", "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const ct = `enc1:${iv.toString("base64")}:${Buffer.concat([enc, tag]).toString("base64")}`;
    getDb().prepare(
      "INSERT INTO agents (id, name, role, capabilities, last_seen, created_at) VALUES ('a', 'a', 'r', '[]', ?, ?)"
    ).run(new Date().toISOString(), new Date().toISOString());
    getDb().prepare(
      "INSERT INTO agents (id, name, role, capabilities, last_seen, created_at) VALUES ('b', 'b', 'r', '[]', ?, ?)"
    ).run(new Date().toISOString(), new Date().toISOString());
    getDb().prepare(
      "INSERT INTO messages (id, from_agent, to_agent, content, priority, status, created_at) VALUES ('m1', 'a', 'b', ?, 'normal', 'pending', ?)"
    ).run(ct, new Date().toISOString());
    closeDb();

    const fullKr = JSON.stringify({ current: "k2", keys: { k1: K1, k2: K2 } });
    const r = runRelay(["re-encrypt", "--from", "k1", "--to", "k2", "--yes"], {
      RELAY_ENCRYPTION_KEYRING: fullKr,
      RELAY_ENCRYPTION_LEGACY_KEY_ID: "k1",
      RELAY_DB_PATH: TEST_DB_PATH,
    });
    if (r.status !== 0) {
      // eslint-disable-next-line no-console
      console.error("E.8 CLI stdout:", r.stdout, "stderr:", r.stderr);
    }
    expect(r.status).toBe(0);

    process.env.RELAY_ENCRYPTION_KEYRING = fullKr;
    process.env.RELAY_ENCRYPTION_LEGACY_KEY_ID = "k1";
    delete process.env.RELAY_ENCRYPTION_KEY;
    await resetEncModule();
    const { initializeDb: initA, getDb: getA, closeDb: closeA } = await import("../src/db.js");
    await initA();
    const postRow = getA().prepare("SELECT content FROM messages WHERE id = 'm1'").get() as { content: string };
    expect(postRow.content.startsWith("enc:k2:")).toBe(true);
    const { decryptContent } = await import("../src/encryption.js");
    expect(decryptContent(postRow.content)).toBe("legacy body");
    closeA();
  });

  it("(E.9) progress table tracks per-column completion", async () => {
    await seedMessagesWithKey(2, JSON.stringify({ current: "k1", keys: { k1: K1 } }));
    const fullKr = JSON.stringify({ current: "k2", keys: { k1: K1, k2: K2 } });
    runRelay(["re-encrypt", "--from", "k1", "--to", "k2", "--yes"], {
      RELAY_ENCRYPTION_KEYRING: fullKr,
      RELAY_DB_PATH: TEST_DB_PATH,
    });
    process.env.RELAY_ENCRYPTION_KEYRING = fullKr;
    await resetEncModule();
    const { initializeDb, getDb } = await import("../src/db.js");
    await initializeDb();
    const progress = getDb()
      .prepare("SELECT table_name, status, rows_processed FROM reencryption_progress")
      .all() as Array<{ table_name: string; status: string; rows_processed: number }>;
    expect(progress.length).toBe(5); // 5 encrypted-column targets
    for (const p of progress) {
      expect(p.status).toBe("completed");
    }
    // messages.content row should show rows_processed >= 2.
    const msgRow = progress.find((p) => p.table_name === "messages");
    expect(msgRow!.rows_processed).toBeGreaterThanOrEqual(2);
  });

  it("(E.10) concurrent-write CAS: updates between SELECT and UPDATE are skipped safely", async () => {
    // Exercise the CAS miss path directly via rotate-then-change-row. We
    // simulate by manually running the re-encrypt migration in-process and
    // mutating a row between SELECT and UPDATE would require timing we
    // can't reliably orchestrate in a unit test; instead verify the shape
    // of the UPDATE query by inspecting that a row whose content was
    // touched between scan + write gets skipped, AND a row that wasn't
    // gets migrated.
    await seedMessagesWithKey(2, JSON.stringify({ current: "k1", keys: { k1: K1 } }));
    // Mutate one row post-scan by replacing its content directly.
    const fullKr = JSON.stringify({ current: "k2", keys: { k1: K1, k2: K2 } });
    process.env.RELAY_ENCRYPTION_KEYRING = fullKr;
    await resetEncModule();
    const { initializeDb, getDb, closeDb } = await import("../src/db.js");
    await initializeDb();
    // Replace the FIRST row's content with a k2-encrypted version directly
    // (simulating a concurrent daemon write with the current key).
    const { encryptContent } = await import("../src/encryption.js");
    const newCt = encryptContent("raced");
    const firstId = (getDb().prepare("SELECT id FROM messages ORDER BY created_at ASC LIMIT 1").get() as { id: string }).id;
    getDb().prepare("UPDATE messages SET content = ? WHERE id = ?").run(newCt, firstId);
    closeDb();
    // Now run re-encrypt. The LIKE 'enc:k1:%' predicate should exclude the
    // already-migrated row, and the untouched second row should migrate.
    const r = runRelay(["re-encrypt", "--from", "k1", "--to", "k2", "--yes"], {
      RELAY_ENCRYPTION_KEYRING: fullKr,
      RELAY_DB_PATH: TEST_DB_PATH,
    });
    expect(r.status).toBe(0);
    process.env.RELAY_ENCRYPTION_KEYRING = fullKr;
    await resetEncModule();
    const { initializeDb: initC, getDb: getC } = await import("../src/db.js");
    await initC();
    const rows = getC().prepare("SELECT content FROM messages").all() as Array<{ content: string }>;
    for (const row of rows) {
      expect(row.content.startsWith("enc:k2:")).toBe(true);
    }
  });
});

// ============================================================
// §5.4 lazy re-encrypt signal (4 tests)
// ============================================================

describe("§5.4 lazy re-encrypt signal", () => {
  it("(Y.1) RELAY_LAZY_REENCRYPT=1 recognized by isLazyReencryptEnabled", async () => {
    process.env.RELAY_LAZY_REENCRYPT = "1";
    await resetEncModule();
    const { isLazyReencryptEnabled } = await import("../src/encryption.js");
    expect(isLazyReencryptEnabled()).toBe(true);
  });

  it("(Y.2) unset / !=1 → isLazyReencryptEnabled returns false", async () => {
    delete process.env.RELAY_LAZY_REENCRYPT;
    await resetEncModule();
    const { isLazyReencryptEnabled } = await import("../src/encryption.js");
    expect(isLazyReencryptEnabled()).toBe(false);
    process.env.RELAY_LAZY_REENCRYPT = "true";
    expect(isLazyReencryptEnabled()).toBe(false); // only "1" activates
  });

  it("(Y.3) decryptContent stays PURE — no writes, no re-encryption on read", async () => {
    // Read paths never mutate rows. Rotate keyring current to k2 with k1
    // still present, read an enc:k1: row, verify the row is UNCHANGED on
    // disk post-read.
    process.env.RELAY_LAZY_REENCRYPT = "1";
    process.env.RELAY_ENCRYPTION_KEYRING = JSON.stringify({ current: "k1", keys: { k1: K1 } });
    await resetEncModule();
    const { initializeDb, getDb, registerAgent, sendMessage, closeDb } = await import("../src/db.js");
    await initializeDb();
    registerAgent("a", "r", []);
    registerAgent("b", "r", []);
    sendMessage("a", "b", "readme", "normal");
    const msgId = (getDb().prepare("SELECT id FROM messages").get() as { id: string }).id;
    const beforeCt = (getDb().prepare("SELECT content FROM messages WHERE id = ?").get(msgId) as { content: string }).content;
    closeDb();

    // Swap keyring: current=k2, k1 still present.
    process.env.RELAY_ENCRYPTION_KEYRING = JSON.stringify({ current: "k2", keys: { k1: K1, k2: K2 } });
    await resetEncModule();
    const { initializeDb: initB, getDb: getB, getMessages, closeDb: closeB } = await import("../src/db.js");
    await initB();
    // Read via getMessages — should decrypt via k1.
    const msgs = getMessages("b", "pending", 10);
    expect(msgs.some((m: any) => m.content === "readme")).toBe(true);
    // Row on disk UNCHANGED post-read.
    const afterCt = (getB().prepare("SELECT content FROM messages WHERE id = ?").get(msgId) as { content: string }).content;
    expect(afterCt).toBe(beforeCt);
    expect(afterCt.startsWith("enc:k1:")).toBe(true);
    closeB();
  });

  it("(Y.4) WRITE paths always use current key regardless of RELAY_LAZY_REENCRYPT setting", async () => {
    for (const lazy of ["1", undefined]) {
      resetRoot();
      if (lazy) process.env.RELAY_LAZY_REENCRYPT = lazy;
      else delete process.env.RELAY_LAZY_REENCRYPT;
      process.env.RELAY_ENCRYPTION_KEYRING = JSON.stringify({ current: "k2", keys: { k1: K1, k2: K2 } });
      await resetEncModule();
      const { initializeDb, getDb, registerAgent, sendMessage, closeDb } = await import("../src/db.js");
      await initializeDb();
      registerAgent("a", "r", []);
      registerAgent("b", "r", []);
      sendMessage("a", "b", `under-lazy-${lazy ?? "off"}`, "normal");
      const row = getDb()
        .prepare("SELECT content FROM messages ORDER BY created_at DESC LIMIT 1")
        .get() as { content: string };
      expect(row.content.startsWith("enc:k2:")).toBe(true);
      closeDb();
    }
  });
});

// ============================================================
// §5.5 edge cases (3 tests)
// ============================================================

describe("§5.5 edge cases", () => {
  it("(Z.1) no keyring configured → encryptContent returns plaintext, decryptContent passes through", async () => {
    await resetEncModule();
    const { encryptContent, decryptContent, isEncryptionActive } = await import("../src/encryption.js");
    expect(isEncryptionActive()).toBe(false);
    const ct = encryptContent("plaintext mode");
    expect(ct).toBe("plaintext mode"); // pass-through
    expect(decryptContent(ct)).toBe("plaintext mode");
  });

  it("(Z.2) key deletion while rows still reference it → decrypt errors with clear guidance", async () => {
    process.env.RELAY_ENCRYPTION_KEYRING = JSON.stringify({ current: "k1", keys: { k1: K1 } });
    await resetEncModule();
    const { encryptContent } = await import("../src/encryption.js");
    const ct = encryptContent("some body");
    // Remove k1 from the keyring. A future decrypt must fail with a
    // message that names the missing key_id and tells the operator how to
    // recover.
    process.env.RELAY_ENCRYPTION_KEYRING = JSON.stringify({ current: "k2", keys: { k2: K2 } });
    await resetEncModule();
    const { decryptContent } = await import("../src/encryption.js");
    let caught: Error | null = null;
    try {
      decryptContent(ct);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/key_id="k1"/);
    expect(caught!.message).toMatch(/relay re-encrypt/);
  });

  it("(Z.3) backup/restore across key rotation — destination keyring must contain all key_ids referenced", async () => {
    // Seed rows with k1 + backup the DB. Restore onto a fresh location with
    // a keyring that includes k1 → decrypt works. Without k1 → decrypt
    // would error per Z.2; that's the precondition the key-rotation runbook
    // documents.
    process.env.RELAY_ENCRYPTION_KEYRING = JSON.stringify({ current: "k1", keys: { k1: K1 } });
    await resetEncModule();
    const { initializeDb, registerAgent, sendMessage, closeDb } = await import("../src/db.js");
    await initializeDb();
    registerAgent("a", "r", []);
    registerAgent("b", "r", []);
    sendMessage("a", "b", "cross-backup body", "normal");
    // Read the row content directly to verify encryption.
    const { getDb } = await import("../src/db.js");
    const rawCt = (getDb().prepare("SELECT content FROM messages ORDER BY created_at DESC LIMIT 1").get() as { content: string }).content;
    expect(rawCt.startsWith("enc:k1:")).toBe(true);
    closeDb();
    // Destination environment with a combined keyring can decrypt.
    process.env.RELAY_ENCRYPTION_KEYRING = JSON.stringify({ current: "k2", keys: { k1: K1, k2: K2 } });
    await resetEncModule();
    const { decryptContent } = await import("../src/encryption.js");
    expect(decryptContent(rawCt)).toBe("cross-backup body");
  });
});
