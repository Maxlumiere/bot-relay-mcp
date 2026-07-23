// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * THE WORKTREE-CLOBBER GUARDS (2026-07-23).
 *
 * Root cause proven that day: tests/v2-3-0-profiles.test.ts ran the REAL
 * `relay init` without redirecting the home dir, so every `npm test` rewrote
 * the REAL ~/.claude.json + ~/.claude/settings.json with paths derived from
 * whichever checkout ran the suite — codex audit worktrees pointed every agent
 * at an UNMERGED build; the space-containing main checkout wrote a
 * percent-encoded path that doesn't exist. A contributor running our test
 * suite lost their working relay setup with no warning. Same class as the
 * launchd install Steph flagged (#116 / RELAY_SKIP_DAEMON) — that fixed one
 * symptom; these guards close the pattern.
 *
 * Three layers, each proven load-bearing here:
 *  (G1–G2)  %20 fossil: moduleRootFromUrl must DECODE the module URL.
 *  (G3–G6)  chokepoint: atomicWriteJson refuses real user-config targets
 *           under a test harness — keyed on the DESTINATION, so no future
 *           test can reintroduce the clobber by forgetting an env var.
 *  (plus the suite-wide before/after tripwire in
 *   tests/global-user-config-tripwire.ts, wired via vitest.config.ts.)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const { moduleRootFromUrl } = await import("../src/cli/init.js");
const { atomicWriteJson, assertNotRealUserConfigWrite, _setAccountHomeForTests } =
  await import("../src/cli/config-merge.js");

const SANDBOX = path.join(os.tmpdir(), "bot-relay-config-guard-" + process.pid);
const SAVED = {
  claudeHome: process.env.RELAY_CLAUDE_HOME,
  configPath: process.env.RELAY_CONFIG_PATH,
};

beforeEach(() => {
  delete process.env.RELAY_CLAUDE_HOME;
  delete process.env.RELAY_CONFIG_PATH;
  fs.mkdirSync(SANDBOX, { recursive: true });
});

afterEach(() => {
  // Restore state even if a test threw mid-way.
  _setAccountHomeForTests(null);
  if (SAVED.claudeHome !== undefined) process.env.RELAY_CLAUDE_HOME = SAVED.claudeHome;
  if (SAVED.configPath !== undefined) process.env.RELAY_CONFIG_PATH = SAVED.configPath;
  if (fs.existsSync(SANDBOX)) fs.rmSync(SANDBOX, { recursive: true, force: true });
});

describe("%20 fossil — moduleRootFromUrl decodes the module URL", () => {
  it("(G1) a file:// URL with an encoded space resolves to the REAL path", () => {
    // The old `new URL(url).pathname` form returns '/tmp/My%20Dir' — a path
    // that does not exist — and that string went verbatim into ~/.claude.json.
    expect(moduleRootFromUrl("file:///tmp/My%20Dir/dist/cli/init.js")).toBe("/tmp/My Dir");
  });

  it("(G2) unencoded URLs are unaffected", () => {
    expect(moduleRootFromUrl("file:///opt/relay/dist/cli/init.js")).toBe("/opt/relay");
  });
});

describe("chokepoint — test-harness writes to REAL user config are refused", () => {
  it("(G3) assertNotRealUserConfigWrite names all three ACCOUNT-home files", () => {
    // Direct contract check against the true account paths. The assert
    // function never writes, so this is safe to run against the real
    // locations. userInfo().homedir, not os.homedir(): the account database
    // answer, immune to a sandboxed $HOME.
    const home = os.userInfo().homedir;
    for (const p of [
      path.join(home, ".claude.json"),
      path.join(home, ".claude", "settings.json"),
      path.join(home, ".bot-relay", "config.json"),
    ]) {
      expect(() => assertNotRealUserConfigWrite(p), p).toThrow(/refusing to write the REAL user config/);
    }
  });

  it("(G3b) codex #125 blocker 1: pointing the redirect AT the real home does NOT stand the guard down", () => {
    // The first guard version keyed on redirect-var PRESENCE; codex proved
    // RELAY_CLAUDE_HOME=<real home> bypassed it. Account-home keying refuses
    // the real paths no matter what the environment claims.
    process.env.RELAY_CLAUDE_HOME = os.userInfo().homedir;
    process.env.RELAY_CONFIG_PATH = path.join(os.userInfo().homedir, ".bot-relay", "config.json");
    expect(() =>
      assertNotRealUserConfigWrite(path.join(os.userInfo().homedir, ".claude.json")),
    ).toThrow(/config-guard/);
    expect(() =>
      assertNotRealUserConfigWrite(path.join(os.userInfo().homedir, ".bot-relay", "config.json")),
    ).toThrow(/config-guard/);
  });

  it("(G4) atomicWriteJson ACTUALLY refuses — full chokepoint, temp account home", () => {
    // _setAccountHomeForTests points the guard's notion of "the account" at a
    // temp dir, so a BROKEN guard writes a temp file here — never the real
    // config (the negative-control paradox solved).
    _setAccountHomeForTests(SANDBOX);
    const target = path.join(SANDBOX, ".claude.json");
    expect(() => atomicWriteJson(target, { clobbered: true })).toThrow(/config-guard/);
    expect(fs.existsSync(target)).toBe(false); // the write NEVER landed
  });

  it("(G5) settings.json + relay config.json are protected by the same chokepoint", () => {
    _setAccountHomeForTests(SANDBOX);
    for (const target of [
      path.join(SANDBOX, ".claude", "settings.json"),
      path.join(SANDBOX, ".bot-relay", "config.json"),
    ]) {
      expect(() => atomicWriteJson(target, {}), target).toThrow(/config-guard/);
      expect(fs.existsSync(target), target).toBe(false);
    }
  });

  it("(G5b) codex #125 blocker 2: a SYMLINK ALIAS to the account home is refused BEFORE any write", () => {
    // path.resolve is lexical: alias/.claude.json !== home/.claude.json even
    // though the write lands in home. The guard canonicalizes the deepest
    // existing ancestor on both sides, so the alias resolves to the guarded
    // path and is refused — and nothing is written through the link.
    const home = path.join(SANDBOX, "acct-home");
    const alias = path.join(SANDBOX, "alias");
    fs.mkdirSync(home, { recursive: true });
    fs.symlinkSync(home, alias);
    _setAccountHomeForTests(home);
    const viaAlias = path.join(alias, ".claude.json");
    expect(() => atomicWriteJson(viaAlias, { clobbered: true })).toThrow(/config-guard/);
    expect(fs.existsSync(path.join(home, ".claude.json"))).toBe(false); // nothing landed through the link
  });

  it("(G6) sandboxed writes still work — the guard blocks the clobber, not the installer", () => {
    // A temp HOME / RELAY_CLAUDE_HOME resolves to different paths than the
    // account home, so the real-installer coverage in v2-3-0-profiles /
    // v2-1-cli-tooling / v2-16-0-* keeps running exactly as before.
    const target = path.join(SANDBOX, ".claude.json"); // guarded-SHAPED, but not the account home
    atomicWriteJson(target, { mcpServers: {} });
    expect(JSON.parse(fs.readFileSync(target, "utf-8"))).toEqual({ mcpServers: {} });
  });
});
