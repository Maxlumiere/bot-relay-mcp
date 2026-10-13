// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import fs from "fs";

/**
 * Signal the pid a test RECORDED in a file, and nothing else. The file's content must be all digits and the pid
 * greater than 1. A shell's `echo $pid > file` truncates before it writes, so an early or racing read can see "" and
 * `Number("")` is 0: `process.kill(0, sig)` signals the caller's whole process GROUP. That is never sent here, and
 * neither is a pid of 1. Returns the pid signalled, or null when there was nothing safe to signal (no file, an
 * unparsable read, or a pid <= 1). A process that is already gone is not an error (null).
 */
export function killRecordedPid(file: string, signal: NodeJS.Signals = "SIGKILL", kill: (pid: number, signal: NodeJS.Signals) => void = process.kill): number | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8").trim();
  } catch {
    return null;
  }
  if (!/^\d+$/.test(raw)) return null;
  const pid = Number(raw);
  if (!(pid > 1)) return null;
  try {
    kill(pid, signal);
  } catch {
    return null; // already gone
  }
  return pid;
}
