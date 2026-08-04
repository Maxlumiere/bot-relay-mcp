// Tether for bot-relay-mcp (VSCode)
// SPDX-License-Identifier: MIT
//
// #3 — the no-delivery warning must reach a human without spamming. Both legs:
// it FIRES on the condition (the surfacing that was missing), and it throttles
// per-tick re-consideration without ever muting a DIFFERENT deaf agent.
import { describe, it, expect } from "vitest";
import { decideNoDeliveryWarn, NO_WAKE_WARN_COOLDOWN_MS } from "./no-delivery-warn.js";

describe("#3 no-delivery warn throttle", () => {
  it("HARM surfaced: the first no-delivery for an agent WARNS (the line finally reaches a human)", () => {
    const m = new Map<string, number>();
    expect(decideNoDeliveryWarn('codex-5-5 has mail — no bound terminal', 1_000, NO_WAKE_WARN_COOLDOWN_MS, m)).toBe(true);
  });

  it("throttle: the same condition within the cooldown is SUPPRESSED (no per-poll-tick spam)", () => {
    const m = new Map<string, number>();
    decideNoDeliveryWarn("k", 1_000, 60_000, m);
    expect(decideNoDeliveryWarn("k", 1_000 + 59_999, 60_000, m)).toBe(false);
  });

  it("persistent deafness RE-WARNS on the cooldown boundary (a still-deaf agent keeps nagging, errs toward warning)", () => {
    const m = new Map<string, number>();
    decideNoDeliveryWarn("k", 1_000, 60_000, m);
    expect(decideNoDeliveryWarn("k", 1_000 + 60_000, 60_000, m)).toBe(true);
  });

  it("INNOCENT TWIN: distinct agents warn independently — one deaf agent never mutes another's warning", () => {
    const m = new Map<string, number>();
    decideNoDeliveryWarn("agent-a has mail — no bound terminal", 1_000, 60_000, m);
    expect(decideNoDeliveryWarn("agent-b has mail — no bound terminal", 1_000, 60_000, m)).toBe(true);
  });
});
