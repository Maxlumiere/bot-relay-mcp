// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0003 (v2.20.0) — O(1) token locator digest.
 *
 * The relay authenticates a token-only caller by scanning every agent and
 * running bcrypt per row (O(N)). This module provides the LOOKUP digest that
 * narrows the scan to a single indexed candidate row before bcrypt verifies.
 *
 * `token_lookup = HMAC-SHA256(lookup_key, raw_token)` (hex). It is an INDEX
 * ONLY — never an authentication decision. A digest match still faces
 * `bcrypt.compareSync` on the real `token_hash` (so a digest collision is
 * rejected), and a digest MISS falls back to the O(N) scan (so no agent is
 * ever locked out — e.g. legacy rows whose digest was never populated).
 *
 * Key source (domain-separated from http_secret + the record-encryption key):
 *   1. If a keyring is configured → HKDF subkey of the keyring's current key
 *      (`deriveKeyringSubkey`). Rotates with the keyring; a rotation simply
 *      makes old digests miss → O(N) fallback + lazy self-heal re-populate
 *      under the new key. (Q1 gate ruling.)
 *   2. No keyring (plaintext mode — the common local deployment, which the Q1
 *      ruling did not cover) → a persisted per-instance random secret at
 *      `<instance-dir>/token-lookup.key` (0600), HKDF-expanded. Same server-
 *      held-secret property: a DB-only read can't compute digests.
 *
 * Why HMAC, not plain SHA-256: tokens are high-entropy so a plain hash isn't
 * rainbow-able, but keying on a server-held secret means a DB leak alone can't
 * offline-match a stolen token list against the `token_lookup` column.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { deriveKeyringSubkey, deriveKeyringSubkeyFor, getKeyringInfo } from "./encryption.js";
import { getDbPath } from "./db.js";
import { log } from "./logger.js";

/** HKDF context label — bump the suffix only on a deliberate digest-format break. */
const LOOKUP_INFO = "bot-relay/token-lookup/v1";
const SECRET_FILE = "token-lookup.key";

// PR-B (architect rulings e26359ac, 16343dc1, 7ab8ea86): a stored digest CARRIES THE ID OF THE KEY
// that produced it, `"<key-id>|<hex>"`, so a mismatch can be DEFINITIVE without bcrypt.
//   - key-id `kr:<keyring id>`: an HKDF subkey of that keyring key;
//   - key-id `px:<16 hex>`: the persisted per-instance secret, named by a fingerprint of its derived
//     key (a regenerated file is a DIFFERENT key, never confused with the old one).
// A stored value with no `|` was written before PR-B: its key is UNKNOWN (provenance unknown), and
// nothing ever rewrites it except a SUCCESSFUL auth (a heal). A failed attempt never touches it.
// Every write goes through computeTokenLookup (or copies a stored value whole), so the key id rides
// along every write site by construction.
export const KEY_ID_SEPARATOR = "|";

export interface LookupKey {
  /** `kr:<keyring id>` or `px:<fingerprint>`. */
  id: string;
  key: Buffer;
}

// Memoized per keyring snapshot (current key + the ids it holds), so a rotation recomputes.
let cachedKeys: LookupKey[] | null = null;
let cachedKeysTag: string | null = null;

function persistedSecretPath(): string {
  // Instance dir = the DB's directory (mirrors the token vault at
  // `<dir>/agents/*.token`, see token-store.ts).
  return path.join(path.dirname(getDbPath()), SECRET_FILE);
}

const hkdf = (ikm: Buffer): Buffer => Buffer.from(crypto.hkdfSync("sha256", ikm, Buffer.alloc(0), Buffer.from(LOOKUP_INFO, "utf8"), 32));
/** A ONE-WAY name for the persisted key (it is stored in every agents row): an HMAC of a fixed label, never key material. */
const persistedId = (key: Buffer): string => `px:${crypto.createHmac("sha256", key).update("bot-relay/lookup-key-id/v1", "utf8").digest("hex").slice(0, 16)}`;

/**
 * The persisted per-instance lookup secret, HKDF-expanded. `create`: make it when missing (only when
 * it is the CURRENT key). Best-effort persistence: if the file can't be written (read-only FS) the
 * in-memory random ikm still keys this process; digests then carry a key id no other process can
 * derive, which every reader treats as provenance unknown (never a lockout).
 */
function persistedKey(create: boolean): LookupKey | null {
  const secretPath = persistedSecretPath();
  let ikm: Buffer | null = null;
  try {
    const buf = fs.readFileSync(secretPath);
    if (buf.length >= 32) ikm = buf;
  } catch {
    /* missing/unreadable */
  }
  if (!ikm) {
    if (!create) return null;
    ikm = crypto.randomBytes(32);
    try {
      fs.writeFileSync(secretPath, ikm, { mode: 0o600 });
      if (process.platform !== "win32") {
        try {
          fs.chmodSync(secretPath, 0o600);
        } catch {
          /* perms best-effort */
        }
      }
    } catch (err) {
      log.warn(
        `[token-lookup] could not persist ${secretPath} (${
          err instanceof Error ? err.message : String(err)
        }); using a process-local secret: digests written now will read as provenance unknown elsewhere.`,
      );
    }
  }
  const key = hkdf(ikm);
  return { id: persistedId(key), key };
}

/**
 * Every lookup key this process can DERIVE, the CURRENT one FIRST: with a keyring, its current key,
 * then every other key it still holds, then the persisted secret if its file exists; without one, the
 * persisted secret alone (created when missing). A digest under any of these can be recomputed.
 */
