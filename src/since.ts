// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The ONE resolver for a `since` argument, shared by get_messages (and the other
 * message tools) and `relay pending` (F1), so the CLI's window cannot drift from
 * the drain's. Pure: the session-start lookup is passed in, so a caller holding a
 * raw read-only handle (the CLI) and a caller on getDb() (the tools) resolve the
 * same input to the same bound.
 */

/**
 * Parse `since` as either a duration shorthand or an ISO timestamp. Returns
 * milliseconds-since-epoch of the window start. Throws on invalid input.
 */
export function parseSince(since: string, nowMs: number = Date.now()): number {
  const durMatch = /^(\d+)(m|h|d)$/.exec(since.trim());
  if (durMatch) {
    const n = parseInt(durMatch[1], 10);
    const unit = durMatch[2];
    const multipliers: Record<string, number> = {
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
    };
    if (n <= 0 || !Number.isFinite(n)) {
      throw new Error(`since duration must be positive: "${since}"`);
    }
    return nowMs - n * multipliers[unit];
  }
  // Fallback: ISO timestamp parse.
  const t = Date.parse(since);
  if (Number.isNaN(t)) {
    throw new Error(
      `since must be a duration ('15m' | '1h' | '3h' | '1d') or ISO8601 timestamp; got "${since}"`
    );
  }
  return t;
}

/**
 * v2.1.6: resolve `since` to an ISO lower bound, or null for no bound.
 *   - duration shorthand ("15m" | "1h" | "24h" | "3d") or ISO8601 (via parseSince)
 *   - "session_start": the agent's last register_agent timestamp; null when
 *     unknown (never an invented bound)
 *   - "all" | null | undefined: no bound
 * Throws a caller-facing error on malformed input.
 */
export function resolveSinceBoundWith(
  since: string | null | undefined,
  sessionStart: () => string | null,
): string | null {
  if (since === null || since === undefined) return null;
  if (since === "all") return null;
  if (since === "session_start") return sessionStart() ?? null;
  return new Date(parseSince(since)).toISOString();
}
