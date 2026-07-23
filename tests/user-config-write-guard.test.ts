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
const { atomicWriteJson, assertNotRealUserConfigWrite } = await import("../src/cli/config-merge.js");

const SANDBOX = path.join(os.tmpdir(), "bot-relay-config-guard-" + process.pid);
const REAL_HOME = process.env.HOME;
const SAVED = {
  claudeHome: process.env.RELAY_CLAUDE_HOME,
  configPath: process.env.RELAY_CONFIG_PATH,
};

beforeEach(() => {
  // The guard fires only when the redirect vars are ABSENT (their absence is
  // the forgotten-sandbox defect). Clear them so each test states its case.
  delete process.env.RELAY_CLAUDE_HOME;
  delete process.env.RELAY_CONFIG_PATH;
});

afterEach(() => {
  // Restore env even if a test threw mid-way — a leaked sandbox HOME would
  // corrupt every later test in this worker.
  if (REAL_HOME !== undefined) process.env.HOME = REAL_HOME;
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
  it("(G3) assertNotRealUserConfigWrite names all three protected files", () => {
    // Direct contract check against the true home paths. The assert function
    // never writes, so this is safe to run against the real locations.
    for (const p of [
      path.join(os.homedir(), ".claude.json"),
      path.join(os.homedir(), ".claude", "settings.json"),
      path.join(os.homedir(), ".bot-relay", "config.json"),
    ]) {
      expect(() => assertNotRealUserConfigWrite(p), p).toThrow(/refusing to write the REAL user config/);
    }
  });

  it("(G3b) a PRESENT redirect var marks the environment as deliberately sandboxed — no refusal", () => {
    // The subprocess-test shape (v2-1-cli-tooling, fresh-install-smoke): HOME
    // itself is a temp dir AND RELAY_CLAUDE_HOME points into it. From inside,
    // os.homedir() IS the sandbox — the redirect var's presence is the one
    // signal that this was done on purpose, so the guard must stand down.
    process.env.RELAY_CLAUDE_HOME = path.join(os.homedir());
    expect(() => assertNotRealUserConfigWrite(path.join(os.homedir(), ".claude.json"))).not.toThrow();
    process.env.RELAY_CONFIG_PATH = path.join(os.homedir(), ".bot-relay", "config.json");
    expect(() =>
      assertNotRealUserConfigWrite(path.join(os.homedir(), ".bot-relay", "config.json")),
    ).not.toThrow();
  });

  it("(G4) atomicWriteJson ACTUALLY refuses — proven end-to-end under a sandboxed HOME", () => {
    // os.homedir() follows $HOME on POSIX, so pointing HOME at a sandbox makes
    // the sandbox's .claude.json "the real file" — the full chokepoint fires
    // without any risk to the operator's actual config.
    fs.mkdirSync(SANDBOX, { recursive: true });
    process.env.HOME = SANDBOX;
    const target = path.join(SANDBOX, ".claude.json");
    expect(() => atomicWriteJson(target, { clobbered: true })).toThrow(/config-guard/);
    expect(fs.existsSync(target)).toBe(false); // the write NEVER landed
  });

  it("(G5) settings.json + relay config.json are protected by the same chokepoint", () => {
    fs.mkdirSync(SANDBOX, { recursive: true });
    process.env.HOME = SANDBOX;
    for (const target of [
      path.join(SANDBOX, ".claude", "settings.json"),
      path.join(SANDBOX, ".bot-relay", "config.json"),
    ]) {
      expect(() => atomicWriteJson(target, {}), target).toThrow(/config-guard/);
      expect(fs.existsSync(target), target).toBe(false);
    }
  });

  it("(G6) sandboxed writes still work — the guard blocks the clobber, not the installer", () => {
    // RELAY_CLAUDE_HOME-redirected paths differ from the real files, so the
    // real-installer coverage in v2-3-0-profiles / v2-16-0-* keeps running.
    fs.mkdirSync(SANDBOX, { recursive: true });
    const target = path.join(SANDBOX, "redirected-claude.json");
    atomicWriteJson(target, { mcpServers: {} });
    expect(JSON.parse(fs.readFileSync(target, "utf-8"))).toEqual({ mcpServers: {} });
  });
});
