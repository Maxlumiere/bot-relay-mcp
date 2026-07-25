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
 * ADR-0015 two-leg rule — EVERY guard is tested by BOTH:
 *   HARM LEG — attempt the harm through the shipped predicate → assert it FAILS
 *     (region CHANGES): relay MCP entry rewritten, our hook's command OR matcher
 *     changed, config.json mode widened with identical bytes, a foreign command
 *     falsely claimed as ours. Written FROM the harm, not from the implementation.
 *   INNOCENT TWIN — the benign near-neighbour → assert it PASSES (region
 *     unchanged): ambient Claude Code churn, a foreign SessionStart hook, key
 *     reordering, a mode change on the SHARED Claude files.
 * These exercise the shipped predicate (the pure extractors + regionOf + the
 * decision layer the globalSetup calls) on sandboxed strings/files — the real ~/
 * is never touched.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  claudeJsonRegion,
  claudeSettingsRegion,
  botRelayConfigRegion,
  changedRegions,
  protectedRegions,
  regionOf,
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

describe("shared ownership classifier — isRelayCheckHookCommand (reject cases FIRST)", () => {
  // codex #139: a classifier without reject controls is an accept-list in a
  // costume. The whole command must BE our hook path, not merely CONTAIN it.
  it("REJECTS: a foreign command whose ARGUMENT is a relay-shaped path (the codex counterexample)", () => {
    expect(isRelayCheckHookCommand("echo /foreign/hooks/check-relay.sh")).toBe(false); // <-- the v2 false-positive
    expect(isRelayCheckHookCommand("cat '/x/hooks/check-relay.sh'")).toBe(false); // quoted arg, opening quote not at index 0
    expect(isRelayCheckHookCommand("bash /root/hooks/check-relay.sh")).toBe(false); // interpreter prefix — not a shape we write
    expect(isRelayCheckHookCommand("/root/hooks/check-relay.sh --flag")).toBe(false); // trailing arg
  });

  it("REJECTS: name-mentions that are not our hook (#128 false-ownership class)", () => {
    expect(isRelayCheckHookCommand("echo check-relay.sh")).toBe(false); // bare name
    expect(isRelayCheckHookCommand("check-relay.sh")).toBe(false); // basename alone
    expect(isRelayCheckHookCommand("/x/not-hooks/check-relay.sh")).toBe(false); // wrong parent dir
    expect(isRelayCheckHookCommand("/x/hooks/check-relay.sh.bak")).toBe(false); // wrong suffix
    expect(isRelayCheckHookCommand("/x/hooks/check-relay.sh/wrapper.sh")).toBe(false); // our name is a parent DIR
    expect(isRelayCheckHookCommand("/x/check-relay.sh/hooks/other.sh")).toBe(false); // name in an ancestor dir
    expect(isRelayCheckHookCommand("")).toBe(false);
    expect(isRelayCheckHookCommand(undefined)).toBe(false);
    expect(isRelayCheckHookCommand(42)).toBe(false);
  });

  it("ACCEPTS: only the single-token path shapes the installer actually writes", () => {
    expect(isRelayCheckHookCommand("/Users/x/bot-relay-mcp/hooks/check-relay.sh")).toBe(true); // init raw path (no space)
    expect(isRelayCheckHookCommand("'/Users/x/bot-relay-mcp/hooks/check-relay.sh'")).toBe(true); // single-quoted
    expect(isRelayCheckHookCommand("'/Users/x/LLMs/Claude AI/bot-relay-mcp/hooks/check-relay.sh'")).toBe(true); // quoted spaced path
    expect(isRelayCheckHookCommand('"/Users/x/bot-relay-mcp/hooks/check-relay.sh"')).toBe(true); // double-quoted
    expect(isRelayCheckHookCommand("/Users/x/My%20Dir/bot-relay-mcp/hooks/check-relay.sh")).toBe(true); // %20 fossil — our own broken entry
  });

  it("DIVERGENCE GUARD: accepts the EXACT command init/generate-hooks produce (fails if the shape drifts)", () => {
    const rootNoSpace = "/opt/relay/bot-relay-mcp";
    const rootSpace = "/Users/x/LLMs/Claude AI/bot-relay-mcp";
    const initCmd = path.join(rootNoSpace, "hooks", "check-relay.sh"); // init writes the raw path (no-space install)
    const genQuoted = `'${path.join(rootSpace, "hooks", "check-relay.sh")}'`; // generate-hooks single-quotes a spaced path
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

// codex #139 P1 — the harm is a MODE widening that exposes http_secret with
// byte-identical content. Exercised through the SHIPPED regionOf() on real files.
// POSIX only (chmod semantics); Windows mode bits are not meaningful.
describe.skipIf(process.platform === "win32")("mode leg — ~/.bot-relay/config.json (relay-owned, secret-bearing)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tripwire-mode-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const configPR = (p: string) => ({ path: p, extract: botRelayConfigRegion, label: "config", fingerprintMode: true });
  const sharedPR = (p: string) => ({ path: p, extract: claudeJsonRegion, label: "shared" }); // fingerprintMode omitted

  it("HARM: config.json chmod 0644 with BYTE-IDENTICAL content → region CHANGES (would FAIL)", () => {
    const f = path.join(dir, "config.json");
    fs.writeFileSync(f, '{"http_secret":"s3cr3t","http_port":3777}', { mode: 0o600 });
    const before = regionOf(configPR(f));
    fs.chmodSync(f, 0o644); // widen mode, do NOT touch bytes
    const after = regionOf(configPR(f));
    expect(before).not.toBe(after); // the P1: a content-only fingerprint would MISS this
    expect(before).toMatch(/::mode=600$/);
    expect(after).toMatch(/::mode=644$/);
  });

  it("INNOCENT TWIN: a mode change on a SHARED Claude file → region UNCHANGED (PASS)", () => {
    // The distinction victra got wrong and codex corrected: mode is in scope ONLY
    // for the relay-owned secret-bearing file, out of scope for shared/ambient ones
    // (folding it in there would re-admit the false-trips this rewrite removed).
    const f = path.join(dir, "claude.json");
    fs.writeFileSync(f, JSON.stringify({ mcpServers: { "bot-relay": { command: "node" } } }), { mode: 0o600 });
    const before = regionOf(sharedPR(f));
    fs.chmodSync(f, 0o644);
    const after = regionOf(sharedPR(f));
    expect(before).toBe(after); // mode out of scope for the shared file
  });

  it("INNOCENT: config.json identical content AND identical mode → region unchanged", () => {
    const f = path.join(dir, "config.json");
    fs.writeFileSync(f, '{"http_secret":"s3cr3t"}', { mode: 0o600 });
    const before = regionOf(configPR(f));
    const after = regionOf(configPR(f)); // no mutation
    expect(before).toBe(after);
  });
});
