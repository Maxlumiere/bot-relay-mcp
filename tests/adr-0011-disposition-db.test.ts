// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0011 — message disposition + read-receipts (L2 of ADR-0007), DB-layer
 * contract. Additive on the messages table: `disposition` (log|ask|obligation,
 * default log), `deadline`, and the sender's sticky agent-level `read_at`.
 *
 * The 5 LOAD-BEARING invariants victra's gate names, each asserted on the
 * CONTRACT (not a proxy):
 *   1. MIGRATION-SAFE — default 'log' by construction; LOG is excluded from the
 *      outstanding recap, so a historical/undeclared message can NEVER be overdue.
 *   2. STICKY AGENT-LEVEL READ — read_at is stamped write-once on the first drain,
 *      survives the reading session's death, and NEVER flips back when a fresh
 *      session re-sees the message pending (the core lie to prevent).
 *   3. ORTHOGONALITY — read and resolved are independent axes (read-without-
 *      resolve AND resolve-without-read both hold).
 *   4. PULL-QUERYABLE OVERDUE — get_outstanding reconstructs overdue state from a
 *      cold call, with zero reliance on a webhook that may not have been heard.
 *   5. REPORT-ONLY — computing overdue NEVER mutates a message.
 * Plus: peek=true is a non-consuming read → leaves read_at NULL (victra note #2).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-adr0011-db-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
delete process.env.RELAY_ALLOW_LEGACY;

const {
  closeDb,
  getDb,
  getSchemaVersion,
  registerAgent,
  sendMessage,
  getMessages,
  resolveMessages,
  getOutstanding,
  CURRENT_SCHEMA_VERSION,
} = await import("../src/db.js");

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
}
beforeEach(() => cleanup());
afterEach(() => cleanup());

/** Fetch a single message row's raw disposition/read_at/resolved_at. */
function row(id: string) {
  return getDb()
    .prepare("SELECT disposition, deadline, read_at, resolved_at, status, created_at FROM messages WHERE id = ?")
    .get(id) as {
    disposition: string;
    deadline: string | null;
    read_at: string | null;
    resolved_at: string | null;
    status: string;
    created_at: string;
  };
}

// --- 1. MIGRATION-SAFE ---

describe("ADR-0011 (1) migration-safe — default LOG, no historical overdue", () => {
  it("the schema migrated to v24", () => {
    getDb();
    expect(getSchemaVersion()).toBe(24);
    expect(CURRENT_SCHEMA_VERSION).toBe(24);
  });

  it("send_message with no disposition defaults to 'log'", () => {
    registerAgent("alice", "r", []);
    registerAgent("bob", "r", []);
    const m = sendMessage("alice", "bob", "fyi", "normal");
    expect(m.disposition).toBe("log");
    expect(row(m.id).disposition).toBe("log");
  });

  it("a LOG message is NEVER outstanding/overdue — even an ancient one (the historical backlog can't wall the recap)", () => {
    registerAgent("alice", "r", []);
    registerAgent("bob", "r", []);
    // Simulate a pre-ADR-0011 row: raw-insert omitting disposition so the column
    // DEFAULT 'log' backfills it, with a created_at two years in the past.
    const ancient = "2024-01-01T00:00:00.000Z";
    getDb()
      .prepare(
        "INSERT INTO messages (id, from_agent, to_agent, content, priority, status, created_at) VALUES (?, ?, ?, ?, 'normal', 'pending', ?)",
      )
      .run("legacy-1", "alice", "bob", "old fyi", ancient);
    expect(row("legacy-1").disposition).toBe("log");
    const out = getOutstanding("alice", { overdueBoundSeconds: 1, nowIso: "2030-01-01T00:00:00.000Z" });
    // Bound is 1s and the message is 6 years old — yet it is ABSENT (LOG excluded).
    expect(out.find((m) => m.id === "legacy-1")).toBeUndefined();
    expect(out.some((m) => m.overdue)).toBe(false);
  });
});

// --- 2. STICKY AGENT-LEVEL READ ---

