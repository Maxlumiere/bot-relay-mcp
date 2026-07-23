// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v213-status-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;

const {
  registerAgent,
  setAgentStatus,
  getAgents,
  getDb,
  CURRENT_SCHEMA_VERSION,
  closeDb,
  setAgentLivenessAnchor,
  _resetLivenessProbeCacheForTests,
} = await import("../src/db.js");
const { _resetOwnHostIdForTests } = await import("../src/liveness.js");
const OWN_HOST = "v213-own-host";
const LIVE_PID = process.pid;
const { handleSetStatus } = await import("../src/tools/status.js");

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) {
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  }
}

beforeEach(() => {
  cleanup();
  vi.useRealTimers();
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

// ============================================================================
// v2.1.3 I6 — agent_status enum widened from (online|busy|away|offline) to
// (idle|working|blocked|waiting_user|stale|offline). Legacy values normalized
// on input. Read-side derives stale/offline from last_seen age for active
// declared states.
// ============================================================================

describe("v2.1.3 I6 — schema v2_5 migration + defaults", () => {
  it("schema version is current post-migration (Phase A server_version bumped to 22; ADR-0002 agent-class 21; ADR-0003 auth latency 20; v2.15.1 stale-status cleanup 19, v2.13.0 presence liveness 18, v2.12.0 pending-vs-history 17, Tether PID-handshake 16)", () => {
    registerAgent("sv-current", "r", []);
    expect(CURRENT_SCHEMA_VERSION).toBe(22);
    const row = getDb().prepare("SELECT version FROM schema_info WHERE id = 1").get() as { version: number };
    expect(row.version).toBe(22);
  });

  it("new registrations default agent_status='idle' (was 'online')", () => {
    registerAgent("fresh", "r", []);
    const row = getDb().prepare("SELECT agent_status FROM agents WHERE name = ?").get("fresh") as { agent_status: string };
    expect(row.agent_status).toBe("idle");
  });

  it("migration remaps legacy stored values: online→idle, busy→working, away→blocked", () => {
    // Seed rows with legacy values directly (bypasses Zod; simulates an old-DB upgrade).
    registerAgent("legacy-online", "r", []);
    registerAgent("legacy-busy", "r", []);
    registerAgent("legacy-away", "r", []);
    registerAgent("legacy-offline", "r", []);
    const db = getDb();
    db.prepare("UPDATE agents SET agent_status='online' WHERE name='legacy-online'").run();
    db.prepare("UPDATE agents SET agent_status='busy' WHERE name='legacy-busy'").run();
    db.prepare("UPDATE agents SET agent_status='away' WHERE name='legacy-away'").run();
    db.prepare("UPDATE agents SET agent_status='offline' WHERE name='legacy-offline'").run();

    // Close + reopen to trigger migrations (migrateSchemaToV2_5 is idempotent;
    // re-running it maps the stored old values to new).
    closeDb();
    // Import a fresh module instance is awkward; instead run the migration
    // helpers by closing and re-opening the DB via initializeDb through the
    // same module. The getDb() call below will re-initialize.
    const db2 = getDb();
    const rows = db2
      .prepare("SELECT name, agent_status FROM agents ORDER BY name")
      .all() as Array<{ name: string; agent_status: string }>;
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.agent_status]));
    expect(byName["legacy-online"]).toBe("idle");
    expect(byName["legacy-busy"]).toBe("working");
    expect(byName["legacy-away"]).toBe("blocked");
    expect(byName["legacy-offline"]).toBe("offline");
  });
});

describe("v2.1.3 I6 — setAgentStatus accepts new + legacy enum", () => {
  it("accepts each new value", () => {
    registerAgent("w", "r", []);
    for (const s of ["idle", "working", "blocked", "waiting_user", "offline"] as const) {
      expect(setAgentStatus("w", s)).toBe(true);
    }
  });

  it("legacy aliases normalize internally (online→idle, busy→working, away→blocked)", () => {
    registerAgent("legacy-caller", "r", []);
    setAgentStatus("legacy-caller", "online");
    let row = getDb().prepare("SELECT agent_status FROM agents WHERE name = ?").get("legacy-caller") as { agent_status: string };
    expect(row.agent_status).toBe("idle");

    setAgentStatus("legacy-caller", "busy");
    row = getDb().prepare("SELECT agent_status FROM agents WHERE name = ?").get("legacy-caller") as { agent_status: string };
    expect(row.agent_status).toBe("working");

    setAgentStatus("legacy-caller", "away");
    row = getDb().prepare("SELECT agent_status FROM agents WHERE name = ?").get("legacy-caller") as { agent_status: string };
    expect(row.agent_status).toBe("blocked");
  });

  it("working/blocked/waiting_user populate busy_expires_at; idle/offline clear it", () => {
    registerAgent("ttl", "r", []);
    setAgentStatus("ttl", "working");
    let row = getDb().prepare("SELECT busy_expires_at FROM agents WHERE name = ?").get("ttl") as { busy_expires_at: string | null };
    expect(row.busy_expires_at).toBeTruthy();

    setAgentStatus("ttl", "blocked");
    row = getDb().prepare("SELECT busy_expires_at FROM agents WHERE name = ?").get("ttl") as { busy_expires_at: string | null };
    expect(row.busy_expires_at).toBeTruthy();

    setAgentStatus("ttl", "waiting_user");
    row = getDb().prepare("SELECT busy_expires_at FROM agents WHERE name = ?").get("ttl") as { busy_expires_at: string | null };
    expect(row.busy_expires_at).toBeTruthy();

    setAgentStatus("ttl", "idle");
    row = getDb().prepare("SELECT busy_expires_at FROM agents WHERE name = ?").get("ttl") as { busy_expires_at: string | null };
    expect(row.busy_expires_at).toBeNull();

    setAgentStatus("ttl", "offline");
    row = getDb().prepare("SELECT busy_expires_at FROM agents WHERE name = ?").get("ttl") as { busy_expires_at: string | null };
    expect(row.busy_expires_at).toBeNull();
  });
});

