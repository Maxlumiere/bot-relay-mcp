// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import fs from "node:fs";
import path from "node:path";

/**
 * The env for a child that runs the relay in a sandbox HOME. An ALLOWLIST by class: nothing else is copied from the
 * parent. A caller that needs more adds a NAMED variable after construction (e.g. SEC-22's deliberate NODE_OPTIONS).
 *
 * - PATH (its value, whatever the parent's key casing; Windows spells it `Path`).
 * - The HOME spellings HOME and USERPROFILE (plus HOMEDRIVE and HOMEPATH on Windows), set to the sandbox.
 * - The temp dirs TMPDIR, TMP and TEMP, set to `<home>/.tmp` (created here).
 * - LC_ALL and LANG, copied when the parent has them.
 * - Per-OS system variables MEASURED as required, copied from the parent (WINDOWS_SYSTEM_VARS): NONE on any OS.
 *   MEASURED on windows-2022 (25 Oct): node (libuv) re-adds SystemRoot to every child it spawns on Windows, from the
 *   parent, even when the env passed omits it. So the relay's SystemRoot requirement (SEC-22: systemBinary() fails
 *   closed without it) is met with nothing copied. Both facts are pinned by tests/sandbox-env-node-options.test.ts.
 *
 * WHY an allowlist: an ambient code loader in the parent env would otherwise run in the child BEFORE the operator
 * tripwire's own preload (which the spawn decorator, tests/_setup/operator-tripwire.ts, injects): NODE_OPTIONS
 * (--require/--import), LD_PRELOAD (the Linux dynamic loader), OPENSSL_CONF (read by node at startup; a provider module
 * loads native code). Each class has a control in tests/sandbox-env-node-options.test.ts.
 */
export function sandboxEnv(home: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const pick = (name: string) => Object.entries(source).find(([k, v]) => k.toLowerCase() === name.toLowerCase() && v !== undefined)?.[1];
  const tmp = path.join(home, ".tmp");
  fs.mkdirSync(tmp, { recursive: true });
  const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
  const p = pick("PATH");
  if (p !== undefined) env.PATH = p;
  for (const name of ["LC_ALL", "LANG"]) if (source[name] !== undefined) env[name] = source[name];
  if (process.platform === "win32") {
    Object.assign(env, { HOMEDRIVE: path.parse(home).root.replace(/\\$/, ""), HOMEPATH: home.slice(path.parse(home).root.length - 1) });
    for (const name of WINDOWS_SYSTEM_VARS) {
      const v = pick(name);
      if (v !== undefined) env[name] = v;
    }
  }
  return env;
}

/** The Windows system variables a sandbox child gets from this helper: only those MEASURED as required (see sandboxEnv). */
export const WINDOWS_SYSTEM_VARS: readonly string[] = [];
