// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The failed-auth THROTTLE (PR-B; architect rulings e26359ac (i), 16343dc1, 7ab8ea86).
 *
 * Only the path that must run bcrypt to learn a token is wrong consumes it: a row whose digest
 * cannot decide (no digest, a pre-PR-B digest of unknown provenance, or a key no longer derivable).
 * A known-provenance digest decides a wrong token with ZERO bcrypt, so it never needs throttling.
 *
 *   - Keyed by (source, name): an attack on one name, from one source, cannot lock out another name.
 *   - RESERVED BEFORE any hashing, in one synchronous step (an empty bucket refuses without a compare),
 *     and REFUNDED when the compare succeeds: only a FAILED compare spends an attempt.
 *   - A token bucket: BURST attempts at once, then one per REFILL_MS.
 *   - The map is bounded (MAX_KEYS, oldest evicted), so distinct (source, name) pairs cannot grow it
 *     without limit. Eviction can only GIVE an evicted key a fresh bucket; the pool's global queue
 *     bound still caps the total work.
 */

export const THROTTLE_BURST = 5;
export const THROTTLE_REFILL_MS = 2_000;
export const THROTTLE_MAX_KEYS = 10_000;

interface Bucket {
  tokens: number;
  updated: number;
}

const buckets = new Map<string, Bucket>();
const keyOf = (source: string, name: string) => `${source}\u0000${name}`;

function bucket(source: string, name: string, now: number): Bucket {
  const k = keyOf(source, name);
  let b = buckets.get(k);
  if (!b) {
    b = { tokens: THROTTLE_BURST, updated: now };
    if (buckets.size >= THROTTLE_MAX_KEYS) buckets.delete(buckets.keys().next().value as string);
  } else {
    buckets.delete(k); // re-inserted below: the map stays in least-recently-used order
    b.tokens = Math.min(THROTTLE_BURST, b.tokens + (now - b.updated) / THROTTLE_REFILL_MS);
    b.updated = now;
  }
  buckets.set(k, b);
  return b;
}

/**
 * RESERVE one undecidable compare for (source, name), or refuse. The check and the reservation are one
 * synchronous step, so N CONCURRENT requests cannot all pass a check before any of them has failed
 * (MEASURED: check-then-consume let 30 concurrent unknown tokens spend 40 compares against a bound of
 * 20). A compare that SUCCEEDS gives its attempt back (throttleRefund): only failures spend.
 */
export function throttleTake(source: string, name: string, now = Date.now()): boolean {
  const b = bucket(source, name, now);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/** The reserved compare SUCCEEDED (or never ran): return the attempt. */
export function throttleRefund(source: string, name: string, now = Date.now()): void {
  const b = bucket(source, name, now);
  b.tokens = Math.min(THROTTLE_BURST, b.tokens + 1);
}

/** Tests only. */
export function _resetAuthThrottleForTests(): void {
  buckets.clear();
}
