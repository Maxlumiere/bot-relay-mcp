// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * THE HOOK BUDGET TRIPWIRE (setupFiles; every test file). The PostToolUse and Stop hooks have a 5 s budget and a 3 s
 * report margin: on the REAL clock a step that starts after 2 s is skipped, so a behaviour row run that way depends on
 * the runner's speed (measured on CI). Every spawn of either hook is checked:
 *   - a script whose REAL path (symlinks resolved) is not inside a budgetTree copy (the real hooks/, a plain copy, or a
 *     link from a marked copy back to the real hook) → refused: the test clock seam does nothing there;
 *   - from a budgetTree copy with no RELAY_TEST_CLOCK in its environment (the real clock) → refused, unless it comes
 *     through runHookRealBudget (tests/_helpers/hook-real-budget.ts), which asserts its cut.
 * The message names the opt-in.
 *
 * WHAT IS CHECKED: child_process's spawn, spawnSync, execFile, execFileSync, exec and execSync (the ESM named imports
 * follow, syncBuiltinESMExports), on the module object every test imports. A shell command (exec, execSync, a
 * `shell: true` spawn, or a shell's -c string) is CONSERVATIVE: any word that names one of the two hooks is treated
 * as a run, even one that only echoes it (a false positive is a loud error at the row; a false negative would be
 * silent). Quoted words are honoured, so a seamed path with spaces is one word.
 * WHAT IT CANNOT SEE: a reference to a child_process function captured before this setup file ran; fork (a Node
 * script, never a hook); a process started by a child process; Node-internal spawns that do not go through the
 * patched exports.
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
/** Shell options that take the NEXT argument as their value (bash/sh/zsh): never the script. */
const OPTS_WITH_VALUE = new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]);

/** Split a shell command into words, honouring single quotes, double quotes and backslash escapes (a sketch of the
 * shell's own splitting: enough to find the words, never an evaluator). Unquoted ; | & < > ( ) end a word. */
export function shellWords(cmd: string): string[] {
  const words: string[] = [];
  let cur = "";
  let has = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (ch === "'") {
      const j = cmd.indexOf("'", i + 1);
      cur += cmd.slice(i + 1, j < 0 ? cmd.length : j);
      i = j < 0 ? cmd.length : j;
      has = true;
    } else if (ch === '"') {
      let j = i + 1;
      for (; j < cmd.length && cmd[j] !== '"'; j++) {
        if (cmd[j] === "\\" && j + 1 < cmd.length) j++;
        cur += cmd[j];
      }
      i = j;
      has = true;
    } else if (ch === "\\" && i + 1 < cmd.length) {
      cur += cmd[++i];
      has = true;
    } else if (/[\s;|&<>()]/.test(ch)) {
      if (has) words.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) words.push(cur);
  return words;
}

/** The hook paths a spawn EXECUTES (or, for a shell command, NAMES: conservative). */
function executedHookPaths(file: string, argv: string[], shell: boolean): string[] {
  const named = (words: string[]) =>
    words.map((w) => (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) ? w.slice(w.indexOf("=") + 1) : w)).filter((w) => HOOK_NAMES.has(path.basename(w)));
  if (shell) return named(shellWords([file, ...argv].join(" ")));
  const out = named([file]);
  if (!SHELLS.has(path.basename(file))) return out;
  // A shell: walk its options. Any short-option cluster containing "c" (-c, -lc, -ec, -xc) makes the first operand a
  // command STRING; otherwise the first operand is the script it runs. "--" ends the options.
  let cmode = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      const operand = argv[i + 1];
      if (operand !== undefined) out.push(...(cmode ? named(shellWords(operand)) : named([operand])));
      break;
    }
    if (OPTS_WITH_VALUE.has(a)) { i++; continue; }
    if (/^[-+][A-Za-z]+$/.test(a)) { if (a.startsWith("-") && a.includes("c")) cmode = true; continue; }
    if (a.startsWith("--")) continue; // a long option (--login, --norc, …)
    out.push(...(cmode ? named(shellWords(a)) : named([a])));
    break;
  }
  return out;
}

