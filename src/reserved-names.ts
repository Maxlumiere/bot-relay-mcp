// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.14.0 — reserved-name protection (impersonation / identity governance).
 *
 * The local daemon is intentionally auth-free for zero-config onboarding, and
 * any agent that already holds a token is protected against impersonation by
 * the token↔identity binding (a `from`/actor field authenticates only against
 * the caller's own token — v2.12.0 schemaCallerKeys). The remaining hole is the
 * REGISTER side: `register_agent`'s bootstrap path (no existing row → no auth)
 * lets any caller CLAIM a persona/sentinel name that has no live row and mint
 * its token — becoming that identity. Reserved names close that: a reserved
 * name cannot be self-registered; it must be provisioned by an operator
 * (`relay mint-token <name>`, which has filesystem authority), after which the
 * normal token requirement protects it.
 *
 * Source of the reserved set:
 *   - HARDCODED: the relay's own message sentinels (e.g. `system`). PUBLIC-
 *     CLEAN — only generic relay-internal names are ever hardcoded here.
 *   - RELAY_RESERVED_NAMES env: a comma-separated operator list of persona
 *     names to protect (e.g. on the daemon's launchd/systemd env). Private
 *     persona names live ONLY in the operator's local config, NEVER in the
 *     repo.
 * Matching is case-insensitive so `System`/`SYSTEM` can't slip past the guard.
 */

/**
 * Relay-internal sentinel names that are ALWAYS reserved, regardless of config.
 * `system` is the sender sentinel `sendMessage` special-cases for relay-authored
 * messages (spawn kickstart, push notifications) — it must never be claimable by
 * an external caller. Keep this list to generic relay-internal names only
 * (public-safe); operator persona names belong in RELAY_RESERVED_NAMES.
 */
export const RELAY_SENTINEL_NAMES: readonly string[] = ["system"];

/** Parse the operator's RELAY_RESERVED_NAMES env (comma-separated) → lowercased names. */
function envReservedNames(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env.RELAY_RESERVED_NAMES;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/**
 * The full reserved-name set (lowercased): hardcoded relay sentinels ∪ the
 * operator's RELAY_RESERVED_NAMES. Computed per call so an env change (or a
 * test override) takes effect without a restart — the set is tiny.
 */
export function getReservedNames(env: Record<string, string | undefined> = process.env): Set<string> {
  const set = new Set<string>();
  for (const n of RELAY_SENTINEL_NAMES) set.add(n.toLowerCase());
  for (const n of envReservedNames(env)) set.add(n);
  return set;
}

/** Is `name` reserved (case-insensitive)? Empty/null → false. */
export function isReservedName(
  name: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!name) return false;
  return getReservedNames(env).has(name.toLowerCase());
}
