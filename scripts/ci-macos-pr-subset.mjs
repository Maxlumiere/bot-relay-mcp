#!/usr/bin/env node
// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The macOS test subset ci.yml runs on a PULL REQUEST (main and nightly run the full suite on macOS).
 * Chosen AT CI TIME from the test sources, so a new matching test joins without editing a list: every
 * tests/**\/*.test.ts that mentions
 *   - a hook (bash 3.2 on macOS behaves differently from Linux bash 5),
 *   - darwin / launchctl / launchd / osascript / macOS,
 *   - the modules runInit's launchd bootstrap goes through (cli/init, cli/launchd, cli/restart, runInit,
 *     installDaemon, system-binary).
 * RESIDUAL: a test that reaches real launchctl without matching any pattern runs on macOS only on main and
 * nightly, so the launchd leak guard catches it there, not on the PR.
 *
 * Prints one path per line (relative to the repo root, sorted). Exits 1 when nothing matches: an empty
 * subset would make the macOS PR job pass vacuously.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export const MACOS_PR_PATTERNS = [
  /hooks\/|check-relay\.sh|stop-check\.sh|post-tool-use-check\.sh|codex-session-start\.sh|_vault-helpers|_verdict\.sh|budgetTree/,
  /darwin|launchctl|launchd|osascript|macOS|macos/,
  /cli\/init|cli\/launchd|cli\/restart|runInit|installDaemon|system-binary/,
];

export function macosPrSubset(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".test.ts")) {
        const src = fs.readFileSync(p, "utf8");
        if (MACOS_PR_PATTERNS.some((re) => re.test(src))) out.push(path.relative(root, p).split(path.sep).join("/"));
      }
    }
  };
  walk(path.join(root, "tests"));
  return out.sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const files = macosPrSubset(root);
  if (files.length === 0) {
    process.stderr.write("ci-macos-pr-subset: NO test matched; refusing an empty macOS PR subset\n");
    process.exit(1);
  }
  process.stdout.write(files.join("\n") + "\n");
}
