// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.7 Tether Phase 4 — fast unit test for the reaper skip predicate.
 *
 * Context: the long-lived SSE GET /mcp stream has its session's `lastSeen`
 * bumped exactly ONCE — when handleSessionRequest fires at stream open
 * (src/transport/http.ts:1363). Subsequent server-side pushes don't
 * touch lastSeen. After RELAY_HTTP_SESSION_IDLE_SECONDS (default 300s),
 * the reaper would close the transport and drop the active subscriber
 * — observed externally as the maintainer's "SSE stream disconnected" after
 * ~5 min of idle in the Phase 4 smoke (cited in dispatch
 * msg `a1e9505d`).
 *
 * The fix is structural: every session tracks `openGetStreams` (a
 * COUNT, not a boolean — codex SCOPE-TIGHTEN's specific note: a count
 * survives reconnect-races where a newer stream is already live before
 * the older stream's `res.close` fires). The reaper skips any session
 * with `openGetStreams > 0` regardless of lastSeen age.
 *
 * This file exercises the pure predicate
 * {@link import("../src/transport/http.js").shouldReapSession} on a
 * structural session shape — no HTTP daemon spawn, no async, ~2 ms.
 */
import { describe, it, expect } from "vitest";
import { shouldReapSession } from "../src/transport/http.js";

describe("v2.7 Tether Phase 4 — shouldReapSession (pure predicate)", () => {
  const IDLE_MS = 300_000; // mirrors the production default (300s)
  const NOW = 1_000_000_000_000;

  it("session with openGetStreams > 0 → never reaps, regardless of lastSeen age", () => {
    // lastSeen arbitrarily old — should still NOT reap because a live
    // SSE subscriber is holding the stream open. This is the load-
    // bearing case fixed in Phase 4.
    const session = {
      lastSeen: NOW - 10 * IDLE_MS, // 50 minutes old
      openGetStreams: 1,
    };
    expect(shouldReapSession(session, NOW, IDLE_MS)).toBe(false);
  });

  it("session with openGetStreams > 1 (overlapping reconnect race) → still doesn't reap", () => {
    // Codex's specific concern: a reconnecting client may briefly hold
    // TWO open GET streams (old + new) before the old closes. The count
    // must survive that.
    const session = { lastSeen: NOW - 2 * IDLE_MS, openGetStreams: 2 };
    expect(shouldReapSession(session, NOW, IDLE_MS)).toBe(false);
  });

  it("session with openGetStreams === 0 AND lastSeen older than idleMs → REAPS", () => {
    // Genuinely abandoned session: no live subscriber, no recent POST.
    const session = { lastSeen: NOW - IDLE_MS - 1, openGetStreams: 0 };
    expect(shouldReapSession(session, NOW, IDLE_MS)).toBe(true);
  });

  it("session with openGetStreams === 0 AND lastSeen exactly at idleMs cutoff → NO-OP (strict less-than)", () => {
    // Boundary: lastSeen == now - idleMs is not yet past cutoff. Reaps
    // only when STRICTLY older. Guards against off-by-one culls.
    const session = { lastSeen: NOW - IDLE_MS, openGetStreams: 0 };
    expect(shouldReapSession(session, NOW, IDLE_MS)).toBe(false);
  });

  it("session with openGetStreams === 0 AND lastSeen within idleMs → NO-OP", () => {
    // Recently-active POST-only session — no SSE listener but its owner
    // has been polling. Reaper waits.
    const session = { lastSeen: NOW - 60_000, openGetStreams: 0 };
    expect(shouldReapSession(session, NOW, IDLE_MS)).toBe(false);
  });

  it("predicate is pure: same inputs → same output across repeated calls", () => {
    const session = { lastSeen: NOW - IDLE_MS - 1, openGetStreams: 0 };
    const r1 = shouldReapSession(session, NOW, IDLE_MS);
    const r2 = shouldReapSession(session, NOW, IDLE_MS);
    const r3 = shouldReapSession(session, NOW, IDLE_MS);
    expect([r1, r2, r3]).toEqual([true, true, true]);
  });
});
