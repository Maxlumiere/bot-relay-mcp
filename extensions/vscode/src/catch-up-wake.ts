// Tether for bot-relay-mcp (VSCode)
// SPDX-License-Identifier: MIT
//
// v0.2.3 (A) — catch-up wake on (re)subscribe.
//
// Pre-v0.2.3 the auto-`inbox` wake fired ONLY from the live
// ResourceUpdated notification handler — i.e. only for messages that
// arrived AFTER subscribe. Mail already sitting in the inbox at subscribe
// time (a fresh start, or a re-subscribe after a Switch-Agent / daemon
// restart) was painted into the status bar but never woke the terminal —
// the operator had to type `inbox` by hand. This module is the pure
// decision the connect() + live paths share so the wake fires once on
// (re)subscribe AND never double-wakes.
//
// High-water signal = the newest message's `last_message_at`
// (`MAX(created_at)` for the inbox; see src/mcp-resources.ts buildInboxSnapshot).
// We deliberately do NOT key on the relay's `seq`: seq is assigned at
// OBSERVATION, not creation (src/db.ts getInboxSummary doc), so it is not a
// "new mail arrived" signal — last_message_at is. The mark lives in MODULE
// memory only: it persists across reconnects (so a daemon-restart reconnect
// with no new mail does NOT re-wake) but resets on a window reload (so a
// reload SHOULD re-wake any still-pending mail — that's the desired
// behaviour, ruled in A1).

export interface WakeInboxView {
  /** Messages still status='pending' (un-drained) for the subscribed agent. */
  readonly pending_count: number;
  /** ISO timestamp of the newest message (any status); null when the inbox is empty. */
  readonly last_message_at: string | null;
}

export interface WakeDecision {
  /** Whether to fire exactly one inbox wake now. */
  readonly shouldWake: boolean;
  /** The high-water mark to store back (the newest-message timestamp we've woken for). */
  readonly newMark: string | null;
}

/**
 * Decide whether a (re)subscribe / live snapshot should fire one inbox wake,
 * given the high-water mark of the newest message we last woke for.
 *
 * Both the catch-up path (connect → initial snapshot) and the live path
 * (ResourceUpdated → refreshed snapshot) route through this so they share
 * one watermark — that shared mark is what guarantees no double-wake.
 *
 * Gated on `autoInjectInbox` ONLY (A2) — independent of notificationLevel,
 * mirroring the live path exactly.
 */
export function decideWake(
  snapshot: WakeInboxView,
  opts: { autoInjectInbox: boolean; lastWokenAt: string | null },
): WakeDecision {
  const { autoInjectInbox, lastWokenAt } = opts;

  // Auto-inject off → never wake; leave the mark untouched.
  if (!autoInjectInbox) return { shouldWake: false, newMark: lastWokenAt };

  // Nothing pending → nothing to wake for. Don't advance the mark (so a
  // later arrival that re-uses an old timestamp can't be masked).
  if (snapshot.pending_count <= 0) return { shouldWake: false, newMark: lastWokenAt };

  // Empty / unknown inbox → no timestamp to form a watermark from.
  if (snapshot.last_message_at === null) return { shouldWake: false, newMark: lastWokenAt };

  // We've already woken for this newest message → NO double-wake. This is
  // the load-bearing invariant on every reconnect with no new mail.
  if (snapshot.last_message_at === lastWokenAt) return { shouldWake: false, newMark: lastWokenAt };

  // First wake, or genuinely newer mail than we last woke for → wake once
  // and advance the high-water mark.
  return { shouldWake: true, newMark: snapshot.last_message_at };
}
