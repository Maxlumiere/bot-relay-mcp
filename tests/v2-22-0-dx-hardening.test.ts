// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0005 (v2.22.0) — Relay DX hardening. The security-critical piece is #4
 * (safe orphan cleanup). The KEYSTONE invariant is proved airtight here: an
 * agent that has EVER authenticated can NEVER be abandoned or GC'd, handle or
 * not — so a working agent is safe by construction. Plus the handle can't be
 * forged/replayed, and the #5 message alias.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-adr0005-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_ORPHAN_TTL_MINUTES;

const {
  closeDb,
  getDb,
  registerAgent,
  abandonRegistration,
  gcOrphanRegistrations,
  resolveAgentByToken,
  getAgentAuthData,
} = await import("../src/db.js");
const { handleSendMessage } = await import("../src/tools/messaging.js");

function reset() {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
}
beforeEach(() => {
  reset();
  getDb();
});
afterEach(() => reset());

/** Register + return {token, handle}. A fresh register carries a LIVE session. */
function reg(name: string) {
  const r = registerAgent(name, "worker", []);
  return { token: r.plaintext_token!, handle: r.registration_recovery! };
}
/**
 * Register a genuine session-LESS ORPHAN. abandon/GC only ever touch a
 * session-less orphan (`session_id IS NULL`); a fresh register carries a live
 * session, so end it — modelling a registration whose session died before it
 * ever authenticated (the real orphan-cleanup target).
 */
function regOrphan(name: string) {
  const r = reg(name);
  getDb().prepare("UPDATE agents SET session_id = NULL WHERE name = ?").run(name);
  return r;
}
/** Drive one successful auth (goes through the cache-miss funnel → sets first_authed_at). */
function authOnce(token: string) {
  return resolveAgentByToken(token);
}

