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
import { spawnSync, exec, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hookSpawnRefusal, shellWords } from "./_setup/hook-budget-tripwire.js";
import { budgetTree } from "./_helpers/hook-budget-tree.js";
import { runHookRealBudget, REAL_BUDGET_OPTIN, REAL_BUDGET_FIXTURE } from "./_helpers/hook-real-budget.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REAL = path.join(REPO, "hooks");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "hook-tripwire-"));
const SEAMED = budgetTree(path.join(ROOT, "seamed"), REAL, path.join(REPO, "bin"), { declaredBudget: "real" }); // its starved row measures the REAL budget
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
    expect(hookSpawnRefusal("bash", [path.join(SEAMED, "post-tool-use-check.sh")], { env: { RELAY_TEST_CLOCK: "" } }), "an EMPTY clock is the real clock").toMatch(/REAL clock/);
  });
  it("a shell's -c string that runs the real hook → refused", () => {
    expect(hookSpawnRefusal("bash", ["-c", `"${path.join(REAL, "stop-check.sh")}" < /dev/null`], CLOCK0)).toMatch(/not a budgetTree copy/);
  });
  it("shell flags: a combined cluster (-lc, -ec), an option with a value (-o pipefail), and -- all reach the hook → refused", () => {
    const hook = path.join(REAL, "stop-check.sh");
    expect(hookSpawnRefusal("sh", ["-lc", `"${hook}"`], CLOCK0)).toMatch(/not a budgetTree copy/);
    expect(hookSpawnRefusal("bash", ["-ec", `cd /tmp && bash "${hook}" < /dev/null`], CLOCK0)).toMatch(/not a budgetTree copy/);
    expect(hookSpawnRefusal("bash", ["-o", "pipefail", hook], CLOCK0)).toMatch(/not a budgetTree copy/);
    expect(hookSpawnRefusal("bash", ["--norc", "--", hook], CLOCK0)).toMatch(/not a budgetTree copy/);
    expect(hookSpawnRefusal("bash", ["-x", path.join(SEAMED, "stop-check.sh")], CLOCK0), "a seamed copy behind an option is still allowed").toBeNull();
  });
  it("a shell command is CONSERVATIVE (documented): a -c string, exec or a shell:true spawn that merely NAMES the real hook is refused", () => {
    const hook = path.join(REAL, "post-tool-use-check.sh");
    expect(hookSpawnRefusal("sh", ["-c", `echo "${hook}"`], CLOCK0)).toMatch(/not a budgetTree copy/);
    expect(hookSpawnRefusal(`bash "${hook}"`, [], { ...CLOCK0, shell: true })).toMatch(/not a budgetTree copy/);
  });
  it("quoted words are honoured: a seamed copy whose path has a SPACE is one word (allowed), in a -c string and in a shell:true spawn", () => {
    const spaced = budgetTree(path.join(ROOT, "with space"), REAL, path.join(REPO, "bin"));
    const hook = path.join(spaced, "stop-check.sh");
    expect(hookSpawnRefusal("bash", ["-c", `"${hook}" < /dev/null`], CLOCK0)).toBeNull();
    expect(hookSpawnRefusal(`bash '${hook}'`, [], { ...CLOCK0, shell: true })).toBeNull();
    expect(hookSpawnRefusal("bash", [hook], CLOCK0)).toBeNull();
  });
  it.skipIf(process.platform === "win32")("a MARKED copy whose hook is a SYMLINK to the real hook → refused (the marker is judged beside the script's real path)", () => {
    const linked = path.join(ROOT, "linked");
    fs.cpSync(SEAMED, linked, { recursive: true });
    fs.rmSync(path.join(linked, "stop-check.sh"));
    fs.symlinkSync(path.join(REAL, "stop-check.sh"), path.join(linked, "stop-check.sh"));
    expect(fs.existsSync(path.join(linked, ".relay-budget-tree")), "precondition: the copy is marked").toBe(true);
    expect(hookSpawnRefusal("bash", [path.join(linked, "stop-check.sh")], CLOCK0)).toMatch(/not a budgetTree copy/);
  });
  it("budgetTree's DEFAULT is the behaviour budget (PostToolUse/Stop at 30 s); a real-budget fixture names itself ('real')", () => {
    const shipped = (h: string) => /^RELAY_HOOK_BUDGET_SECS=(\d+)$/m.exec(fs.readFileSync(path.join(REAL, h), "utf-8"))![1];
    const declared = (dir: string, h: string) => /^RELAY_HOOK_BUDGET_SECS=(\d+)$/m.exec(fs.readFileSync(path.join(dir, h), "utf-8"))![1];
    const def = budgetTree(path.join(ROOT, "default"), REAL, path.join(REPO, "bin"));
    for (const h of ["post-tool-use-check.sh", "stop-check.sh"]) {
      expect(declared(def, h), h).toBe("30");
      expect(declared(SEAMED, h), `${h}: "real" keeps the shipped value`).toBe(shipped(h));
    }
    expect(declared(def, "check-relay.sh"), "SessionStart keeps its own").toBe(shipped("check-relay.sh"));
  });
  it("shellWords: quotes, escapes and operators", () => {
    expect(shellWords(`a "b c" 'd e' f\\ g;h|i&&j`)).toEqual(["a", "b c", "d e", "f g", "h", "i", "j"]);
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
  it("exec and execSync are wrapped too: a shell command running the REAL Stop hook THROWS before anything runs", () => {
    const cmd = `bash "${path.join(REAL, "stop-check.sh")}" < /dev/null`;
    expect(() => execSync(cmd, { env: { RELAY_TEST_CLOCK: "0" } })).toThrow(/hook budget tripwire/);
    expect(() => exec(cmd, { env: { RELAY_TEST_CLOCK: "0" } }, () => {})).toThrow(/hook budget tripwire/);
  });
});