describe("ADR-0011 (2) sticky agent-level read — survives session death, never flips back", () => {
  it("read_at stamps on first drain, and a fresh session re-pending the message does NOT clear it", () => {
    registerAgent("alice", "r", []);
    registerAgent("bob", "r", []); // session S1
    const m = sendMessage("alice", "bob", "please reply", "normal", "ask");

    // Before any read: sender sees 'unread'.
    let out = getOutstanding("alice", { overdueBoundSeconds: 86_400 });
    expect(out).toHaveLength(1);
    expect(out[0].state).toBe("unread");
    expect(out[0].read_at).toBeNull();

    // S1 drains it → read_at stamped.
    getMessages("bob", "pending", 20);
    out = getOutstanding("alice", { overdueBoundSeconds: 86_400 });
    expect(out[0].state).toBe("read-unresolved");
    const stampedReadAt = out[0].read_at;
    expect(stampedReadAt).not.toBeNull();

    // S1 dies; a brand-new session S2 registers and RE-SEES the message as
    // pending (per-session action queue) — proving the two axes are live at once.
    registerAgent("bob", "r", []); // session S2
    expect(getMessages("bob", "pending", 20).some((x) => x.id === m.id)).toBe(true); // re-pends

    // ...yet the SENDER's receipt is UNCHANGED — monotonic, never flipped back.
    out = getOutstanding("alice", { overdueBoundSeconds: 86_400 });
    expect(out[0].state).toBe("read-unresolved");
    expect(out[0].read_at).toBe(stampedReadAt);

    // Even after S2 ALSO drains it, read_at is still the FIRST stamp (COALESCE).
    getMessages("bob", "pending", 20);
    expect(getOutstanding("alice", { overdueBoundSeconds: 86_400 })[0].read_at).toBe(stampedReadAt);
  });

  it("peek=true is a non-consuming read → leaves read_at NULL (victra note #2)", () => {
    registerAgent("alice", "r", []);
    registerAgent("bob", "r", []);
    const m = sendMessage("alice", "bob", "peek me", "normal", "ask");
    // A non-mutating survey must NOT stamp the receipt.
    getMessages("bob", "pending", 20, /* peek */ true);
    expect(row(m.id).read_at).toBeNull();
    expect(getOutstanding("alice", { overdueBoundSeconds: 86_400 })[0].state).toBe("unread");
  });
});

// --- 3. ORTHOGONALITY (read ⊥ resolved) ---

describe("ADR-0011 (3) read and resolved are independent axes", () => {
  it("resolve does NOT clear read_at, and read does NOT set resolved_at", () => {
    registerAgent("alice", "r", []);
    registerAgent("bob", "r", []);
    const m = sendMessage("alice", "bob", "do it", "normal", "ask");

    getMessages("bob", "pending", 20); // read (read_at set), NOT resolved
    const afterRead = row(m.id);
    expect(afterRead.read_at).not.toBeNull();
    expect(afterRead.resolved_at).toBeNull(); // read never implies resolved

    resolveMessages("bob", [m.id]); // resolve
    const afterResolve = row(m.id);
    expect(afterResolve.resolved_at).not.toBeNull();
    expect(afterResolve.read_at).toBe(afterRead.read_at); // resolve never clears the receipt

    // include_resolved surfaces it as 'resolved' with the receipt intact.
    const full = getOutstanding("alice", { overdueBoundSeconds: 86_400, includeResolved: true });
    expect(full[0].state).toBe("resolved");
    expect(full[0].read_at).toBe(afterRead.read_at);
    // ...and it is ABSENT from the default (outstanding-only) recap.
    expect(getOutstanding("alice", { overdueBoundSeconds: 86_400 })).toHaveLength(0);
  });

  it("a message can be RESOLVED WITHOUT ever being read (resolve-without-read)", () => {
    registerAgent("alice", "r", []);
    registerAgent("bob", "r", []);
    const m = sendMessage("alice", "bob", "silent-resolve", "normal", "obligation");
    resolveMessages("bob", [m.id]); // resolve an UNREAD message
    const r = row(m.id);
    expect(r.resolved_at).not.toBeNull();
    expect(r.read_at).toBeNull(); // never read
    const full = getOutstanding("alice", { overdueBoundSeconds: 86_400, includeResolved: true });
    expect(full[0].state).toBe("resolved"); // resolved takes precedence over read
  });
});

