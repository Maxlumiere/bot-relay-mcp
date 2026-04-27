// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Readable, Writable } from "node:stream";
import { createServer } from "../server.js";
import { markAgentOffline, closeAgentSession, getAgentSessionId, logAudit } from "../db.js";
import { log } from "../logger.js";

/**
 * v2.0 final (#1) + v2.0.1 (Codex HIGH 1) + v2.0.2: auto-offline on terminal
 * close, scoped to THIS process's session_id so a stale shutdown cannot
 * clobber a fresh session that a new terminal just registered under the same
 * agent name.
 *
 * v2.1.3 (I9 fix): changed from DELETE to mark-offline. Operator-visible
 * agent identity (token_hash, capabilities, description, auth_state) is NO
 * LONGER destroyed when a Claude Code terminal closes. The agents row is
 * preserved; only `session_id` clears (so the next terminal bootstraps
 * cleanly) and `agent_status` flips to 'offline'. Subsequent
 * `register_agent` with the same RELAY_AGENT_NAME + existing
 * RELAY_AGENT_TOKEN resumes through the standard active-state re-register
 * CAS path — zero operator ceremony, zero lost identity.
 *
 * The concurrent-instance-wipe protection from v2.0.1 HIGH 1 is preserved:
 * the CAS predicate still pins session_id, so if a sibling terminal rotated
 * the session between our SIGINT capture and this call, we no-op instead of
 * clearing their fresh session.
 *
 * Flow:
 *   1. At server start we capture our agent's current session_id. If the
 *      SessionStart hook pre-registered, that value is set. Otherwise it is
 *      null until a future register_agent call rotates a session.
 *   2. At SIGINT/SIGTERM, if we have a captured session_id we CAS-mark
 *      offline with it. If a concurrent terminal rotated the session in the
 *      meantime, the CAS misses and we exit cleanly. If we never captured
 *      one, we no-op: this process cannot safely identify its own session,
 *      so acting by name alone would risk clobbering someone else's session
 *      (HIGH 1 regression that the v2.0.1 fallback chain re-introduced).
 *
 * Hard kills (SIGKILL) still fall through to the dead-agent purge (#2) +
 * the health monitor. A crashed terminal leaves session_id populated until
 * the 30-day purge or until the next terminal with that name re-registers.
 *
 * Audit trail: v2.1.3 closes the forensic gap — this path now writes an
 * audit_log entry with tool='stdio.auto_offline' + signal + captured
 * session_id. Previously the DELETE-on-SIGINT path bypassed the dispatcher
 * and left no trace.
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
 * Pure logic for the SIGINT/SIGTERM auto-offline path. Exported so tests
 * can exercise the three branches (null / mismatch / match) without
 * spawning a process and sending real signals.
 *
 * v2.1.3 (I9 fix): renamed semantically from "unregister" to "mark offline."
 * The export name `performAutoUnregister` is retained for back-compat with
 * existing test imports + the index.ts signal wiring; the new semantics
 * are "mark this session offline, preserving agent identity."
 */
export function performAutoUnregister(
  name: string | undefined,
  capturedSid: string | null,
  signal: string,
): void {
  if (!name || name === "default") return;
  if (!capturedSid) {
    log.debug(
      `[stdio] auto-offline skipped for "${name}" — no captured session_id (process can't safely identify its own session)`,
    );
    return;
  }
  try {
    // v2.2.2 BUG2: prefer closeAgentSession (agent_status='closed') over
    // markAgentOffline so dashboards can distinguish "operator killed
    // the terminal" from "network dropped / sleep / transient". Fall
    // back to markAgentOffline only on helper-level failure.
    let transition: "closed" | "offline" = "closed";
    let changed = false;
    try {
      ({ changed } = closeAgentSession(name, capturedSid));
    } catch (closeErr) {
      log.warn(`[stdio] closeAgentSession failed for "${name}" — falling back to offline:`, closeErr);
      transition = "offline";
      ({ changed } = markAgentOffline(name, capturedSid));
    }
    if (changed) {
      log.info(`[stdio] marked agent "${name}" ${transition} (session=${capturedSid}) on ${signal}`);
      // v2.1.3: close the forensic gap. SIGINT-triggered state changes
      // now write an audit_log entry even though this path bypasses the
      // MCP dispatcher. Source='stdio' distinguishes from dispatcher calls.
      try {
        logAudit(
          name,
          transition === "closed" ? "stdio.auto_close" : "stdio.auto_offline",
          `signal=${signal}`,
          true,
          null,
          "stdio",
          { signal, captured_session_id: capturedSid, transition },
        );
      } catch (auditErr) {
        // Audit write failure MUST NOT block the exit path. Log + continue.
        log.warn(`[stdio] auto-${transition} audit_log write failed for "${name}":`, auditErr);
      }
    } else {
      log.debug(
        `[stdio] auto-${transition} skipped for "${name}" — session_id mismatch (${capturedSid}) or row already ${transition}`,
      );
    }
  } catch (err) {
    log.warn(`[stdio] auto-offline failed for "${name}":`, err);
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

/**
 * v2.4.2 R1: optional `stdin` lets the TTY guard hand a PassThrough proxy
 * (already piped from process.stdin) to the SDK transport so the first
 * frame survives the guard's first-byte detection. When the guard is not
 * engaged (TTY attached, or RELAY_SKIP_TTY_CHECK=1), callers pass nothing
 * and the SDK defaults to process.stdin / process.stdout — unchanged.
 */
export async function startStdioServer(
  stdin?: Readable,
  stdout?: Writable,
): Promise<void> {
  const server = createServer();
  const transport = stdin
    ? new StdioServerTransport(stdin, stdout ?? process.stdout)
    : new StdioServerTransport();
  captureSessionId();
  installAutoUnregister();
  await server.connect(transport);
}
