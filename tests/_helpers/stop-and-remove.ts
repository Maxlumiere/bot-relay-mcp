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

/** Stops one child (SIGTERM, bounded wait, SIGKILL, bounded wait); resolves its pid if it is STILL alive, else null. */
async function stopOne(child: ChildProcess, opts: { graceMs?: number; killGraceMs?: number }): Promise<number | string | null> {
  if (isDone(child)) return null;
  // The listener goes on BEFORE the signal, and the state is re-read after it: an exit can never be missed.
  const exited = new Promise<void>((res) => child.once("exit", () => res()));
  if (isDone(child)) return null;
  child.kill("SIGTERM");
  if (await within(exited, opts.graceMs ?? 5_000)) return null;
  child.kill("SIGKILL");
  if ((await within(exited, opts.killGraceMs ?? 5_000)) || isDone(child)) return null;
  return child.pid ?? "?";
}

/**
 * `children`: ONE child, or SEVERAL that write into the same directory (a daemon and its connector, a daemon and a
 * SQLite writer); a null or undefined entry (a child never started) is skipped. ALL are stopped, in parallel, before
 * the directory is removed; if ANY is still alive after SIGKILL and its bound, this REJECTS and the directory stays.
 */
export async function stopAndRemove(
  children: ChildProcess | ReadonlyArray<ChildProcess | null | undefined>,
  dir: string,
  opts: { graceMs?: number; killGraceMs?: number } = {}
): Promise<void> {
  const list = (Array.isArray(children) ? children : [children]).filter((c): c is ChildProcess => c != null);
  const alive = (await Promise.all(list.map((c) => stopOne(c, opts)))).filter((pid) => pid !== null);
  if (alive.length > 0) {
    throw new Error(`stopAndRemove: child ${alive.join(", ")} is still alive after SIGKILL; its directory was NOT removed: ${dir}`);
  }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
