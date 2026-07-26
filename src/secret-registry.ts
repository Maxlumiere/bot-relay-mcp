// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * PR C — redact-by-VALUE, the durable complement to the field-name + anchor
 * redaction in logger.ts.
 *
 * A field-name denylist loses to a credential under an un-named field or embedded
 * as a substring. This registry inverts that: it holds the actual secret VALUES
 * the process knows and scrubs them from any line, field- and position-agnostic.
 *
 * BOUND BY IDENTITY, NOT BY MINT VOLUME (Victra ruling). An earlier draft used a
 * flat FIFO capped at N insertions — which SILENTLY dropped still-valid tokens
 * once a busy daemon minted past N, decaying coverage with no signal. That is
 * silence-as-failure in the redaction layer. The fix: key agent secrets by the
 * PRINCIPAL they belong to and keep current + a short rotation window per
 * principal, so a live agent's current token NEVER ages out — the bound is the
 * number of principals (agents: tens/hundreds; config secrets: a handful), which
 * is what actually matters, not how many tokens have ever been issued.
 *
 * Three tiers, each with an explicit bound:
 *  - byIdentity: principal → [current, ...previous] (rotation grace). Bounded by
 *    live principals; a current token is never evicted while the principal exists.
 *  - configSecrets: identity-less but fixed (http_secret, dashboard_secret) — a
 *    tiny Set, never evicted.
 *  - orphan: a small FIFO for genuinely identity-less values, and its evictions
 *    are LOGGED (loud, not silent) — an evicted value falls back to anchor-only
 *    coverage, which is the pre-registry state (no regression), but coverage must
 *    never degrade invisibly.
 *
 * LENGTH FLOOR on every tier so a short/low-entropy value can't turn ordinary log
 * text into `***` noise. LAYERED: redactRegisteredValues runs IN ADDITION to the
 * logger's anchor/field regexes, never instead of them.
 */

const MIN_SECRET_LEN = 16;
const PREVIOUS_PER_IDENTITY = 3; // rotation-grace window kept per principal
const ORPHAN_MAX = 64;

const byIdentity = new Map<string, string[]>(); // principal → [current, ...previous] (newest first)
const configSecrets = new Set<string>();
const orphan: string[] = []; // FIFO; evictions logged

function eligible(v: unknown): v is string {
  return typeof v === "string" && v.length >= MIN_SECRET_LEN;
}

/**
 * Register a secret keyed to the PRINCIPAL that owns it (an agent name). The
 * value becomes that principal's `current`; the prior current shifts into a
 * bounded previous-window so a rotation grace period stays covered. A live
 * principal's current value is never aged out by volume elsewhere.
 */
export function registerIdentitySecret(principal: string, value: unknown): void {
  if (!eligible(value)) return;
  const list = byIdentity.get(principal) ?? [];
  if (list[0] === value) return; // already current
  byIdentity.set(principal, [value, ...list.filter((v) => v !== value)].slice(0, 1 + PREVIOUS_PER_IDENTITY));
}

/** Register an identity-less but FIXED secret (config http_secret / dashboard_secret). */
export function registerConfigSecret(value: unknown): void {
  if (!eligible(value)) return;
  configSecrets.add(value);
}

/**
 * Register a genuinely identity-less value into the small orphan FIFO. Eviction
 * is LOGGED — coverage must not degrade silently. (Currently unused by the
 * codebase; every real secret has a principal or is a config secret. Kept as the
 * explicit home for any future identity-less case so it can't quietly reuse an
 * unbounded structure.)
 */
export function registerOrphanSecret(value: unknown): void {
  if (!eligible(value)) return;
  if (orphan.includes(value)) return;
  if (orphan.length >= ORPHAN_MAX) {
    orphan.shift();
    // Loud, not silent. No secret value in the message — just the fact of eviction.
    process.stderr.write(
      `[secret-registry] orphan pool full (${ORPHAN_MAX}); evicted an identity-less secret from redact-by-value. ` +
        `Not a leak — anchor/field rules still apply — but coverage for that value is reduced.\n`,
    );
  }
  orphan.push(value);
}

/**
 * Replace every registered secret VALUE in `line` with `***`, field- and
 * position-agnostic. Early-returns when nothing is registered (the common case
 * for stdio clients) so it costs nothing there.
 */
export function redactRegisteredValues(line: string): string {
  if (!line || (byIdentity.size === 0 && configSecrets.size === 0 && orphan.length === 0)) return line;
  let out = line;
  for (const list of byIdentity.values()) {
    for (const s of list) if (out.includes(s)) out = out.split(s).join("***");
  }
  for (const s of configSecrets) if (out.includes(s)) out = out.split(s).join("***");
  for (const s of orphan) if (out.includes(s)) out = out.split(s).join("***");
  return out;
}

/** Test-only: clear all tiers between cases. */
export function _resetSecretRegistryForTests(): void {
  byIdentity.clear();
  configSecrets.clear();
  orphan.length = 0;
}

/** Test-only: number of distinct principals currently keyed. */
export function _identityCountForTests(): number {
  return byIdentity.size;
}
