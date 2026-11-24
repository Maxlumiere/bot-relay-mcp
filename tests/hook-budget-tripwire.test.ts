// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The hook budget tripwire (tests/_setup/hook-budget-tripwire.ts) and the ONE real-budget path
 * (tests/_helpers/hook-real-budget.ts). A PostToolUse/Stop spawn from a directory without the budgetTree seam, or on the
 * real clock outside runHookRealBudget, is refused with a message naming the opt-in; runHookRealBudget must SEE its cut.
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hookSpawnRefusal } from "./_setup/hook-budget-tripwire.js";
import { budgetTree } from "./_helpers/hook-budget-tree.js";
import { runHookRealBudget, REAL_BUDGET_OPTIN } from "./_helpers/hook-real-budget.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REAL = path.join(REPO, "hooks");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "hook-tripwire-"));
const SEAMED = budgetTree(path.join(ROOT, "seamed"), REAL, path.join(REPO, "bin"));
const PLAIN = path.join(ROOT, "plain", "hooks");
fs.cpSync(REAL, PLAIN, { recursive: true });
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const CLOCK0 = { env: { RELAY_TEST_CLOCK: "0" } };

describe("the refusal (pure)", () => {
  it("the REAL hooks directory → refused, naming the budgetTree copy and the opt-in", () => {
    const r = hookSpawnRefusal("bash", [path.join(REAL, "post-tool-use-check.sh")], CLOCK0);
    expect(r).toMatch(/not a budgetTree copy/);
    expect(r).toMatch(/runHookRealBudget/);
  });
  it("a PLAIN copy (no seam) → refused, even with a fixed clock set (the clock reads nothing there)", () => {
    expect(hookSpawnRefusal("bash", [path.join(PLAIN, "stop-check.sh")], CLOCK0)).toMatch(/not a budgetTree copy/);
  });
  it("a budgetTree copy with a fixed clock → allowed (both hooks; the script spawned directly too)", () => {
    expect(hookSpawnRefusal("bash", [path.join(SEAMED, "post-tool-use-check.sh")], CLOCK0)).toBeNull();
    expect(hookSpawnRefusal("bash", ["-x", path.join(SEAMED, "stop-check.sh")], CLOCK0)).toBeNull();
    expect(hookSpawnRefusal(path.join(SEAMED, "stop-check.sh"), [], CLOCK0)).toBeNull();
  });
  it("a budgetTree copy on the REAL clock (no RELAY_TEST_CLOCK) → refused, unless through the opt-in", () => {
    expect(hookSpawnRefusal("bash", [path.join(SEAMED, "post-tool-use-check.sh")], { env: {} })).toMatch(/REAL clock .* outside runHookRealBudget/);
    expect(hookSpawnRefusal("bash", [path.join(SEAMED, "post-tool-use-check.sh")], { env: { [REAL_BUDGET_OPTIN]: "1" } })).toBeNull();
  });
  it("a shell's -c string that runs the real hook → refused", () => {
    expect(hookSpawnRefusal("bash", ["-c", `"${path.join(REAL, "stop-check.sh")}" < /dev/null`], CLOCK0)).toMatch(/not a budgetTree copy/);
  });
  it("NOT a run: a fixture named legacy-stop-check.sh; check-relay.sh; a hook's NAME passed as an argument to another program", () => {
    expect(hookSpawnRefusal("bash", [path.join(ROOT, "legacy-stop-check.sh")], { env: {} })).toBeNull();
    expect(hookSpawnRefusal("bash", [path.join(REAL, "check-relay.sh")], { env: {} })).toBeNull();
    expect(hookSpawnRefusal(process.execPath, ["script.js", path.join(REAL, "stop-check.sh")], { env: {} })).toBeNull();
  });
});

describe("installed (every test file)", () => {
  it("a spawnSync of the REAL PostToolUse hook THROWS the tripwire's message before anything runs", () => {
    expect(() => spawnSync("bash", [path.join(REAL, "post-tool-use-check.sh")], { env: { RELAY_TEST_CLOCK: "0" } })).toThrow(/hook budget tripwire/);
  });
});

describe("runHookRealBudget: the ONE real-budget path", () => {
  it("the real clock: the opt-in is set and the fixed clock removed; a starved clock: RELAY_TEST_CLOCK is the seconds spent", () => {
    const seen: Record<string, string>[] = [];
    runHookRealBudget({ label: "x", env: { RELAY_TEST_CLOCK: "0", A: "1" }, clock: "real", assertsCut: /cut/, run: (e) => (seen.push(e), { out: "cut" }) });
    runHookRealBudget({ label: "x", env: { A: "1" }, clock: { starvedSeconds: 2 }, assertsCut: /cut/, run: (e) => (seen.push(e), { out: "cut" }) });
    expect(seen[0]).toEqual({ A: "1", [REAL_BUDGET_OPTIN]: "1" });
    expect(seen[1]).toEqual({ A: "1", RELAY_TEST_CLOCK: "2" });
  });
  it("assertsCut must MATCH: an output without the cut THROWS, naming the seamed default for behaviour rows", () => {
    expect(() => runHookRealBudget({ label: "x", env: {}, clock: "real", assertsCut: /no time budget left/, run: () => ({ out: "VERDICT=HEALTHY" }) })).toThrow(/does not show the cut[\s\S]*seamed default/);
  });
  it("a REAL run through it: the seamed real-budget copy, starved at 2 s, prints the payload-read cut", () => {
    const r = runHookRealBudget({
      label: "PostToolUse starved",
      env: { PATH: process.env.PATH ?? "", HOME: ROOT, RELAY_AGENT_NAME: "tw-bob", RELAY_HTTP_PORT: "1" },
      clock: { starvedSeconds: 2 },
      assertsCut: /no time budget left for the hook payload read/,
      run: (e) => {
        const p = spawnSync("bash", [path.join(SEAMED, "post-tool-use-check.sh")], { env: e, input: "{}", encoding: "utf-8", timeout: 30_000 });
        return { out: `${p.stdout}\n${p.stderr}` };
      },
    });
    expect(r.out).toMatch(/no time budget left/);
  });
});

describe("the opt-in marker is set ONLY by runHookRealBudget", () => {
  it("no other file under tests/ names it (a test cannot set it by hand)", () => {
    const allowed = new Set(["tests/_helpers/hook-real-budget.ts", "tests/hook-budget-tripwire.test.ts"]);
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          if (e.name !== "node_modules" && e.name !== "fixtures") walk(p);
        } else if (/\.(ts|mjs|js)$/.test(e.name) && fs.readFileSync(p, "utf-8").includes("RELAY_TEST_REAL_BUDGET_OPTIN")) {
          hits.push(path.relative(REPO, p));
        }
      }
    };
    walk(path.join(REPO, "tests"));
    expect(hits.filter((h) => !allowed.has(h))).toEqual([]);
  });
});
