// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * SEC-23: what a backup may carry. No backup contains an encryption KEY, a raw TOKEN or the mint secret; a secret the
 * operator keeps in PLAINTEXT in the DB (no-key mode: webhook_subscriptions.secret) is carried and STATED.
 *
 * - The archived config.json is SERIALIZED through CONFIG_ARCHIVE_CLASS, one entry per RelayConfig field (the type
 *   makes a missing entry a compile error, and a meta-test checks it against the interface): a "secret" (a shared
 *   bearer credential is a raw token by function) is set to null and listed as redacted; a "copy" field is copied;
 *   a key RelayConfig does not declare is DROPPED and listed by name only, never by value. Restore never reads the
 *   archived config (src/backup.ts importRelayState), so the redaction costs a restore nothing.
 * - The key ids an archive NEEDS come from its DB's own ciphertext (scanCiphertextKeyIds), not from a manifest
 *   (stale, or absent in an old archive). Restore checks them before any mutation (assertKeyringCanRead).
 */
import type { RelayConfig } from "./config.js";
import type { CompatDatabase } from "./sqlite-compat.js";
import { backupKeyFingerprint, decryptContent, getKeyringInfo, isValidKeyId } from "./encryption.js";

export type ConfigArchiveClass = "secret" | "copy";

export const CONFIG_ARCHIVE_CLASS: { readonly [K in keyof RelayConfig]-?: ConfigArchiveClass } = {
  transport: "copy",
  http_port: "copy",
  http_host: "copy",
  webhook_timeout_ms: "copy",
  api_allowlist: "copy",
  http_secret: "secret",
  http_secrets_previous: "secret",
  dashboard_secret: "secret",
  dashboard_push_url: "copy",
  dashboard_push_secret: "secret",
  rate_limit_messages_per_hour: "copy",
  rate_limit_tasks_per_hour: "copy",
  rate_limit_spawns_per_hour: "copy",
  trusted_proxies: "copy",
  allowed_dashboard_origins: "copy",
};

export interface ArchivedConfig {
  /** RelayConfig secrets the file held, set to null in the archive. */
  redacted: string[];
  /** Keys RelayConfig does not declare, left out of the archive (named, never valued). */
  dropped: string[];
  /** Set when the file is not archived at all, and why (a file that is not a JSON object). */
  omitted?: string;
}

/** The archive's config.json text, and what was redacted or dropped; `json` is null when the file is omitted. */
export function serializeConfigForArchive(raw: string): { json: string | null; info: ArchivedConfig } {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    obj = undefined;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { json: null, info: { redacted: [], dropped: [], omitted: "config.json is not a JSON object, so it is not archived" } };
  }
  const out: Record<string, unknown> = {};
  const redacted: string[] = [];
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const cls = Object.prototype.hasOwnProperty.call(CONFIG_ARCHIVE_CLASS, k) ? CONFIG_ARCHIVE_CLASS[k as keyof RelayConfig] : undefined;
    if (cls === "copy") out[k] = v;
    else if (cls === "secret") {
      out[k] = null;
      if (v !== null && v !== undefined) redacted.push(k);
    } else dropped.push(k);
  }
  return { json: JSON.stringify(out, null, 2), info: { redacted: redacted.sort(), dropped: dropped.sort() } };
}

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/**
 * Per key id, the rows of `db` encrypted under it and one sample ciphertext, found by scanning EVERY column of every
 * table for the ciphertext prefixes (src/encryption.ts): `enc:<key_id>:` and the legacy `enc1:` (its key id is
 * `legacyKeyId`). Every column, not a list of the encrypted ones, so a column encrypted later is not missed. A value
 * that only looks like ciphertext (its id is not a well-formed key id) is not counted.
 */
export function scanCiphertextKeyIds(db: CompatDatabase, legacyKeyId: string): Record<string, { rows: number; sample: string }> {
  const out: Record<string, { rows: number; sample: string }> = {};
  const add = (id: string, n: number, sample: string): void => {
    const cur = out[id];
    if (cur) cur.rows += n;
    else out[id] = { rows: n, sample };
  };
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
  for (const { name: t } of tables) {
    const cols = db.prepare(`PRAGMA table_info(${quoteIdent(t)})`).all() as Array<{ name: string }>;
    for (const { name: c } of cols) {
      const col = quoteIdent(c);
      const v2 = db
        .prepare(
          `SELECT substr(${col}, 5, instr(substr(${col}, 5), ':') - 1) AS id, COUNT(*) AS n, MIN(${col}) AS sample ` +
            `FROM ${quoteIdent(t)} WHERE typeof(${col}) = 'text' AND substr(${col}, 1, 4) = 'enc:' GROUP BY id`
        )
        .all() as Array<{ id: string; n: number; sample: string }>;
      for (const r of v2) if (isValidKeyId(r.id)) add(r.id, r.n, r.sample);
      const v1 = db
        .prepare(`SELECT COUNT(*) AS n, MIN(${col}) AS sample FROM ${quoteIdent(t)} WHERE typeof(${col}) = 'text' AND substr(${col}, 1, 5) = 'enc1:'`)
        .get() as { n: number; sample: string | null } | undefined;
      if (v1 && v1.n > 0 && v1.sample !== null) add(legacyKeyId, v1.n, v1.sample);
    }
  }
  return out;
}

