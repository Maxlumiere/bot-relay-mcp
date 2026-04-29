// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.5.0 Tether Phase 1 — Part E — pure-function unit tests for the
 * VSCode extension's format helpers. These bits run in the main vitest
 * suite so the extension's deterministic logic is exercised by every
 * `npm test`. The extension's UX integration (status bar updates on
 * real notifications, terminal injection, webview rendering) requires
 * vscode-test which is heavyweight + CI-only — see
 * extensions/vscode/PUBLISH.md for the manual verification checklist.
 *
 * The Server-side contract that's UPSTREAM of every UX behaviour here
 * (subscribe → real notifications/resources/updated frame received via
 * the SDK) is asserted by tests/v2-5-mcp-subscriptions.test.ts. Together
 * they cover the inbox event pipeline end-to-end without booting a full
 * VSCode test host.
 */
import { describe, it, expect } from "vitest";
import {
  formatStatusBar,
  formatToast,
  formatRelativeTime,
  statusBarSeverity,
  type InboxSnapshot,
} from "../extensions/vscode/src/format.js";

const NOW = Date.UTC(2026, 3, 29, 12, 0, 0); // 2026-04-29T12:00:00Z (deterministic)

function snapshot(overrides: Partial<InboxSnapshot> = {}): InboxSnapshot {
  return {
    agent_name: "victra",
    agent_known: true,
    pending_count: 0,
    total_count: 0,
    last_message_at: null,
    last_message_from: null,
    last_message_priority: null,
    last_message_preview: null,
    last_message_truncated: false,
    ...overrides,
  };
}

describe("v2.5.0 Tether — VSCode extension format helpers", () => {
  it("formatStatusBar with empty inbox shows 'no mail yet'", () => {
    expect(formatStatusBar(snapshot(), NOW)).toBe("Tether: 0 | last no mail yet");
  });

  it("formatStatusBar with mail shows count + relative time", () => {
    const tenMinutesAgo = new Date(NOW - 10 * 60 * 1000).toISOString();
    const s = snapshot({ pending_count: 2, last_message_at: tenMinutesAgo });
    expect(formatStatusBar(s, NOW)).toBe("Tether: 2 | last 10m ago");
  });

  it("formatRelativeTime spans seconds → minutes → hours → days", () => {
    expect(formatRelativeTime(new Date(NOW - 30 * 1000).toISOString(), NOW)).toBe("30s ago");
    expect(formatRelativeTime(new Date(NOW - 5 * 60 * 1000).toISOString(), NOW)).toBe("5m ago");
    expect(formatRelativeTime(new Date(NOW - 3 * 60 * 60 * 1000).toISOString(), NOW)).toBe("3h ago");
    expect(formatRelativeTime(new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString(), NOW)).toBe("2d ago");
  });

  it("formatRelativeTime with future timestamp returns 'just now' (clock-skew defense)", () => {
    expect(formatRelativeTime(new Date(NOW + 10_000).toISOString(), NOW)).toBe("just now");
  });

  it("statusBarSeverity buckets pending count into ok/warn/alert", () => {
    expect(statusBarSeverity(snapshot({ pending_count: 0 }))).toBe("ok");
    expect(statusBarSeverity(snapshot({ pending_count: 2 }))).toBe("warn");
    expect(statusBarSeverity(snapshot({ pending_count: 4 }))).toBe("alert");
    expect(statusBarSeverity(snapshot({ pending_count: 100 }))).toBe("alert");
  });

  it("formatToast names sender + agent inbox; falls back to 'system' when sender absent", () => {
    expect(
      formatToast(snapshot({ agent_name: "victra-build", last_message_from: "victra" })),
    ).toBe("Tether: New message from victra in victra-build inbox");
    expect(
      formatToast(snapshot({ agent_name: "victra-build", last_message_from: null })),
    ).toBe("Tether: New message from system in victra-build inbox");
  });
});
