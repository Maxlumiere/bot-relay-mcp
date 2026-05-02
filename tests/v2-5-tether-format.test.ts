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
import { resolveTetherConfig } from "../extensions/vscode/src/config.js";

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

/**
 * R1 #3 — endpoint precedence regression. Pre-R1 the inline `?:` ternary
 * bound after `||`, so VSCode-configured endpoints were silently ignored
 * when env vars were set. The 8-combo matrix below pins the canonical
 * rule (VSCode setting > env > default) for endpoint, agentName, and
 * agentToken so a future inline-rewrite can't reintroduce the bug.
 */
function makeGetter(
  overrides: Record<string, string | boolean | undefined>,
): (key: string) => string | boolean | undefined {
  return (key) => overrides[key];
}

describe("v2.5.0 R1 — Tether config precedence (VSCode > env > default)", () => {
  it("endpoint: VSCode setting wins over env + default", () => {
    const c = resolveTetherConfig(
      makeGetter({ endpoint: "http://10.0.0.1:9999" }),
      { RELAY_HTTP_HOST: "10.0.0.2", RELAY_HTTP_PORT: "9000" },
    );
    expect(c.endpoint).toBe("http://10.0.0.1:9999");
  });

  it("endpoint: env composes when VSCode setting is empty/whitespace", () => {
    const c = resolveTetherConfig(
      makeGetter({ endpoint: "  " }),
      { RELAY_HTTP_HOST: "10.0.0.2", RELAY_HTTP_PORT: "9000" },
    );
    expect(c.endpoint).toBe("http://10.0.0.2:9000");
  });

  it("endpoint: env with only RELAY_HTTP_HOST defaults port to 3777", () => {
    const c = resolveTetherConfig(makeGetter({}), { RELAY_HTTP_HOST: "10.0.0.2" });
    expect(c.endpoint).toBe("http://10.0.0.2:3777");
  });

  it("endpoint: env with only RELAY_HTTP_PORT (no host) falls through to default", () => {
    // R0 bug: produced "http://undefined:9000" because env partial was
    // treated as "use env." The R1 rule: env composition requires HOST;
    // partial env falls through.
    const c = resolveTetherConfig(makeGetter({}), { RELAY_HTTP_PORT: "9000" });
    expect(c.endpoint).toBe("http://127.0.0.1:3777");
    expect(c.endpoint).not.toContain("undefined");
  });

  it("endpoint: bare default with no VSCode + no env", () => {
    const c = resolveTetherConfig(makeGetter({}), {});
    expect(c.endpoint).toBe("http://127.0.0.1:3777");
  });

  it("agentName: VSCode setting wins over env", () => {
    const c = resolveTetherConfig(
      makeGetter({ agentName: "from-cfg" }),
      { RELAY_AGENT_NAME: "from-env" },
    );
    expect(c.agentName).toBe("from-cfg");
  });

  it("agentName: env wins when VSCode setting empty", () => {
    const c = resolveTetherConfig(
      makeGetter({ agentName: "" }),
      { RELAY_AGENT_NAME: "from-env" },
    );
    expect(c.agentName).toBe("from-env");
  });

  it("agentName: empty default when neither VSCode nor env set", () => {
    const c = resolveTetherConfig(makeGetter({}), {});
    expect(c.agentName).toBe("");
  });

  it("agentToken: VSCode > env > '' (same precedence shape as agentName)", () => {
    expect(
      resolveTetherConfig(
        makeGetter({ agentToken: "tok-cfg" }),
        { RELAY_AGENT_TOKEN: "tok-env" },
      ).agentToken,
    ).toBe("tok-cfg");
    expect(
      resolveTetherConfig(makeGetter({}), { RELAY_AGENT_TOKEN: "tok-env" }).agentToken,
    ).toBe("tok-env");
    expect(resolveTetherConfig(makeGetter({}), {}).agentToken).toBe("");
  });

  it("autoInjectInbox + notificationLevel default sensibly when unset", () => {
    const c = resolveTetherConfig(makeGetter({}), {});
    expect(c.autoInjectInbox).toBe(false);
    expect(c.notificationLevel).toBe("event");
  });
});
