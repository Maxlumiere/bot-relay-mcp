// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * SEC-23: no backup contains an encryption KEY, a raw TOKEN or the mint secret. A secret the operator keeps in
 * PLAINTEXT in the DB (no-key mode: webhook_subscriptions.secret) is carried and STATED, loudly, with its count, in
 * stderr, the export result and the manifest, naming the remedy.
 *
 * - The archived config.json is SERIALIZED through one classification of every RelayConfig field: a secret (a
 *   shared bearer credential is a raw token by function) is set to null and listed as redacted; an unknown key is
 *   DROPPED and listed by name only. A meta-test fails when a RelayConfig field has no classification.
 * - The manifest records, per key id the DB's ciphertext needs, the id, its row count and a fingerprint
 *   (HMAC-SHA256(key, "bot-relay backup key fingerprint v1"), 128 bits): never the key.
 * - Restore, in staging and before ANY live mutation, takes the needed key ids from the STAGED DB's own ciphertext
 *   (not the manifest alone: it may be stale, and an old archive has none), and refuses, by name, a key id the
 *   keyring lacks, a fingerprint that does not match, or a staged row that does not decrypt (the AEAD tag is the
 *   ground truth, which also covers an old archive with no fingerprint).
 * - The archive is owner-only on every OS.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { craftTar, gzip } from "./_helpers/ustar.js";

const ROOT = path.join(fs.realpathSync(os.tmpdir()), `sec-23-${process.pid}`);
const DB_PATH = path.join(ROOT, "relay.db");
const CONFIG_PATH = path.join(ROOT, "config.json");
const ENV_KEYS = [
  "RELAY_DB_PATH",
  "RELAY_CONFIG_PATH",
  "RELAY_HTTP_PORT",
  "RELAY_ENCRYPTION_KEYRING",
  "RELAY_ENCRYPTION_KEYRING_PATH",
  "RELAY_ENCRYPTION_KEY",
  "RELAY_ENCRYPTION_LEGACY_KEY_ID",
] as const;
const FP_LABEL = "bot-relay backup key fingerprint v1";
const ZERO_REASONS = { no_keyring: 0, key_not_held: 0, auth_failed: 0, keyring_unreadable: 0 };

const newKey = (): Buffer => crypto.randomBytes(32);
const fingerprintOf = (key: Buffer): string => crypto.createHmac("sha256", key).update(FP_LABEL).digest().subarray(0, 16).toString("hex");

async function useKeyring(keys: Record<string, Buffer> | null, current?: string): Promise<void> {
  if (keys === null) delete process.env.RELAY_ENCRYPTION_KEYRING;
  else {
    const b64: Record<string, string> = {};
    for (const [id, k] of Object.entries(keys)) b64[id] = k.toString("base64");
    process.env.RELAY_ENCRYPTION_KEYRING = JSON.stringify({ current: current ?? Object.keys(keys)[0], keys: b64 });
  }
  const { _resetKeyringCacheForTests } = await import("../src/encryption.js");
  _resetKeyringCacheForTests();
}

/** A live DB with a message, a task and a webhook (its secret), written under whatever keyring is set now. */
async function seed(webhookSecret = "whsec-" + crypto.randomBytes(8).toString("hex")): Promise<void> {
  const db = await import("../src/db.js");
  await db.initializeDb();
  db.registerAgent("alpha", "r", []);
  db.registerAgent("beta", "r", []);
  db.sendMessage("alpha", "beta", "a private message body", "normal");
  db.registerWebhook("https://example.com/hook", "message.sent", undefined, webhookSecret);
}

