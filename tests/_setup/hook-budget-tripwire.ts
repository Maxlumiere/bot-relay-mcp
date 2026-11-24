// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * THE HOOK BUDGET TRIPWIRE (setupFiles; every test file). The PostToolUse and Stop hooks have a 5 s budget and a 3 s
 * report margin: on the REAL clock a step that starts after 2 s is skipped, so a behaviour row run that way depends on
 * the runner's speed (measured on CI). Every spawn of either hook is checked:
 *   - from a directory that is NOT a budgetTree copy (the real hooks/ or a plain copy) → refused: the test clock seam
 *     does nothing there;
 *   - from a budgetTree copy with no RELAY_TEST_CLOCK in its environment (the real clock) → refused, unless it comes
 *     through runHookRealBudget (tests/_helpers/hook-real-budget.ts), which asserts its cut.
 * The message names the opt-in. child_process's spawn, spawnSync, execFile and execFileSync are wrapped; the ESM named
 * imports follow (syncBuiltinESMExports).
 */
import childProcess from "child_process";
import fs from "fs";
import path from "path";
import { syncBuiltinESMExports } from "module";
import { BUDGET_TREE_MARKER } from "../_helpers/hook-budget-tree.js";
import { REAL_BUDGET_OPTIN } from "../_helpers/hook-real-budget.js";

/** The two hooks, by EXACT basename (a fixture named e.g. legacy-stop-check.sh is not one of them). */
const HOOK_NAMES = new Set(["post-tool-use-check.sh", "stop-check.sh"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);

/** The refusal for a spawn, or null when it is allowed (exported for the tripwire's own rows). */
export function hookSpawnRefusal(file: unknown, args: unknown, opts: { env?: NodeJS.ProcessEnv; cwd?: string | URL } | undefined): string | null {
  const argv = Array.isArray(args) ? args.map(String) : [];
  const env = opts?.env ?? process.env;
  const cwd = opts?.cwd ? String(opts.cwd) : process.cwd();
  // Only a hook that is EXECUTED: the spawned file itself, or the script a shell runs (its first non-option argument,
  // or the words of its -c string). A hook's NAME passed as an argument to another program is not a run.
  const parts: string[] = [String(file)];
  if (SHELLS.has(path.basename(String(file)))) {
    const c = argv.indexOf("-c");
    if (c >= 0 && argv[c + 1] !== undefined) parts.push(argv[c + 1]!);
    else {
      const script = argv.find((a) => !a.startsWith("-"));
      if (script !== undefined) parts.push(script);
    }
  }
  for (const part of parts) {
    for (const m of part.split(/[\s'";=]+/).filter((t) => HOOK_NAMES.has(path.basename(t)))) {
      const hook = path.resolve(cwd, m);
      const name = path.basename(hook);
      if (!fs.existsSync(path.join(path.dirname(hook), BUDGET_TREE_MARKER))) {
        return `hook budget tripwire: ${name} was spawned from a directory that is not a budgetTree copy (${path.dirname(hook)}): there the test clock seam does nothing, so the real clock and budget make the row depend on the runner's speed. Run it from a budgetTree copy (tests/_helpers/hook-budget-tree.ts; a behaviour row raises the declared budget). A row that tests the REAL budget uses runHookRealBudget (tests/_helpers/hook-real-budget.ts), which asserts its cut.`;
      }
      if (env.RELAY_TEST_CLOCK === undefined && env[REAL_BUDGET_OPTIN] !== "1") {
        return `hook budget tripwire: ${name} runs on the REAL clock (no RELAY_TEST_CLOCK in its environment) outside runHookRealBudget. Set RELAY_TEST_CLOCK for a fixed clock, or test the real budget through runHookRealBudget (tests/_helpers/hook-real-budget.ts), which asserts its cut.`;
      }
    }
  }
  return null;
}

type AnyFn = (...a: unknown[]) => unknown;
const cp = childProcess as unknown as Record<string, AnyFn>;
for (const name of ["spawn", "spawnSync", "execFile", "execFileSync"] as const) {
  const real = cp[name]!;
  if ((real as { __hookBudgetTripwire?: boolean }).__hookBudgetTripwire) continue;
  const wrapped = function (this: unknown, file: unknown, args?: unknown, opts?: unknown) {
    const o = (Array.isArray(args) ? opts : args) as { env?: NodeJS.ProcessEnv; cwd?: string } | undefined;
    const refusal = hookSpawnRefusal(file, Array.isArray(args) ? args : [], o);
    if (refusal !== null) throw new Error(refusal);
    // eslint-disable-next-line prefer-rest-params
    return real.apply(this, arguments as unknown as unknown[]);
  } as AnyFn & { __hookBudgetTripwire?: boolean };
  wrapped.__hookBudgetTripwire = true;
  cp[name] = wrapped;
}
syncBuiltinESMExports();
