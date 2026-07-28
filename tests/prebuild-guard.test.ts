// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * prebuild production-tree guard. The harm: `npm run build` in the live-serving
 * tree overwrites the dist the launchd daemon + every stdio terminal load — a
 * fleet deploy with no separate step. The guard REFUSES a build there, positive
 * match only (fails toward BUILD), with a RELAY_ALLOW_PROD_BUILD=1 escape.
 *
 * Tested through the pure decision AND the shipped script end-to-end, with HOME
 * pointed at an empty dir so the detector cannot see the real machine's plists.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "node:child_process";

const { decideProdBuild, treePointsHere } = await import("../scripts/prebuild-guard.mjs");

const GUARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "prebuild-guard.mjs");
const TREE = "/Users/x/LLMs/Claude AI/bot-relay-mcp";
const plist = (entry: string) => `<array><string>/usr/local/bin/node</string><string>${entry}</string></array>`;

describe("prebuild-guard — pure decision", () => {
  it("no production signal → build", () => {
    expect(decideProdBuild({ cwd: TREE, hasSentinel: false, consumers: [], allow: false }).action).toBe("build");
  });

  it("a consumer pointing at THIS tree → refuse (the harm)", () => {
    const d = decideProdBuild({
      cwd: TREE,
      hasSentinel: false,
      consumers: [{ label: "launchd plist com.x.plist", text: plist(`${TREE}/dist/index.js`) }],
      allow: false,
    });
    expect(d.action).toBe("refuse");
    expect(d.hits).toContain("launchd plist com.x.plist");
  });

  it("the SAME production tree + RELAY_ALLOW_PROD_BUILD → build-allowed (intentional)", () => {
    const d = decideProdBuild({
      cwd: TREE,
      hasSentinel: false,
      consumers: [{ label: "~/.claude.json", text: plist(`${TREE}/dist/index.js`) }],
      allow: true,
    });
    expect(d.action).toBe("build-allowed");
  });

  it("gitignored sentinel present → refuse", () => {
    expect(decideProdBuild({ cwd: TREE, hasSentinel: true, consumers: [], allow: false }).action).toBe("refuse");
  });

  it("NO false positive: a consumer pointing at a DIFFERENT tree → build", () => {
    const d = decideProdBuild({
      cwd: "/private/tmp/wt-tripwire",
      hasSentinel: false,
      consumers: [{ label: "plist", text: plist(`${TREE}/dist/index.js`) }],
      allow: false,
    });
    expect(d.action).toBe("build");
    expect(d.hits).toEqual([]);
  });
});

describe("prebuild-guard — treePointsHere (path matching)", () => {
  it("matches this tree's dist/index.js", () => {
    expect(treePointsHere(plist(`${TREE}/dist/index.js`), TREE)).toBe(true);
  });
  it("matches the %20 percent-encoded fossil form (spaced path)", () => {
    const encoded = `/Users/x/LLMs/Claude%20AI/bot-relay-mcp/dist/index.js`;
    expect(treePointsHere(`<string>${encoded}</string>`, TREE)).toBe(true);
  });
  it("does NOT match a sibling tree", () => {
    expect(treePointsHere(plist(`${TREE}/dist/index.js`), "/private/tmp/wt-tripwire")).toBe(false);
  });
  it("empty text / cwd → false", () => {
    expect(treePointsHere("", TREE)).toBe(false);
    expect(treePointsHere(plist(`${TREE}/dist/index.js`), "")).toBe(false);
  });
});

describe("prebuild-guard — shipped script end-to-end (HOME isolated)", () => {
  // A private HOME with no LaunchAgents and no ~/.claude.json → the auto-detector
  // sees nothing, so only the in-cwd sentinel can trigger. Isolates the test from
  // the real machine's live config.
  const run = (cwd: string, env: Record<string, string> = {}) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "guard-home-"));
    try {
      execFileSync("node", [GUARD], { cwd, env: { ...process.env, HOME: home, ...env }, stdio: "pipe" });
      return 0;
    } catch (e) {
      return (e as { status?: number }).status ?? -1;
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  };

  it("a clean dir (no sentinel, isolated HOME) → exit 0 (build)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-clean-"));
    try {
      expect(run(dir)).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a dir bearing .relay-prod-tree → exit 1 (refuse)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-prod-"));
    fs.writeFileSync(path.join(dir, ".relay-prod-tree"), "");
    try {
      expect(run(dir)).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("same prod dir + RELAY_ALLOW_PROD_BUILD=1 → exit 0 (intentional)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-prod-allow-"));
    fs.writeFileSync(path.join(dir, ".relay-prod-tree"), "");
    try {
      expect(run(dir, { RELAY_ALLOW_PROD_BUILD: "1" })).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
