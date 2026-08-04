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
import { deriveKeyringSubkey, getKeyringInfo } from "./encryption.js";
import { getDbPath } from "./db.js";
import { log } from "./logger.js";

/** HKDF context label — bump the suffix only on a deliberate digest-format break. */
const LOOKUP_INFO = "bot-relay/token-lookup/v1";
const SECRET_FILE = "token-lookup.key";

// Memoized derived key + a tag identifying its source so a keyring rotation
// (current key_id change) or a plaintext→keyring switch recomputes it.
let cachedKey: Buffer | null = null;
let cachedKeyTag: string | null = null;

function persistedSecretPath(): string {
  // Instance dir = the DB's directory (mirrors the token vault at
  // `<dir>/agents/*.token`, see token-store.ts).
  return path.join(path.dirname(getDbPath()), SECRET_FILE);
}

/**
 * Load (or first-time create) the per-instance lookup secret and HKDF-expand
 * it. Best-effort persistence: if the file can't be written (read-only FS) the
 * in-memory random ikm still keys this process — digests just won't match
 * across processes/restarts, which the O(N) fallback tolerates (no lockout).
 */
function deriveFromPersistedSecret(): Buffer {
  const secretPath = persistedSecretPath();
  let ikm: Buffer | null = null;
  try {
    const buf = fs.readFileSync(secretPath);
    if (buf.length >= 32) ikm = buf;
  } catch {
    /* missing/unreadable → create below */
  }
  if (!ikm) {
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
        }); using a process-local secret — O(1) locator degrades to O(N) fallback across restarts.`,
      );
    }
  }
  return Buffer.from(crypto.hkdfSync("sha256", ikm, Buffer.alloc(0), Buffer.from(LOOKUP_INFO, "utf8"), 32));
}

/** The HMAC key for the lookup digest — keyring-derived when present, else the persisted secret. Memoized per source. */
function getTokenLookupKey(): Buffer {
  const current = getKeyringInfo().current; // null when no keyring is configured
  const tag = current ? `kr:${current}` : "persisted";
  if (cachedKey && cachedKeyTag === tag) return cachedKey;
  const sub = current ? deriveKeyringSubkey(LOOKUP_INFO) : null;
  cachedKey = sub ?? deriveFromPersistedSecret();
  cachedKeyTag = tag;
  return cachedKey;
}

/**
 * Compute the indexed lookup digest for a raw token.
 * `HMAC-SHA256(lookup_key, raw_token)` as lowercase hex. Deterministic for a
 * fixed key, so it can be stored + queried. NEVER an auth decision on its own.
 */
export function computeTokenLookup(rawToken: string): string {
  return crypto.createHmac("sha256", getTokenLookupKey()).update(rawToken, "utf8").digest("hex");
}

/** Test-only: drop the memoized key so a test can swap keyring/instance dir between cases. */
export function _resetTokenLookupCacheForTests(): void {
  cachedKey = null;
  cachedKeyTag = null;
}
