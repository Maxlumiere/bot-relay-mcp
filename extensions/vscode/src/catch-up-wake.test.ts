// Tether for bot-relay-mcp (VSCode)
// SPDX-License-Identifier: MIT
//
// v0.2.3 (A) — catch-up wake decision. The no-double-wake assertion is the
// load-bearing one (Risk-A): on a reconnect with no new mail, decideWake must
// NOT fire again. These tests pin the watermark contract directly; the
// real-daemon round-trip (tests/tether-reliable-wake.test.ts) proves the same
// invariant against a live HTTP daemon's snapshots.

import { describe, it, expect } from "vitest";
import { decideWake } from "./catch-up-wake.js";

const T1 = "2026-06-17T10:00:00.000Z";
const T2 = "2026-06-17T10:05:00.000Z";

describe("decideWake — catch-up / live shared watermark", () => {
  it("does NOT wake when autoInjectInbox is off (gated on autoInject only, A2)", () => {
    const d = decideWake(
      { pending_count: 3, last_message_at: T1 },
      { autoInjectInbox: false, lastWokenAt: null },
    );
    expect(d.shouldWake).toBe(false);
    expect(d.newMark).toBe(null); // mark untouched
  });

  it("does NOT wake when nothing is pending", () => {
    const d = decideWake(
      { pending_count: 0, last_message_at: T1 },
      { autoInjectInbox: true, lastWokenAt: null },
    );
    expect(d.shouldWake).toBe(false);
  });

  it("does NOT wake when the inbox has no message timestamp", () => {
    const d = decideWake(
      { pending_count: 0, last_message_at: null },
      { autoInjectInbox: true, lastWokenAt: null },
    );
    expect(d.shouldWake).toBe(false);
  });

  it("WAKES on first subscribe with pending mail, advancing the mark", () => {
    const d = decideWake(
      { pending_count: 2, last_message_at: T1 },
      { autoInjectInbox: true, lastWokenAt: null },
    );
    expect(d).toEqual({ shouldWake: true, newMark: T1 });
  });

  it("★ NO DOUBLE-WAKE: a reconnect with no new mail (last === mark) does NOT wake", () => {
    const d = decideWake(
      { pending_count: 2, last_message_at: T1 },
      { autoInjectInbox: true, lastWokenAt: T1 },
    );
    expect(d.shouldWake).toBe(false);
    expect(d.newMark).toBe(T1);
  });

  it("WAKES again only when genuinely newer mail arrives (T2 > mark T1)", () => {
    const d = decideWake(
      { pending_count: 3, last_message_at: T2 },
      { autoInjectInbox: true, lastWokenAt: T1 },
    );
    expect(d).toEqual({ shouldWake: true, newMark: T2 });
  });

  it("reload (module memory reset → lastWokenAt=null) RE-WAKES still-pending mail (A1 desired)", () => {
    const d = decideWake(
      { pending_count: 5, last_message_at: T2 },
      { autoInjectInbox: true, lastWokenAt: null },
    );
    expect(d.shouldWake).toBe(true);
  });

  it("agent switch: a different newest-message timestamp wakes for the new inbox", () => {
    // mark carried from the previous agent (T1); the switched-to inbox's
    // newest message differs → wake for the new agent's pending mail.
    const d = decideWake(
      { pending_count: 1, last_message_at: T2 },
      { autoInjectInbox: true, lastWokenAt: T1 },
    );
    expect(d.shouldWake).toBe(true);
    expect(d.newMark).toBe(T2);
  });
});