/** Both forms of the archive's bytes: as written (gzip) and decompressed. */
function archiveBytes(p: string): { gz: Buffer; plain: Buffer } {
  const gz = fs.readFileSync(p);
  return { gz, plain: zlib.gunzipSync(gz) };
}
function holds(bytes: { gz: Buffer; plain: Buffer }, needle: string): boolean {
  return bytes.gz.includes(Buffer.from(needle)) || bytes.plain.includes(Buffer.from(needle));
}
/** The archive's manifest.json, read from the decompressed ustar bytes (the member's data follows its 512-byte header). */
function manifestOf(plain: Buffer): Record<string, unknown> {
  for (let off = 0; off + 512 <= plain.length; ) {
    const name = plain.subarray(off, off + 100).toString("latin1").replace(/\0.*$/s, "");
    if (!name) break;
    const size = parseInt(plain.subarray(off + 124, off + 136).toString("latin1").replace(/\0.*$/s, "").trim() || "0", 8);
    if (name === "manifest.json") return JSON.parse(plain.subarray(off + 512, off + 512 + size).toString("utf-8"));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error("no manifest.json in the archive");
}
function memberOf(plain: Buffer, member: string): string | null {
  for (let off = 0; off + 512 <= plain.length; ) {
    const name = plain.subarray(off, off + 100).toString("latin1").replace(/\0.*$/s, "");
    if (!name) break;
    const size = parseInt(plain.subarray(off + 124, off + 136).toString("latin1").replace(/\0.*$/s, "").trim() || "0", 8);
    if (name === member) return plain.subarray(off + 512, off + 512 + size).toString("utf-8");
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

let saved: Record<string, string | undefined>;
beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  process.env.RELAY_DB_PATH = DB_PATH;
  process.env.RELAY_CONFIG_PATH = CONFIG_PATH;
  process.env.RELAY_HTTP_PORT = "1";
  const { closeDb } = await import("../src/db.js");
  closeDb();
  await useKeyring(null);
});
afterEach(async () => {
  const { closeDb } = await import("../src/db.js");
  closeDb();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const { _resetKeyringCacheForTests } = await import("../src/encryption.js");
  _resetKeyringCacheForTests();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

const preRestoreBackups = (): string[] => {
  const dir = path.join(ROOT, "backups");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith("pre-restore-")) : [];
};

/** Restore `archive` into a FRESH live DB (written under the keyring set now) and assert the refusal left no trace. */
async function expectRefusedBeforeAnyMutation(archive: string, pattern: RegExp): Promise<void> {
  const db = (await import("../src/db.js")) as typeof import("../src/db.js") & { peekDb: () => unknown };
  db.closeDb();
  fs.rmSync(DB_PATH, { force: true });
  for (const s of ["-wal", "-shm"]) fs.rmSync(DB_PATH + s, { force: true });
  await db.initializeDb();
  db.registerAgent("live-only", "r", []);
  const handle = db.peekDb();
  const { importRelayState } = await import("../src/backup.js");
  await expect(importRelayState(archive, { force: true })).rejects.toThrow(pattern);
  expect(preRestoreBackups(), "no safety backup was made").toEqual([]);
  expect(db.peekDb(), "the live connection is the same, still open").toBe(handle);
  expect(db.getAgents().map((a: { name: string }) => a.name), "the live data is unchanged").toContain("live-only");
}

describe("SEC-23: what a backup carries, and what it states", () => {
  it("no-key mode: the plaintext webhook secrets are STATED with their count, in stderr, the export result and the manifest, naming the remedy", async () => {
    await seed("whsec-plain-1");
    const db = await import("../src/db.js");
    db.registerWebhook("https://example.com/hook2", "task.posted", undefined, "whsec-plain-2");
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (c: unknown, ...a: unknown[]) => boolean }).write = (c: unknown, ...a: unknown[]) => {
      writes.push(String(c));
      return orig(c as string, ...(a as []));
    };
    let exp: Record<string, unknown>;
    try {
      const { exportRelayState } = await import("../src/backup.js");
      exp = (await exportRelayState({ destinationPath: path.join(ROOT, "nokey.tar.gz") })) as unknown as Record<string, unknown>;
    } finally {
      (process.stderr as unknown as { write: typeof orig }).write = orig;
    }
    const stated = writes.join("");
    expect(stated, "stderr states the count").toMatch(/2 webhook secrets? .*PLAINTEXT/i);
    expect(stated, "stderr names the remedy").toMatch(/keyring/i);
    expect(exp.webhook_secrets, "the export result states the count").toEqual({ plaintext: 2, encrypted: 0, unverifiable: 0, unverifiable_reasons: ZERO_REASONS });
    expect((exp.warnings as string[] | undefined)?.join(" ") ?? "", "the export result carries the warning").toMatch(/2 webhook secrets? .*PLAINTEXT.*keyring/i);
    const manifest = manifestOf(archiveBytes(String(exp.archive_path)).plain);
    expect(manifest.webhook_secrets, "the manifest states the count").toEqual({ plaintext: 2, encrypted: 0, unverifiable: 0, unverifiable_reasons: ZERO_REASONS });
  });

  it("known-good twin: with a keyring, the webhook secrets are encrypted, so NONE is stated as plaintext, and no secret value is in the archive", async () => {
    await useKeyring({ k1: newKey() });
    await seed("whsec-encrypted-value");
    const { exportRelayState } = await import("../src/backup.js");
    const exp = (await exportRelayState({ destinationPath: path.join(ROOT, "keyed.tar.gz") })) as unknown as Record<string, unknown>;
    expect(exp.webhook_secrets, "a real encrypted secret with its key: encrypted 1").toEqual({ plaintext: 0, encrypted: 1, unverifiable: 0, unverifiable_reasons: ZERO_REASONS });
    expect(exp.warnings, "no warning").toEqual([]);
    expect(holds(archiveBytes(String(exp.archive_path)), "whsec-encrypted-value")).toBe(false);
  });

  it("the manifest records each NEEDED key id with its row count and fingerprint, never the key", async () => {
    const k1 = newKey();
    await useKeyring({ k1 });
    await seed();
    const { exportRelayState } = await import("../src/backup.js");
    const exp = (await exportRelayState({ destinationPath: path.join(ROOT, "fp.tar.gz") })) as unknown as Record<string, unknown>;
    const bytes = archiveBytes(String(exp.archive_path));
    const manifest = manifestOf(bytes.plain) as { encryption?: { keys?: Array<{ key_id: string; rows: number; fingerprint: string }> } };
    const k = manifest.encryption?.keys ?? [];
    expect(k.map((e) => e.key_id)).toEqual(["k1"]);
    expect(k[0]?.rows, "a message and a webhook secret, at least").toBeGreaterThanOrEqual(2);
    expect(k[0]?.fingerprint).toBe(fingerprintOf(k1));
    expect(exp.encryption, "the export result states it too").toEqual(manifest.encryption);
    for (const form of [k1.toString("base64"), k1.toString("hex")]) expect(holds(bytes, form), "the key is not in the archive").toBe(false);
    expect(bytes.plain.includes(k1), "the raw key bytes are not in the archive").toBe(false);
  });

  it("the archived config: the 4 bearer secrets are REDACTED, an unknown key is DROPPED (named, never valued); no value is anywhere in the archive bytes", async () => {
    const secrets = {
      http_secret: "S1-" + crypto.randomBytes(20).toString("hex"),
      http_secrets_previous: ["S2-" + crypto.randomBytes(20).toString("hex")],
      dashboard_secret: "S3-" + crypto.randomBytes(20).toString("hex"),
      dashboard_push_secret: "S4-" + crypto.randomBytes(20).toString("hex"),
    };
    const canary = "CANARY-" + crypto.randomBytes(12).toString("hex");
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ http_port: 4123, trusted_proxies: ["10.0.0.0/8"], ...secrets, made_up_key: canary }));
    await seed();
    const { exportRelayState } = await import("../src/backup.js");
    const exp = (await exportRelayState({ destinationPath: path.join(ROOT, "cfg.tar.gz") })) as unknown as Record<string, unknown>;
    const bytes = archiveBytes(String(exp.archive_path));
    for (const v of [secrets.http_secret, secrets.http_secrets_previous[0], secrets.dashboard_secret, secrets.dashboard_push_secret, canary]) {
      expect(holds(bytes, v), `${v.slice(0, 3)}… is not in the archive (gz or plain)`).toBe(false);
    }
    const cfg = JSON.parse(memberOf(bytes.plain, "config.json") ?? "null") as Record<string, unknown>;
    expect(cfg.http_secret).toBeNull();
    expect(cfg.http_secrets_previous).toBeNull();
    expect(cfg.dashboard_secret).toBeNull();
    expect(cfg.dashboard_push_secret).toBeNull();
    expect("made_up_key" in cfg, "the unknown key is dropped").toBe(false);
    const manifest = manifestOf(bytes.plain) as { config?: { redacted?: string[]; dropped?: string[] } };
    expect(manifest.config?.redacted?.slice().sort()).toEqual(["dashboard_push_secret", "dashboard_secret", "http_secret", "http_secrets_previous"]);
    expect(manifest.config?.dropped).toEqual(["made_up_key"]);
    expect(exp.config, "the export result lists them too").toEqual(manifest.config);
    // The known-good twin: the non-secret fields survive, unchanged.
    expect(cfg.http_port).toBe(4123);
    expect(cfg.trusted_proxies).toEqual(["10.0.0.0/8"]);
  });

  it("the archived config: an UNKNOWN key (a made-up key with a unique value) is DROPPED; its value is nowhere in the archive bytes, its name is listed", async () => {
    const canary = "UNKNOWN-KEY-CANARY-" + crypto.randomBytes(12).toString("hex");
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ http_port: 4124, zz_not_a_relay_field: canary }));
    await seed();
    const { exportRelayState } = await import("../src/backup.js");
    const exp = (await exportRelayState({ destinationPath: path.join(ROOT, "canary.tar.gz") })) as unknown as Record<string, unknown>;
    const bytes = archiveBytes(String(exp.archive_path));
    expect(holds(bytes, canary), "the canary value is not in the archive (gz or plain)").toBe(false);
    const manifest = manifestOf(bytes.plain) as { config?: { dropped?: string[] } };
    expect(manifest.config?.dropped, "dropped, by name").toEqual(["zz_not_a_relay_field"]);
    expect(JSON.parse(memberOf(bytes.plain, "config.json") ?? "null").http_port, "the twin: a known field survives").toBe(4124);
  });

  it("the mint secret is not in the archive (a PIN: the 3 fixed members already exclude it)", async () => {
    const mintValue = "MINT-" + crypto.randomBytes(16).toString("hex");
    fs.mkdirSync(path.join(ROOT, "secrets"), { recursive: true });
    fs.writeFileSync(path.join(ROOT, "secrets", "mint.secret"), mintValue);
    await seed();
    const { exportRelayState } = await import("../src/backup.js");
    const exp = await exportRelayState({ destinationPath: path.join(ROOT, "mint.tar.gz") });
    expect(holds(archiveBytes(exp.archive_path), mintValue)).toBe(false);
  });

  it("the archive is owner-only on every OS: POSIX mode 0600 (a PIN, already written so); Windows, no allow ACE but the owner's and SYSTEM's", async () => {
    await seed();
    const { exportRelayState } = await import("../src/backup.js");
    const exp = await exportRelayState({ destinationPath: path.join(ROOT, "mode.tar.gz") });
    const { privacyFaults } = await import("../src/fs-perms.js");
    expect(privacyFaults(exp.archive_path, 0o600)).toEqual([]);
  });

  it.skipIf(process.platform !== "win32")("Windows: an archive written into a directory whose ACL grants others (an inherited BUILTIN\\Users allow ACE) is still owner-only", async () => {
    const shared = path.join(ROOT, "shared");
    fs.mkdirSync(shared);
    const icacls = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");
    const grant = spawnSync(icacls, [shared, "/grant", "*S-1-5-32-545:(OI)(CI)(RX)"], { encoding: "utf-8" });
    expect(grant.status, `icacls /grant: ${grant.stderr}`).toBe(0);
    const { privacyFaults } = await import("../src/fs-perms.js");
    expect(privacyFaults(shared, 0o700).join(" "), "the setup reaches the target: the dir really grants a foreign SID").toMatch(/S-1-5-32-545/);
    await seed();
    const { exportRelayState } = await import("../src/backup.js");
    const exp = await exportRelayState({ destinationPath: path.join(shared, "inherited.tar.gz") });
    expect(privacyFaults(exp.archive_path, 0o600)).toEqual([]);
  });

  it("meta: every RelayConfig field has a classification for the archive (a new field without one fails here)", async () => {
    const { CONFIG_ARCHIVE_CLASS } = (await import("../src/backup-secrets.js")) as { CONFIG_ARCHIVE_CLASS: Record<string, string> };
    const { DEFAULT_CONFIG } = await import("../src/config.js");
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "config.ts"), "utf-8");
    const body = src.slice(src.indexOf("export interface RelayConfig {"), src.indexOf("export const DEFAULT_CONFIG"));
    const declared = [...body.matchAll(/^ {2}([a-z_]+)\??:/gm)].map((m) => m[1]).sort();
    expect(declared.length, "the interface was parsed (a vacuous empty list would pass)").toBeGreaterThan(10);
    expect(Object.keys(DEFAULT_CONFIG).sort(), "the defaults name the same fields").toEqual(declared);
    expect(Object.keys(CONFIG_ARCHIVE_CLASS).sort()).toEqual(declared);
    for (const [k, c] of Object.entries(CONFIG_ARCHIVE_CLASS)) expect(["secret", "copy"], k).toContain(c);
    expect(Object.entries(CONFIG_ARCHIVE_CLASS).filter(([, c]) => c === "secret").map(([k]) => k).sort()).toEqual(["dashboard_push_secret", "dashboard_secret", "http_secret", "http_secrets_previous"]);
  });
});