/** The refusal for a spawn, or null when it is allowed (exported for the tripwire's own rows). */
export function hookSpawnRefusal(
  file: unknown,
  args: unknown,
  opts: { env?: NodeJS.ProcessEnv; cwd?: string | URL; shell?: unknown } | undefined,
): string | null {
  const argv = Array.isArray(args) ? args.map(String) : [];
  const env = opts?.env ?? process.env;
  const cwd = opts?.cwd ? String(opts.cwd) : process.cwd();
  for (const m of executedHookPaths(String(file), argv, Boolean(opts?.shell))) {
    const spelled = path.resolve(cwd, m);
    // The marker is checked beside the script's REAL path: a marked copy whose hook is a LINK to the real hook runs the
    // real (unseamed) hook, and must be refused.
    let real = spelled;
    try {
      real = fs.realpathSync(spelled);
    } catch {
      /* not there: the spawn itself will fail; judge the spelling */
    }
    const name = path.basename(spelled);
    if (!fs.existsSync(path.join(path.dirname(real), BUDGET_TREE_MARKER))) {
      return `hook budget tripwire: ${name} was spawned from a directory that is not a budgetTree copy (${path.dirname(real)}): there the test clock seam does nothing, so the real clock and budget make the row depend on the runner's speed. Run it from a budgetTree copy (tests/_helpers/hook-budget-tree.ts; a behaviour row raises the declared budget). A row that tests the REAL budget uses runHookRealBudget (tests/_helpers/hook-real-budget.ts), which asserts its cut.`;
    }
    // An EMPTY RELAY_TEST_CLOCK is the real clock too (the seam reads ${RELAY_TEST_CLOCK:-${SECONDS:-0}}).
    if (!env.RELAY_TEST_CLOCK && env[REAL_BUDGET_OPTIN] !== "1") {
      return `hook budget tripwire: ${name} runs on the REAL clock (no RELAY_TEST_CLOCK in its environment) outside runHookRealBudget. Set RELAY_TEST_CLOCK for a fixed clock, or test the real budget through runHookRealBudget (tests/_helpers/hook-real-budget.ts), which asserts its cut.`;
    }
  }
  return null;
}

type AnyFn = (...a: unknown[]) => unknown;
type SpawnOpts = { env?: NodeJS.ProcessEnv; cwd?: string; shell?: unknown };
const cp = childProcess as unknown as Record<string, AnyFn>;
const refuseOrRun = (real: AnyFn, self: unknown, all: unknown[], refusal: string | null) => {
  if (refusal !== null) throw new Error(refusal);
  return real.apply(self, all);
};
const mark = (fn: AnyFn) => Object.assign(fn, { __hookBudgetTripwire: true });
const marked = (fn: AnyFn) => (fn as { __hookBudgetTripwire?: boolean }).__hookBudgetTripwire === true;
// spawn / spawnSync / execFile / execFileSync: (file, args?, opts?) — a `shell: true` option makes it a shell command.
for (const name of ["spawn", "spawnSync", "execFile", "execFileSync"] as const) {
  const real = cp[name]!;
  if (marked(real)) continue;
  cp[name] = mark(function (this: unknown, file: unknown, args?: unknown, opts?: unknown) {
    const o = (Array.isArray(args) ? opts : args) as SpawnOpts | undefined;
    // eslint-disable-next-line prefer-rest-params
    return refuseOrRun(real, this, Array.from(arguments), hookSpawnRefusal(file, Array.isArray(args) ? args : [], o));
  });
}
// exec / execSync: (command, opts?) — always a shell command.
for (const name of ["exec", "execSync"] as const) {
  const real = cp[name]!;
  if (marked(real)) continue;
  cp[name] = mark(function (this: unknown, command: unknown, opts?: unknown) {
    const o = (typeof opts === "object" && opts !== null ? opts : undefined) as SpawnOpts | undefined;
    // eslint-disable-next-line prefer-rest-params
    return refuseOrRun(real, this, Array.from(arguments), hookSpawnRefusal(command, [], { ...o, shell: true }));
  });
}
syncBuiltinESMExports();
