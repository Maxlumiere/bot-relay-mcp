// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0011 — critical subset on the WASM (sql.js) driver. Confirms the v24
 * migration (ALTER ADD COLUMN … NOT NULL DEFAULT 'log' + the disposition index)
 * and the get_outstanding read path behave identically on sql.js, since the
 * NOT NULL DEFAULT ALTER is the one bit of SQL that could differ across drivers.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-adr0011-wasm-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
delete process.env.RELAY_ALLOW_LEGACY;
process.env.RELAY_SQLITE_DRIVER = "wasm";

const {
  closeDb,
  getDb,
  getSchemaVersion,
  registerAgent,
  sendMessage,
  getMessages,
  resolveMessages,
  getOutstanding,
} = await import("../src/db.js");

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
}
beforeEach(() => cleanup());
afterEach(() => cleanup());

describe("ADR-0011 (wasm) — migration + read-receipt + overdue on sql.js", () => {
  it("migrates to v24 and the NOT NULL DEFAULT backfills disposition='log'", () => {
    getDb();
    expect(getSchemaVersion()).toBe(24);
    registerAgent("alice", "r", []);
    registerAgent("bob", "r", []);
    const m = sendMessage("alice", "bob", "fyi", "normal");
    expect(m.disposition).toBe("log");
    expect(getOutstanding("alice", { overdueBoundSeconds: 1, nowIso: "2030-01-01T00:00:00.000Z" })).toHaveLength(0);
  });

  it("sticky read_at stamps on drain and survives a fresh session; overdue is report-only", () => {
    registerAgent("alice", "r", []);
    registerAgent("bob", "r", []);
    const m = sendMessage("alice", "bob", "please reply", "normal", "obligation", "2000-01-01T00:00:00.000Z");

    // Unread + overdue (past deadline).
    let out = getOutstanding("alice", { overdueBoundSeconds: 86_400 });
    expect(out[0].state).toBe("unread");
    expect(out[0].overdue).toBe(true);

    // Drain in S1 → read_at stamped.
    getMessages("bob", "pending", 20);
    out = getOutstanding("alice", { overdueBoundSeconds: 86_400 });
    expect(out[0].state).toBe("read-unresolved");
    const stamped = out[0].read_at;
    expect(stamped).not.toBeNull();

    // Fresh session S2 re-pends it, but read_at is unchanged (sticky).
    registerAgent("bob", "r", []);
    expect(getMessages("bob", "pending", 20).some((x) => x.id === m.id)).toBe(true);
    expect(getOutstanding("alice", { overdueBoundSeconds: 86_400 })[0].read_at).toBe(stamped);

    // Resolve → leaves the default recap empty; overdue never auto-resolved.
    resolveMessages("bob", [m.id]);
    expect(getOutstanding("alice", { overdueBoundSeconds: 86_400 })).toHaveLength(0);
    const raw = getDb().prepare("SELECT resolved_at, read_at FROM messages WHERE id = ?").get(m.id) as {
      resolved_at: string | null;
      read_at: string | null;
    };
    expect(raw.resolved_at).not.toBeNull();
    expect(raw.read_at).toBe(stamped);
  });
});
