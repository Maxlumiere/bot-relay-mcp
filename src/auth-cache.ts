// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0003 (v2.20.0) — verified-token cache (the security-critical core).
 *
 * A per-process, in-memory, LRU-bounded cache of POSITIVE auth verdicts keyed
 * on the token's lookup digest (HMAC — never the plaintext token, never the
 * bcrypt hash). A hit lets the resolver skip both the indexed locator SELECT
 * and the bcrypt verify.
 *
 * INVALIDATION MODEL — a global generation counter (see db.ts
 * getAuthGeneration / bumpAuthGeneration). Every entry stamps the generation
 * at insert; a hit is valid ONLY when `entry.gen === currentGen` AND
 * `now < entry.hardExpiry`. Any mutation that can change a token's validity
 * (rotate / revoke / unregister / rotation-grace expiry / admin-rotate /
 * caps change / delete) bumps the counter → EVERY entry is logically dead on
 * its next hit. This gives INSTANT revocation regardless of TTL — the counter,
 * not the clock, is the correctness mechanism.
 *
 * The TTL (`hardExpiry`) is a defense-in-depth backstop that bounds staleness
 * even against a hypothetically-missed bump, and — for a rotation_grace
 * PREVIOUS-token entry — is capped at `rotation_grace_expires_at` so the old
 * token's verdict cannot outlive its grace window even before the sweep bumps
 * the generation.
 *
 * Cache stores VERDICTS only. Negative/failed auths are NOT cached (avoids a
 * just-registered agent being locked out, and any poisoning surface).
 */

/** Default entry TTL — matches the liveness-probe cache. Override via RELAY_AUTH_CACHE_TTL_MS. */
export const AUTH_CACHE_DEFAULT_TTL_MS = 5000;
/** Max entries before LRU eviction. Bounds memory against a flood of distinct token probes. */
export const AUTH_CACHE_MAX_ENTRIES = 1000;

export interface AuthCacheValue {
  name: string;
  capabilities: string[];
}

interface CacheEntry extends AuthCacheValue {
  gen: number;
  hardExpiry: number; // epoch ms
}

// Insertion-ordered Map = cheap LRU: re-insert on hit to move to the tail;
// evict the head (oldest) when over capacity.
const store = new Map<string, CacheEntry>();

export function authCacheTtlMs(): number {
  const raw = process.env.RELAY_AUTH_CACHE_TTL_MS;
  if (raw === undefined || raw === "") return AUTH_CACHE_DEFAULT_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : AUTH_CACHE_DEFAULT_TTL_MS;
}

/**
 * Look up a cached verdict. Returns the verdict ONLY if the entry's stamped
 * generation still matches `currentGen` AND it hasn't hit its hardExpiry;
 * otherwise the entry is evicted and `null` is returned (forcing a re-verify).
 * `now` is injectable for deterministic tests.
 */
export function authCacheGet(digest: string, currentGen: number, now: number = Date.now()): AuthCacheValue | null {
  const e = store.get(digest);
  if (!e) return null;
  if (e.gen !== currentGen || now >= e.hardExpiry) {
    // Stale (a mutation bumped the generation) or expired — never serve it.
    store.delete(digest);
    return null;
  }
  // LRU touch: move to tail.
  store.delete(digest);
  store.set(digest, e);
  return { name: e.name, capabilities: e.capabilities };
}

/**
 * Insert a positive verdict. `hardExpiry` is an absolute epoch-ms deadline the
 * caller computes (min of now+TTL and, for a grace previous-token, the grace
 * expiry). Evicts the LRU head when over capacity.
 */
export function authCacheSet(
  digest: string,
  value: AuthCacheValue,
  gen: number,
  hardExpiry: number,
): void {
  if (store.has(digest)) store.delete(digest);
  store.set(digest, { name: value.name, capabilities: value.capabilities, gen, hardExpiry });
  while (store.size > AUTH_CACHE_MAX_ENTRIES) {
    const oldest = store.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/** Current entry count — for tests + diagnostics. */
export function authCacheSize(): number {
  return store.size;
}

/** Drop every entry. Used by tests and available as a hard reset. */
export function authCacheClear(): void {
  store.clear();
}
