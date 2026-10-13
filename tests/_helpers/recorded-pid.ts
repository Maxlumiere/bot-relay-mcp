// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import fs from "fs";
import { spawnSync } from "child_process";

/**
 * THE ONE pid parser for every pid a test reads as TEXT (a file, `ps` output) before it signals one. The ONE captured
 * string must be all digits and its value an integer greater than 1; anything else is null. Why: `Number("")` is 0,
 * and `process.kill(0, sig)` signals the caller's whole process GROUP (the test runner). A shell's
 * `echo $pid > file` truncates before it writes, and `ps -o ppid=` prints nothing for a process that is gone, so an
 * empty read is ordinary. A ppid of 1 is a process reparented to init: never one of the test's.
 */
export function parsePid(raw: string | null | undefined): number | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return null;
  const pid = Number(t);
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

/** Signal the pid in ONE captured string, or nothing (parsePid). Returns the pid signalled, or null. Already gone: null. */
export function signalParsedPid(raw: string | null | undefined, signal: NodeJS.Signals, kill: (pid: number, signal: NodeJS.Signals) => void = process.kill): number | null {
  const pid = parsePid(raw);
  if (pid === null) return null;
  try {
    kill(pid, signal);
  } catch {
    return null; // already gone
  }
  return pid;
}

/** Signal the pid a test RECORDED in a file, and nothing else (see parsePid). No file is not an error (null). */
export function killRecordedPid(file: string, signal: NodeJS.Signals = "SIGKILL", kill: (pid: number, signal: NodeJS.Signals) => void = process.kill): number | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
  return signalParsedPid(raw, signal, kill);
}

/**
 * A process's parent, from `ps -o ppid=` (one captured string, parsePid), or null: gone, unreadable, or reparented to
 * init (1). `ps` is injectable so a test can pin the empty-output case without signalling anything.
 */
export function parentPidOf(pid: number, ps: (args: string[]) => string = (args) => spawnSync("ps", args, { encoding: "utf-8" }).stdout ?? ""): number | null {
  return parsePid(ps(["-o", "ppid=", "-p", String(pid)]));
}