export function lookupKeys(): LookupKey[] {
  const info = getKeyringInfo(); // current: null when no keyring is configured
  const tag = info.current ? `kr:${info.current}:${info.known_key_ids.join(",")}` : "persisted";
  if (cachedKeys && cachedKeysTag === tag) return cachedKeys;
  const keys: LookupKey[] = [];
  if (info.current) {
    const ids = [info.current, ...info.known_key_ids.filter((k) => k !== info.current)];
    for (const id of ids) {
      const sub = id === info.current ? deriveKeyringSubkey(LOOKUP_INFO) : deriveKeyringSubkeyFor(id, LOOKUP_INFO);
      if (sub) keys.push({ id: `kr:${id}`, key: sub });
    }
    const px = persistedKey(false);
    if (px) keys.push(px);
  }
  if (keys.length === 0) keys.push(persistedKey(true)!);
  cachedKeys = keys;
  cachedKeysTag = tag;
  return keys;
}

const hmacHex = (key: Buffer, rawToken: string): string => crypto.createHmac("sha256", key).update(rawToken, "utf8").digest("hex");

/**
 * The STORED form of a token's lookup digest under the CURRENT key: `"<key-id>|<hex>"`. Deterministic
 * for a fixed key, so it can be stored and queried. NEVER an auth decision on its own.
 */
export function computeTokenLookup(rawToken: string): string {
  const cur = lookupKeys()[0];
  return `${cur.id}${KEY_ID_SEPARATOR}${hmacHex(cur.key, rawToken)}`;
}

/**
 * Every stored form a row could hold for this token: `"<id>|<hex>"` under each derivable key, plus the
 * bare `<hex>` under each (a pre-PR-B, provenance-unknown value). For the token-only INDEXED lookup.
 */
export function tokenLookupCandidates(rawToken: string): string[] {
  const out: string[] = [];
  for (const k of lookupKeys()) {
    const hex = hmacHex(k.key, rawToken);
    out.push(`${k.id}${KEY_ID_SEPARATOR}${hex}`, hex);
  }
  return out;
}

/**
 * What a STORED digest says about a token, WITHOUT bcrypt:
 *   - "match": the token produces this digest (a bcrypt confirm is still required);
 *   - "mismatch": the digest was written under a key we can derive, and the token does not produce
 *     it: DEFINITIVELY the wrong token;
 *   - "unknown": no digest, a pre-PR-B digest whose key is unknown and that no derivable key
 *     reproduces, or a digest under a key we can no longer derive. Only bcrypt can decide.
 */
export function digestVerdict(stored: string | null | undefined, rawToken: string): "match" | "mismatch" | "unknown" {
  if (!stored) return "unknown";
  const sep = stored.indexOf(KEY_ID_SEPARATOR);
  const keys = lookupKeys();
  const eq = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  if (sep === -1) {
    // Provenance unknown: a match under ANY derivable key is a match; no match proves nothing.
    return keys.some((k) => eq(stored, hmacHex(k.key, rawToken))) ? "match" : "unknown";
  }
  const key = keys.find((k) => k.id === stored.slice(0, sep));
  if (!key) return "unknown"; // the key that wrote it is gone: cannot be computed, so not a mismatch
  return eq(stored.slice(sep + 1), hmacHex(key.key, rawToken)) ? "match" : "mismatch";
}

/** The key id a stored digest names, or null (no digest, or written before PR-B: provenance unknown). */
export function storedLookupKeyId(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const sep = stored.indexOf(KEY_ID_SEPARATOR);
  return sep === -1 ? null : stored.slice(0, sep);
}

/** Test-only: drop the memoized keys so a test can swap keyring/instance dir between cases. */
export function _resetTokenLookupCacheForTests(): void {
  cachedKeys = null;
  cachedKeysTag = null;
}

/**
 * PR-B (architect 9496935f, Codex R1 #1): the lookup values the digest index CANNOT decide, as EXACT INDEX RANGES
 * instead of a table scan. A value is REACHABLE when it starts with `<derivable key id>|` (the in-band key id;
 * key ids never contain the separator). Those values form, per key id p, the half-open range [p|, p}) in the
 * index's BINARY order, because '}' is the byte after '|'. UNREACHABLE = NULL (indexable on its own) plus the
 * COMPLEMENT of those ranges: exact whatever alphabet bare or garbage values use. `null` = unbounded on that side.
 * ONE function, from lookupKeys(), so the ranges and the derivable keys cannot drift.
 */
export function unreachableLookupRanges(keyIds: readonly string[] = lookupKeys().map((k) => k.id)): Array<{ lo: string | null; hi: string | null }> {
  const reachable = [...new Set(keyIds)]
    .map((id) => ({ lo: `${id}${KEY_ID_SEPARATOR}`, hi: `${id}}` }))
    .sort((a, b) => (a.lo < b.lo ? -1 : a.lo > b.lo ? 1 : 0));
  const out: Array<{ lo: string | null; hi: string | null }> = [];
  let cursor: string | null = null; // everything below the first reachable range
  for (const r of reachable) {
    if (cursor === null || cursor < r.lo) out.push({ lo: cursor, hi: r.lo });
    if (cursor === null || r.hi > cursor) cursor = r.hi;
  }
  out.push({ lo: cursor, hi: null });
  return out;
}
