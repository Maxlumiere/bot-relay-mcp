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
 *   - the src modules that run OS tools on darwin (cli/init, cli/launchd, cli/restart, runInit, installDaemon,
 *     system-binary, and liveness: ioreg/ps),
 * or imports a local test helper (./helpers/, ./_helpers/) whose source matches; plus MACOS_PR_ALWAYS, the
 * explicit list of OS-dependent integration tests a source read would miss.
 * RESIDUAL: OS behaviour reached through a deeper dependency chain, and a test that reaches real launchctl
 * without matching any pattern, run on macOS only on main and nightly (the full suite there catches them, and
 * the launchd leak guard runs there), not on the PR.
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
  /cli\/init|cli\/launchd|cli\/restart|runInit|installDaemon|system-binary|src\/liveness|\/liveness\.js/,
];

/** OS-dependent integration tests a source read misses: add here when one is found. */
export const MACOS_PR_ALWAYS = [
  "tests/doorbell-pr7-supervisor.test.ts", // real host/process identity through liveness.ts (ioreg on darwin)
];

const matches = (src) => MACOS_PR_PATTERNS.some((re) => re.test(src));

/** The local helpers a test imports (./helpers/x.js, ./_helpers/x.js), as .ts paths that exist. */
function localHelpers(testFile, src) {
  const out = [];
  for (const m of src.matchAll(/from\s+["'](\.\/_?helpers\/[^"']+)["']|import\(\s*["'](\.\/_?helpers\/[^"']+)["']\s*\)/g)) {
    const spec = m[1] ?? m[2];
    const ts = path.join(path.dirname(testFile), spec).replace(/\.js$/, ".ts");
    if (fs.existsSync(ts)) out.push(ts);
  }
  return out;
}

export function macosPrSubset(root) {
  const out = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".test.ts")) {
        const src = fs.readFileSync(p, "utf8");
        if (matches(src) || localHelpers(p, src).some((h) => matches(fs.readFileSync(h, "utf8")))) {
          out.add(path.relative(root, p).split(path.sep).join("/"));
        }
      }
    }
  };
  walk(path.join(root, "tests"));
  for (const f of MACOS_PR_ALWAYS) {
    if (!fs.existsSync(path.join(root, f))) throw new Error(`MACOS_PR_ALWAYS names a test that does not exist: ${f}`);
    out.add(f);
  }
  return [...out].sort();
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
