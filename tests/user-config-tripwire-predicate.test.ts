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
import path from "path";
import {
  claudeJsonRegion,
  claudeSettingsRegion,
  botRelayConfigRegion,
  changedRegions,
  protectedRegions,
} from "./global-user-config-tripwire.js";
import { isRelayCheckHookCommand } from "../src/cli/config-merge.js";

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
  const RELAY_HOOK = { type: "command", command: "'/Users/x/bot-relay-mcp/hooks/check-relay.sh'", timeout: 10 };
  const settings = (relayHook: unknown, matcher = "startup|resume", extraSessionStart: unknown[] = [], extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      hooks: {
        SessionStart: [{ matcher, hooks: [relayHook] }, ...extraSessionStart],
        PostToolUse: [{ hooks: [{ type: "command", command: "/other/pth.sh" }] }],
      },
      ...extra,
    });

  it("NEGATIVE: an unrelated SessionStart hook is added + top-level key changes → region UNCHANGED", () => {
    const before = settings(RELAY_HOOK, "startup|resume", [], { theme: "dark" });
    const after = settings(
      RELAY_HOOK,
      "startup|resume",
      [{ matcher: "startup", hooks: [{ type: "command", command: "/someone-elses/hook.sh", timeout: 5 }] }],
      { theme: "light", newKey: 1 }
    );
    expect(claudeSettingsRegion(before)).toBe(claudeSettingsRegion(after));
  });

  it("POSITIVE (P1 regression): a MATCHER flip that disables our hook → region CHANGES (would FAIL)", () => {
    // The codex #139 P1: matcher "startup|resume" → "never" disables the relay hook
    // while the hook OBJECT is byte-identical. A hook-object-only region waved this
    // through; carrying the matcher catches it.
    const before = claudeSettingsRegion(settings(RELAY_HOOK, "startup|resume"));
    const afterMatcher = claudeSettingsRegion(settings(RELAY_HOOK, "never"));
    expect(before).not.toBe(afterMatcher);
  });

  it("POSITIVE: OUR hook's command/timeout changes → region CHANGES (would FAIL)", () => {
    const before = claudeSettingsRegion(settings(RELAY_HOOK));
    const afterTimeout = claudeSettingsRegion(settings({ ...RELAY_HOOK, timeout: 30 }));
    const afterCommand = claudeSettingsRegion(settings({ ...RELAY_HOOK, command: "'/Users/x/bot-relay-mcp/hooks/check-relay.sh' --evil" }));
    expect(before).not.toBe(afterTimeout);
    expect(before).not.toBe(afterCommand);
  });

  it("a REMOVED relay hook → region CHANGES (a test that drops our hook trips)", () => {
    const withHook = claudeSettingsRegion(settings(RELAY_HOOK));
    const withoutHook = claudeSettingsRegion(JSON.stringify({ hooks: { SessionStart: [{ matcher: "x", hooks: [{ type: "command", command: "/other/hook.sh" }] }] } }));
    expect(withHook).not.toBe(withoutHook);
  });
});

describe("shared ownership classifier — isRelayCheckHookCommand (precise, not substring)", () => {
  it("ACCEPTS every shape the installer writes", () => {
    expect(isRelayCheckHookCommand("/Users/x/bot-relay-mcp/hooks/check-relay.sh")).toBe(true); // init raw path
    expect(isRelayCheckHookCommand("'/Users/x/bot-relay-mcp/hooks/check-relay.sh'")).toBe(true); // quoted (spaces)
    expect(isRelayCheckHookCommand("'/Users/x/LLMs/Claude AI/bot-relay-mcp/hooks/check-relay.sh'")).toBe(true); // real space-path
    expect(isRelayCheckHookCommand("bash /root/hooks/check-relay.sh")).toBe(true); // leading interpreter
    expect(isRelayCheckHookCommand("/root/hooks/check-relay.sh --flag")).toBe(true); // trailing arg
  });

  it("REJECTS foreign commands that merely mention the name (the #128 false-ownership trap)", () => {
    expect(isRelayCheckHookCommand("echo check-relay.sh")).toBe(false); // bare name, not a path tail
    expect(isRelayCheckHookCommand("/x/not-hooks/check-relay.sh")).toBe(false); // wrong parent dir
    expect(isRelayCheckHookCommand("/x/hooks/check-relay.sh.bak")).toBe(false); // not the exact tail
    expect(isRelayCheckHookCommand("check-relay.sh")).toBe(false); // basename alone
    expect(isRelayCheckHookCommand(undefined)).toBe(false);
    expect(isRelayCheckHookCommand(42)).toBe(false);
  });

  it("DIVERGENCE GUARD: the classifier accepts the EXACT command the installer produces", () => {
    // Pins the classifier to what src/cli/init.ts writes (path.join(root,"hooks",
    // "check-relay.sh")) and what generate-hooks emits (same path, single-quoted
    // when it has spaces). If the installer's command shape ever drifts, this fails.
    const rootNoSpace = "/opt/relay/bot-relay-mcp";
    const rootSpace = "/Users/x/LLMs/Claude AI/bot-relay-mcp";
    const initCmd = path.join(rootNoSpace, "hooks", "check-relay.sh"); // init writes the raw path
    const genQuoted = `'${path.join(rootSpace, "hooks", "check-relay.sh")}'`; // generate-hooks quotes spaced paths
    expect(isRelayCheckHookCommand(initCmd)).toBe(true);
    expect(isRelayCheckHookCommand(genQuoted)).toBe(true);
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

  it("UNPARSEABLE residual handled: two DIFFERENT corruptions read as CHANGED, not unchanged", () => {
    // A test that corrupts ~/.claude.json two different ways must trip, not slip
    // through a constant "UNPARSEABLE" sentinel (codex #139 residual).
    const good = claudeJsonRegion(JSON.stringify({ mcpServers: { "bot-relay": { command: "node" } } }));
    const brokenA = claudeJsonRegion("{ this is not json");
    const brokenB = claudeJsonRegion("also not }{ json but different");
    expect(good).not.toBe(brokenA); // valid → corrupt trips
    expect(brokenA).not.toBe(brokenB); // corrupt one way → corrupt another trips
    expect(brokenA).toMatch(/^UNPARSEABLE:/);
  });
});
