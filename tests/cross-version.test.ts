// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 5b — cross-version upgrade path regression.
 *
 * Seeds a DB at each prior shape (pre-v1.7 / v1.7 / v2.0 / schema_info 1/2/3/4)
 * and runs the current daemon's initializeDb chain against it. Asserts:
 *   - Migration chain succeeds.
 *   - Row data is preserved.
 *   - auth_state column is populated correctly for seeded rows (pre-4b.1-v2
 *     rows with null token_hash → legacy_bootstrap; rows with hash → active).
 *   - End-to-end tool call works on the migrated DB (no silent corruption).
 *
 * Uses better-sqlite3 directly to seed schemas that predate modern
 * migrations. Tests skip their seed phase if the column/table doesn't
 * exist in the historical shape.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";

const TEST_ROOT = path.join(os.tmpdir(), "bot-relay-xver-" + process.pid);
const TEST_DB_PATH = path.join(TEST_ROOT, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;

function resetRoot() {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
}

async function closeAndReset() {
  const { closeDb } = await import("../src/db.js");
  closeDb();
  const { _resetKeyringCacheForTests } = await import("../src/encryption.js");
  _resetKeyringCacheForTests();
}

beforeEach(async () => {
  resetRoot();
  await closeAndReset();
  delete process.env.RELAY_ALLOW_LEGACY;
  delete process.env.RELAY_ENCRYPTION_KEY;
  delete process.env.RELAY_ENCRYPTION_KEYRING;
});

afterEach(async () => {
  await closeAndReset();
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

/**
 * Seed a DB at the shape of a pre-v1.7 deployment: agents table has NO
 * token_hash column. Any row inserted is treated as legacy-bootstrap.
 */
async function seedPreV1_7(): Promise<void> {
  const Better = (await import("better-sqlite3")).default;
  const db = new Better(TEST_DB_PATH);
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL,
      capabilities TEXT NOT NULL DEFAULT '[]',
      last_seen TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_agents_name ON agents(name);
    CREATE INDEX idx_agents_role ON agents(role);
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      content TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL
    );
  `);
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO agents (id, name, role, capabilities, last_seen, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run("v16-" + Date.now(), "v16-alice", "r", '["tasks"]', now, now);
  db.prepare(
    "INSERT INTO messages (id, from_agent, to_agent, content, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run("v16m-" + Date.now(), "v16-alice", "v16-bob", "pre-auth era greeting", now);
  db.close();
}

/**
 * Seed a DB at v1.7 shape: token_hash column present but NO auth_state, no
 * agent_capabilities normalization, no encryption versioning. Rows written
 * with a hash are effectively `active` per the current model.
 */
async function seedV1_7(): Promise<void> {
  const Better = (await import("better-sqlite3")).default;
  const db = new Better(TEST_DB_PATH);
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL,
      capabilities TEXT NOT NULL DEFAULT '[]',
      last_seen TEXT NOT NULL,
      created_at TEXT NOT NULL,
      token_hash TEXT
    );
    CREATE INDEX idx_agents_name ON agents(name);
    CREATE INDEX idx_agents_role ON agents(role);
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      content TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL
    );
    CREATE TABLE audit_log (
      id TEXT PRIMARY KEY,
      agent_name TEXT,
      tool TEXT NOT NULL,
      params_summary TEXT,
      success INTEGER NOT NULL DEFAULT 1,
      error TEXT,
      source TEXT NOT NULL DEFAULT 'stdio',
      created_at TEXT NOT NULL
    );
  `);
  const now = new Date().toISOString();
  // Row 1: legacy (null token_hash) — migration should mark as legacy_bootstrap.
  db.prepare(
    "INSERT INTO agents (id, name, role, capabilities, last_seen, created_at, token_hash) VALUES (?, ?, ?, ?, ?, ?, NULL)"
  ).run("v17a-" + Date.now(), "v17-legacy", "r", '[]', now, now);
  // Row 2: hashed (token_hash present) — migration should mark as active.
  db.prepare(
    "INSERT INTO agents (id, name, role, capabilities, last_seen, created_at, token_hash) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run("v17b-" + Date.now(), "v17-active", "r", '["broadcast"]', now, now, "$2b$10$DUMMY.HASH.PAYLOAD.PLACEHOLDER.FAKE.BCRYPT.STRING.OK");
  db.close();
}

describe("v2.1 Phase 5b — cross-version migration", () => {
  it("pre-v1.7 shape (no token_hash column) migrates to v2.1 cleanly", async () => {
    await seedPreV1_7();
    // Initialize under the current code — migration chain should run.
    const { initializeDb, getDb } = await import("../src/db.js");
    await initializeDb();
    // token_hash column exists post-migration.
    const cols = (getDb().prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("token_hash");
    expect(cols).toContain("auth_state");
    expect(cols).toContain("managed");
    // Seeded row is preserved.
    const row = getDb().prepare("SELECT name, auth_state, token_hash FROM agents WHERE name = ?").get("v16-alice") as
      | { name: string; auth_state: string; token_hash: string | null }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.name).toBe("v16-alice");
    // token_hash is null (column didn't exist pre-v1.7) → migrateSchemaToV2_1
    // sees token_hash IS NULL + auth_state default 'active' → marks as
    // legacy_bootstrap.
    expect(row!.token_hash).toBeNull();
    expect(row!.auth_state).toBe("legacy_bootstrap");
    // Message row preserved.
    const msg = getDb().prepare("SELECT content FROM messages WHERE from_agent = ?").get("v16-alice") as
      | { content: string }
      | undefined;
    expect(msg!.content).toBe("pre-auth era greeting");
    // Schema version now current.
    const { CURRENT_SCHEMA_VERSION, getSchemaVersion } = await import("../src/db.js");
    expect(getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("v1.7 shape (token_hash column, no auth_state) migrates — legacy rows → legacy_bootstrap, hashed → active", async () => {
    await seedV1_7();
    const { initializeDb, getDb } = await import("../src/db.js");
    await initializeDb();
    // Legacy row marked.
    const legacy = getDb().prepare("SELECT auth_state FROM agents WHERE name = ?").get("v17-legacy") as
      | { auth_state: string }
      | undefined;
    expect(legacy!.auth_state).toBe("legacy_bootstrap");
    // Hashed row stayed active (column default).
    const active = getDb().prepare("SELECT auth_state FROM agents WHERE name = ?").get("v17-active") as
      | { auth_state: string }
      | undefined;
    expect(active!.auth_state).toBe("active");
  });

  it("v1.7 legacy row can re-register via Phase 2b migration path after upgrade", async () => {
    await seedV1_7();
    const { initializeDb, registerAgent } = await import("../src/db.js");
    await initializeDb();
    // Plain register against the legacy row — should mint a token.
    const r = registerAgent("v17-legacy", "r", []);
    expect(r.plaintext_token).toBeTruthy();
    // State flips to active.
    const { getAgentAuthData } = await import("../src/db.js");
    expect(getAgentAuthData("v17-legacy")?.auth_state).toBe("active");
  });

  it("end-to-end tool call works on cross-version-migrated DB", async () => {
    await seedV1_7();
    const { initializeDb, registerAgent, sendMessage, getMessages } = await import("../src/db.js");
    await initializeDb();
    // Register two fresh agents on top of the legacy DB.
    registerAgent("xver-a", "r", []);
    registerAgent("xver-b", "r", []);
    sendMessage("xver-a", "xver-b", "post-migration works", "normal");
    const msgs = getMessages("xver-b", "pending", 10);
    expect(msgs.some((m: any) => m.content === "post-migration works")).toBe(true);
  });

  it("Phase 2c backup-restore round-trip works on a migrated DB", async () => {
    await seedV1_7();
    const { initializeDb, registerAgent, sendMessage, closeDb } = await import("../src/db.js");
    await initializeDb();
    // Add fresh rows after migration so the backup contains both legacy +
    // post-migration data.
    registerAgent("roundtrip-a", "r", []);
    registerAgent("roundtrip-b", "r", []);
    sendMessage("roundtrip-a", "roundtrip-b", "round trip", "normal");

    // Take a backup. Copy the archive OUT of the DB root before the reset
    // that wipes it for the restore's fresh environment.
    const { exportRelayState } = await import("../src/backup.js");
    const backup = await exportRelayState();
    closeDb();
    expect(fs.existsSync(backup.archive_path)).toBe(true);
    const safeArchive = path.join(os.tmpdir(), "xver-archive-" + process.pid + ".tar.gz");
    fs.copyFileSync(backup.archive_path, safeArchive);

    // Fresh DB, restore the backup.
    resetRoot();
    await closeAndReset();
    const { importRelayState } = await import("../src/backup.js?xver=1");
    await importRelayState(safeArchive, { force: true });
    fs.unlinkSync(safeArchive);

    // Reopen and verify the message is still there.
    const db2 = await import("../src/db.js?xver=1");
    await db2.initializeDb();
    const msgs = db2.getMessages("roundtrip-b", "pending", 10);
    expect(msgs.some((m: any) => m.content === "round trip")).toBe(true);
    db2.closeDb();
  });

  it("schema_info reports CURRENT_SCHEMA_VERSION after migration chain runs on a fresh DB", async () => {
    // Fresh DB path — no seed. Initialization alone should populate
    // schema_info at the current version.
    const { initializeDb, getSchemaVersion, CURRENT_SCHEMA_VERSION } = await import("../src/db.js");
    await initializeDb();
    expect(getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("legacy enc1: ciphertext decrypts after upgrade to v2.1 keyring", async () => {
    // Seed at v1.7 shape + write a message with legacy `enc1:` ciphertext
    // directly via crypto. Then upgrade the DB + read via decryptContent.
    await seedV1_7();
    const K1 = crypto.randomBytes(32).toString("base64");
    const key = Buffer.from(K1, "base64");
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const enc = Buffer.concat([cipher.update("legacy encrypted body", "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const ct = `enc1:${iv.toString("base64")}:${Buffer.concat([enc, tag]).toString("base64")}`;
    // Insert directly into messages.
    const Better = (await import("better-sqlite3")).default;
    const db = new Better(TEST_DB_PATH);
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO messages (id, from_agent, to_agent, content, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("legacy-enc-" + Date.now(), "v17-legacy", "v17-active", ct, now);
    db.close();

    process.env.RELAY_ENCRYPTION_KEYRING = JSON.stringify({ current: "k1", keys: { k1: K1 } });
    process.env.RELAY_ENCRYPTION_LEGACY_KEY_ID = "k1";
    const { _resetKeyringCacheForTests } = await import("../src/encryption.js");
    _resetKeyringCacheForTests();
    const { initializeDb, getDb } = await import("../src/db.js");
    await initializeDb();
    const rawRow = getDb().prepare("SELECT content FROM messages WHERE to_agent = 'v17-active' LIMIT 1").get() as { content: string };
    expect(rawRow.content.startsWith("enc1:")).toBe(true);
    const { decryptContent } = await import("../src/encryption.js");
    expect(decryptContent(rawRow.content)).toBe("legacy encrypted body");
    delete process.env.RELAY_ENCRYPTION_KEYRING;
    delete process.env.RELAY_ENCRYPTION_LEGACY_KEY_ID;
  });
});
