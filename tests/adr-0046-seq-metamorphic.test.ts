// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0046 rule 1 — "no decision may key on seq" (ADR-0044), tested for what it
 * MEANS, however the SQL is written: a METAMORPHIC test.
 *
 * Run every decision surface on a fixture, then scramble `seq` and `epoch` on every
 * message (all NULL, random, reversed) and run them again. The results must be
 * IDENTICAL. `seq` is the OBSERVED axis: any view stamps it, including a peek, so a
 * decision that reads it would change with nothing but observation.
 *
 * Surfaces: the canonical pending set; the unread / wake count
 * (peek_inbox_version); get_messages(pending) ids, order, count, total_pending and
 * has_more; get_messages_summary(pending); the board's inbox summary; health's
 * pending count; and the PostToolUse notice (its text and the damper fingerprint)
 * from the hook's read-only reader. F1 joins the list when it lands.
 *
 * Outputs that ARE the observation axis (last_seq, epoch, the per-record seq/epoch
 * fields) are not decisions and are excluded from the comparison.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import cp from "child_process";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(HERE, "..", "hooks", "post-tool-use-check.sh");
const DIR = path.join(os.tmpdir(), "bot-relay-adr0046-seq-" + process.pid);
const DB_PATH = path.join(DIR, "relay.db");
const HOME = path.join(DIR, "home");
process.env.RELAY_DB_PATH = DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;

const db = await import("../src/db.js");
const { handleGetMessages, handleGetMessagesSummary } = await import("../src/tools/messaging.js");
const { GetMessagesSchema, GetMessagesSummarySchema } = await import("../src/types.js");

const R = "a46-seq";
const H = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3600_000).toISOString();

function cleanup() {
  db.closeDb();
  fs.rmSync(DIR, { recursive: true, force: true });
}
beforeEach(() => {
  cleanup();
  fs.mkdirSync(HOME, { recursive: true });
  db.getDb();
});
afterEach(() => cleanup());

