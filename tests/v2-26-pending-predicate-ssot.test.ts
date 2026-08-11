// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * #53 (mustang [DEFECT]) — PENDING PREDICATE SSOT: cross-surface invariant guard.
 *
 * "Pending" is ONE concept. Before #53 it had four definitions — the peek wake
 * signal (`seq IS NULL`), the get_messages drain (per-session `read_by_session`),
 * the health count (`read_by_session IS NULL`), and the SessionStart hook (binary
 * `status`). That predicate sprawl is what let a wake report N unread while
 * `get_messages` pending returned 0 (silence-as-failure in the core promise): the
 * count you woke on and the queue you drained answered different questions.
 *
 * This guard PROMOTES the sampled consistency-probe (which only ever `log.warn`ed
 * into stderr) to an ENFORCED invariant: the peek wake signal, the get_messages
 * pending drain, health's backlog count, and the canonical predicate helpers
 * (`pendingForSessionClause` / `pendingGlobalClause`) must AGREE across scenarios.
 * Two of the assertions are NEGATIVE CONTROLS — they compute the OLD, buggy
 * predicate alongside the new one and prove the old one would report the wrong
 * number. That makes the guard load-bearing: if a surface is reverted to a
 * pre-#53 predicate, a control reds and names the regression, rather than the
 * guard passing for a coincidental reason.
 *
 * COVERED surfaces (routed through the SSOT): peek_inbox_version.total_unread_count,
 * get_messages(pending), getHealthSnapshot.message_count_pending, hooks/check-relay.sh,
 * src/transport/consistency-probe.ts.
 *
 * KNOWN RESIDUALS (explicitly OUT of #53's named scope — NOT silently claimed
 * unified; see the diagnosis doc + PR body):
 *   - hooks/stop-check.sh   — the #124 Stop-hook read-only wake still keys on the
 *                             binary `status` column. Fast-follow.
 *   - getInboxSummary.unread_count — the dashboard's seq-based "unread" column
 *                             (its pending_count was already resolved-fixed).
 * The residual tripwire at the end fires when either is unified, so this guard's
 * scope stays honest.
 *
 * SCOPE: this unifies the DEFINITION of pending. It does NOT change WHEN a
 * message is marked read (still on the get_messages fetch) — decoupling fetch
 * from consume is an architect-gated behavioural change (Option 1), not here.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.join(os.tmpdir(), "bot-relay-pending-ssot-" + process.pid);
process.env.RELAY_DB_PATH = path.join(TEST_DIR, "relay.db");

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const {
  closeDb,
  getDb,
  registerAgent,
  sendMessage,
  getMessages,
  peekMailboxVersion,
  getHealthSnapshot,
  resolveMessages,
  pendingForSessionClause,
  pendingGlobalClause,
} = await import("../src/db.js");

/** The agent's current session as get_messages/peek resolve it. */
function agentSession(agent: string): string {
  const row = getDb()
    .prepare("SELECT session_id FROM agents WHERE name = ?")
    .get(agent) as { session_id: string | null } | undefined;
  return row?.session_id ?? "";
}

