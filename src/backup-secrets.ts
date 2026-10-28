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
 * - Every judgment of a stored value goes through src/encryption.ts's ONE classifier: parseEnvelope (the shape) and
 *   classifyStored (plaintext / encrypted, i.e. authenticated / unverifiable, with the reason).
 */
import type { RelayConfig } from "./config.js";
import type { CompatDatabase } from "./sqlite-compat.js";
import { backupKeyFingerprint, classifyStored, getKeyringInfo, parseEnvelope, type UnverifiableReason } from "./encryption.js";

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

/** Rows of a statement, streamed on both drivers (CompatStatement.iterate): never all held at once. */
function rowsOf<T>(db: CompatDatabase, sql: string): Iterable<T> {
  return db.prepare(sql).iterate() as Iterable<T>;
}

export type NeededKeys = Map<string, { rows: number; sample: string }>;

/**
 * Per key id, the rows of `db` encrypted under it and one sample ciphertext. EVERY column of every table, generated
 * and hidden ones included (table_xinfo), not a list of the encrypted ones, so a column encrypted later is not
 * missed. SQL only narrows to values starting with a ciphertext prefix; each one is then judged by the classifier's
 * parseEnvelope (a value without an envelope's shape is not counted), and a legacy `enc1:` value's id is
 * `legacyKeyId`. A Map, so a key id that is an Object.prototype name (`constructor`, `__proto__`) is a key like any
 * other.
 */
export function scanCiphertextKeyIds(db: CompatDatabase, legacyKeyId: string): NeededKeys {
  const out: NeededKeys = new Map();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
  for (const { name: t } of tables) {
    const cols = db.prepare(`PRAGMA table_xinfo(${quoteIdent(t)})`).all() as Array<{ name: string }>;
    for (const { name: c } of cols) {
      const col = quoteIdent(c);
      const sql =
        `SELECT ${col} AS v FROM ${quoteIdent(t)} WHERE typeof(${col}) = 'text' ` +
        `AND (substr(${col}, 1, 4) = 'enc:' OR substr(${col}, 1, 5) = 'enc1:')`;
      for (const { v } of rowsOf<{ v: string }>(db, sql)) {
        const env = parseEnvelope(v);
        if (!env) continue;
        const id = env.keyId ?? legacyKeyId;
        const cur = out.get(id);
        if (cur) cur.rows += 1;
        else out.set(id, { rows: 1, sample: v });
      }
    }
  }
  return out;
}

/** The webhook secrets, by the classifier's verdict. `unverifiable` > 0 is never a confident count of the others. */
export interface WebhookSecretCount {
  plaintext: number;
  encrypted: number;
  unverifiable: number;
  unverifiable_reasons: Record<UnverifiableReason, number>;
}

/**
 * The webhook secrets `db` holds, each classified by classifyStored: plaintext (carried as such), encrypted
 * (authenticated under the keyring), or unverifiable (with its reason). All zeros when the table is ABSENT (an older
 * schema), found as SQLite resolves identifiers (case-insensitively); null, UNVERIFIABLE as a whole, when the
 * table cannot be discovered or read. No decrypted value is kept.
 */
export function classifyWebhookSecrets(db: CompatDatabase): WebhookSecretCount | null {
  const count: WebhookSecretCount = { plaintext: 0, encrypted: 0, unverifiable: 0, unverifiable_reasons: { no_keyring: 0, key_not_held: 0, auth_failed: 0 } };
  try {
    const found = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'webhook_subscriptions' COLLATE NOCASE").get() as { name: string } | undefined;
    if (!found) return count;
    for (const r of rowsOf<{ secret: unknown }>(db, `SELECT secret FROM ${quoteIdent(found.name)} WHERE secret IS NOT NULL AND secret <> ''`)) {
      const c = typeof r.secret === "string" ? classifyStored(r.secret) : ({ kind: "plaintext" } as const);
      if (c.kind === "unverifiable") {
        count.unverifiable += 1;
        count.unverifiable_reasons[c.reason] += 1;
      } else count[c.kind] += 1;
    }
    return count;
  } catch {
    return null;
  }
}

export interface ManifestKey {
  key_id: string;
  rows: number;
  /** backupKeyFingerprint(key_id) when the backup was made; null when that keyring did not hold the key. */
  fingerprint: string | null;
}

/** The manifest's `encryption` block for the key ids `db` needs. */
export function manifestKeysOf(needed: NeededKeys): ManifestKey[] {
  return [...needed.keys()].sort().map((key_id) => ({ key_id, rows: needed.get(key_id)!.rows, fingerprint: backupKeyFingerprint(key_id) }));
}

/**
 * Restore, in staging, before ANY mutation: this keyring can read every key id the STAGED DB needs. Refuses, by
 * name: an id the keyring does not hold; a key whose fingerprint is not the one the manifest recorded (when it
 * recorded one); a staged row that the classifier cannot AUTHENTICATE (the GCM tag is the ground truth, and an old
 * archive has no fingerprints). `manifestEncryption` is the manifest's `encryption` value, undefined for an old
 * archive.
 */
export function assertKeyringCanRead(needed: NeededKeys, manifestEncryption: unknown): void {
  const ids = [...needed.keys()].sort();
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
      `backup restore refused: the archive has rows encrypted under key id(s) ${missing.map((id) => `${id} (${needed.get(id)!.rows} rows)`).join(", ")}, ` +
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
  const undecryptable = ids.filter((id) => classifyStored(needed.get(id)!.sample).kind !== "encrypted");
  if (undecryptable.length) {
    throw new Error(
      `backup restore refused: a staged row encrypted under key id(s) ${undecryptable.join(", ")} does not decrypt with this keyring's key ` +
        `(authentication failed: the archive was made with a different key, or the row is corrupt). Configure the original key, then restore again. Nothing was changed.`
    );
  }
}