/** The webhook secrets `db` holds in PLAINTEXT (no-key mode); 0 when the table does not exist (an older schema). */
export function countPlaintextWebhookSecrets(db: CompatDatabase): number {
  try {
    const r = db
      .prepare(
        "SELECT COUNT(*) AS n FROM webhook_subscriptions WHERE secret IS NOT NULL AND secret <> '' " +
          "AND substr(secret, 1, 4) <> 'enc:' AND substr(secret, 1, 5) <> 'enc1:'"
      )
      .get() as { n: number } | undefined;
    return r?.n ?? 0;
  } catch {
    return 0;
  }
}

export interface ManifestKey {
  key_id: string;
  rows: number;
  /** backupKeyFingerprint(key_id) when the backup was made; null when that keyring did not hold the key. */
  fingerprint: string | null;
}

/** The manifest's `encryption` block for the key ids `db` needs. */
export function manifestKeysOf(needed: Record<string, { rows: number }>): ManifestKey[] {
  return Object.keys(needed)
    .sort()
    .map((key_id) => ({ key_id, rows: needed[key_id].rows, fingerprint: backupKeyFingerprint(key_id) }));
}

/**
 * Restore, in staging, before ANY mutation: this keyring can read every key id the STAGED DB needs. Refuses, by
 * name: an id the keyring does not hold; a key whose fingerprint is not the one the manifest recorded (when it
 * recorded one); a staged row that does not decrypt (the AEAD tag is the ground truth, and an old archive has no
 * fingerprints). `manifestEncryption` is the manifest's `encryption` value, undefined for an old archive.
 */
export function assertKeyringCanRead(needed: Record<string, { rows: number; sample: string }>, manifestEncryption: unknown): void {
  const ids = Object.keys(needed).sort();
  const recorded = new Map<string, string | null>();
  if (manifestEncryption !== undefined) {
    const keys = (manifestEncryption as { keys?: unknown } | null)?.keys;
    const wellFormed =
      Array.isArray(keys) &&
      keys.every(
        (k) => k && typeof k === "object" && typeof (k as ManifestKey).key_id === "string" && ((k as ManifestKey).fingerprint === null || typeof (k as ManifestKey).fingerprint === "string")
      );
    if (!wellFormed) throw new Error("backup restore refused: manifest.json's `encryption` block is malformed. Nothing was changed.");
    for (const k of keys as ManifestKey[]) recorded.set(k.key_id, k.fingerprint);
  }
  if (ids.length === 0) return;
  const held = new Set(getKeyringInfo().known_key_ids);
  const missing = ids.filter((id) => !held.has(id));
  if (missing.length) {
    throw new Error(
      `backup restore refused: the archive has rows encrypted under key id(s) ${missing.map((id) => `${id} (${needed[id].rows} rows)`).join(", ")}, ` +
        `which are not held by this relay's keyring. Configure a keyring that holds ${missing.length === 1 ? "that key" : "those keys"} ` +
        `(RELAY_ENCRYPTION_KEYRING or RELAY_ENCRYPTION_KEYRING_PATH), then restore again. Nothing was changed.`
    );
  }
  const mismatched = ids.filter((id) => {
    const fp = recorded.get(id);
    return typeof fp === "string" && backupKeyFingerprint(id) !== fp;
  });
  if (mismatched.length) {
    throw new Error(
      `backup restore refused: this keyring's key for key id(s) ${mismatched.join(", ")} is not the key the archive was made with ` +
        `(its fingerprint differs from the one manifest.json recorded). Configure the original key, then restore again. Nothing was changed.`
    );
  }
  const undecryptable = ids.filter((id) => {
    try {
      decryptContent(needed[id].sample);
      return false;
    } catch {
      return true;
    }
  });
  if (undecryptable.length) {
    throw new Error(
      `backup restore refused: a staged row encrypted under key id(s) ${undecryptable.join(", ")} does not decrypt with this keyring's key ` +
        `(the archive was made with a different key). Configure the original key, then restore again. Nothing was changed.`
    );
  }
}
