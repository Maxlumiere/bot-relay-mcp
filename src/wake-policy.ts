// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * WHO MAY WAKE WHOM (doorbell PR 7, architect ruling 7224605e (4)): the ONE shared policy the wake
 * trigger (src/watch-wake.ts) evaluates per pending id. It decides only whether mail WAKES its
 * recipient; refused mail stays pending and visible on the recipient's own drain.
 *   - STANDING: does this sender, on this lane, have standing to wake this recipient? PR 7 allows all
 *     (`ALLOW_ALL`); PR 8 replaces `currentStanding` with a default-deny sender → recipient matrix.
 *   - THE PER-PAIR RATE: at most N wakes per (sender → recipient) pair per trailing hour.
 * Metadata only, never content: the relay-authenticated sender (from_agent) and the lane.
 */

/** One id's METADATA for the policy (never content): the relay-authenticated sender and its lane. */
export interface WakeMeta {
  from: string | null;
  lane: "direct" | "capability";
}
export type StandingCheck = (x: { sender: string | null; recipient: string; kind: "direct" | "capability"; id: string }) => "allowed" | { refused: string };
export const ALLOW_ALL: StandingCheck = () => "allowed";
/** Default per-pair rate (ruling 6b05554c): at most this many wakes per (sender → recipient) pair per hour. */
export const DEFAULT_PAIR_WAKES_PER_HOUR = 4;
export const PAIR_WINDOW_MS = 3_600_000;
export const pairKey = (sender: string | null, recipient: string): string => `${sender ?? "\u0001unknown"}\u0000${recipient}`;

/** The policy in force. The ONE place PR 8 changes (a default-deny matrix). */
export function currentWakePolicy(): { standing: StandingCheck; pairWakesPerHour: number } {
  return { standing: ALLOW_ALL, pairWakesPerHour: DEFAULT_PAIR_WAKES_PER_HOUR };
}
