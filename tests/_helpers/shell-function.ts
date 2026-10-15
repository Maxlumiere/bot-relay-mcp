// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import fs from "fs";

/**
 * The source text of one top-level shell function in `script`: from its `name() {` line through the first line that
 * starts with `}` (the range `awk '/^name\(\) \{/,/^\}/'` printed). Throws if the function is absent.
 *
 * Tests that exercise one function of a gate script inline its TEXT into their `bash -c` line instead of
 * `eval "$(awk …)"`: the desktop tripwire refuses `eval` (it runs a command line the check cannot read), and an
 * inlined body is one it can.
 */
export function shellFunctionSource(script: string, name: string): string {
  const lines = fs.readFileSync(script, "utf8").split("\n");
  const start = lines.findIndex((l) => l.startsWith(`${name}() {`));
  if (start < 0) throw new Error(`shellFunctionSource: no function ${name}() in ${script}`);
  const end = lines.findIndex((l, i) => i > start && l.startsWith("}"));
  if (end < 0) throw new Error(`shellFunctionSource: ${name}() in ${script} has no closing brace at column 0`);
  return lines.slice(start, end + 1).join("\n");
}
