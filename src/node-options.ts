// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0047 PR 3 (#297 Codex R1 P1); ruling c076b9cb (3): node's OWN command-line option ARITY, so the fleet classifier
 * can find a process's script (the first non-option argument) without ever taking an option's VALUE for it.
 *
 * DERIVED AT RUNTIME from the RUNNING node's own `--help` (process.execPath: never a target process's binary, which
 * would execute whatever a ps row names). An option written `--opt=...` takes a value, which node also accepts as the
 * NEXT argument; every other listed option is a flag (an optional value, `--inspect[=port]`, attaches only with `=`).
 * Cached per (binary path, version). A pinned table broke on a newer Node 24 patch (24.22.3 added 4 value-taking
 * options: MEASURED in CI); a newer version alone never fails this. If the derivation FAILS (the help cannot be read,
 * or reads as too few options), the result is {ok:false, why}: the classifier then reads every option both ways and
 * says why (UNKNOWN, loud), never a guessed table. Per-version snapshots of the help live in tests/fixtures/node-help/.
 *
 * An option NOT in the derived table (a V8 option such as --max-old-space-size) is uncertain in the space form: the
 * classifier reads it both ways and never concludes "not relay" from a reading it cannot confirm.
 */
import { execFileSync } from "child_process";
import fs from "fs";

export type NodeOptionTable = { ok: true; withValue: ReadonlySet<string>; flags: ReadonlySet<string> } | { ok: false; why: string };

/** Below this many options a help text is not node's option table (the real one lists 200+). */
export const MIN_HELP_OPTIONS = 150;

/**
 * Parse `node --help` into the arity of every listed option (aliases on one line share it). Pure.
 * The CLEAN shapes only: `--opt` (a flag, its description after it), `--opt=...` / `--opt=<x>` (takes a value) and
 * `--opt[=...]` (an optional value attaches only with `=`: a flag). Any other line (e.g. `--opt <file>`, `--print
 * [...]`) goes into NEITHER set, `ambiguous`: the classifier then reads it both ways, never guessing its arity.
 */
export function parseNodeHelp(help: string): { withValue: Set<string>; flags: Set<string>; ambiguous: Set<string> } {
  const withValue = new Set<string>();
  const flags = new Set<string>();
  const ambiguous = new Set<string>();
  for (const line of help.split("\n")) {
    const m = /^ {2}(-[^ ].*?)(?: {2,}| [A-Z(]|$)/.exec(line);
    if (!m) continue;
    const aliases = m[1]!.split(/, /).map((x) => x.trim());
    const lm = /^(-{1,2}[A-Za-z0-9][A-Za-z0-9.-]*)(.*)$/.exec(aliases[aliases.length - 1]!);
    if (!lm) continue; // "-" (stdin) and "--"
    const rest = lm[2]!;
    // A single space then plain words is the description glued on; a space then `<`, `[` or `=` is a continuation.
    const set = rest.startsWith("=") ? withValue : rest === "" || rest.startsWith("[=") || /^ [A-Za-z]/.test(rest) ? flags : ambiguous;
    for (const a of aliases) {
      const am = /^(-{1,2}[A-Za-z0-9][A-Za-z0-9.-]*)/.exec(a);
      if (am) set.add(am[1]!);
    }
  }
  return { withValue, flags, ambiguous };
}

const cache = new Map<string, NodeOptionTable>();

/**
 * The cache key of a node binary: its FILE identity (dev, ino, size, mtime), so a binary replaced at the same path is
 * a new key (process.version names the RUNNING node, not the file at the path). Unstatable: the path, marked.
 */
export function tableKeyOf(execPath: string): string {
  try {
    const st = fs.statSync(execPath, { bigint: true });
    return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}`;
  } catch {
    return `unstatable\u0000${execPath}`;
  }
}

/**
 * The running node's option table, derived once per (binary path, version). `run` and `key` are test seams (the
 * default runs `process.execPath --help`, bounded).
 */
export function nodeOptionTable(opts: { run?: () => string; key?: string } = {}): NodeOptionTable {
  const key = opts.key ?? tableKeyOf(process.execPath);
  const hit = cache.get(key);
  if (hit) return hit;
  let table: NodeOptionTable;
  try {
    // An ALLOWLISTED env, never the inherited one (ruling 617c5d69 P1): a NODE_OPTIONS --require hook or any other
    // inherited setting never runs in, nor shapes, the help child. Windows needs SystemRoot to start a process.
    const env: NodeJS.ProcessEnv = process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {};
    const help = (opts.run ?? (() => execFileSync(process.execPath, ["--help"], { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], env })))();
    const t = parseNodeHelp(help);
    const n = t.withValue.size + t.flags.size;
    table = n >= MIN_HELP_OPTIONS ? { ok: true, ...t } : { ok: false, why: `node --help listed too few options (${n}, need ${MIN_HELP_OPTIONS})` };
  } catch (err) {
    table = { ok: false, why: `node --help could not be read: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` };
  }
  cache.set(key, table);
  return table;
}

/**
 * Options after which node runs no script file at all (checked BEFORE the tables above).
 * NOT -i / --interactive: `node -i <script>` still runs the script (#297 Codex R2 #2).
 */
export const NODE_NO_SCRIPT: ReadonlySet<string> = new Set([
  "-e", "--eval", "-p", "--print", "-v", "--version", "-h", "--help", "-c", "--check", "--run",
]);
