// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * RESOLVED MAIL MUST NOT BE COUNTED AS PENDING.
 *
 * `resolve_messages` stamps `resolved_at` and deliberately does NOT touch
 * `status` — so `status = 'pending'` is NOT a proxy for "unresolved". Four
 * separate counters used it as one, and all four over-reported:
 *
 *   src/db.ts getInboxSummary()      -> the DASHBOARD and Tether's snapshot
 *   src/db.ts pending_count_old      -> stale-mail detection
 *   src/mcp-resources.ts (per-agent) -> MCP resource
 *   src/mcp-resources.ts (global)    -> MCP resource
 *
 * Measured on the live DB before the fix: the summary reported 301 pending
 * against a true 229 — exactly the 72 messages that had been resolved.
 *
 * TWO HARMS, and the second is the dangerous one:
 *   1. The number could never go DOWN, so resolving mail was invisible in the
 *      UI — a metric structurally incapable of showing improvement.
 *   2. Any wake logic reading that count would wake agents for mail already
 *      handled — a spurious wake that is not transient but PERMANENT, because
 *      nothing the agent does can decrement the count.
 *
 * This is the day's recurring shape once more: two sources of truth silently
 * disagreeing, with the disagreement visible only if you go and measure it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const TEST_DIR = path.join(os.tmpdir(), "bot-relay-resolved-count-" + process.pid);
process.env.RELAY_DB_PATH = path.join(TEST_DIR, "relay.db");

const { closeDb, getDb, registerAgent, sendMessage, resolveMessages, getInboxSummary } =
  await import("../src/db.js");

function summaryFor(agent: string): number {
  const row = getInboxSummary().find((r) => r.agent_name === agent);
  return row?.pending_count ?? -1;
}

beforeEach(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(process.env.RELAY_DB_PATH!, { force: true }); } catch { /* ignore */ }
  getDb();
});

afterEach(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("getInboxSummary — the dashboard + Tether snapshot count", () => {
  it("pending_count DROPS when mail is resolved", () => {
    registerAgent("rc-from", "role", []);
    registerAgent("rc-to", "role", []);
    const a = sendMessage("rc-from", "rc-to", "one", "normal");
    const b = sendMessage("rc-from", "rc-to", "two", "normal");
    sendMessage("rc-from", "rc-to", "three", "normal");
    expect(summaryFor("rc-to")).toBe(3);

    const r = resolveMessages("rc-to", [a.id, b.id]);
    expect(r.resolved_count).toBe(2);

    // THE CONTRACT. Before the fix this stayed at 3 forever.
    expect(summaryFor("rc-to")).toBe(1);
  });

  it("resolving EVERYTHING takes the count to zero", () => {
    registerAgent("rz-from", "role", []);
    registerAgent("rz-to", "role", []);
    const ids = [
      sendMessage("rz-from", "rz-to", "a", "normal").id,
      sendMessage("rz-from", "rz-to", "b", "normal").id,
    ];
    expect(summaryFor("rz-to")).toBe(2);
    resolveMessages("rz-to", ids);
    expect(summaryFor("rz-to")).toBe(0);
  });

  it("NEGATIVE CONTROL — status alone would still count resolved mail", () => {
    // Proves the guard is load-bearing rather than coincidental: the rows ARE
    // still status='pending' after a resolve, so a counter keyed on status
    // alone would report the pre-resolve number. If resolve_messages ever
    // starts mutating status, this test fails and tells the next person that
    // the invariant moved rather than silently passing for a new reason.
    registerAgent("nc-from", "role", []);
    registerAgent("nc-to", "role", []);
    const id = sendMessage("nc-from", "nc-to", "only", "normal").id;
    resolveMessages("nc-to", [id]);

    const statusOnly = getDb()
      .prepare("SELECT COUNT(*) AS c FROM messages WHERE to_agent = ? AND status = 'pending'")
      .get("nc-to") as { c: number };
    const withResolved = getDb()
      .prepare(
        "SELECT COUNT(*) AS c FROM messages WHERE to_agent = ? AND status = 'pending' AND resolved_at IS NULL",
      )
      .get("nc-to") as { c: number };

    expect(statusOnly.c).toBe(1);   // the buggy predicate still says 1
    expect(withResolved.c).toBe(0); // the correct predicate says 0
    expect(summaryFor("nc-to")).toBe(0); // and the summary uses the correct one
  });

  it("an agent with no mail reports 0, not a phantom", () => {
    // Guards the LEFT JOIN: adding a second AND to the CASE must not
    // reintroduce the NULL-row miscount the original comment warns about.
    registerAgent("empty-agent", "role", []);
    expect(summaryFor("empty-agent")).toBe(0);
  });
});
