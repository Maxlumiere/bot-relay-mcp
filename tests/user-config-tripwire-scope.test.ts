// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * 2026-07-24 — the tripwire watches RELAY-OWNED state, not whole files.
 *
 * The original whole-file hash false-positived on every suite launched from a
 * live Claude Code session (~/.claude.json is Claude Code's own state file and
 * is rewritten mid-run), which sent a "residual sandbox escape" hunt after a
 * writer that did not exist. These tests pin the scoping contract:
 * Claude-Code-owned churn is invisible; any relay-owned drift is not.
 */
import { describe, it, expect } from "vitest";
import { extractRelayOwnedState } from "./global-user-config-tripwire.js";

const relayEntry = {
  type: "stdio",
  command: "node",
  args: ["/Users/op/bot-relay-mcp/dist/index.js"],
  env: { RELAY_INSTANCE_ID: "abc" },
};

describe("tripwire scope — ~/.claude.json (kind: claude-json)", () => {
  it("ignores Claude Code's own state churn (history, projects, other servers)", () => {
    const before = { history: ["a"], mcpServers: { "bot-relay": relayEntry, other: { x: 1 } } };
    const after = { history: ["a", "b", "c"], projects: { p: 1 }, mcpServers: { "bot-relay": relayEntry, other: { x: 2 } } };
    expect(extractRelayOwnedState("claude-json", JSON.stringify(before))).toBe(
      extractRelayOwnedState("claude-json", JSON.stringify(after)),
    );
  });

  it("trips on any change to the bot-relay entry (the %20 clobber shape)", () => {
    const before = { mcpServers: { "bot-relay": relayEntry } };
    const clobbered = {
      mcpServers: {
        "bot-relay": {
          ...relayEntry,
          args: ["/Users/op/LLMs/Claude%20AI/bot-relay-mcp/dist/index.js"],
          env: {},
        },
      },
    };
    expect(extractRelayOwnedState("claude-json", JSON.stringify(before))).not.toBe(
      extractRelayOwnedState("claude-json", JSON.stringify(clobbered)),
    );
  });

  it("trips on entry removal (whole-file wipe still detected)", () => {
    const before = { mcpServers: { "bot-relay": relayEntry } };
    expect(extractRelayOwnedState("claude-json", JSON.stringify(before))).not.toBe(
      extractRelayOwnedState("claude-json", JSON.stringify({})),
    );
    expect(extractRelayOwnedState("claude-json", "{}")).toBe("NO-RELAY-ENTRY");
  });

  it("fails closed on unparseable content — any byte then counts", () => {
    const a = extractRelayOwnedState("claude-json", "{corrupt");
    const b = extractRelayOwnedState("claude-json", "{corrupt!");
    expect(a.startsWith("UNPARSEABLE:")).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe("tripwire scope — ~/.claude/settings.json (kind: claude-settings)", () => {
  const relayHookGroup = {
    matcher: "startup|resume",
    hooks: [{ type: "command", command: "/Users/op/bot-relay-mcp/hooks/check-relay.sh", timeout: 10 }],
  };

  it("ignores the operator's own unrelated hooks", () => {
    const before = { hooks: { SessionStart: [relayHookGroup] } };
    const after = {
      hooks: {
        SessionStart: [relayHookGroup, { matcher: "*", hooks: [{ type: "command", command: "/user/own.sh" }] }],
        PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "/user/pre.sh" }] }],
      },
    };
    expect(extractRelayOwnedState("claude-settings", JSON.stringify(before))).toBe(
      extractRelayOwnedState("claude-settings", JSON.stringify(after)),
    );
  });

  it("trips when a relay hook entry is added — the per-checkout stacking shape", () => {
    const before = { hooks: { SessionStart: [relayHookGroup] } };
    const stacked = {
      hooks: {
        SessionStart: [
          relayHookGroup,
          { matcher: "startup|resume", hooks: [{ type: "command", command: "/private/tmp/audit-x/hooks/check-relay.sh" }] },
        ],
      },
    };
    expect(extractRelayOwnedState("claude-settings", JSON.stringify(before))).not.toBe(
      extractRelayOwnedState("claude-settings", JSON.stringify(stacked)),
    );
  });

  it("is order-insensitive across relay entries", () => {
    const other = { matcher: "startup", hooks: [{ type: "command", command: "/x/bot-relay/notify.sh" }] };
    const ab = { hooks: { SessionStart: [relayHookGroup, other] } };
    const ba = { hooks: { SessionStart: [other, relayHookGroup] } };
    expect(extractRelayOwnedState("claude-settings", JSON.stringify(ab))).toBe(
      extractRelayOwnedState("claude-settings", JSON.stringify(ba)),
    );
  });
});

describe("tripwire scope — ~/.bot-relay/config.json (kind: relay-config)", () => {
  it("is entirely relay-owned: any byte change trips", () => {
    expect(extractRelayOwnedState("relay-config", '{"a":1}')).not.toBe(
      extractRelayOwnedState("relay-config", '{"a":2}'),
    );
  });
});
