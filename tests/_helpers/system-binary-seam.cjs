// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * A TEST-ONLY seam for the relay's system tools (SEC-22), loaded into a CHILD process with
 * `NODE_OPTIONS=--require <this file>`. Since SEC-22 the relay runs `ps`, `lsof`, ... by an ABSOLUTE trusted path, so a
 * PATH shim no longer reaches it (by design). A test that needs a slow or failing `ps` (INV-LIVE-01's unreadable-start
 * cases) names the absolute path it replaces:
 *
 *   RELAY_TEST_SYSTEM_BINARY_SEAM='{"/bin/ps":"/abs/path/to/slow-ps"}'
 *
 * Every child_process spawn-family call whose program is EXACTLY a key runs the mapped script instead. Nothing else
 * changes. This file lives under tests/ and never ships (package.json `files`); production has NO override knob: a
 * preload is already code execution in that process, so this adds no capability a same-user attacker lacks.
 */
"use strict";
const cp = require("child_process");
const { syncBuiltinESMExports } = require("module");
const path = require("path");

let map = {};
try {
  map = JSON.parse(process.env.RELAY_TEST_SYSTEM_BINARY_SEAM || "{}");
} catch (err) {
  process.stderr.write(`system-binary-seam: RELAY_TEST_SYSTEM_BINARY_SEAM is not JSON (${err.message}): no seam\n`);
  map = {};
}
for (const [from, to] of Object.entries(map)) {
  if (!path.isAbsolute(from) || !path.isAbsolute(String(to))) {
    process.stderr.write(`system-binary-seam: ${from} -> ${to}: both sides must be absolute paths: no seam\n`);
    map = {};
    break;
  }
}
if (Object.keys(map).length) {
  for (const api of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
    const real = cp[api];
    cp[api] = function seamed(file, ...rest) {
      return real.call(this, Object.prototype.hasOwnProperty.call(map, file) ? map[file] : file, ...rest);
    };
  }
  // The relay is ESM. Under --require this runs BEFORE its first `import ... from "child_process"`, whose builtin ESM
  // exports are taken then, so they already see these assignments (MEASURED 20 Oct: the seam bites without the sync).
  // The sync only covers an ESM import made before this file ran, which --require never is: belt and braces.
  syncBuiltinESMExports();
}
