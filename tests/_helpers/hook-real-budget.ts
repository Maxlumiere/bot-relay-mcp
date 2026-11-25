// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * THE ONLY way a test runs the PostToolUse or Stop hook on the REAL clock (tests/_setup/hook-budget-tripwire.ts refuses
 * every other real-clock run). A real-clock run on a fast machine may never reach the budget's cut and pass vacuously,
 * so every call must ASSERT its cut: `assertsCut` must MATCH the output (the skip or cut line printed), never merely
 * "not fail". Where it can, a row runs it ALSO under a STARVED seamed clock (`{ starvedSeconds }`: the fixed clock reads
 * that many seconds spent), which reaches the cut on any machine. Behaviour rows never come here: they run a budgetTree
 * copy with a raised declared budget and a fixed clock (the hook-runners' default).
 *
 * The caller keeps its own spawn mechanics: `run(env)` spawns the hook with exactly the env given, and returns at least
 * its combined output. `hooksDir` is the copy it spawns from: it MUST declare the production budget (asserted here), and
 * the tripwire checks the spawned script itself (REAL_BUDGET_FIXTURE is in the env), so the two cannot disagree.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REAL_BUDGET_OPTIN = "RELAY_TEST_REAL_BUDGET_OPTIN";
/** Set on EVERY run through this helper (either clock): the tripwire then requires the spawned script to declare the
 * PRODUCTION budget, so a real-budget row can never run a raised (behaviour) copy. */
export const REAL_BUDGET_FIXTURE = "RELAY_TEST_REAL_BUDGET_FIXTURE";

const SHIPPED_HOOKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks");
/** The two hooks with a budget a real-budget row measures. */
export const BUDGETED_HOOKS = ["post-tool-use-check.sh", "stop-check.sh"] as const;
/** The `RELAY_HOOK_BUDGET_SECS=<n>` a hook script declares, or null. */
export function declaredBudgetOf(script: string): number | null {
  try {
    const m = /^RELAY_HOOK_BUDGET_SECS=(\d+)$/m.exec(fs.readFileSync(script, "utf-8"));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}
/** The budget production declares for a hook (the shipped script). */
export const productionBudgetOf = (hook: string): number | null => declaredBudgetOf(path.join(SHIPPED_HOOKS, hook));

/** THROWS unless every budgeted hook in `hooksDir` declares exactly the production budget. */
export function assertProductionBudget(hooksDir: string, label: string): void {
  for (const hook of BUDGETED_HOOKS) {
    const got = declaredBudgetOf(path.join(hooksDir, hook));
    const want = productionBudgetOf(hook);
    if (got !== want) {
      throw new Error(
        `runHookRealBudget (${label}): ${path.join(hooksDir, hook)} declares ${got ?? "no"} s, production declares ${want} s. ` +
          'A real-budget row runs the REAL-budget fixture: budgetTree(..., { declaredBudget: "real" }).',
      );
    }
  }
}

export type HookClock = "real" | { starvedSeconds: number };

function clockEnv(base: Record<string, string>, clock: HookClock): Record<string, string> {
  const env = { ...base, [REAL_BUDGET_FIXTURE]: "1" };
  delete env.RELAY_TEST_CLOCK;
  if (clock === "real") env[REAL_BUDGET_OPTIN] = "1";
  else env.RELAY_TEST_CLOCK = String(clock.starvedSeconds);
  return env;
}

function assertCut(out: string, assertsCut: RegExp, label: string, clock: HookClock): void {
  if (!assertsCut.test(out)) {
    throw new Error(
      `runHookRealBudget (${label}, ${clock === "real" ? "real clock" : `starved clock ${clock.starvedSeconds}s`}): the output does not show the cut ${assertsCut}. ` +
        "A real-budget row must assert its skip path; a row that tests BEHAVIOUR must use the seamed default (a raised declared budget). Output:\n" +
        out,
    );
  }
}

/** Synchronous callers (spawnSync). */
export function runHookRealBudget<T extends { out: string }>(o: { label: string; hooksDir: string; env: Record<string, string>; clock: HookClock; assertsCut: RegExp; run: (env: Record<string, string>) => T }): T {
  assertProductionBudget(o.hooksDir, o.label);
  const r = o.run(clockEnv(o.env, o.clock));
  assertCut(r.out, o.assertsCut, o.label, o.clock);
  return r;
}

/** Asynchronous callers (spawn). */
export async function runHookRealBudgetAsync<T extends { out: string }>(o: { label: string; hooksDir: string; env: Record<string, string>; clock: HookClock; assertsCut: RegExp; run: (env: Record<string, string>) => Promise<T> }): Promise<T> {
  assertProductionBudget(o.hooksDir, o.label);
  const r = await o.run(clockEnv(o.env, o.clock));
  assertCut(r.out, o.assertsCut, o.label, o.clock);
  return r;
}
