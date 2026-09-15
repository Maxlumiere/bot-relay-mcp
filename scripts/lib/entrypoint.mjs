// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Entrypoint detection for scripts/*.mjs: "am I being run directly?"
 *
 * The guards compared `path.resolve(process.argv[1])` (or `pathToFileURL(argv[1])`)
 * with `import.meta.url`. The module URL is symlink-RESOLVED; argv[1] is not. So run
 * through a symlinked directory (on the maintainer Mac, ~/bot-relay-mcp is one) the
 * comparison was false, main() never ran, and the guard exited 0 with no output: a
 * release gate that passed without checking anything.
 *
 * Resolving argv[1] with realpathSync makes both sides physical, and pathToFileURL
 * makes both sides percent-encoded, so a path containing a space compares equal too.
 * Same shape as dashboard/verify-deploy.mjs's entrypointStatus (#272); duplicated
 * here because dashboard/ is a separate package.
 */
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * How the module at `moduleUrl` was loaded, judged from argv[1]:
 *   "main"     — argv[1] resolves to this very file → run the CLI;
 *   "imported" — argv[1] is some other program (a test runner, an importer) → stay quiet;
 *   "mismatch" — argv[1] has this file's name but cannot be confirmed as this file.
 *
 * @param {string} moduleUrl  the caller's import.meta.url
 * @param {string | undefined} [argv1]  defaults to process.argv[1]
 * @returns {"main" | "imported" | "mismatch"}
 */
export function entrypointStatus(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return "imported";
  let resolved = null;
  try {
    resolved = pathToFileURL(realpathSync(argv1)).href;
  } catch {
    // unreadable argv path: fall through to the name comparison
  }
  if (resolved === moduleUrl) return "main";
  return basename(argv1) === basename(fileURLToPath(moduleUrl)) ? "mismatch" : "imported";
}

/**
 * True only for a confirmed direct run. A run that LOOKS direct (same file name) but
 * cannot be confirmed prints why and sets exit code 2, so it can never read as a
 * silent pass.
 *
 * @param {string} moduleUrl  the caller's import.meta.url
 * @param {string | undefined} [argv1]  defaults to process.argv[1]
 * @returns {boolean}
 */
export function isDirectRun(moduleUrl, argv1 = process.argv[1]) {
  const status = entrypointStatus(moduleUrl, argv1);
  if (status === "mismatch") {
    const name = basename(fileURLToPath(moduleUrl));
    process.stderr.write(
      `${name}: this looks like a direct run, but the entrypoint could not be confirmed ` +
        `(argv[1]=${JSON.stringify(argv1)}); refusing to exit 0 without running.\n`,
    );
    process.exitCode = 2;
  }
  return status === "main";
}
