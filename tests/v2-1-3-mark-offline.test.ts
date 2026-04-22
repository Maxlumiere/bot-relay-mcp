// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v213-offline-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
// v2.1.3 I8-prepend: clear any inherited RELAY_AGENT_* env vars so the
// isolated relay doesn't observe the parent shell's identity.
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;

const {
  registerAgent,
  markAgentOffline,
  getAgentAuthData,
  getAuditLog,
  closeDb,
} = await import("../src/db.js");
const { performAutoUnregister } = await import("../src/transport/stdio.js");

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) {
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  }
}

beforeEach(cleanup);
afterEach(cleanup);

// ============================================================================
// v2.1.3 — markAgentOffline replaces DELETE-on-SIGINT.
//
// The v2.0.1 Codex HIGH 1 fix shipped DELETE-on-SIGINT to prevent a stale
// terminal wiping a fresh session. That worked for the concurrent-instance
// hazard but created a new user-hostile behavior: closing a Claude Code
// terminal destroyed the agent's durable identity (token_hash, capabilities,
// description). Every respawn had to re-bootstrap.
//
// v2.1.3 keeps the concurrent-instance protection (CAS on session_id) but
// transitions the row to offline instead of deleting it. A subsequent
// register_agent with the same RELAY_AGENT_NAME + preserved token takes the
// existing active-state re-register path — zero operator ceremony.
// ============================================================================

describe("v2.1.3 markAgentOffline — CAS contract", () => {
  it("preserves token_hash + capabilities + description + auth_state on CAS match", () => {
    const r = registerAgent("m1", "builder", ["tasks", "webhooks"], {
      description: "durability guard",
    });
    const sid = r.agent.session_id!;
    const tokenHashBefore = getAgentAuthData("m1")?.token_hash;

    const result = markAgentOffline("m1", sid);
    expect(result.changed).toBe(true);

    const row = getAgentAuthData("m1");
    expect(row).toBeTruthy();
    expect(row?.session_id).toBeNull();
    expect(row?.agent_status).toBe("offline");
    expect(row?.busy_expires_at).toBeNull();
    // Durability: identity preserved.
    expect(row?.token_hash).toBe(tokenHashBefore);
    expect(row?.description).toBe("durability guard");
    expect(row?.role).toBe("builder");
    expect(row?.auth_state).toBe("active");
    expect(JSON.parse(row?.capabilities ?? "[]")).toEqual(["tasks", "webhooks"]);
  });

  it("CAS miss (session rotated) → { changed: false }, row untouched", () => {
    const r1 = registerAgent("m2", "r", []);
    const sidA = r1.agent.session_id!;
    const r2 = registerAgent("m2", "r", []);
    const sidB = r2.agent.session_id!;
    expect(sidA).not.toBe(sidB);

    const result = markAgentOffline("m2", sidA);
    expect(result.changed).toBe(false);

    const row = getAgentAuthData("m2");
    expect(row).toBeTruthy();
    expect(row?.session_id).toBe(sidB);
    expect(row?.agent_status).not.toBe("offline");
  });

  it("non-existent name → { changed: false }, no throw", () => {
    // CAS on a name that never existed is a no-op, not an error.
    const result = markAgentOffline("never-registered", "any-session");
    expect(result.changed).toBe(false);
  });
});

describe("v2.1.3 round-trip — re-register after markAgentOffline resumes cleanly", () => {
  it("same name re-registers with existing token; session_id rotates; identity preserved", () => {
    const r1 = registerAgent("respawn", "builder", ["tasks"], {
      description: "round-trip target",
    });
    const sidA = r1.agent.session_id!;
    const tokenHash = getAgentAuthData("respawn")?.token_hash;

    // Terminal closes → SIGINT path marks closed (v2.2.2 BUG2 — was 'offline' pre-BUG2).
    performAutoUnregister("respawn", sidA, "SIGTERM");

    const offlineRow = getAgentAuthData("respawn");
    expect(offlineRow?.agent_status).toBe("closed");
    expect(offlineRow?.session_id).toBeNull();

    // Fresh terminal with same name re-registers. registerAgent takes the
    // active-re-register path (existing row, auth_state='active'). This
    // preserves token_hash and rotates session_id.
    const r2 = registerAgent("respawn", "builder", ["tasks"]);
    expect(r2.agent.session_id).toBeTruthy();
    expect(r2.agent.session_id).not.toBe(sidA);

    const afterRow = getAgentAuthData("respawn");
    expect(afterRow?.token_hash).toBe(tokenHash);
    expect(afterRow?.description).toBe("round-trip target");
    expect(afterRow?.auth_state).toBe("active");
    // No new plaintext token minted on active-state re-register with a
    // preserved token_hash. Caller should keep using the existing token.
    expect(r2.plaintext_token).toBeNull();
  });
});

describe("v2.1.3 audit-log forensic trail", () => {
  it("performAutoUnregister writes audit_log entry with signal + session_id", () => {
    const r = registerAgent("forensic-target", "r", []);
    const sid = r.agent.session_id!;

    performAutoUnregister("forensic-target", sid, "SIGINT");

    const entries = getAuditLog("forensic-target", "stdio.auto_close", 10);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const latest = entries[0];
    expect(latest.agent_name).toBe("forensic-target");
    expect(latest.tool).toBe("stdio.auto_close");
    expect(latest.success).toBe(1);
    expect(latest.source).toBe("stdio");
    expect(latest.params_summary).toBe("signal=SIGINT");
    // Structured params include the captured session_id for forensics.
    expect(latest.params_json).toBeTruthy();
    expect((latest.params_json as Record<string, unknown>).signal).toBe("SIGINT");
    expect((latest.params_json as Record<string, unknown>).captured_session_id).toBe(sid);
  });

  it("CAS miss does NOT write an audit entry (only successful offlines tracked)", () => {
    const r1 = registerAgent("no-log", "r", []);
    const sidA = r1.agent.session_id!;
    registerAgent("no-log", "r", []); // rotates session

    performAutoUnregister("no-log", sidA, "SIGTERM");

    const entries = getAuditLog("no-log", "stdio.auto_close", 10);
    expect(entries.length).toBe(0);
  });
});
