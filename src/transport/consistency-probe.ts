// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.3.0 Part A.2 — live consistency probe.
 *
 * Sampling observer inside the daemon. Every Nth `get_messages` call fires
 * a parallel raw-SQL query asking a SUPERSET of the same question (no
 * session-partition filter). If SQL sees pending rows that the MCP path
 * returned zero for — the class of bug that shipped in v2.2.1 — the
 * divergence is logged to stderr with the missing IDs.
 *
 * Contracts:
 *   - NEVER throws. A probe error is logged at debug level and swallowed.
 *   - NEVER blocks the underlying get_messages call. The probe runs after
 *     the caller has already received their response.
 *   - OFF by default. Set `RELAY_CONSISTENCY_PROBE=1` to enable.
 *   - Sample rate: `RELAY_CONSISTENCY_PROBE_RATE=N` (default 100).
 *
 * Observation-only. No production behavior depends on the probe.
 */
import { getDb } from "../db.js";
import { log } from "../logger.js";
import type { MessageRecord } from "../types.js";

let callCounter = 0;
let divergenceCount = 0;

function isEnabled(): boolean {
  return process.env.RELAY_CONSISTENCY_PROBE === "1";
}

function sampleRate(): number {
  const raw = process.env.RELAY_CONSISTENCY_PROBE_RATE;
  if (!raw) return 100;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 100;
  return n;
}

/**
 * Reset internal counters. Exported for tests; production callers never
 * touch. Lets a test deterministically trigger or skip the probe sample.
 */
export function _resetProbeCounterForTests(): void {
  callCounter = 0;
  divergenceCount = 0;
}

/** Exported for tests — how many divergences have been logged this process. */
export function _probeDivergenceCountForTests(): number {
  return divergenceCount;
}

/**
 * Called from `handleGetMessages` AFTER the caller's result is computed.
 * Compares the MCP-path result set to a parallel raw-SQL query that
 * intentionally IGNORES session-partition state, so a v2.2.1-style
 * "session marked rows read, subsequent pending poll drops them"
 * regression surfaces as a count mismatch.
 *
 * Only `status === "pending"` samples — that's where the drops-pending
 * class of bug manifests. Other filters are out of scope for now.
 */
export function sampleGetMessagesConsistency(args: {
  agentName: string;
  status: string;
  limit: number;
  peek: boolean;
  mcpResult: MessageRecord[];
}): void {
  if (!isEnabled()) return;
  callCounter += 1;
  if (callCounter % sampleRate() !== 0) return;
  // Only probe pending filters — that's where the known-class bug lives.
  if (args.status !== "pending") return;
  try {
    const db = getDb();
    // SUPERSET query: all rows addressed to this agent where the row
    // itself still looks pending (status column or null read_by_session).
    // Intentionally ignores session-partition — the MCP path's session
    // filter can legitimately hide rows read by THIS session, but it
    // should NOT hide rows that no session has read. If SQL sees any
    // such rows that MCP dropped, that's a v2.2.1-style divergence.
    const sqlRows = db
      .prepare(
        "SELECT id FROM messages " +
          "WHERE to_agent = ? " +
          "  AND (read_by_session IS NULL OR status = 'pending') " +
          "LIMIT ?",
      )
      .all(args.agentName, Math.max(args.limit, 100)) as { id: string }[];
    const mcpIds = new Set(args.mcpResult.map((m) => m.id));
    const missingFromMcp = sqlRows.map((r) => r.id).filter((id) => !mcpIds.has(id));
    if (missingFromMcp.length > 0) {
      divergenceCount += 1;
      log.warn(
        "[consistency-probe] divergence: agent=" + args.agentName +
          " status=" + args.status +
          " mcp_returned=" + args.mcpResult.length +
          " sql_sees_pending=" + sqlRows.length +
          " missing_in_mcp=" + missingFromMcp.length +
          " missing_ids=" + JSON.stringify(missingFromMcp.slice(0, 10)),
      );
    }
  } catch (err) {
    // Never surface to the caller. Debug-level — expected during mid-
    // migration or on an unusual schema shape.
    log.debug(
      "[consistency-probe] skipped (" +
        (err instanceof Error ? err.message : String(err)) +
        ")",
    );
  }
}
