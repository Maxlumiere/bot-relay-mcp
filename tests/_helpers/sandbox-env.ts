// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import path from "node:path";

/**
 * The env for a child that runs the relay in a sandbox HOME: the FULL parent env (a user's daemon has theirs, and on
 * Windows the daemon needs SystemRoot: its security subprocesses run by an absolute System32 path, SEC-22) minus every
 * relay and test-runner variable AND `NODE_OPTIONS`, with every HOME spelling pointed at the sandbox.
 *
 * `NODE_OPTIONS` is dropped (any letter case: Windows env names are case-insensitive) because an inherited
 * `--require`/`--import` preload would run in the child BEFORE the operator tripwire's own preload, and could read or
 * write the operator's config. The test process's spawn decorator (tests/_setup/operator-tripwire.ts) injects the
 * trusted tripwire preload into the child itself.
 */
export function sandboxEnv(home: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined || /^(RELAY_|VITEST|__VITEST)/i.test(k) || /^NODE_OPTIONS$/i.test(k)) continue;
    env[k] = v;
  }
  Object.assign(env, { HOME: home, USERPROFILE: home });
  if (process.platform === "win32") Object.assign(env, { HOMEDRIVE: path.parse(home).root.replace(/\\$/, ""), HOMEPATH: home.slice(path.parse(home).root.length - 1) });
  return env;
}