// ─────────────────────────────────────────────────────────────────────────────
describe("ADR-0005 #4 — orphan cleanup KEYSTONE (safe by construction)", () => {
  it("register issues a registration_recovery handle (first register only)", () => {
    const { handle } = reg("o-a");
    expect(typeof handle).toBe("string");
    expect(handle.length).toBeGreaterThan(20);
    // re-register does NOT issue a new handle
    expect(registerAgent("o-a", "worker", []).registration_recovery).toBeNull();
  });

  it("a never-authed orphan CAN be abandoned with its handle", () => {
    const { handle } = regOrphan("o-orphan");
    expect(getAgentAuthData("o-orphan")).not.toBeNull();
    expect(abandonRegistration("o-orphan", handle)).toEqual({ abandoned: true });
    expect(getAgentAuthData("o-orphan")).toBeNull(); // row gone
  });

  it("BLOCKER b (codex #115): abandon REFUSES a never-authed row with a LIVE session — even with a valid handle", () => {
    // A FRESH register carries a live session_id. The old DELETE reasserted only
    // `first_authed_at IS NULL` and wrongly removed it (expected false, got true).
    // Now abandon rejects it (session_id !== null) BEFORE the bcrypt handle check,
    // and the shared deleteReapableOrphan re-asserts session_id IS NULL by construction.
    const r = registerAgent("o-livesess", "worker", []); // NOT via reg() → keep the live session
    const liveSession = (getDb().prepare("SELECT session_id FROM agents WHERE name = ?").get("o-livesess") as { session_id: string | null }).session_id;
    expect(liveSession).not.toBeNull();
    const res = abandonRegistration("o-livesess", r.registration_recovery!);
    expect(res.abandoned).toBe(false);
    expect(res.reason).toMatch(/live session/i);
    expect(getAgentAuthData("o-livesess")).not.toBeNull(); // untouched
  });

  it("KEYSTONE: an AUTHENTICATED agent can NEVER be abandoned — even with a VALID handle", () => {
    const { token, handle } = reg("o-live");
    expect(authOnce(token)).not.toBeNull(); // token auth → first_authed_at AND established_at set
    expect(getAgentAuthData("o-live")!.first_authed_at).not.toBeNull();
    expect(getAgentAuthData("o-live")!.established_at).not.toBeNull(); // the reap invariant
    const r = abandonRegistration("o-live", handle);
    expect(r.abandoned).toBe(false);
    expect(r.reason).toMatch(/established|authenticated/i);
    expect(getAgentAuthData("o-live")).not.toBeNull(); // still there, untouched
  });

  it("first auth stamps first_authed_at AND retires the handle", () => {
    const { token, handle } = reg("o-heal");
    expect(getAgentAuthData("o-heal")!.first_authed_at).toBeNull();
    authOnce(token);
    const row = getAgentAuthData("o-heal")!;
    expect(row.first_authed_at).not.toBeNull();
    expect(row.registration_recovery_hash).toBeNull(); // handle retired
    // and the (now stale) handle can't abandon it
    expect(abandonRegistration("o-heal", handle).abandoned).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("ADR-0005 #4 — handle can't be forged / replayed / mis-scoped", () => {
  it("a wrong handle is refused (bcrypt)", () => {
    regOrphan("h-a");
    expect(abandonRegistration("h-a", "not-the-real-handle").abandoned).toBe(false);
  });

  it("an EXPIRED handle is refused", () => {
    const { handle } = regOrphan("h-exp");
    getDb()
      .prepare("UPDATE agents SET registration_recovery_expires_at = ? WHERE name = ?")
      .run(new Date(Date.now() - 1000).toISOString(), "h-exp");
    expect(abandonRegistration("h-exp", handle).abandoned).toBe(false);
    expect(getAgentAuthData("h-exp")).not.toBeNull();
  });

  it("agent X's handle can NOT abandon agent Y (name-scoped)", () => {
    const x = regOrphan("h-x");
    regOrphan("h-y");
    expect(abandonRegistration("h-y", x.handle).abandoned).toBe(false); // X's handle ≠ Y's hash
    expect(getAgentAuthData("h-y")).not.toBeNull();
  });

  it("a replayed handle is dead after the row is gone", () => {
    const { handle } = regOrphan("h-replay");
    expect(abandonRegistration("h-replay", handle).abandoned).toBe(true);
    expect(abandonRegistration("h-replay", handle).abandoned).toBe(false); // no such registration
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("ADR-0005 #4 — auto orphan GC (same keystone)", () => {
  function makeOrphan(name: string, opts: { authed?: boolean; sessionNull?: boolean; oldCreate?: boolean }) {
    const { token } = reg(name);
    if (opts.authed) authOnce(token);
    const db = getDb();
    if (opts.sessionNull) db.prepare("UPDATE agents SET session_id = NULL WHERE name = ?").run(name);
    if (opts.oldCreate) db.prepare("UPDATE agents SET created_at = ? WHERE name = ?").run(new Date(Date.now() - 60 * 60 * 1000).toISOString(), name);
  }

  it("removes ONLY never-authed + session-less + old rows", () => {
    makeOrphan("gc-orphan", { sessionNull: true, oldCreate: true }); // → removed
    makeOrphan("gc-authed", { authed: true, sessionNull: true, oldCreate: true }); // authed → kept (keystone)
    makeOrphan("gc-session", { sessionNull: false, oldCreate: true }); // has session → kept
    makeOrphan("gc-recent", { sessionNull: true, oldCreate: false }); // recent → kept
    const removed = gcOrphanRegistrations(getDb());
    expect(removed).toBe(1);
    expect(getAgentAuthData("gc-orphan")).toBeNull();
    expect(getAgentAuthData("gc-authed")).not.toBeNull();
    expect(getAgentAuthData("gc-session")).not.toBeNull();
    expect(getAgentAuthData("gc-recent")).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("ADR-0005 #5 — MCP send_message accepts `content` OR `message`", () => {
  function parsed(res: any) {
    return JSON.parse(res.content[0].text);
  }
  beforeEach(() => {
    registerAgent("s-from", "worker", []);
    registerAgent("s-to", "worker", []);
  });
  it("content works", () => {
    expect(parsed(handleSendMessage({ from: "s-from", to: "s-to", content: "hi", priority: "normal" } as any)).success).toBe(true);
  });
  it("message (alias) works", () => {
    expect(parsed(handleSendMessage({ from: "s-from", to: "s-to", message: "hi", priority: "normal" } as any)).success).toBe(true);
  });
  it("neither content nor message is rejected", () => {
    const r = parsed(handleSendMessage({ from: "s-from", to: "s-to", priority: "normal" } as any));
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/content.*or.*message.*required/i);
  });
  it("both with DIFFERENT values is rejected", () => {
    const r = parsed(handleSendMessage({ from: "s-from", to: "s-to", content: "a", message: "b", priority: "normal" } as any));
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/only one/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// victra pre-ship catch (2026-07-22): the v22 migration must BACKFILL every
// row that predates the orphan concept, or an upgrade leaves all existing
// agents at first_authed_at IS NULL and the orphan-GC could false-reap a
// live-but-session-less one before it re-authenticates.
describe("ADR-0005 — v22 migration backfills pre-existing rows (no false-reap on upgrade)", () => {
  it("a pre-v22 row (no v22 columns) gets first_authed_at backfilled on migrate → GC-safe", () => {
    let db = getDb(); // fresh v22
    // Simulate a genuine PRE-v22 agent: a row created before the v22 columns
    // existed. Register it, then drop the three v22 columns to reproduce v21
    // shape (row keeps its created_at; loses first_authed_at + the handle cols).
    const old = new Date(Date.now() - 3600_000).toISOString();
    registerAgent("pre22", "worker", []);
    db.exec("UPDATE agents SET created_at = '" + old + "' WHERE name = 'pre22'");
    db.exec("ALTER TABLE agents DROP COLUMN first_authed_at");
    db.exec("ALTER TABLE agents DROP COLUMN established_at");
    db.exec("ALTER TABLE agents DROP COLUMN registration_recovery_hash");
    db.exec("ALTER TABLE agents DROP COLUMN registration_recovery_expires_at");
    // Sanity: the columns are genuinely gone (v21 shape).
    const before = (db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(before).not.toContain("first_authed_at");
    expect(before).not.toContain("established_at");

    // Re-open the DB → the init chain re-runs migrateSchemaToV2_22 (the real
    // 21→22 column migration + backfill; applyMigration only syncs the version).
    closeDb();
    db = getDb();

    // The pre-v22 row is now stamped (= its created_at) — NOT NULL. established_at
    // is the REAP-relevant one (it keys REAPABLE_ORPHAN_WHERE); first_authed_at is
    // the forensic sibling. Both are backfilled so the row is treated as established.
    const row = getAgentAuthData("pre22");
    expect(row).not.toBeNull();
    expect(row!.first_authed_at).not.toBeNull();
    expect(row!.established_at).not.toBeNull();
    // And its (re-added) recovery handle is NULL — a pre-v22 row was never an orphan.
    expect(row!.registration_recovery_hash ?? null).toBeNull();

    // Keystone consequence: the GC can NEVER reap it, even session-less + old.
    db.exec("UPDATE agents SET session_id = NULL WHERE name = 'pre22'");
    gcOrphanRegistrations(db);
    expect(getAgentAuthData("pre22")).not.toBeNull();
  });

  it("the backfill does NOT stamp a genuine post-v22 orphan (guarded by ADD COLUMN, runs once)", () => {
    getDb(); // already v22 — column exists
    registerAgent("post22-orphan", "worker", []); // fresh orphan: first_authed_at NULL
    // Re-open (re-runs the init chain). The column already exists → the ADD
    // COLUMN + backfill are skipped → the genuine orphan must stay NULL.
    closeDb();
    getDb();
    expect(getAgentAuthData("post22-orphan")!.first_authed_at).toBeNull();
  });
});
