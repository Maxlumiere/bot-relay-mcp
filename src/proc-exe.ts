// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * THE EXECUTABLE IDENTITY of a process: what the KERNEL says it runs, never a thread name.
 * MEASURED (a CI diagnostic, Node 22 / 24.13.0 / 24.22.3 on ubuntu and macOS): on Linux, Node 24 names its main
 * thread "MainThread", and a process's comm IS its main thread's name, so `ps -o comm=` and /proc/<pid>/comm read
 * "MainThread" for a node process; /proc/<pid>/exe still names the binary. macOS is unaffected: ps's comm there is the
 * executable path.
 *   - Linux: readlink /proc/<pid>/exe, a trailing " (deleted)" stripped (the binary was replaced while the process
 *     runs: a Node upgrade, a rebuild). Unreadable (another user's process, gone) → undefined.
 *   - Elsewhere: undefined; callers keep ps's comm, which there IS the executable.
 * Callers judge `exe ?? comm`. When the exe is unreadable the safe side is the CALLER's: agent detection reads a
 * non-matching comm as "not an agent"; the fleet classifier reads a runtime THREAD name as UNKNOWN (isRuntimeThreadName).
 */
import fs from "fs";
import path from "path";

export interface ExeOpts {
  platform?: NodeJS.Platform;
  readlink?: (p: string) => string;
}

const DELETED_SUFFIX = " (deleted)";

export function executableIdentity(pid: number, opts: ExeOpts = {}): string | undefined {
  if ((opts.platform ?? process.platform) !== "linux") return undefined;
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    let target = (opts.readlink ?? ((p: string) => fs.readlinkSync(p)))(`/proc/${pid}/exe`);
    if (target.endsWith(DELETED_SUFFIX)) target = target.slice(0, -DELETED_SUFFIX.length);
    return target.length > 0 ? target : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The thread names a runtime gives its threads, as comm shows them on Linux (MEASURED on Node 24: MainThread,
 * DelayedTaskSche (DelayedTaskScheduler truncated to 15 bytes), V8Worker, SignalInspector). A comm reading one of these
 * names a THREAD, not an executable: it neither proves nor disproves "node".
 */
const RUNTIME_THREAD_NAMES = /^(MainThread|DelayedTaskSche|DelayedTaskScheduler|V8Worker|SignalInspector)$/;

export function isRuntimeThreadName(comm: string): boolean {
  return RUNTIME_THREAD_NAMES.test(path.basename(comm.trim()));
}
