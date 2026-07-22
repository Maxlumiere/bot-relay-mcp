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

/** Register + return {token, handle}. */
function reg(name: string) {
  const r = registerAgent(name, "worker", []);
  return { token: r.plaintext_token!, handle: r.registration_recovery! };
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
    const { handle } = reg("o-orphan");
    expect(getAgentAuthData("o-orphan")).not.toBeNull();
    expect(abandonRegistration("o-orphan", handle)).toEqual({ abandoned: true });
    expect(getAgentAuthData("o-orphan")).toBeNull(); // row gone
  });

  it("KEYSTONE: an AUTHENTICATED agent can NEVER be abandoned — even with a VALID handle", () => {
    const { token, handle } = reg("o-live");
    expect(authOnce(token)).not.toBeNull(); // it authenticates → first_authed_at set
    expect(getAgentAuthData("o-live")!.first_authed_at).not.toBeNull();
    const r = abandonRegistration("o-live", handle);
    expect(r.abandoned).toBe(false);
    expect(r.reason).toMatch(/authenticated/i);
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
    reg("h-a");
    expect(abandonRegistration("h-a", "not-the-real-handle").abandoned).toBe(false);
  });

  it("an EXPIRED handle is refused", () => {
    const { handle } = reg("h-exp");
    getDb()
      .prepare("UPDATE agents SET registration_recovery_expires_at = ? WHERE name = ?")
      .run(new Date(Date.now() - 1000).toISOString(), "h-exp");
    expect(abandonRegistration("h-exp", handle).abandoned).toBe(false);
    expect(getAgentAuthData("h-exp")).not.toBeNull();
  });

  it("agent X's handle can NOT abandon agent Y (name-scoped)", () => {
    const x = reg("h-x");
    reg("h-y");
    expect(abandonRegistration("h-y", x.handle).abandoned).toBe(false); // X's handle ≠ Y's hash
    expect(getAgentAuthData("h-y")).not.toBeNull();
  });

  it("a replayed handle is dead after the row is gone", () => {
    const { handle } = reg("h-replay");
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