// --- 4. PULL-QUERYABLE OVERDUE ---

describe("ADR-0011 (4) overdue is pull-queryable — reconstructs from a cold call, no webhook", () => {
  it("ask past the config bound is overdue; within it is not", () => {
    registerAgent("alice", "r", []);
    registerAgent("bob", "r", []);
    const m = sendMessage("alice", "bob", "reply soon", "normal", "ask");
    const created = row(m.id).created_at;
    const createdMs = Date.parse(created);
    // now = created + 10s, bound = 3600s → NOT overdue.
    let out = getOutstanding("alice", { overdueBoundSeconds: 3600, nowIso: new Date(createdMs + 10_000).toISOString() });
    expect(out[0].overdue).toBe(false);
    // now = created + 2h, bound = 3600s → overdue.
    out = getOutstanding("alice", { overdueBoundSeconds: 3600, nowIso: new Date(createdMs + 7_200_000).toISOString() });
    expect(out[0].overdue).toBe(true);
  });

  it("obligation is overdue strictly past its explicit deadline (deadline beats the bound)", () => {
    registerAgent("alice", "r", []);
    registerAgent("bob", "r", []);
    const deadline = "2026-06-01T00:00:00.000Z";
    const m = sendMessage("alice", "bob", "ship it", "normal", "obligation", deadline);
    expect(row(m.id).deadline).toBe(deadline);
    // Before the deadline → not overdue, even with a tiny bound (deadline wins).
    let out = getOutstanding("alice", { overdueBoundSeconds: 1, nowIso: "2026-05-31T23:59:59.000Z" });
    expect(out[0].overdue).toBe(false);
    // After the deadline → overdue, even with a huge bound.
    out = getOutstanding("alice", { overdueBoundSeconds: 999_999_999, nowIso: "2026-06-01T00:00:01.000Z" });
    expect(out[0].overdue).toBe(true);
  });

  it("a fresh (cold) session reconstructs the same overdue picture — the pull IS the recap", () => {
    registerAgent("alice", "r", []);
    registerAgent("bob", "r", []);
    sendMessage("alice", "bob", "q1", "normal", "ask");
    sendMessage("alice", "bob", "q2", "normal", "obligation", "2000-01-01T00:00:00.000Z"); // long overdue
    const nowIso = "2030-01-01T00:00:00.000Z";
    const first = getOutstanding("alice", { overdueBoundSeconds: 86_400, nowIso });
    // A brand-new orchestrator session (a fresh cold call, no prior state, no
    // webhook) reconstructs an identical view.
    const cold = getOutstanding("alice", { overdueBoundSeconds: 86_400, nowIso });
    expect(cold).toEqual(first);
    expect(cold.filter((m) => m.overdue)).toHaveLength(2);
  });
});

// --- 5. REPORT-ONLY ---

describe("ADR-0011 (5) overdue is report-only — never mutates a message", () => {
  it("computing overdue leaves resolved_at/status/read_at untouched", () => {
    registerAgent("alice", "r", []);
    registerAgent("bob", "r", []);
    const m = sendMessage("alice", "bob", "owed", "normal", "obligation", "2000-01-01T00:00:00.000Z");
    const before = row(m.id);
    // Query overdue several times.
    for (let i = 0; i < 3; i++) {
      const out = getOutstanding("alice", { overdueBoundSeconds: 1, nowIso: "2030-01-01T00:00:00.000Z" });
      expect(out[0].overdue).toBe(true);
    }
    const after = row(m.id);
    expect(after.resolved_at).toBeNull(); // NEVER auto-resolved
    expect(after).toEqual(before); // byte-identical row
  });
});
