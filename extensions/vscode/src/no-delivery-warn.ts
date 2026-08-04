// Tether for bot-relay-mcp (VSCode)
// SPDX-License-Identifier: MIT
//
// #3 (2026-07) — surface the NO-DELIVERY condition to a human.
//
// When Tether has pending mail for a watched agent but cannot deliver a wake
// (no terminal bound by PID or name, or an ambiguous match), it logged the
// reason and flashed an 8-second `setStatusBarMessage` — which vanishes long
// before anyone looks. A deaf agent persists for MINUTES (316s observed), so an
// 8s blip is "the line never reaches a human": the silence-as-failure that cost
// hours chasing a phantom today. The extension must raise a REAL, visible
// warning that sits in the notifications list until dismissed.
//
// The wake path re-considers on every poll tick, so the hint fires repeatedly
// while the condition holds. A notification per tick is spam; never notifying
// after the first lets a condition quietly persist. So: notify on onset, then at
// most once per cooldown — a persistent deafness keeps nagging (~1/min), a
// transient one warns once. This module is the PURE throttle decision so the
// vscode surface (extension.ts) stays a thin wire and the policy is unit-tested.

export const NO_WAKE_WARN_COOLDOWN_MS = 60_000;

/**
 * Decide whether to raise a human-facing warning for a no-delivery `key` (the
 * distinct condition message — per agent + reason). Returns true on first sight
 * of the key and again once `cooldownMs` has elapsed since the last warning;
 * false within the cooldown (suppress the per-tick spam). Records a fired
 * warning in `lastWarnedAt` (the caller owns the map's lifetime).
 *
 * Direction-of-failure: an EXTRA warning is loud but harmless; a MISSED warning
 * re-creates the silent deafness. So the throttle errs toward warning — it warns
 * ON the cooldown boundary (`>=`), and distinct keys never mask each other (one
 * deaf agent cannot mute another's warning).
 */
export function decideNoDeliveryWarn(
  key: string,
  now: number,
  cooldownMs: number,
  lastWarnedAt: Map<string, number>,
): boolean {
  const last = lastWarnedAt.get(key);
  if (last === undefined || now - last >= cooldownMs) {
    lastWarnedAt.set(key, now);
    return true;
  }
  return false;
}
