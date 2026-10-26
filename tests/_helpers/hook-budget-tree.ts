// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import fs from "fs";
import path from "path";

/**
 * A COPY of the hooks with deterministic budget seams, for tests only (the live hooks are never edited). Bash's
 * SECONDS ticks on whole WALL-CLOCK seconds, so a hook can read 2s spent after ~1.1s of real time: with the 5s
 * budget and its 3s report margin, a step drawing on the margin then has nothing left. On a slow runner that skips
 * a step a test needs to run. The seams make the step's budget a function of the test, never of the runner:
 *
 *   RELAY_TEST_STARVE=<case pattern>  those steps get 0s: the REAL skip path runs. Checked first.
 *   RELAY_TEST_FEED=<case pattern>    those steps run the REAL relay_budget_for with the hook's clock read as 0, so
 *                                     the real cap is computed as if the step were reached at once; the elapsed time
 *                                     is restored afterwards. "*" feeds every step: a run that cannot be starved by
 *                                     the runner, with every cap exactly min(own, what the budget leaves at 0s).
 *
 * `bin` is a symlink to the repo's: Node resolves a main script's symlinks, so bin/relay still finds the real dist/.
 */
export function budgetTree(dir: string, hooksDir: string, binDir: string): string {
  const base = path.join(dir, "bot-relay-mcp");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(hooksDir, path.join(base, "hooks"), { recursive: true });
  fs.symlinkSync(binDir, path.join(base, "bin"));
  fs.appendFileSync(
    path.join(base, "hooks", "_vault-helpers.sh"),
    [
      "",
      "# TEST ONLY (budgetTree): deterministic budget seams. See tests/_helpers/hook-budget-tree.ts.",
      `eval "$(declare -f relay_budget_for | sed '1s/^relay_budget_for/relay_budget_for_real/')"`,
      "relay_budget_for() {",
      '  case "$1" in',
      '    $RELAY_TEST_STARVE) relay_budget_for_real "$1" 0 "${3:-}" ;;',
      '    $RELAY_TEST_FEED) local _t0=$SECONDS _rc; SECONDS=0; relay_budget_for_real "$@"; _rc=$?; SECONDS=$((_t0 + SECONDS)); return $_rc ;;',
      '    *) relay_budget_for_real "$@" ;;',
      "  esac",
      "}",
      "",
    ].join("\n"),
  );
  return path.join(base, "hooks");
}
