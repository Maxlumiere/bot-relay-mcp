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

  // (G7) the LIVE relay config on an instance-mode machine is the PER-INSTANCE one (<root>/instances/<id>/config.json).
  // The guard refuses every instance config STRUCTURALLY (any valid id, active or not, symlink- or env-selected) by
  // pure path comparison: nothing of the operator's tree is read to work out what to protect.
  it("(G7) atomicWriteJson refuses a PER-INSTANCE relay config under the account home, and nothing is written", () => {
    _setAccountHomeForTests(SANDBOX);
    const target = path.join(SANDBOX, ".bot-relay", "instances", "fbd470d2-0000-4000-8000-000000000001", "config.json");
    expect(() => atomicWriteJson(target, { clobbered: true })).toThrow(/config-guard/);
    expect(fs.existsSync(target), "the write NEVER landed").toBe(false);
  });

  it("(G7b) the pure check names an instance config under the account home, for ANY valid id (not only the active one)", () => {
    _setAccountHomeForTests(SANDBOX);
    for (const id of ["work", "fbd470d2-0000-4000-8000-000000000002", "an_inactive-one"]) {
      const target = path.join(SANDBOX, ".bot-relay", "instances", id, "config.json");
      expect(() => assertNotRealUserConfigWrite(target), id).toThrow(/config-guard/);
    }
  });

  it("(G7c) a SYMLINK ALIAS to an instance dir is refused before any write", () => {
    const home = path.join(SANDBOX, "acct-home-7c");
    const inst = path.join(home, ".bot-relay", "instances", "work");
    fs.mkdirSync(inst, { recursive: true });
    const alias = path.join(SANDBOX, "alias-7c");
    fs.symlinkSync(inst, alias);
    _setAccountHomeForTests(home);
    expect(() => atomicWriteJson(path.join(alias, "config.json"), { clobbered: true })).toThrow(/config-guard/);
    expect(fs.existsSync(path.join(inst, "config.json"))).toBe(false);
  });

  it("(G7d) TWIN: with the protected configs PRESENT, only an instance's config.json is refused, not its siblings, not a nested look-alike, not another root", () => {
    _setAccountHomeForTests(SANDBOX);
    // The protected files EXIST (as on a configured machine): the siblings below are then other files by identity.
    // With a protected file MISSING the guard refuses them too (inconclusive is protected): (G8f) pins that.
    for (const f of [path.join(SANDBOX, ".claude.json"), path.join(SANDBOX, ".claude", "settings.json"), path.join(SANDBOX, ".bot-relay", "config.json"), path.join(SANDBOX, ".bot-relay", "instances", "work", "config.json")]) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, "{}");
    }
    const allowed = [
      path.join(SANDBOX, ".bot-relay", "instances", "work", "other.json"), // a sibling file
      path.join(SANDBOX, ".bot-relay", "instances", "work", "sub", "config.json"), // not an instance's own config
      path.join(SANDBOX, "elsewhere", ".bot-relay", "instances", "work", "config.json"), // another root
    ];
    for (const target of allowed) {
      atomicWriteJson(target, { ok: true });
      expect(JSON.parse(fs.readFileSync(target, "utf-8")), target).toEqual({ ok: true });
    }
  });

  // ---- #343 R1 rework: the guard decides on THE path walk (src/path-walk.ts) and reads its verdict through isProtected
  // (same | inconclusive), so a link anywhere in the destination, a physical `..`, a case variant, or a walk that throws
  // cannot slip past it (Codex #343 R1 #1 and #2).
  const posixOnly = process.platform === "win32";
  it.skipIf(posixOnly)("(G8a) Codex R1 #1: an instance DIR that is itself a symlink (instances/work -> elsewhere) is refused, nothing written", () => {
    const home = path.join(SANDBOX, "acct-8a");
    const elsewhere = path.join(SANDBOX, "relocated-prod");
    fs.mkdirSync(path.join(home, ".bot-relay", "instances"), { recursive: true });
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.symlinkSync(elsewhere, path.join(home, ".bot-relay", "instances", "work"));
    _setAccountHomeForTests(home);
    const target = path.join(home, ".bot-relay", "instances", "work", "config.json");
    expect(() => atomicWriteJson(target, { clobbered: true })).toThrow(/config-guard/);
    expect(fs.existsSync(path.join(elsewhere, "config.json")), "nothing landed through the link").toBe(false);
  });
  it.skipIf(posixOnly)("(G8b) Codex R1 #1: an instance config.json that is itself a symlink to another file is refused (the rename would replace the protected entry)", () => {
    const home = path.join(SANDBOX, "acct-8b");
    const inst = path.join(home, ".bot-relay", "instances", "work");
    fs.mkdirSync(inst, { recursive: true });
    const other = path.join(SANDBOX, "other.json");
    fs.writeFileSync(other, "{}");
    fs.symlinkSync(other, path.join(inst, "config.json"));
    _setAccountHomeForTests(home);
    expect(() => atomicWriteJson(path.join(inst, "config.json"), { clobbered: true })).toThrow(/config-guard/);
    expect(fs.lstatSync(path.join(inst, "config.json")).isSymbolicLink(), "the protected entry is untouched").toBe(true);
  });
  it.skipIf(posixOnly)("(G8c) Codex R1 #2: alias/../config.json, with alias -> an instance's sub dir, lands on the instance config: refused", () => {
    const home = path.join(SANDBOX, "acct-8c");
    const inst = path.join(home, ".bot-relay", "instances", "work");
    fs.mkdirSync(path.join(inst, "sub"), { recursive: true });
    const alias = path.join(SANDBOX, "alias-8c");
    fs.symlinkSync(path.join(inst, "sub"), alias);
    _setAccountHomeForTests(home);
    expect(() => atomicWriteJson(`${alias}${path.sep}..${path.sep}config.json`, { clobbered: true })).toThrow(/config-guard/);
    expect(fs.existsSync(path.join(inst, "config.json"))).toBe(false);
  });
  it("(G8d) a case variant of an EXISTING protected config is refused where the kernel opens the same file, and allowed where it does not", () => {
    const home = path.join(SANDBOX, "acct-8d");
    const inst = path.join(home, ".bot-relay", "instances", "work");
    fs.mkdirSync(inst, { recursive: true });
    fs.writeFileSync(path.join(inst, "config.json"), "{}");
    _setAccountHomeForTests(home);
    const variant = path.join(inst, "Config.json");
    const sameFile = fs.existsSync(variant); // the kernel's own answer (a case-insensitive volume opens it)
    if (sameFile) expect(() => assertNotRealUserConfigWrite(variant)).toThrow(/config-guard/);
    else expect(() => assertNotRealUserConfigWrite(variant)).not.toThrow();
  });
  it("(G8e) a case variant of a MISSING protected config is refused (inconclusive is protected), on every volume", () => {
    const home = path.join(SANDBOX, "acct-8e");
    fs.mkdirSync(path.join(home, ".bot-relay", "instances", "work"), { recursive: true });
    _setAccountHomeForTests(home);
    expect(() => assertNotRealUserConfigWrite(path.join(home, ".bot-relay", "instances", "work", "Config.json"))).toThrow(/config-guard/);
  });
  it("(G8f) with a protected config MISSING, a write sharing its nearest existing directory is refused: a sibling, a nested look-alike, another name (the stated over-block)", () => {
    const home = path.join(SANDBOX, "acct-8f");
    fs.mkdirSync(path.join(home, ".bot-relay", "instances", "work"), { recursive: true });
    _setAccountHomeForTests(home);
    for (const t of [
      path.join(home, ".bot-relay", "instances", "work", "other.json"),
      path.join(home, ".bot-relay", "instances", "work", "sub", "config.json"),
      path.join(home, ".bot-relay", "notes.json"),
    ]) {
      expect(() => atomicWriteJson(t, { x: 1 }), t).toThrow(/config-guard/);
      expect(fs.existsSync(t), t).toBe(false);
    }
  });
  it("(G8i) a FRESH account home (nothing under it): a new file directly under it, and a path through a wholly missing subtree, are refused; a write under a directory that already exists below it is not", () => {
    const home = path.join(SANDBOX, "acct-8i-fresh");
    fs.mkdirSync(home, { recursive: true }); // the home exists, nothing under it
    _setAccountHomeForTests(home);
    for (const t of [path.join(home, "new.json"), path.join(home, "a", "b", "c.json"), path.join(home, ".bot-relay", "notes.json")]) {
      expect(() => atomicWriteJson(t, { x: 1 }), t).toThrow(/config-guard/);
      expect(fs.existsSync(t), t).toBe(false);
    }
    // TWIN: the deepest existing entry is a directory that already exists BELOW the home, not the home itself:
    // "different" from every protected path, so the write lands.
    fs.mkdirSync(path.join(home, "existing-dir"));
    const ok = path.join(home, "existing-dir", "x.json");
    atomicWriteJson(ok, { ok: true });
    expect(JSON.parse(fs.readFileSync(ok, "utf-8"))).toEqual({ ok: true });
  });
  it.skipIf(posixOnly)("(G8g) a destination the walk cannot judge (a link loop) is REFUSED, never let through", () => {
    const home = path.join(SANDBOX, "acct-8g");
    fs.mkdirSync(path.join(home, ".bot-relay"), { recursive: true });
    fs.symlinkSync(path.join(SANDBOX, "loop-b"), path.join(SANDBOX, "loop-a"));
    fs.symlinkSync(path.join(SANDBOX, "loop-a"), path.join(SANDBOX, "loop-b"));
    _setAccountHomeForTests(home);
    expect(() => assertNotRealUserConfigWrite(path.join(SANDBOX, "loop-a", "config.json"))).toThrow(/config-guard/);
  });
  it("(G8h) PRODUCTION: with VITEST and NODE_ENV unset the guard is inactive, so a first-time write on a FRESH account home lands", () => {
    const home = path.join(SANDBOX, "acct-8h-fresh");
    _setAccountHomeForTests(home); // nothing exists under it: a fresh install
    const saved = { vitest: process.env.VITEST, nodeEnv: process.env.NODE_ENV };
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    try {
      const target = path.join(home, ".bot-relay", "config.json");
      atomicWriteJson(target, { fresh: true });
      expect(JSON.parse(fs.readFileSync(target, "utf-8"))).toEqual({ fresh: true });
    } finally {
      if (saved.vitest !== undefined) process.env.VITEST = saved.vitest;
      if (saved.nodeEnv !== undefined) process.env.NODE_ENV = saved.nodeEnv;
    }
  });

  // ---- #343 R2 DESIGN (ruled, SEC-11): the protected instance INVENTORY comes from the tripwire's own sanctioned
  // snapshot (every instances/ entry: its config.json as spelled, as resolved, and the config's own target), so a
  // protected config reached through its TARGET, not through instances/<id>, is still refused.
  const inv = async (home: string): Promise<string[]> => {
    const { instanceInventory } = (await import("./_setup/vitest-tripwire-base.mjs")) as unknown as { instanceInventory?: (root: string) => { configs: string[] } };
    expect(typeof instanceInventory, "the tripwire base exports instanceInventory").toBe("function");
    return instanceInventory!(path.join(home, ".bot-relay")).configs;
  };
  const point = _setAccountHomeForTests as unknown as (p: string | null, inventory?: string[]) => void;
  it.skipIf(posixOnly)("(G9a) a DIRECT write to an instance's link target (instances/work -> relocated-prod; write relocated-prod/config.json) is refused", async () => {
    const home = path.join(SANDBOX, "acct-9a");
    const relocated = path.join(SANDBOX, "relocated-prod-9a");
    fs.mkdirSync(path.join(home, ".bot-relay", "instances"), { recursive: true });
    fs.mkdirSync(relocated, { recursive: true });
    fs.writeFileSync(path.join(relocated, "config.json"), '{"live":true}');
    fs.symlinkSync(relocated, path.join(home, ".bot-relay", "instances", "work"));
    point(home, await inv(home));
    expect(() => atomicWriteJson(path.join(relocated, "config.json"), { clobbered: true })).toThrow(/config-guard/);
    expect(fs.readFileSync(path.join(relocated, "config.json"), "utf-8")).toBe('{"live":true}');
  });
  it.skipIf(posixOnly)("(G9b) an alias whose NAME is not an instance id, pointing at that target, is refused", async () => {
    const home = path.join(SANDBOX, "acct-9b");
    const relocated = path.join(SANDBOX, "relocated-prod-9b");
    fs.mkdirSync(path.join(home, ".bot-relay", "instances"), { recursive: true });
    fs.mkdirSync(relocated, { recursive: true });
    fs.writeFileSync(path.join(relocated, "config.json"), '{"live":true}');
    fs.symlinkSync(relocated, path.join(home, ".bot-relay", "instances", "work"));
    const alias = path.join(SANDBOX, "not an id 9b");
    fs.symlinkSync(relocated, alias);
    point(home, await inv(home));
    expect(() => atomicWriteJson(path.join(alias, "config.json"), { clobbered: true })).toThrow(/config-guard/);
    expect(fs.readFileSync(path.join(relocated, "config.json"), "utf-8")).toBe('{"live":true}');
  });
  it.skipIf(posixOnly)("(G9c) an instance config.json that is a symlink: a direct write to ITS target is refused", async () => {
    const home = path.join(SANDBOX, "acct-9c");
    const inst = path.join(home, ".bot-relay", "instances", "work");
    fs.mkdirSync(inst, { recursive: true });
    const live = path.join(SANDBOX, "live-9c.json");
    fs.writeFileSync(live, '{"live":true}');
    fs.symlinkSync(live, path.join(inst, "config.json"));
    point(home, await inv(home));
    expect(() => atomicWriteJson(live, { clobbered: true })).toThrow(/config-guard/);
    expect(fs.readFileSync(live, "utf-8")).toBe('{"live":true}');
  });
  it("(G9d) under the harness with NO inventory published (the real account, no snapshot), every guarded write is refused: the inventory is not established", () => {
    const saved = process.env.RELAY_TEST_OPERATOR_INSTANCE_CONFIGS;
    delete process.env.RELAY_TEST_OPERATOR_INSTANCE_CONFIGS;
    try {
      expect(() => assertNotRealUserConfigWrite(path.join(SANDBOX, "unrelated-9d", "config.json"))).toThrow(/inventory/);
    } finally {
      if (saved !== undefined) process.env.RELAY_TEST_OPERATOR_INSTANCE_CONFIGS = saved;
    }
  });
  it("(G9e) TWIN: with the inventory established, an unrelated tmp config is allowed", async () => {
    const home = path.join(SANDBOX, "acct-9e");
    fs.mkdirSync(path.join(home, ".bot-relay", "instances", "work"), { recursive: true });
    fs.writeFileSync(path.join(home, ".bot-relay", "instances", "work", "config.json"), "{}");
    point(home, await inv(home));
    const t = path.join(SANDBOX, "unrelated-9e", "config.json");
    atomicWriteJson(t, { ok: true });
    expect(JSON.parse(fs.readFileSync(t, "utf-8"))).toEqual({ ok: true });
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