/** Count via the canonical per-session predicate helper directly (the SSOT). */
function canonicalPendingCount(agent: string, session: string): number {
  const pc = pendingForSessionClause(session);
  return (getDb()
    .prepare(`SELECT COUNT(*) AS c FROM messages WHERE to_agent = ? AND ${pc.sql}`)
    .get(agent, ...pc.params) as { c: number }).c;
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

describe("#53 pending predicate SSOT — every surface derives from one definition", () => {
  it("peek total_unread_count, get_messages(pending), and the canonical predicate all agree", () => {
    registerAgent("ssot-from", "role", []);
    registerAgent("ssot-to", "role", []);
    sendMessage("ssot-from", "ssot-to", "m1", "normal");
    sendMessage("ssot-from", "ssot-to", "m2", "normal");
    sendMessage("ssot-from", "ssot-to", "m3", "normal");

    const session = agentSession("ssot-to");
    const peekCount = peekMailboxVersion("ssot-to").total_unread_count;
    const drainSet = getMessages("ssot-to", "pending", 100, true).length; // peek=true: no consume
    const canonical = canonicalPendingCount("ssot-to", session);

    expect(peekCount).toBe(3);
    expect(drainSet).toBe(3);
    expect(canonical).toBe(3);
    // The whole point of the SSOT: these cannot disagree.
    expect(peekCount).toBe(drainSet);
    expect(peekCount).toBe(canonical);
  });

  it("wake signal survives a non-consuming browse — the old seq-based count would falsely report 0 (DEFECT B bite)", () => {
    registerAgent("browse-from", "role", []);
    registerAgent("browse-to", "role", []);
    sendMessage("browse-from", "browse-to", "still-unread", "normal");

    // A history browse with peek=true stamps `seq` (the seq-assignment block is
    // NOT peek-gated) but marks NO read_by_session. This is exactly the motion
    // that silently zeroed the pre-#53 seq-based wake signal while the mail was
    // still pending for the session that had not seen it.
    const browsed = getMessages("browse-to", "all", 100, true);
    expect(browsed.length).toBe(1);
    expect(browsed[0].seq).not.toBeNull(); // seq WAS stamped by the browse

    // NEGATIVE CONTROL — the OLD wake predicate (seq IS NULL) now reports 0.
    const seqBased = (getDb()
      .prepare("SELECT COUNT(*) AS c FROM messages WHERE to_agent = ? AND seq IS NULL")
      .get("browse-to") as { c: number }).c;
    expect(seqBased).toBe(0); // the buggy signal: "no unread" — but the mail IS unread

    // THE CONTRACT — the canonical wake signal still reports it pending.
    expect(peekMailboxVersion("browse-to").total_unread_count).toBe(1);
    expect(getMessages("browse-to", "pending", 100, true).length).toBe(1);
  });

  it("a resolved-but-unread message is excluded from health, peek, and get_messages (health resolved_at bite)", () => {
    registerAgent("res-from", "role", []);
    registerAgent("res-to", "role", []);
    const id = sendMessage("res-from", "res-to", "handle-me", "normal").id;

    // resolveMessages stamps resolved_at WITHOUT touching read_by_session — so a
    // resolved message can still have read_by_session IS NULL. This isolates the
    // resolved_at guard that pre-#53 health omitted.
    resolveMessages("res-to", [id]);

    // NEGATIVE CONTROL — the OLD health predicate (read_by_session IS NULL, no
    // resolved guard) still counts a handled message as backlog.
    const oldHealth = (getDb()
      .prepare("SELECT COUNT(*) AS c FROM messages WHERE to_agent = ? AND read_by_session IS NULL")
      .get("res-to") as { c: number }).c;
    expect(oldHealth).toBe(1); // buggy: resolved mail still counted

    // THE CONTRACT — every canonical surface excludes it.
    const pg = pendingGlobalClause();
    const globalForAgent = (getDb()
      .prepare(`SELECT COUNT(*) AS c FROM messages WHERE to_agent = ? AND ${pg.sql}`)
      .get("res-to") as { c: number }).c;
    expect(globalForAgent).toBe(0);
    expect(peekMailboxVersion("res-to").total_unread_count).toBe(0);
    expect(getMessages("res-to", "pending", 100, true).length).toBe(0);
    // getHealthSnapshot is system-wide; this isolated DB holds only the resolved
    // message, so the backlog count must be 0 (pre-#53 it would have been 1).
    expect(getHealthSnapshot().message_count_pending).toBe(0);
  });

  it("re-pend for a fresh session is preserved, and all surfaces agree across the handover", () => {
    registerAgent("rp-from", "role", []);
    registerAgent("rp-to", "role", []); // session S1
    sendMessage("rp-from", "rp-to", "work", "normal");

    // Drain in S1 (marks read_by_session = S1).
    expect(getMessages("rp-to", "pending", 100, false).length).toBe(1);
    // The SAME session now sees nothing — and every surface agrees.
    expect(peekMailboxVersion("rp-to").total_unread_count).toBe(0);
    expect(getMessages("rp-to", "pending", 100, true).length).toBe(0);

    // A fresh terminal = re-register, which rotates session_id (v2.0 #6).
    registerAgent("rp-to", "role", []); // session S2
    const s2 = agentSession("rp-to");

    // Unfinished (unresolved) mail re-pends for S2 — peek, drain, canonical agree.
    expect(peekMailboxVersion("rp-to").total_unread_count).toBe(1);
    expect(getMessages("rp-to", "pending", 100, true).length).toBe(1);
    expect(canonicalPendingCount("rp-to", s2)).toBe(1);
  });

  it("check-relay.sh delivers on the canonical per-session predicate, not the binary status column", () => {
    const hook = fs.readFileSync(path.join(PROJECT_ROOT, "hooks/check-relay.sh"), "utf8");
    // The delivery query must use the canonical predicate…
    expect(hook).toContain("resolved_at IS NULL");
    expect(hook).toMatch(
      /read_by_session IS NULL\s+OR\s+read_by_session != \(SELECT session_id FROM agents WHERE name = :name\)/,
    );
    // …and must NOT deliver on the pre-#53 binary `status='pending'` filter.
    expect(hook).not.toMatch(/FROM messages WHERE to_agent = :name AND status\s*=\s*'pending'/);
  });

  it("RESIDUAL TRIPWIRE — records the surfaces #53 deliberately left for a fast-follow", () => {
    // This does NOT endorse the residual; it marks the guard's scope boundary so
    // it stays honest (no silent caps). When a follow-up unifies either surface,
    // this assertion fires and prompts updating the SSOT scope above.
    const stop = fs.readFileSync(path.join(PROJECT_ROOT, "hooks/stop-check.sh"), "utf8");
    expect(stop).toMatch(/status = 'pending'/); // stop-check.sh still binary-status (residual)
    const db = fs.readFileSync(path.join(PROJECT_ROOT, "src/db.ts"), "utf8");
    expect(db).toMatch(/m\.seq IS NULL\s+THEN 1/); // getInboxSummary.unread_count still seq-based (residual)
  });
});
