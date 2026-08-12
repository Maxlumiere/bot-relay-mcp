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
import { getDb, pendingGlobalClause, pendingSinceClause } from "../db.js";
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
  /**
   * v2.7.0: the same `since` bound the MCP path applied. Pre-v2.7.0 the
   * filter ran in JS after the SQL fetch, so the probe's SUPERSET
   * query naturally matched. The external-review-flagged P1 fix moved the
   * filter into SQL; the probe must mirror it or every since-narrower-
   * than-all call emits false-positive "divergence" warnings.
   */
  sinceIso: string | null;
}): void {
  if (!isEnabled()) return;
  callCounter += 1;
  if (callCounter % sampleRate() !== 0) return;
  // Only probe pending filters — that's where the known-class bug lives.
  if (args.status !== "pending") return;
  try {
    const db = getDb();
    // SUPERSET query: rows that MUST appear in ANY session's pending drain —
    // #53 derives this from the CANONICAL pendingGlobalClause (unresolved AND
    // read_by_session IS NULL). A row unread by EVERY session and not resolved
    // is pending for everyone, so the MCP path can never legitimately hide it;
    // its absence from the result is a true cross-surface divergence (the class
    // that shipped in v2.2.1). This replaces the pre-#53 ad-hoc
    // `(read_by_session IS NULL OR status='pending')` and routes the probe
    // through the same single source of truth every mailbox surface now shares.
    //
    // The `since` clause MIRRORS the MCP pending drain via the SAME
    // pendingSinceClause SSOT helper the drain uses (#198), NOT a local copy —
    // a probe that duplicates the predicate it checks drifts from it and goes
    // blind to precisely the divergence it exists to catch. Building the superset
    // on the shared helper makes drain/probe agreement structural: the aged
    // never-observed row the drain now delivers is in the superset too, so a
    // regression that DROPPED it from the drain would surface as `missingFromMcp`.
    const pc = pendingGlobalClause();
    const psc = pendingSinceClause(args.sinceIso);
    const params: unknown[] = [args.agentName, ...pc.params, ...psc.params];
    params.push(Math.max(args.limit, 100));
    const sqlRows = db
      .prepare(
        "SELECT id FROM messages " +
          "WHERE to_agent = ? " +
          "  AND " + pc.sql + " " +
          "  " + psc.sql + " " +
          "LIMIT ?",
      )
      .all(...params) as { id: string }[];
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
