// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0005 FINAL RULING (Maxime, 2026-07-23) — the automatic orphan GC is
 * GONE, not disabled, and this file is the regression that keeps it gone.
 *
 * WHY IT WAS CUT: abandonment is UNDECIDABLE from row state. A slow-spawned
 * child, an idle recovered agent, and a genuinely abandoned registration are
 * byte-identical in the data. Five audit rounds found five different
 * legitimate identities being reaped (force re-registration, live-session
 * abandon, credential recovery, spawn provisioning, operator CLI token
 * rotation) — every fix was correct while the bug simply relocated, because
 * the predicate itself cannot be decided by observation. THE RULE: do not
 * attach an irreversible action to a predicate that cannot be decided by
 * observation.
 *
 * WHAT REMAINS SANCTIONED: abandon_registration — a principal proves a
 * one-time handle and ASKS. Un-abandoned rows persist harmlessly (session-
 * less, never established, name reclaimable via unregister or recover).
 *
 * A feature flagged off is a feature that comes back — so this file asserts
 * ABSENCE at three levels: the export is gone, the purge tick deletes no
 * agent row, and the only surviving deletion path still requires the asking
 * principal.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-no-auto-gc-" + process.pid);
process.env.RELAY_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_ORPHAN_TTL_MINUTES;

const dbModule = await import("../src/db.js");
const { initializeDb, closeDb, getDb, registerAgent, abandonRegistration, purgeOldRecords, getAgentAuthData } = dbModule;

beforeAll(async () => {
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  await initializeDb();
});

afterAll(() => {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

describe("ADR-0005 FINAL — auto orphan GC is GONE, not disabled", () => {
  it("(G1) STRUCTURAL: both retired reapers are gone from the source — the orphan GC and the stale purge", () => {
    expect((dbModule as Record<string, unknown>).gcOrphanRegistrations).toBeUndefined();
    const src = fs.readFileSync(path.resolve(__dirname, "..", "src", "db.ts"), "utf8");
    expect(src).not.toContain("gcOrphanRegistrations");
    // The 30-day dead-agent purge (codex #119 blocker: the LAST autonomous
    // agent-row deletion, keyed on last_seen alone) — its teardown reason is
    // gone from the union, so reintroduction fails the type-check too.
    expect(src).not.toContain('"stale_purge"');
  });

  it("(G2) BEHAVIORAL: a maximally-reapable row — never authed, session-less, ancient on BOTH time axes — survives the purge tick", () => {
    // Both axes matter and both are aged deliberately: the retired orphan GC
    // keyed on created_at, the retired 30-day dead-agent purge keyed on
    // last_seen. Codex caught the first version of this test aging only
    // created_at — it passed while the last_seen reaper was still live,
    // because the fixture never exercised the predicate that reaper used.
    const ancient = new Date(Date.now() - 365 * 24 * 3600_000).toISOString();
    registerAgent("ancient-orphan", "worker", []);
    getDb()
      .prepare("UPDATE agents SET session_id = NULL, created_at = ?, last_seen = ? WHERE name = ?")
      .run(ancient, ancient, "ancient-orphan");
    purgeOldRecords(getDb());
    expect(getAgentAuthData("ancient-orphan")).not.toBeNull();
  });

  it("(G2b) an ESTABLISHED identity idle for a year also survives — the old dead-agent purge reaped these on last_seen alone", () => {
    // The 30-day purge did not even check establishment: a working,
    // token-authed agent that went idle 31 days was deleted and its name
    // freed for anyone to claim. This is the regression that keeps THAT
    // reaper out.
    const reg = registerAgent("idle-established", "worker", []);
    const { resolveAgentByToken } = dbModule as unknown as {
      resolveAgentByToken: (t: string) => unknown;
    };
    resolveAgentByToken(reg.plaintext_token!); // authenticates → established
    const ancient = new Date(Date.now() - 365 * 24 * 3600_000).toISOString();
    getDb()
      .prepare("UPDATE agents SET session_id = NULL, last_seen = ? WHERE name = ?")
      .run(ancient, "idle-established");
    purgeOldRecords(getDb());
    expect(getAgentAuthData("idle-established")).not.toBeNull();
  });

  it("(G3) the surviving deletion path still requires the ASKING principal — abandon with the handle works, absence of the ask preserves the row forever", () => {
    const reg = registerAgent("asked-orphan", "worker", []);
    getDb().prepare("UPDATE agents SET session_id = NULL WHERE name = ?").run("asked-orphan");
    // No ask → no deletion, however many ticks pass.
    purgeOldRecords(getDb());
    purgeOldRecords(getDb());
    expect(getAgentAuthData("asked-orphan")).not.toBeNull();
    // The ask (principal proves the one-time handle) → deletion.
    expect(abandonRegistration("asked-orphan", reg.registration_recovery!)).toEqual({ abandoned: true });
    expect(getAgentAuthData("asked-orphan")).toBeNull();
  });
});