describe("SEC-23: restore refuses, before any mutation, an archive this keyring cannot read", () => {
  it("REFUSED: a key id the keyring lacks (named)", async () => {
    await useKeyring({ k1: newKey() });
    await seed();
    const { exportRelayState } = await import("../src/backup.js");
    const exp = await exportRelayState({ destinationPath: path.join(ROOT, "a.tar.gz") });
    await useKeyring({ k2: newKey() });
    await expectRefusedBeforeAnyMutation(exp.archive_path, /key id.*k1.*not (in|held)/i);
  });

  it("REFUSED: the keyring holds the id, but the key's fingerprint is not the manifest's", async () => {
    await useKeyring({ k1: newKey() });
    await seed();
    const { exportRelayState } = await import("../src/backup.js");
    const exp = await exportRelayState({ destinationPath: path.join(ROOT, "b.tar.gz") });
    await useKeyring({ k1: newKey() }); // the same id, a different key
    await expectRefusedBeforeAnyMutation(exp.archive_path, /fingerprint/i);
  });

  it("REFUSED: an OLD archive (no fingerprints in its manifest) under the wrong key: the decrypt probe refuses", async () => {
    await useKeyring({ k1: newKey() });
    await seed();
    const { exportRelayState } = await import("../src/backup.js");
    const exp = await exportRelayState({ destinationPath: path.join(ROOT, "c.tar.gz") });
    const old = path.join(ROOT, "c-old.tar.gz");
    stripManifestEncryption(exp.archive_path, old);
    await useKeyring({ k1: newKey() });
    await expectRefusedBeforeAnyMutation(old, /decrypt/i);
  });

  it("known-good twin: the RIGHT key proceeds (fingerprint and probe pass), and the restored rows decrypt", async () => {
    const k1 = newKey();
    await useKeyring({ k1 });
    await seed("whsec-restored-secret");
    const { exportRelayState, importRelayState } = await import("../src/backup.js");
    const exp = await exportRelayState({ destinationPath: path.join(ROOT, "d.tar.gz") });
    // Change the live data AFTER the export, so a restore that did nothing cannot pass.
    const db = await import("../src/db.js");
    db.registerAgent("after-export", "r", []);
    db.sendMessage("alpha", "beta", "written after the export", "normal");
    db.registerWebhook("https://example.com/after", "task.posted", undefined, "whsec-after-export");
    const imp = await importRelayState(exp.archive_path, { force: true });
    expect(imp.restored).toBe(true);
    // Reopen the RESTORED DB and read the seeded rows through the relay's own decrypting paths.
    db.closeDb();
    await db.initializeDb();
    expect(db.getMessages("beta", "all", 10, true).map((m: { content: string }) => m.content)).toEqual(["a private message body"]);
    expect(db.listWebhooks().map((w: { secret: string | null }) => w.secret)).toEqual(["whsec-restored-secret"]);
    expect(db.getAgents().map((a: { name: string }) => a.name), "the post-export agent is gone").not.toContain("after-export");
  });

  it("known-good twin: an OLD archive under the RIGHT key proceeds (the probe is the ground truth)", async () => {
    const k1 = newKey();
    await useKeyring({ k1 });
    await seed();
    const { exportRelayState, importRelayState } = await import("../src/backup.js");
    const exp = await exportRelayState({ destinationPath: path.join(ROOT, "e.tar.gz") });
    const old = path.join(ROOT, "e-old.tar.gz");
    stripManifestEncryption(exp.archive_path, old);
    const imp = await importRelayState(old, { force: true });
    expect(imp.restored).toBe(true);
  });
});