/** Every axis the pending predicate decides on, at fixed ages so ages render stably. */
function seed(): void {
  db.registerAgent("a46-sender", "s", []);
  db.registerAgent(R, "r", []);
  db.registerAgent("a46-other", "r", []);
  const S = (db.getDb().prepare("SELECT session_id FROM agents WHERE name = ?").get(R) as { session_id: string }).session_id;
  const m = (content: string, priority = "normal", to = R) => db.sendMessage("a46-sender", to, content, priority).id;
  const set = (id: string, cols: Record<string, unknown>) => {
    const k = Object.keys(cols);
    db.getDb().prepare(`UPDATE messages SET ${k.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...k.map((c) => cols[c]), id);
  };
  set(m("undelivered normal"), { created_at: H(5) });
  set(m("undelivered high", "high"), { created_at: H(4) });
  set(m("read by me"), { created_at: H(3), read_by_session: S, status: "read" });
  set(m("read by a prior session"), { created_at: H(2), read_by_session: "prior", status: "read" });
  set(m("resolved"), { created_at: H(6), resolved_at: H(1) });
  set(m("aged undelivered"), { created_at: H(80) });
  set(m("to someone else", "normal", "a46-other"), { created_at: H(2) });
}

const strip = (rows: Array<Record<string, unknown>>) => rows.map((r) => r.id);

/**
 * Every decision surface, each measured on its OWN freshly-restored fixture. A
 * get_messages peek STAMPS seq on the rows it returns, so measuring the surfaces in
 * sequence let an earlier one change the seq the later ones saw (round-4 audit: a
 * hook keyed on `seq IS NOT NULL` escaped because the peek ran first). `restore`
 * re-applies the SAME seq/epoch assignment before every surface.
 */
function surfaces(restore: () => void) {
  const d = db.getDb();
  const measure = <T,>(f: () => T): T => {
    restore();
    return f();
  };
  const canonical = measure(() => {
    const session = (d.prepare("SELECT session_id FROM agents WHERE name = ?").get(R) as { session_id: string | null }).session_id;
    const pc = db.pendingForSessionClause(session ?? "");
    return (d.prepare(`SELECT id FROM messages WHERE to_agent = ? AND ${pc.sql} ORDER BY id`).all(R, ...pc.params) as Array<{ id: string }>).map(
      (r) => r.id,
    );
  });
  const peek = measure(() => {
    const p = db.peekMailboxVersion(R);
    return { unread: p.total_unread_count, total: p.total_messages_count };
  });
  const getMessages = measure(() => {
    const gm = JSON.parse(
      handleGetMessages(GetMessagesSchema.parse({ agent_name: R, status: "pending", peek: true, limit: 100, since: "all" }) as never).content[0].text,
    );
    return { ids: strip(gm.messages), count: gm.count, total_pending: gm.total_pending, has_more: gm.has_more };
  });
  const getMessagesPage = measure(() => {
    const gm = JSON.parse(handleGetMessages(GetMessagesSchema.parse({ agent_name: R, status: "pending", peek: true, limit: 2 }) as never).content[0].text);
    return { ids: strip(gm.messages), has_more: gm.has_more, total_pending: gm.total_pending };
  });
  const summary = measure(() => {
    const sum = JSON.parse(
      handleGetMessagesSummary(GetMessagesSummarySchema.parse({ agent_name: R, status: "pending", limit: 100, since: "all" }) as never).content[0].text,
    );
    return { ids: strip(sum.summaries), total: sum.total };
  });
  const inbox = measure(() => {
    const row = db.getInboxSummary().find((r) => r.agent_name === R)!;
    return { pending: row.pending_count, unread: row.unread_count };
  });
  const health = measure(() => (db.getHealthSnapshot() as unknown as Record<string, unknown>).message_count_pending ?? null);
  const notice = measure(() => {
    const hook = cp.spawnSync("bash", [HOOK], {
      input: JSON.stringify({ session_id: "44444444-4444-4444-4444-444444444444", hook_event_name: "PostToolUse" }),
      encoding: "utf-8",
      timeout: 15_000,
      env: { PATH: process.env.PATH ?? "", HOME, RELAY_AGENT_NAME: R, RELAY_DB_PATH: DB_PATH, RELAY_HOOK_NOTICE_REMIND_SECS: "0" },
    });
    return hook.stdout ? JSON.parse(hook.stdout).hookSpecificOutput.additionalContext : "";
  });
  return { canonical, peek, getMessages, getMessagesPage, summary, inbox, health, notice };
}

type Scramble = "null" | "random" | "reversed";
/** A FIXED seq/epoch assignment for a scramble kind, re-applied before every surface. */
function assignment(kind: Scramble): () => void {
  const d = db.getDb();
  const ids = (d.prepare("SELECT id FROM messages ORDER BY created_at").all() as Array<{ id: string }>).map((r) => r.id);
  const vals = ids.map((id, i): [number | null, string | null, string] =>
    kind === "null"
      ? [null, null, id]
      : kind === "random"
        ? [Math.floor(Math.random() * 1_000_000), `ep-${Math.random()}`, id]
        : [ids.length - i, `ep-rev-${ids.length - i}`, id],
  );
  const upd = d.prepare("UPDATE messages SET seq = ?, epoch = ? WHERE id = ?");
  return () => {
    for (const v of vals) upd.run(...v);
  };
}

describe("ADR-0046 — no decision keys on seq: scrambling seq/epoch changes NO decision surface", () => {
  it.each(["null", "random", "reversed"] as const)("scramble = %s: every surface is identical", (kind) => {
    seed();
    const baseline = surfaces(assignment("null"));
    // Non-vacuous: the fixture splits in and out, the notice exists, and a page truncates.
    expect(baseline.canonical.length).toBe(4);
    expect(baseline.notice).toMatch(/^relay: 4 unread for a46-seq/);
    expect(baseline.getMessagesPage.has_more).toBe(true);
    expect(surfaces(assignment(kind))).toEqual(baseline);
  });
});
