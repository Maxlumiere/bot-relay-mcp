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

export type NodeOptionTable = { ok: true; withValue: ReadonlySet<string>; flags: ReadonlySet<string> } | { ok: false; why: string };

/** Below this many options a help text is not node's option table (the real one lists 200+). */
export const MIN_HELP_OPTIONS = 150;

/** Parse `node --help` into the arity of every listed option (aliases on one line share it). Pure. */
export function parseNodeHelp(help: string): { withValue: Set<string>; flags: Set<string> } {
  const withValue = new Set<string>();
  const flags = new Set<string>();
  for (const line of help.split("\n")) {
    const m = /^ {2}(-[^ ].*?)(?: {2,}| [A-Z(]|$)/.exec(line);
    if (!m) continue;
    const aliases = m[1]!.split(/, /).map((x) => x.trim());
    const lm = /^(-{1,2}[A-Za-z0-9][A-Za-z0-9.-]*)(.*)$/.exec(aliases[aliases.length - 1]!);
    if (!lm) continue; // "-" (stdin) and "--"
    for (const a of aliases) {
      const am = /^(-{1,2}[A-Za-z0-9][A-Za-z0-9.-]*)/.exec(a);
      if (am) (lm[2]!.startsWith("=") ? withValue : flags).add(am[1]!);
    }
  }
  return { withValue, flags };
}

const cache = new Map<string, NodeOptionTable>();

/**
 * The running node's option table, derived once per (binary path, version). `run` and `key` are test seams (the
 * default runs `process.execPath --help`, bounded).
 */
export function nodeOptionTable(opts: { run?: () => string; key?: string } = {}): NodeOptionTable {
  const key = opts.key ?? `${process.execPath}\u0000${process.version}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let table: NodeOptionTable;
  try {
    const help = (opts.run ?? (() => execFileSync(process.execPath, ["--help"], { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] })))();
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
