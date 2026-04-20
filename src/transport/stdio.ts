// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "../server.js";
import { unregisterAgent, getAgentSessionId } from "../db.js";
import { log } from "../logger.js";

/**
 * v2.0 final (#1) + v2.0.1 (Codex HIGH 1) + v2.0.2: auto-unregister on terminal
 * close, scoped to THIS process's session_id so a stale shutdown cannot wipe a
 * fresh session that a new terminal just registered under the same agent name.
 *
 * Flow:
 *   1. At server start we capture our agent's current session_id. If the
 *      SessionStart hook pre-registered, that value is set. Otherwise it is
 *      null until a future register_agent call rotates a session (re-capture
 *      on-the-fly is deferred to v2.1).
 *   2. At SIGINT/SIGTERM, if we have a captured session_id we CAS-delete with
 *      it. If a concurrent terminal rotated the session in the meantime, the
 *      CAS misses and we exit cleanly. If we never captured one, we no-op:
 *      this process cannot safely identify its own session, so deleting by
 *      name alone would risk wiping someone else's fresh session (HIGH 1
 *      regression that the v2.0.1 fallback chain re-introduced).
 *
 * Hard kills (SIGKILL) still fall through to the dead-agent purge (#2) +
 * the health monitor.
 */
let capturedSessionId: string | null = null;

/**
 * v2.1 Phase 4f.1: setter for `capturedSessionId` so `handleRegisterAgent`
 * can refresh it when a stdio process registers (or re-registers) itself
 * mid-lifetime via the MCP tool. Without this, an agent that registers via
 * MCP AFTER startStdioServer (no SessionStart hook) leaks its row on SIGTERM
 * because Phase 2a's null-guard correctly refuses to guess.
 *
 * Gate conditions (applied by the caller in src/tools/identity.ts):
 *   - transport must be "stdio"
 *   - newly-registered name must match process.env.RELAY_AGENT_NAME
 * Either failure → do not call this setter.
 */
export function updateCapturedSessionId(sid: string | null): void {
  capturedSessionId = sid;
  log.debug(`[stdio] re-captured session_id=${sid ?? "<null>"}`);
}

/** Exposed for tests — read-only accessor on the module-local state. */
export function getCapturedSessionId(): string | null {
  return capturedSessionId;
}

/**
 * Pure logic for the SIGINT/SIGTERM auto-unregister. Exported so tests can
 * exercise the three branches (null/mismatch/match) without spawning a
 * process and sending real signals.
 */
export function performAutoUnregister(
  name: string | undefined,
  capturedSid: string | null,
  signal: string,
): void {
  if (!name || name === "default") return;
  if (!capturedSid) {
    log.debug(
      `[stdio] auto-unregister skipped for "${name}" — no captured session_id (process can't safely identify its own session)`,
    );
    return;
  }
  try {
    const removed = unregisterAgent(name, capturedSid);
    if (removed) {
      log.info(`[stdio] auto-unregistered agent "${name}" (session=${capturedSid}) on ${signal}`);
    } else {
      log.debug(
        `[stdio] auto-unregister skipped for "${name}" — session_id mismatch (${capturedSid}) or already unregistered`,
      );
    }
  } catch (err) {
    log.warn(`[stdio] auto-unregister failed for "${name}":`, err);
  }
}

function installAutoUnregister(): void {
  let fired = false;
  const handler = (signal: NodeJS.Signals) => {
    if (fired) {
      process.exit(signal === "SIGINT" ? 130 : 143);
      return;
    }
    fired = true;
    performAutoUnregister(process.env.RELAY_AGENT_NAME, capturedSessionId, signal);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
}

/**
 * Capture our agent's current session_id at server start. If the agent row
 * already exists (SessionStart hook ran), the captured value matches the
 * live session. If not, the first register_agent tool call via MCP will
 * rotate a session_id; we re-read lazily at SIGINT time in that case.
 */
function captureSessionId(): void {
  const name = process.env.RELAY_AGENT_NAME;
  if (!name || name === "default") return;
  try {
    capturedSessionId = getAgentSessionId(name);
    if (capturedSessionId) {
      log.debug(`[stdio] captured session_id=${capturedSessionId} for agent "${name}"`);
    }
  } catch {
    // If the DB isn't ready yet (shouldn't happen post-initializeDb), SIGINT falls back to live read.
  }
}

export async function startStdioServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  captureSessionId();
  installAutoUnregister();
  await server.connect(transport);
}
