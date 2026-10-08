// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * EVERY vitest config in the repo extends the shared base (architect ruling 621856a0, layer 1). Codex
 * #305 R1 P1 #1: vitest.full.config.ts was its own config with no setupFiles, so the publish gate's
 * load-smoke, chaos and cross-version runs had no private HOME and no tripwire. A new config would repeat
 * that silently; this test fails on it instead.
 *
 * It finds every vitest*.config.* and vite*.config.* in the tree (not node_modules, .git, dist, out) and
 * requires that set to EQUAL the configs imported below, so a new config fails here until it is added.
 * Each is IMPORTED (what vitest itself would load, not its text) and its RESOLVED config checked: the
 * tripwire setup FIRST in setupFiles, the run guard FIRST in globalSetup, and the env a private HOME (in
 * every spelling) inside the run directory, port 1, and the operator snapshot. The imports are static:
 * the guard-test parser-pin gate (#212) refuses a computed import specifier.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { TRIPWIRE_SETUP, TRIPWIRE_GLOBAL, HOME_KEYS, SAFE_PORT, withOperatorTripwire } from "./_setup/vitest-tripwire-base.mjs";
import rootConfig from "../vitest.config.ts";
import fullConfig from "../vitest.full.config.ts";
import extensionConfig from "../extensions/vscode/vitest.config.ts";
import fixtureConfig from "./fixtures/operator-tripwire/vitest.config.ts";

/** Every vitest config in the repo, by its path from the repo root. A new one is added HERE. */
const IMPORTED: Record<string, unknown> = {
  "vitest.config.ts": rootConfig,
  "vitest.full.config.ts": fullConfig,
  "extensions/vscode/vitest.config.ts": extensionConfig,
  "tests/fixtures/operator-tripwire/vitest.config.ts": fixtureConfig,
};

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_NAME = /^(vitest|vite)([.-][^/]*)?\.config\.[cm]?[jt]s$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "out", "coverage"]);

function findConfigs(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) findConfigs(path.join(dir, e.name), out);
    } else if (CONFIG_NAME.test(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}

interface Cfg { test?: { setupFiles?: unknown; globalSetup?: unknown; env?: Record<string, string> } }
const first = (v: unknown) => (Array.isArray(v) ? v[0] : v);

/** What is wrong with a RESOLVED config (empty = extends the base). */
export function baseProblems(cfg: unknown): string[] {
  if (cfg === null || typeof cfg !== "object") return ["the default export is not a config object (a function config cannot be checked: export the object)"];
  const t = (cfg as Cfg).test ?? {};
  const env = t.env ?? {};
  const p: string[] = [];
  if (first(t.setupFiles) !== TRIPWIRE_SETUP) p.push(`setupFiles[0] is ${JSON.stringify(first(t.setupFiles))}, not the tripwire`);
  if (first(t.globalSetup) !== TRIPWIRE_GLOBAL) p.push(`globalSetup[0] is ${JSON.stringify(first(t.globalSetup))}, not the run guard`);
  const runDir = env.RELAY_TEST_TRIPWIRE_RUN_DIR;
  if (!runDir || !path.isAbsolute(runDir)) p.push("env has no RELAY_TEST_TRIPWIRE_RUN_DIR");
  else {
    if (!env.HOME || !env.HOME.startsWith(runDir + path.sep)) p.push(`env.HOME ${JSON.stringify(env.HOME)} is not inside the run directory`);
    if (env.USERPROFILE !== env.HOME) p.push("env.USERPROFILE is not the private HOME"); // os.homedir() on Windows reads it
    // Windows: temp inside the private home (the relay's path guard approves the home, not Windows temp).
    if (process.platform === "win32" && !(env.TEMP && env.TEMP.startsWith(env.HOME + path.sep) && env.TMP === env.TEMP)) p.push("env.TEMP/TMP are not inside the private HOME");
  }
  for (const k of HOME_KEYS) if (!(k in env)) p.push(`env.${k} is not set`);
  if (env.RELAY_HTTP_PORT !== SAFE_PORT) p.push(`env.RELAY_HTTP_PORT is ${JSON.stringify(env.RELAY_HTTP_PORT)}, not ${SAFE_PORT}`);
  if (!env.RELAY_TEST_OPERATOR_ROOTS || !env.RELAY_TEST_OPERATOR_PORTS || !env.RELAY_TEST_OPERATOR_HOME) p.push("env lacks the operator snapshot");
  return p;
}

describe("the checker (both legs)", () => {
  it("a config built by withOperatorTripwire passes, with or without its own setup files", () => {
    expect(baseProblems(withOperatorTripwire({ test: {} }))).toEqual([]);
    expect(baseProblems(withOperatorTripwire({ test: { setupFiles: ["./x.ts"], globalSetup: "./g.ts" } }))).toEqual([]);
  });
  it("a plain config, a reordered one, a function config, and one with the port or HOME overridden all FAIL", () => {
    expect(baseProblems({ test: { setupFiles: ["./tests/_setup/hermetic-config.ts"] } }).length).toBeGreaterThan(0);
    const ok = withOperatorTripwire({ test: { setupFiles: ["./x.ts"] } }) as Cfg;
    expect(baseProblems({ ...ok, test: { ...ok.test, setupFiles: ["./x.ts", TRIPWIRE_SETUP] } })).toEqual([expect.stringMatching(/setupFiles\[0\]/)]);
    expect(baseProblems({ ...ok, test: { ...ok.test, globalSetup: [] } })).toEqual([expect.stringMatching(/globalSetup\[0\]/)]);
    expect(baseProblems({ ...ok, test: { ...ok.test, env: { ...ok.test!.env, RELAY_HTTP_PORT: "3777" } } })).toEqual([expect.stringMatching(/RELAY_HTTP_PORT/)]);
    expect(baseProblems({ ...ok, test: { ...ok.test, env: { ...ok.test!.env, HOME: "/Users/someone" } } })).toEqual(expect.arrayContaining([expect.stringMatching(/env\.HOME/)]));
    expect(baseProblems(() => ({}))).toEqual([expect.stringMatching(/not a config object/)]);
  });
});

describe("every vitest config in the repo extends the shared base", () => {
  it("the configs on disk are EXACTLY the configs checked here (a new one must be added to IMPORTED)", () => {
    const onDisk = findConfigs(REPO).map((c) => path.relative(REPO, c).split(path.sep).join("/")).sort();
    expect(onDisk).toEqual(Object.keys(IMPORTED).sort());
  });
  for (const [rel, cfg] of Object.entries(IMPORTED)) {
    it(rel, () => {
      expect(baseProblems(cfg)).toEqual([]);
    });
  }
});
