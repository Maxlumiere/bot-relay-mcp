// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Stop a spawned child and remove the directory it writes into, in THAT order: SIGTERM, then AWAIT its exit (bounded
 * by `graceMs`, default 5 s; past it SIGKILL, and await again, bounded by `killGraceMs`, default 5 s), and only then
 * remove the directory, with Node's own retries for ENOTEMPTY/EBUSY. A child still shutting down writes into its
 * directory (the daemon's owner endpoint record, SQLite's side files): removing it first races the child.
 * If the child is STILL alive after SIGKILL and its bound, this REJECTS and leaves the directory in place (removing it
 * under a live writer is the race this helper exists to prevent); every wait is bounded, so it always settles.
 */
import fs from "node:fs";
import type { ChildProcess } from "node:child_process";

const isDone = (c: ChildProcess): boolean => c.exitCode !== null || c.signalCode !== null;

/** Resolves true when `exited` settles within `ms`, false otherwise (the timer is always cleared). */
async function within(exited: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<false>((res) => (timer = setTimeout(() => res(false), ms)));
  try {
    return await Promise.race([exited.then(() => true as const), late]);
  } finally {
    clearTimeout(timer);
  }
}

export async function stopAndRemove(child: ChildProcess, dir: string, opts: { graceMs?: number; killGraceMs?: number } = {}): Promise<void> {
  if (!isDone(child)) {
    // The listener goes on BEFORE the signal, and the state is re-read after it: an exit can never be missed.
    const exited = new Promise<void>((res) => child.once("exit", () => res()));
    if (!isDone(child)) {
      child.kill("SIGTERM");
      if (!(await within(exited, opts.graceMs ?? 5_000))) {
        child.kill("SIGKILL");
        if (!(await within(exited, opts.killGraceMs ?? 5_000)) && !isDone(child)) {
          throw new Error(`stopAndRemove: child ${child.pid ?? "?"} is still alive after SIGKILL; its directory was NOT removed: ${dir}`);
        }
      }
    }
  }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