describe("runHookRealBudget: the ONE real-budget path", () => {
  it("the real clock: the opt-in is set and the fixed clock removed; a starved clock: RELAY_TEST_CLOCK is the seconds spent", () => {
    const seen: Record<string, string>[] = [];
    runHookRealBudget({ label: "x", hooksDir: SEAMED, env: { RELAY_TEST_CLOCK: "0", A: "1" }, clock: "real", assertsCut: /cut/, run: (e) => (seen.push(e), { out: "cut" }) });
    runHookRealBudget({ label: "x", hooksDir: SEAMED, env: { A: "1" }, clock: { starvedSeconds: 2 }, assertsCut: /cut/, run: (e) => (seen.push(e), { out: "cut" }) });
    expect(seen[0]).toEqual({ A: "1", [REAL_BUDGET_OPTIN]: "1", [REAL_BUDGET_FIXTURE]: "1" });
    expect(seen[1]).toEqual({ A: "1", RELAY_TEST_CLOCK: "2", [REAL_BUDGET_FIXTURE]: "1" });
  });
  it("assertsCut must MATCH: an output without the cut THROWS, naming the seamed default for behaviour rows", () => {
    expect(() => runHookRealBudget({ label: "x", hooksDir: SEAMED, env: {}, clock: "real", assertsCut: /no time budget left/, run: () => ({ out: "VERDICT=HEALTHY" }) })).toThrow(/does not show the cut[\s\S]*seamed default/);
  });
  it("a REAL run through it: the seamed real-budget copy, starved at 2 s, prints the payload-read cut", () => {
    const r = runHookRealBudget({
      label: "PostToolUse starved",
      hooksDir: SEAMED,
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

describe("a real-budget row can only run a copy that declares the PRODUCTION budget", () => {
  const RAISED = budgetTree(path.join(ROOT, "raised"), REAL, path.join(REPO, "bin")); // the behaviour default (30 s)
  it("runHookRealBudget given a RAISED (behaviour) copy THROWS before running anything, naming the real-budget fixture", () => {
    let ran = false;
    expect(() => runHookRealBudget({ label: "x", hooksDir: RAISED, env: {}, clock: "real", assertsCut: /cut/, run: () => ((ran = true), { out: "cut" }) })).toThrow(/declares 30 s, production declares \d+ s[\s\S]*declaredBudget: "real"/);
    expect(ran).toBe(false);
  });
  it("the tripwire refuses a runHookRealBudget spawn (either clock) whose SCRIPT declares a raised budget, even when hooksDir was a real copy", () => {
    const script = path.join(RAISED, "post-tool-use-check.sh");
    expect(hookSpawnRefusal("bash", [script], { env: { [REAL_BUDGET_FIXTURE]: "1", RELAY_TEST_CLOCK: "2" } })).toMatch(/declares 30 s, but production declares/);
    expect(hookSpawnRefusal("bash", [script], { env: { [REAL_BUDGET_FIXTURE]: "1", [REAL_BUDGET_OPTIN]: "1" } })).toMatch(/declares 30 s, but production declares/);
    expect(hookSpawnRefusal("bash", [path.join(SEAMED, "post-tool-use-check.sh")], { env: { [REAL_BUDGET_FIXTURE]: "1", RELAY_TEST_CLOCK: "2" } })).toBeNull();
    expect(hookSpawnRefusal("bash", [script], CLOCK0), "a behaviour row on the raised copy is fine").toBeNull();
  });
});

describe("command substitution, eval and sourcing are refused when a hook is named anywhere (conservative)", () => {
  const hook = path.join(SEAMED, "stop-check.sh"); // even a SEAMED copy: what the string runs cannot be read from its words
  it.each([
    ["$( )", `echo "$(bash ${hook})"`],
    ["backtick", `echo \`bash ${hook}\``],
    ["eval", `eval "bash ${hook}"`],
    ["source", `source ${hook}`],
    [". (dot)", `. ${hook}`],
    ["a hook name as a substring", `X=$(printf %s "${path.dirname(hook)}/stop-check.sh"); bash "$X"`],
  ])("%s → refused (exec, a -c string, a shell:true spawn)", (_k, cmd) => {
    expect(hookSpawnRefusal(cmd, [], { ...CLOCK0, shell: true })).toMatch(/command substitution, eval or source/);
    expect(hookSpawnRefusal("bash", ["-c", cmd], CLOCK0)).toMatch(/command substitution, eval or source/);
  });
  it("substitution WITHOUT a hook name is not the tripwire's business; an installed exec of the $( ) form throws before running", () => {
    expect(hookSpawnRefusal(`echo "$(date)"`, [], { ...CLOCK0, shell: true })).toBeNull();
    expect(() => execSync(`echo "$(bash ${path.join(REAL, "stop-check.sh")} < /dev/null)"`, { env: { RELAY_TEST_CLOCK: "0" } })).toThrow(/hook budget tripwire/);
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
        } else if (/\.(ts|mjs|js)$/.test(e.name) && /RELAY_TEST_REAL_BUDGET_(OPTIN|FIXTURE)/.test(fs.readFileSync(p, "utf-8"))) {
          hits.push(path.relative(REPO, p));
        }
      }
    };
    walk(path.join(REPO, "tests"));
    expect(hits.filter((h) => !allowed.has(h))).toEqual([]);
  });
});
