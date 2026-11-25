// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The watch's NAME and PATH rules, pure (no lock, no DB, no doorbell): shared by the watch (src/watch-wake.ts
 * re-exports them) and by readers that must not reach the doorbell, such as the daemon's wake-coverage sweep
 * (doorbell PR 8b; the A1 §A2 entrypoint guard keeps the doorbell unreachable from the server).
 */
import path from "path";
import { AGENT_NAME_PATTERN } from "./types.js";

/** An agent name that can have a watch: a valid name, and not all dots (`.`/`..` would name a parent dir). */
export const watchableName = (agent: string): boolean => AGENT_NAME_PATTERN.test(agent) && !/^\.+$/.test(agent);

/** The --until-wake AGENT dir, beside the resolved relay DB: <instance dir>/watch/<agent>/. */
export function watchAgentDir(dbPath: string, agent: string): string {
  if (!watchableName(agent)) throw new Error(`no watch for this agent name: ${JSON.stringify(agent)}`);
  return path.join(path.dirname(dbPath), "watch", agent);
}