/** A well-formed v2 ciphertext under `keyId` (the structure decryptContent accepts), but encrypted under no real key. */
const fakeCiphertext = (keyId: string): string => `enc:${keyId}:${crypto.randomBytes(12).toString("base64")}:${crypto.randomBytes(32).toString("base64")}`;
async function insertMessageRow(content: string): Promise<void> {
  const db = await import("../src/db.js");
  db.getDb()
    .prepare("INSERT INTO messages (id, from_agent, to_agent, content, priority, status, created_at) VALUES (?, 'alpha', 'beta', ?, 'normal', 'read', ?)")
    .run("m-" + crypto.randomBytes(6).toString("hex"), content, new Date().toISOString());
}
type Keys = Array<{ key_id: string; rows: number; fingerprint: string | null }>;
async function exportedKeys(name: string): Promise<{ keys: Keys; archive: string }> {
  const { exportRelayState } = await import("../src/backup.js");
  const exp = await exportRelayState({ destinationPath: path.join(ROOT, name) });
  const m = manifestOf(archiveBytes(exp.archive_path).plain) as { encryption?: { keys?: Keys } };
  return { keys: m.encryption?.keys ?? [], archive: exp.archive_path };
}
const reEscape = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("SEC-23 R1: the needed-key scan sees every key id, in every column, counted right", () => {
  it.each(["constructor", "toString", "__proto__"])("a key id that is an Object.prototype name (%s) is NEEDED: exported with its count, and restore refuses it before any mutation", async (id) => {
    await seed();
    await insertMessageRow(fakeCiphertext(id));
    const { keys, archive } = await exportedKeys(`proto-${id.replace(/_/g, "u")}.tar.gz`);
    expect(keys.filter((k) => k.key_id === id), `${id} is in the manifest`).toEqual([{ key_id: id, rows: 1, fingerprint: null, fingerprint_reason: "no_keyring" }]);
    await useKeyring({ k1: newKey() });
    await expectRefusedBeforeAnyMutation(archive, new RegExp(`key id.*${reEscape(id)}.*not held`, "i"));
  });

  it("the wasm driver STREAMS the scan: its statement steps row by row (iterate), yielding exactly what all() returns, and the scan agrees with native", async () => {
    await useKeyring({ k1: newKey() });
    await seed();
    const db = await import("../src/db.js");
    db.closeDb();
    const { openReadOnly } = await import("../src/sqlite-compat.js");
    const { scanCiphertextKeyIds } = await import("../src/backup-secrets.js");
    const wasm = await openReadOnly(DB_PATH, "wasm");
    const native = await openReadOnly(DB_PATH, "native");
    try {
      const stmt = wasm.prepare("SELECT name FROM agents ORDER BY name") as ReturnType<typeof wasm.prepare> & { iterate?: () => Iterable<unknown> };
      expect(typeof stmt.iterate, "the wasm statement can iterate").toBe("function");
      expect([...stmt.iterate!()]).toEqual(stmt.all());
      expect([...scanCiphertextKeyIds(wasm, "k1")].map(([id, v]) => [id, v.rows])).toEqual([...scanCiphertextKeyIds(native, "k1")].map(([id, v]) => [id, v.rows]));
    } finally {
      wasm.close();
      native.close();
    }
  });

  it("two rows under DIFFERENT key ids in a table whose own column is named `id`, sharing that id: both key ids, one row each", async () => {
    await seed();
    const db = await import("../src/db.js");
    db.getDb().exec("CREATE TABLE zz_dup (id TEXT, v TEXT)");
    db.getDb().prepare("INSERT INTO zz_dup (id, v) VALUES ('same', ?), ('same', ?)").run(fakeCiphertext("ka"), fakeCiphertext("kz"));
    const { keys } = await exportedKeys("dup.tar.gz");
    expect(keys.filter((k) => k.key_id === "ka" || k.key_id === "kz").map((k) => [k.key_id, k.rows])).toEqual([["ka", 1], ["kz", 1]]);
  });

  it("known-good twin: the same, with UNIQUE ids in that column", async () => {
    await seed();
    const db = await import("../src/db.js");
    db.getDb().exec("CREATE TABLE zz_uniq (id TEXT, v TEXT)");
    db.getDb().prepare("INSERT INTO zz_uniq (id, v) VALUES ('u1', ?), ('u2', ?)").run(fakeCiphertext("ka"), fakeCiphertext("kz"));
    const { keys } = await exportedKeys("uniq.tar.gz");
    expect(keys.filter((k) => k.key_id === "ka" || k.key_id === "kz").map((k) => [k.key_id, k.rows])).toEqual([["ka", 1], ["kz", 1]]);
  });

  it("a GENERATED column holding ciphertext is scanned too: its key id is needed, and restore refuses it before any mutation", async () => {
    await seed();
    const db = await import("../src/db.js");
    db.getDb().exec("CREATE TABLE zz_gen (raw TEXT, gen TEXT GENERATED ALWAYS AS ('enc:kgen:' || raw) STORED)");
    const body = fakeCiphertext("x").split(":").slice(2).join(":");
    db.getDb().prepare("INSERT INTO zz_gen (raw) VALUES (?)").run(body);
    const { keys, archive } = await exportedKeys("gen.tar.gz");
    expect(keys.filter((k) => k.key_id === "kgen").map((k) => k.rows)).toEqual([1]);
    await useKeyring({ k1: newKey() });
    await expectRefusedBeforeAnyMutation(archive, /key id.*kgen.*not held/i);
  });
});

