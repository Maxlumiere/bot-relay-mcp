// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * THE SHARED BASE every vitest config in this repo extends (architect ruling 621856a0, layer 1:
 * PROTECTION by construction). `withOperatorTripwire(config)` returns the config with, for every run:
 *
 *   - test.env: a PRIVATE HOME (HOME, USERPROFILE, HOMEDRIVE, HOMEPATH) under a per-run directory, and
 *     RELAY_HTTP_PORT=1 (nothing listens there, nothing unprivileged can). So a worker, and any code
 *     path that falls back to "the home" or "the default port", starts away from the operator's relay,
 *     before any setup file runs;
 *   - test.env: the operator SNAPSHOT (its real home, relay roots and ports), discovered HERE, once, in
 *     the main process, from the shell the run started in;
 *   - setupFiles: the tripwire FIRST (tests/_setup/operator-tripwire.ts), then the config's own;
 *   - globalSetup: the tripwire's run guard FIRST (tests/_setup/operator-tripwire-global.mjs): it creates
 *     the run directory, and its teardown FAILS THE RUN if any violation was recorded.
 *
 * Discovery FAILS CLOSED: a config that exists but cannot be read or parsed is an ERROR (the run does
 * not start), never "no port". It reads every operator root (the account's ~/.bot-relay and an ambient
 * RELAY_HOME: its config.json and every instances/<id>/config.json) and an ambient RELAY_CONFIG_PATH.
 *
 * Plain JS, node builtins only, and NO filesystem writes at load: the extension's config imports it
 * too, and tests/vitest-configs-extend-base.test.ts imports every config to check it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The setup file and the global run guard every config must list FIRST. */
export const TRIPWIRE_SETUP = path.join(HERE, "operator-tripwire.ts");
export const TRIPWIRE_GLOBAL = path.join(HERE, "operator-tripwire-global.mjs");
export const DEFAULT_OPERATOR_PORT = 3777;
export const SAFE_PORT = "1";
export const HOME_KEYS = ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"];

// Inside a test worker, fs is wrapped by the tripwire; discovery must read through the raw functions.
const RAW = () => globalThis[Symbol.for("bot-relay.operator-tripwire.raw-fs")] ?? { readFileSync: fs.readFileSync, readdirSync: fs.readdirSync };

/**
 * The env that points the HOME of a process at `home` on every platform. Unix (and node's os.homedir()
 * there) read HOME; on Windows node's os.homedir() reads USERPROFILE and, without it, falls back to the
 * ACCOUNT's real profile. HOMEDRIVE + HOMEPATH are the other Windows spelling (cmd, Git Bash).
 *
 * On Windows the temp directory moves INSIDE the private home too (TEMP, TMP: its real layout,
 * <profile>\AppData\Local\Temp). The relay's path guard (src/approved-roots.ts) approves the home and the
 * POSIX shared temp roots only; Windows temp was approved only because it normally sits under the real
 * profile. With the home private and temp outside it, every test DB made under os.tmpdir() was refused
 * (MEASURED, CI windows-latest on 42add53: 40 PR-D tests). POSIX temp roots are approved on their own.
 */
export function privateHomeEnv(home, platform = process.platform) {
  if (platform === "win32") {
    const drive = path.win32.parse(home).root.replace(/[\\/]+$/, "");
    const temp = path.win32.join(home, "AppData", "Local", "Temp");
    return { HOME: home, USERPROFILE: home, HOMEDRIVE: drive, HOMEPATH: home.slice(drive.length) || "\\", TEMP: temp, TMP: temp };
  }
  return { HOME: home, USERPROFILE: home, HOMEDRIVE: "", HOMEPATH: home };
}

/** Read one config's http_port. Absent → nothing. Present but unreadable or not JSON → THROW. */
function portOf(file) {
  let text;
  try {
    text = RAW().readFileSync(file, "utf-8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw new Error(`operator tripwire: cannot read the operator's relay config ${file} (${err && err.code}): refusing to run without knowing its port`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`operator tripwire: the operator's relay config ${file} is not valid JSON: refusing to run without knowing its port`);
  }
  const n = Number(json && json.http_port);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

/**
 * The operator, as the shell that started this run sees it. `env` is that shell's env; `realHome` is the
 * ACCOUNT's home (passwd / profile), never $HOME, so a run started from a sandboxed HOME still protects
 * the real one.
 */
export function discoverOperator(env = process.env, realHome = os.userInfo().homedir) {
  const roots = [path.join(realHome, ".bot-relay")];
  if (env.RELAY_HOME && path.isAbsolute(env.RELAY_HOME)) roots.push(path.resolve(env.RELAY_HOME));
  const ports = new Set([DEFAULT_OPERATOR_PORT]);
  const configs = [];
  for (const root of roots) {
    configs.push(path.join(root, "config.json"));
    let ids = [];
    try {
      ids = RAW().readdirSync(path.join(root, "instances"));
    } catch (err) {
      if (!err || (err.code !== "ENOENT" && err.code !== "ENOTDIR")) throw new Error(`operator tripwire: cannot list ${path.join(root, "instances")} (${err && err.code})`);
    }
    for (const id of ids) configs.push(path.join(root, "instances", id, "config.json"));
  }
  if (env.RELAY_CONFIG_PATH && path.isAbsolute(env.RELAY_CONFIG_PATH)) configs.push(path.resolve(env.RELAY_CONFIG_PATH));
  for (const f of configs) {
    const p = portOf(f);
    if (p !== null) ports.add(p);
  }
  const ambient = Number(env.RELAY_HTTP_PORT);
  if (Number.isInteger(ambient) && ambient > 0 && ambient < 65536) ports.add(ambient);
  // A shell-set config or DB path is the operator's too: protect it like a root.
  for (const k of ["RELAY_CONFIG_PATH", "RELAY_DB_PATH"]) if (env[k] && path.isAbsolute(env[k])) roots.push(path.resolve(env[k]));
  return { realHome, roots, ports: [...ports] };
}

/** The per-run directory: a NAME only (the global setup creates it). */
function runDirName() {
  let tmp = os.tmpdir();
  try {
    tmp = fs.realpathSync.native(tmp); // canonical: code comparing a resolved cwd with $HOME must agree
  } catch {
    /* keep it as is */
  }
  return path.join(tmp, `bot-relay-tripwire-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
}

const asList = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const abs = (root, p) => (path.isAbsolute(p) ? p : path.resolve(root, p));

/** The config, with the operator tripwire layered in FIRST. See the module comment. */
export function withOperatorTripwire(config = {}) {
  const test = config.test ?? {};
  const root = test.root ?? config.root ?? process.cwd();
  const op = discoverOperator();
  const runDir = runDirName();
  const env = {
    ...(test.env ?? {}),
    ...privateHomeEnv(path.join(runDir, "home")),
    RELAY_HTTP_PORT: SAFE_PORT,
    RELAY_TEST_TRIPWIRE_RUN_DIR: runDir,
    RELAY_TEST_OPERATOR_HOME: op.realHome,
    RELAY_TEST_OPERATOR_ROOTS: JSON.stringify(op.roots),
    RELAY_TEST_OPERATOR_PORTS: op.ports.join(","),
  };
  const setupFiles = [TRIPWIRE_SETUP, ...asList(test.setupFiles).filter((f) => abs(root, f) !== TRIPWIRE_SETUP)];
  const globalSetup = [TRIPWIRE_GLOBAL, ...asList(test.globalSetup).filter((f) => abs(root, f) !== TRIPWIRE_GLOBAL)];
  return { ...config, test: { ...test, env, setupFiles, globalSetup } };
}
