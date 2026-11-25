// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Stop a spawned child and remove the directory it writes into, in THAT order: SIGTERM, then AWAIT its exit (bounded
 * by `graceMs`, default 5 s; past it SIGKILL, and await again), and only then remove the directory, with Node's own
 * retries for ENOTEMPTY/EBUSY. A child still shutting down writes into its directory (the daemon's owner endpoint
 * record, SQLite's side files): removing it first races the child (ENOTEMPTY, or the directory comes back).
 */
import fs from "node:fs";
import type { ChildProcess } from "node:child_process";

const isDone = (c: ChildProcess): boolean => c.exitCode !== null || c.signalCode !== null;

export async function stopAndRemove(child: ChildProcess, dir: string, opts: { graceMs?: number } = {}): Promise<void> {
  if (!isDone(child)) {
    // The listener goes on BEFORE the signal, and the state is re-read after it: an exit can never be missed.
    const exited = new Promise<void>((res) => child.once("exit", () => res()));
    if (!isDone(child)) {
      child.kill("SIGTERM");
      let timer: NodeJS.Timeout | undefined;
      const grace = new Promise<"grace">((res) => (timer = setTimeout(() => res("grace"), opts.graceMs ?? 5_000)));
      const first = await Promise.race([exited.then(() => "exited" as const), grace]);
      clearTimeout(timer);
      if (first === "grace") {
        child.kill("SIGKILL");
        await exited;
      }
    }
  }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
