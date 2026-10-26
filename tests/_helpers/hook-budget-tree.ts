// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import fs from "fs";
import path from "path";

/**
 * A COPY of the hooks with deterministic budget seams, for tests only (the live hooks are never edited). Bash's
 * SECONDS ticks on whole WALL-CLOCK seconds, so a hook can read 2s spent after ~1.0s of real time: with the 5s
 * budget and its 3s report margin, a step drawing on the margin then has nothing left. On a slow runner that skips
 * a step a test needs to run. The seams make the budget a function of the test, never of the runner:
 *
 *   RELAY_TEST_CLOCK=<n>              the budget arithmetic (relay_margin_secs, relay_pending_deadline) reads n
 *                                     seconds spent instead of SECONDS: a FIXED clock that cannot tick. The hook's own
 *                                     SECONDS is never assigned (it still runs the real timeouts, e.g. the Stop stdin
 *                                     loop). With 0, every budgeted step gets exactly min(own, what an instant
 *                                     arrival leaves), whatever the runner's speed.
 *   RELAY_TEST_STARVE=<case pattern>  those steps get 0s: the REAL skip path runs.
 *
 * The clock seam rewrites the two SECONDS reads of the budget arithmetic in the copy and REFUSES (throws) unless it
 * finds exactly those two, so a change to the hooks cannot leave the seam silently inert.
 *
 * `bin` is a symlink to the repo's: Node resolves a main script's symlinks, so bin/relay still finds the real dist/.
 */
export const BUDGET_CLOCK_READ = "${SECONDS:-0}";
export const BUDGET_CLOCK_SEAMED = "${RELAY_TEST_CLOCK:-${SECONDS:-0}}";
export function budgetTree(dir: string, hooksDir: string, binDir: string): string {
  const base = path.join(dir, "bot-relay-mcp");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(hooksDir, path.join(base, "hooks"), { recursive: true });
  fs.symlinkSync(binDir, path.join(base, "bin"));
  const helpers = path.join(base, "hooks", "_vault-helpers.sh");
  const src = fs.readFileSync(helpers, "utf-8");
  const reads = src.split(BUDGET_CLOCK_READ).length - 1;
  if (reads !== 2) {
    throw new Error(`budgetTree: expected the budget arithmetic's 2 reads of ${BUDGET_CLOCK_READ} in _vault-helpers.sh, found ${reads}: update the seam`);
  }
  fs.writeFileSync(
    helpers,
    src.split(BUDGET_CLOCK_READ).join(BUDGET_CLOCK_SEAMED) +
      [
        "",
        "# TEST ONLY (budgetTree): RELAY_TEST_STARVE. See tests/_helpers/hook-budget-tree.ts.",
        `eval "$(declare -f relay_budget_for | sed '1s/^relay_budget_for/relay_budget_for_real/')"`,
        'relay_budget_for() { case "$1" in $RELAY_TEST_STARVE) relay_budget_for_real "$1" 0 "${3:-}" ;; *) relay_budget_for_real "$@" ;; esac; }',
        "",
      ].join("\n"),
  );
  return path.join(base, "hooks");
}