describe("SEC-23 R1: the plaintext count counts only what is not a well-formed ciphertext", () => {
  it("no-key mode: a webhook secret that only LOOKS like ciphertext (`enc:…`, `enc1:…`) is carried as PLAINTEXT and counted", async () => {
    await seed("enc:not-ciphertext");
    const db = await import("../src/db.js");
    db.registerWebhook("https://example.com/hook3", "task.posted", undefined, "enc1:abc");
    const { exportRelayState } = await import("../src/backup.js");
    const exp = (await exportRelayState({ destinationPath: path.join(ROOT, "lookalike.tar.gz") })) as unknown as Record<string, unknown>;
    expect(exp.webhook_secrets).toEqual({ plaintext: 2, encrypted: 0, unverifiable: 0, unverifiable_reasons: ZERO_REASONS });
  });

  it("THREE states (ruled): a forged envelope `enc:k1:…` in no-key mode is UNVERIFIABLE (no keyring), never plaintext-0 or encrypted, and is warned about in stderr, the result and the manifest", async () => {
    await seed(fakeCiphertext("k1"));
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (c: unknown, ...a: unknown[]) => boolean }).write = (c: unknown, ...a: unknown[]) => {
      writes.push(String(c));
      return orig(c as string, ...(a as []));
    };
    let exp: Record<string, unknown>;
    try {
      const { exportRelayState } = await import("../src/backup.js");
      exp = (await exportRelayState({ destinationPath: path.join(ROOT, "forged.tar.gz") })) as unknown as Record<string, unknown>;
    } finally {
      (process.stderr as unknown as { write: typeof orig }).write = orig;
    }
    const want = { plaintext: 0, encrypted: 0, unverifiable: 1, unverifiable_reasons: { no_keyring: 1, key_not_held: 0, auth_failed: 0, keyring_unreadable: 0 } };
    expect(exp.webhook_secrets, "the export result").toEqual(want);
    expect(manifestOf(archiveBytes(String(exp.archive_path)).plain).webhook_secrets, "the manifest").toEqual(want);
    expect((exp.warnings as string[]).join(" "), "the result's warning").toMatch(/could NOT be verified.*no keyring/);
    expect(writes.join(""), "stderr").toMatch(/could NOT be verified.*no keyring/);
  });

  it("THREE states: a secret under a HELD key id but a DIFFERENT key is UNVERIFIABLE (authentication failed: corruption or the wrong key)", async () => {
    await useKeyring({ k1: newKey() });
    await seed("whsec-under-the-first-key");
    await useKeyring({ k1: newKey() }); // the same id, another key
    const { exportRelayState } = await import("../src/backup.js");
    const exp = (await exportRelayState({ destinationPath: path.join(ROOT, "wrongkey.tar.gz") })) as unknown as Record<string, unknown>;
    expect(exp.webhook_secrets).toEqual({ plaintext: 0, encrypted: 0, unverifiable: 1, unverifiable_reasons: { no_keyring: 0, key_not_held: 0, auth_failed: 1, keyring_unreadable: 0 } });
    expect((exp.warnings as string[]).join(" ")).toMatch(/authentication FAILED.*corruption, or the wrong key/);
  });

  it("the webhook table is found as SQLite resolves identifiers (case-insensitively): a `Webhook_Subscriptions` table is counted, not read as absent", async () => {
    const Database = (await import("better-sqlite3")).default;
    const { classifyWebhookSecrets } = await import("../src/backup-secrets.js");
    const mixed = new Database(":memory:");
    mixed.exec("CREATE TABLE Webhook_Subscriptions (id TEXT, secret TEXT)");
    mixed.prepare("INSERT INTO Webhook_Subscriptions (id, secret) VALUES ('w1', 'plain-secret')").run();
    expect(classifyWebhookSecrets(mixed as never)).toEqual({ plaintext: 1, encrypted: 0, unverifiable: 0, unverifiable_reasons: ZERO_REASONS });
    mixed.close();
  });

  it("a failure while DISCOVERING the webhook table is UNVERIFIABLE (null), never 0 and never a throw", async () => {
    const { classifyWebhookSecrets } = await import("../src/backup-secrets.js");
    const broken = { prepare: () => { throw new Error("discovery failed"); } };
    expect(classifyWebhookSecrets(broken as never)).toBeNull();
  });

  it("coverage: an UNVERIFIABLE count is stated on ALL THREE surfaces (stderr, the export result, the manifest)", async () => {
    await seed();
    const db = await import("../src/db.js");
    db.getDb().exec("DROP TABLE webhook_subscriptions; CREATE TABLE webhook_subscriptions (id TEXT)"); // no `secret` column
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (c: unknown, ...a: unknown[]) => boolean }).write = (c: unknown, ...a: unknown[]) => {
      writes.push(String(c));
      return orig(c as string, ...(a as []));
    };
    let exp: Record<string, unknown>;
    try {
      const { exportRelayState } = await import("../src/backup.js");
      exp = (await exportRelayState({ destinationPath: path.join(ROOT, "unverifiable.tar.gz") })) as unknown as Record<string, unknown>;
    } finally {
      (process.stderr as unknown as { write: typeof orig }).write = orig;
    }
    expect(writes.join(""), "stderr").toMatch(/could NOT be verified/);
    expect(exp.webhook_secrets, "the export result").toBeNull();
    expect((exp.warnings as string[]).join(" "), "the export result's warnings").toMatch(/could NOT be verified/);
    expect(manifestOf(archiveBytes(String(exp.archive_path)).plain).webhook_secrets, "the manifest").toBeNull();
  });

  it("a webhook_subscriptions table the count cannot read is reported as UNVERIFIABLE (null), never 0; an absent table is 0", async () => {
    const Database = (await import("better-sqlite3")).default;
    const { classifyWebhookSecrets } = await import("../src/backup-secrets.js");
    const odd = new Database(":memory:");
    odd.exec("CREATE TABLE webhook_subscriptions (id TEXT)"); // no `secret` column: the query fails
    expect(classifyWebhookSecrets(odd as never)).toBeNull();
    odd.close();
    const none = new Database(":memory:");
    expect(classifyWebhookSecrets(none as never)).toEqual({ plaintext: 0, encrypted: 0, unverifiable: 0, unverifiable_reasons: ZERO_REASONS });
    none.close();
  });
});

/**
 * Rewrite an archive as an OLD one: the manifest without its `encryption` block (what every pre-SEC-23 archive is).
 * Re-packed with the suite's ustar crafter.
 */
function stripManifestEncryption(src: string, dst: string): void {
  const plain = zlib.gunzipSync(fs.readFileSync(src));
  const members: Array<{ name: string; data: Buffer }> = [];
  for (let off = 0; off + 512 <= plain.length; ) {
    const name = plain.subarray(off, off + 100).toString("latin1").replace(/\0.*$/s, "");
    if (!name) break;
    const size = parseInt(plain.subarray(off + 124, off + 136).toString("latin1").replace(/\0.*$/s, "").trim() || "0", 8);
    let data = plain.subarray(off + 512, off + 512 + size);
    if (name === "manifest.json") {
      const m = JSON.parse(data.toString("utf-8")) as Record<string, unknown>;
      delete m.encryption;
      data = Buffer.from(JSON.stringify(m));
    }
    members.push({ name, data: Buffer.from(data) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  fs.writeFileSync(dst, gzip(craftTar(members)));
}
