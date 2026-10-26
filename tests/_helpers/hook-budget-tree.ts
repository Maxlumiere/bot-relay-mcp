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
 * Drift guard: the clock seam rewrites the ONE `${SECONDS:-0}` read inside each of those two functions, and REFUSES
 * (throws) when a function is missing or holds another count, or when any hook line reads SECONDS in a way not
 * classified below (a new budget path would otherwise keep ticking under a seam that looks applied). Allowed outside
 * the two functions: diagnostic text that prints `${SECONDS}s`, and the Stop hook's stdin loop (a real timeout, not
 * budget arithmetic). On a construction failure the destination is removed before the error is rethrown.
 *
 * `bin` is a symlink to the repo's: Node resolves a main script's symlinks, so bin/relay still finds the real dist/.
 */
export const BUDGET_CLOCK_READ = "${SECONDS:-0}";
export const BUDGET_CLOCK_SEAMED = "${RELAY_TEST_CLOCK:-${SECONDS:-0}}";
export const BUDGET_FUNCTIONS = ["relay_margin_secs", "relay_pending_deadline"] as const;

/** The text of a top-level `name() {` … `}` function in a hook script, as [start, end) character offsets. */
function functionSpan(src: string, name: string): [number, number] | null {
  const m = new RegExp(`^${name}\\(\\) \\{\\n`, "m").exec(src);
  if (!m) return null;
  const end = src.indexOf("\n}\n", m.index);
  return end === -1 ? null : [m.index, end + 3];
}

/** Every hook line that reads SECONDS outside the two budget functions, and is not a known non-budget use. */
function unclassifiedSecondsReads(hooksDir: string): string[] {
  const helpersSrc = fs.readFileSync(path.join(hooksDir, "_vault-helpers.sh"), "utf-8");
  const spans = BUDGET_FUNCTIONS.map((f) => functionSpan(helpersSrc, f));
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      if (!e.name.endsWith(".sh")) continue;
      const isHelpers = path.resolve(p) === path.resolve(path.join(hooksDir, "_vault-helpers.sh"));
      let at = 0;
      for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
        const lineAt = at;
        at += line.length + 1;
        if (!/SECONDS/.test(line) || /^\s*#/.test(line)) continue;
        if (isHelpers && spans.some((s) => s !== null && lineAt >= s[0] && lineAt < s[1])) continue;
        const diagnostic = !/SECONDS/.test(line.replace(/\$\{SECONDS\}s/g, ""));
        const stopLoop = e.name === "stop-check.sh" && /_stdin_end/.test(line);
        if (!diagnostic && !stopLoop) out.push(`${path.relative(hooksDir, p)}: ${line.trim()}`);
      }
    }
  };
  walk(hooksDir);
  return out;
}

/** The SECONDS reads a hooks dir would be refused for (exported so the guard itself is tested). */
export const budgetGuardFindings = (hooksDir: string): string[] => unclassifiedSecondsReads(hooksDir);

export function budgetTree(dir: string, hooksDir: string, binDir: string): string {
  const base = path.join(dir, "bot-relay-mcp");
  fs.rmSync(dir, { recursive: true, force: true });
  try {
    fs.cpSync(hooksDir, path.join(base, "hooks"), { recursive: true });
    fs.symlinkSync(binDir, path.join(base, "bin"));
    const copy = path.join(base, "hooks");
    const stray = unclassifiedSecondsReads(copy);
    if (stray.length) throw new Error(`budgetTree: SECONDS read outside the seamed budget arithmetic, unclassified: ${stray.join(" | ")}`);
    const helpers = path.join(copy, "_vault-helpers.sh");
    let src = fs.readFileSync(helpers, "utf-8");
    // Each function's one read is rewritten in place, last function first so earlier offsets stay valid.
    const located = BUDGET_FUNCTIONS.map((name) => ({ name, span: functionSpan(src, name) }));
    for (const { name, span } of located) if (!span) throw new Error(`budgetTree: ${name}() not found in _vault-helpers.sh: update the seam`);
    for (const { name, span } of located.sort((a, b) => b.span![0] - a.span![0])) {
      const body = src.slice(span![0], span![1]);
      const reads = body.split(BUDGET_CLOCK_READ).length - 1;
      if (reads !== 1) throw new Error(`budgetTree: expected 1 read of ${BUDGET_CLOCK_READ} in ${name}(), found ${reads}: update the seam`);
      src = src.slice(0, span![0]) + body.split(BUDGET_CLOCK_READ).join(BUDGET_CLOCK_SEAMED) + src.slice(span![1]);
    }
    fs.writeFileSync(
      helpers,
      src +
        [
          "",
          "# TEST ONLY (budgetTree): RELAY_TEST_STARVE. See tests/_helpers/hook-budget-tree.ts.",
          `eval "$(declare -f relay_budget_for | sed '1s/^relay_budget_for/relay_budget_for_real/')"`,
          'relay_budget_for() { case "$1" in $RELAY_TEST_STARVE) relay_budget_for_real "$1" 0 "${3:-}" ;; *) relay_budget_for_real "$@" ;; esac; }',
          "",
        ].join("\n"),
    );
    return copy;
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}
