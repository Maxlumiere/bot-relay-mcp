// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Stop a spawned child and remove the directory it writes into.
 */
import fs from "node:fs";
import type { ChildProcess } from "node:child_process";

export async function stopAndRemove(child: ChildProcess, dir: string, _opts: { graceMs?: number } = {}): Promise<void> {
  child.kill("SIGTERM");
  fs.rmSync(dir, { recursive: true, force: true });
}
