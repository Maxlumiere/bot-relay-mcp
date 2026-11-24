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
 * The caller keeps its own spawn mechanics: `run(env)` spawns the hook (from a budgetTree copy at the REAL declared
 * budget) with exactly the env given, and returns at least its combined output.
 */
export const REAL_BUDGET_OPTIN = "RELAY_TEST_REAL_BUDGET_OPTIN";

export type HookClock = "real" | { starvedSeconds: number };

function clockEnv(base: Record<string, string>, clock: HookClock): Record<string, string> {
  const env = { ...base };
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
export function runHookRealBudget<T extends { out: string }>(o: { label: string; env: Record<string, string>; clock: HookClock; assertsCut: RegExp; run: (env: Record<string, string>) => T }): T {
  const r = o.run(clockEnv(o.env, o.clock));
  assertCut(r.out, o.assertsCut, o.label, o.clock);
  return r;
}

/** Asynchronous callers (spawn). */
export async function runHookRealBudgetAsync<T extends { out: string }>(o: { label: string; env: Record<string, string>; clock: HookClock; assertsCut: RegExp; run: (env: Record<string, string>) => Promise<T> }): Promise<T> {
  const r = await o.run(clockEnv(o.env, o.clock));
  assertCut(r.out, o.assertsCut, o.label, o.clock);
  return r;
}
