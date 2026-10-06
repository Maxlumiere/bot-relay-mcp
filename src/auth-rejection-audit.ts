// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * BOUNDED audit of auth REJECTIONS (PR-B; architect ruling e26359ac Q4).
 *
 * Every rejection is audited, with its source, but NEVER one row per request: a rejection storm must
 * not bloat the DB (that would be a second DoS). One audit row per (source, reason, window), carrying a
 * count. The row is INSERTED at the window's first rejection and UPDATED in place for each later one,
 * so its count is current at every moment (nothing is lost if the process dies) and the number of rows
 * is bounded by (sources x reasons) per window.
 *
 *   - tool `auth_rejection`, agent_name NULL (an unauthenticated caller cannot forge attribution), and
 *     params_json { reason, source, count, window_start, last_at, tools, claimed_names } with tools and
 *     claimed names capped at MAX_NAMES distinct values each.
 *   - The in-memory map is bounded too (MAX_KEYS, oldest evicted): an evicted key starts a new row.
 */
import { v4 as uuidv4 } from "uuid";
import { getDb } from "./db.js";
import { encryptContent } from "./encryption.js";

export const REJECTION_WINDOW_MS = 60_000;
const MAX_NAMES = 5;
const MAX_KEYS = 1_000;

interface Window {
  id: string;
  start: number;
  count: number;
  tools: Set<string>;
  claimed: Set<string>;
}
const windows = new Map<string, Window>();

export interface AuthRejection {
  /** The HTTP source IP, else the transport. */
  source: string;
  transport: string;
  /** e.g. unknown_token, wrong_token, missing_token, throttled, busy, wrong_handle, cap_denied. */
  reason: string;
  tool: string;
  claimedName?: string | null;
}

export function recordAuthRejection(r: AuthRejection, now = Date.now()): void {
  const key = `${r.source}\u0000${r.reason}`;
  let w = windows.get(key);
  let insert = false;
  if (!w || now - w.start >= REJECTION_WINDOW_MS) {
    windows.delete(key);
    if (windows.size >= MAX_KEYS) windows.delete(windows.keys().next().value as string);
    w = { id: uuidv4(), start: now, count: 0, tools: new Set(), claimed: new Set() };
    windows.set(key, w);
    insert = true;
  }
  w.count++;
  if (w.tools.size < MAX_NAMES) w.tools.add(r.tool);
  if (r.claimedName && w.claimed.size < MAX_NAMES) w.claimed.add(r.claimedName);
  const structured = {
    tool: "auth_rejection",
    reason: r.reason,
    source: r.source,
    count: w.count,
    window_start: new Date(w.start).toISOString(),
    last_at: new Date(now).toISOString(),
    tools: [...w.tools],
    claimed_names: [...w.claimed],
  };
  const summary = `reason=${r.reason} source=${r.source} count=${w.count}`;
  const json = encryptContent(JSON.stringify(structured));
  const db = getDb();
  if (!insert) {
    const u = db.prepare("UPDATE audit_log SET params_summary = ?, params_json = ? WHERE id = ?").run(summary, json, w.id);
    if (u.changes > 0) return;
    // The row went away (retention purge): fall through and insert it again.
  }
  db.prepare(
    "INSERT INTO audit_log (id, agent_name, tool, params_summary, params_json, success, error, source, created_at) VALUES (?, NULL, 'auth_rejection', ?, ?, 0, ?, ?, ?)",
  ).run(w.id, summary, json, r.reason, r.transport, new Date(w.start).toISOString());
}

/** Tests only. */
export function _resetAuthRejectionAuditForTests(): void {
  windows.clear();
}