describe("v2.1.3 I6 — discover_agents read-side auto-transition", () => {
  // v2.15.0 — agent_status is now VERDICT-driven, not age-driven. Staleness
  // never transitions the status; only a live/dead probe or a declaration does.
  const anchorAlive = (name: string) => setAgentLivenessAnchor(name, LIVE_PID, null);
  const staleLastSeen = (name: string, minAgo: number) =>
    getDb().prepare("UPDATE agents SET last_seen = ? WHERE name = ?")
      .run(new Date(Date.now() - minAgo * 60 * 1000).toISOString(), name);

  beforeEach(() => _resetOwnHostIdForTests(OWN_HOST));

  it("fresh registration with NO liveness anchor reads 'unknown' (no data), not idle", () => {
    registerAgent("a", "r", [], { host_id: OWN_HOST });
    const a = getAgents().find((x) => x.name === "a")!;
    expect(a.agent_status).toBe("unknown");
    expect(a.liveness).toBe("unknown");
  });

  it("a live anchor makes it idle — and STALE last_seen never changes that (rate-limit case)", () => {
    registerAgent("live", "r", [], { host_id: OWN_HOST });
    anchorAlive("live");
    expect(getAgents().find((x) => x.name === "live")!.agent_status).toBe("idle");
    staleLastSeen("live", 6 * 60); // 6 hours stale — OLD code would have said offline/abandoned
    _resetLivenessProbeCacheForTests();
    const a = getAgents().find((x) => x.name === "live")!;
    expect(a.agent_status).toBe("idle"); // AGE-FREE: a live PID is authoritative
    expect(a.liveness).toBe("alive");
  });

  it("stored working + live anchor stays working regardless of last_seen age", () => {
    registerAgent("working-target", "r", [], { host_id: OWN_HOST });
    setAgentStatus("working-target", "working");
    anchorAlive("working-target");
    staleLastSeen("working-target", 6);
    _resetLivenessProbeCacheForTests();
    expect(getAgents().find((x) => x.name === "working-target")!.agent_status).toBe("working");
  });

  it("stored offline always outputs offline regardless of last_seen recency or a live anchor", () => {
    registerAgent("always-offline", "r", [], { host_id: OWN_HOST });
    setAgentStatus("always-offline", "offline");
    anchorAlive("always-offline"); // even a live process doesn't un-declare offline
    expect(getAgents().find((x) => x.name === "always-offline")!.agent_status).toBe("offline");
  });
});

describe("v2.1.3 I6 — handleSetStatus surfaces new enum + legacy normalization", () => {
  it("new value passes through unchanged; legacy reports normalized_from", () => {
    registerAgent("surf", "r", []);

    const r1 = handleSetStatus({ agent_name: "surf", status: "working" });
    const b1 = JSON.parse((r1 as any).content[0].text);
    expect(b1.success).toBe(true);
    expect(b1.status).toBe("working");
    expect(b1.status_normalized_from).toBeUndefined();

    const r2 = handleSetStatus({ agent_name: "surf", status: "busy" });
    const b2 = JSON.parse((r2 as any).content[0].text);
    expect(b2.success).toBe(true);
    expect(b2.status).toBe("working");
    expect(b2.status_normalized_from).toBe("busy");
  });

  it("exempt-from-reassign states surface the reassign-exempt note", () => {
    registerAgent("exempt", "r", []);
    for (const s of ["working", "blocked", "waiting_user"] as const) {
      const r = handleSetStatus({ agent_name: "exempt", status: s });
      const body = JSON.parse((r as any).content[0].text);
      expect(body.note).toMatch(/will not reassign/);
    }
  });

  it("non-exempt states (idle, offline) surface the plain note", () => {
    registerAgent("plain", "r", []);
    for (const s of ["idle", "offline"] as const) {
      const r = handleSetStatus({ agent_name: "plain", status: s });
      const body = JSON.parse((r as any).content[0].text);
      expect(body.note).not.toMatch(/will not reassign/);
    }
  });
});
