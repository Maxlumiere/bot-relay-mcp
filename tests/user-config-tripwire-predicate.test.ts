// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Controls for the hardened suite-wide user-config tripwire
 * (tests/global-user-config-tripwire.ts). The tripwire now compares only the
 * RELAY-OWNED region of each protected file, so ordinary Claude Code session
 * churn (which rewrites ~/.claude.json on a minutes timescale) no longer trips a
 * ~7-minute suite — while a test writing OUR region still does.
 *
 * Both directions are proven, per the acceptance bar:
 *   NEGATIVE — mutate an UNRELATED part of the file → region unchanged → PASS.
 *   POSITIVE — mutate the relay region (mcpServers["bot-relay"] / our SessionStart
 *              hook) → region changes → FAIL, and for the RIGHT reason.
 * These exercise the pure extractors + the pure decision layer directly, on
 * sandboxed strings/maps — the real ~/ is never touched.
 */
import { describe, it, expect } from "vitest";
import {
  claudeJsonRegion,
  claudeSettingsRegion,
  botRelayConfigRegion,
  changedRegions,
  protectedRegions,
} from "./global-user-config-tripwire.js";

const BOT_RELAY = {
  type: "stdio",
  command: "node",
  args: ["/Users/x/bot-relay-mcp/dist/index.js"],
  env: { RELAY_INSTANCE_ID: "fbd470d2" },
};

const claudeJson = (botRelay: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ mcpServers: { "some-other-server": { type: "http", url: "http://x" }, "bot-relay": botRelay }, ...extra });

describe("tripwire predicate — ~/.claude.json (mcpServers['bot-relay'])", () => {
  it("NEGATIVE: an unrelated key changes + servers reorder → region UNCHANGED (would PASS)", () => {
    const before = claudeJson(BOT_RELAY, { numStartups: 1, tipsHistory: ["a"] });
    // Claude Code rewrite: bumps its own keys, reorders mcpServers, adds a session key.
    const after = JSON.stringify({
      newSessionState: { foo: 1 },
      numStartups: 2,
      tipsHistory: ["a", "b"],
      mcpServers: { "bot-relay": BOT_RELAY, "some-other-server": { url: "http://x", type: "http" } },
    });
    expect(claudeJsonRegion(before)).toBe(claudeJsonRegion(after));
  });

  it("POSITIVE: the bot-relay subtree changes → region CHANGES (would FAIL) — and only because of it", () => {
    const before = claudeJson(BOT_RELAY, { numStartups: 1 });
    const mutated = { ...BOT_RELAY, env: { RELAY_INSTANCE_ID: "CLOBBERED" } };
    const after = claudeJson(mutated, { numStartups: 1 });
    expect(claudeJsonRegion(before)).not.toBe(claudeJsonRegion(after));
    // The right reason: the region string reflects the changed subtree specifically.
    expect(claudeJsonRegion(after)).toContain("CLOBBERED");
    expect(claudeJsonRegion(before)).not.toContain("CLOBBERED");
  });

  it("a removed bot-relay entry → region CHANGES (a test that deletes our server trips)", () => {
    const before = claudeJson(BOT_RELAY);
    const after = JSON.stringify({ mcpServers: { "some-other-server": { type: "http", url: "http://x" } } });
    expect(claudeJsonRegion(before)).not.toBe(claudeJsonRegion(after));
  });
});

describe("tripwire predicate — ~/.claude/settings.json (relay SessionStart hook)", () => {
  const RELAY_HOOK = { type: "command", command: "/Users/x/bot-relay-mcp/hooks/check-relay.sh", timeout: 10 };
  const settings = (relayHook: unknown, extraSessionStart: unknown[] = [], extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: "startup|resume", hooks: [relayHook] }, ...extraSessionStart],
        PostToolUse: [{ hooks: [{ type: "command", command: "/other/pth.sh" }] }],
      },
      ...extra,
    });

  it("NEGATIVE: an unrelated SessionStart hook is added + top-level key changes → region UNCHANGED", () => {
    const before = settings(RELAY_HOOK, [], { theme: "dark" });
    const after = settings(
      RELAY_HOOK,
      [{ matcher: "startup", hooks: [{ type: "command", command: "/someone-elses/hook.sh", timeout: 5 }] }],
      { theme: "light", newKey: 1 }
    );
    expect(claudeSettingsRegion(before)).toBe(claudeSettingsRegion(after));
  });

  it("POSITIVE: OUR hook's command/timeout changes → region CHANGES (would FAIL)", () => {
    const before = claudeSettingsRegion(settings(RELAY_HOOK));
    const afterTimeout = claudeSettingsRegion(settings({ ...RELAY_HOOK, timeout: 30 }));
    const afterCommand = claudeSettingsRegion(settings({ ...RELAY_HOOK, command: "/Users/x/bot-relay-mcp/hooks/check-relay.sh --evil" }));
    expect(before).not.toBe(afterTimeout);
    expect(before).not.toBe(afterCommand);
  });

  it("a REMOVED relay hook → region CHANGES (a test that drops our hook trips)", () => {
    const withHook = claudeSettingsRegion(settings(RELAY_HOOK));
    const withoutHook = claudeSettingsRegion(JSON.stringify({ hooks: { SessionStart: [{ matcher: "x", hooks: [{ type: "command", command: "/other/hook.sh" }] }] } }));
    expect(withHook).not.toBe(withoutHook);
  });
});

describe("tripwire predicate — decision layer + ABSENT handling", () => {
  it("ABSENT→ABSENT is unchanged; a relay-region change is flagged", () => {
    const paths = protectedRegions().map((p) => p.path);
    const before = new Map(paths.map((p) => [p, "ABSENT"] as const));
    const afterSame = new Map(paths.map((p) => [p, "ABSENT"] as const));
    expect(changedRegions(before, afterSame)).toHaveLength(0); // ABSENT→ABSENT: no trip

    const afterOne = new Map(afterSame);
    afterOne.set(paths[0], 'mcpServers["bot-relay"]-mutated');
    const flagged = changedRegions(before, afterOne);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].path).toBe(paths[0]);
  });

  it("~/.bot-relay/config.json: whole-file change flagged; ABSENT→created flagged (relay-owned)", () => {
    expect(botRelayConfigRegion("a")).not.toBe(botRelayConfigRegion("b"));
    // created mid-run: ABSENT (file-level) vs a region string → different → trip
    expect("ABSENT").not.toBe(botRelayConfigRegion("{}"));
  });
});
