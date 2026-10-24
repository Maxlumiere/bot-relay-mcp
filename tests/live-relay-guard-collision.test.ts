// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * FLEET-NAME COLLISIONS in the live-relay guard (tests/_setup/live-relay-guard.mjs header). A live agent whose name is
 * also a test literal (`fx-lead`) acting during a run stays a LIKELY offender (same exit code); the guard NAMES the
 * collision, with that agent's last_seen, so the operator can check whether it was active. Each case runs on a TEMP
 * SQLite DB this test writes: no live relay is read.
 *
 *   RED:   a VERIFIED row (agent_name set, not register_agent) by a fleet member that is a fixture literal → the run
 *          fails AND the report names the collision with last_seen, the row and the tool; no parameter value printed.
 *   TWINS: every other offender keeps its class and carries no collision line: the probe accident (no actor), a
 *          register_agent row (agent_name may be only claimed), an actor outside the fleet, a nonce row (CERTAIN).
 *   START: each fixture literal ∩ fleet name is a named WARNING, never a failure.
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { collisionWarnings, guardAfter, liveOffenders, snapshotLiveDb } from "./_setup/live-relay-guard.mjs";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guard-collision-")));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));
const FIXTURES = new Set(["fx-lead", "fx-planner", "fx-probe", "default"]);
const NONCE = "collisionnonce01";
const LAST_SEEN = "2026-10-20T13:00:00.000Z";

let seq = 0;
/** A temp "live" DB with a pre-run fleet: fx-lead and fx-planner are ALSO test literals; alice is not. Snapshotted. */
function fleetDb() {
  const dir = path.join(ROOT, `db-${++seq}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "relay.db");
  const db = new Database(file);
  db.exec(`CREATE TABLE agents (name TEXT PRIMARY KEY, last_seen TEXT NOT NULL);
    CREATE TABLE messages (id TEXT, from_agent TEXT, to_agent TEXT);
    CREATE TABLE audit_log (agent_name TEXT, tool TEXT, source TEXT, success INTEGER, params_summary TEXT);`);
  for (const n of ["fx-lead", "fx-planner", "alice", "default"]) db.prepare("INSERT INTO agents (name, last_seen) VALUES (?, ?)").run(n, LAST_SEEN);
  db.close();
  const before = snapshotLiveDb(file);
  const audit = (actor: string | null, tool: string, params: Record<string, unknown> = {}, success = 1) => {
    const w = new Database(file);
    try {
      w.prepare("INSERT INTO audit_log (agent_name, tool, source, success, params_summary) VALUES (?, ?, 'http', ?, ?)").run(actor, tool, success, JSON.stringify(params));
    } finally {
      w.close();
    }
  };
  return { file, before, audit };
}
const opts = { fixtureNames: FIXTURES, nonce: NONCE };

describe("the live-relay guard: fleet-name collisions are NAMED, never exempted (temp DBs only)", () => {
  it("RED: a verified row by a live agent that is ALSO a test fixture → the run still FAILS (LIKELY) and the report names the collision with last_seen, the row and the tool; no parameter value is printed", () => {
    const d = fleetDb();
    d.audit("fx-lead", "send_message", { from: "fx-lead", to: "fx-planner", content: "SEKRET-CONTENT-123" });
    const offenders = liveOffenders(d.before, opts);
    expect(offenders.map((o) => o.class)).toEqual(["LIKELY"]);
    const v = guardAfter({ evaluated: [d.before], notEvaluated: [] }, opts);
    expect(v.fail, "same exit code as before: the run fails").toBe(true);
    const text = v.lines.join("\n");
    expect(text).toContain(`fleet-name collision: fx-lead is a live agent AND a test fixture; verified by its token; last_seen ${LAST_SEEN}; row 1, tool send_message. Check whether that agent was active during the run.`);
    expect(text, "no parameter value or content is printed").not.toContain("SEKRET");
  });

  it("TWINS: every other offender keeps its class and carries NO collision line", () => {
    const cases: Array<{ label: string; actor: string | null; tool: string; params?: Record<string, unknown>; success?: number; cls: string }> = [
      { label: "the probe accident: no actor, a fleet+fixture name claimed", actor: null, tool: "register_agent", params: { name: "fx-lead" }, cls: "LIKELY" },
      { label: "DETECTION (ruling A(a)): a FAILED register_agent, a fixture name claimed, NULL actor (the probe burst's exact shape)", actor: null, tool: "register_agent", params: { name: "fx-probe" }, success: 0, cls: "LIKELY" },
      { label: "the ALLOWED collision 'default' signing a verified row: still LIKELY (the allowance is the start NOTE only)", actor: "default", tool: "send_message", cls: "LIKELY" },
      { label: "register_agent under a fleet fixture name (agent_name may be only claimed there)", actor: "fx-lead", tool: "register_agent", params: { name: "fx-lead" }, cls: "LIKELY" },
      { label: "an actor outside the fleet named like a fixture", actor: "fx-probe", tool: "send_message", cls: "LIKELY" },
      { label: "an actor outside the fleet", actor: "mallory", tool: "send_message", cls: "POSSIBLE" },
      { label: "a nonce row", actor: "fx-lead", tool: "send_message", params: { name: `x-${NONCE}` }, cls: "CERTAIN" },
    ];
    for (const c of cases) {
      const d = fleetDb();
      d.audit(c.actor, c.tool, c.params ?? {}, c.success ?? 1);
      const o = liveOffenders(d.before, opts);
      expect(o.map((x) => x.class), c.label).toEqual([c.cls]);
      if (c.actor !== "default") expect(o[0].collision, c.label).toBeUndefined();
      expect(guardAfter({ evaluated: [d.before], notEvaluated: [] }, opts).fail, c.label).toBe(true);
    }
    const quiet = fleetDb();
    quiet.audit("alice", "send_message");
    expect(liveOffenders(quiet.before, opts), "a fleet member that is no fixture: not an offender (unchanged)").toEqual([]);
  });

  it("AT RUN START: each fixture literal that is also a live fleet name is a named WARNING (never a failure)", () => {
    const d = fleetDb();
    const lines = collisionWarnings({ evaluated: [d.before], notEvaluated: [] }, FIXTURES);
    expect(lines).toEqual([
      `live-relay guard: WARNING 2 fleet-name collision(s) in ${d.file}: fx-lead, fx-planner (each is a live agent AND a test fixture: a row it signs during the run is flagged LIKELY; the fix is renaming the fixture)`,
      `live-relay guard: NOTE allowed collision in ${d.file}: default (the product's fallback name: an unnamed window registered as 'default' before #311); a row it signs during the run is still flagged LIKELY`,
    ]);
    expect(collisionWarnings({ evaluated: [d.before], notEvaluated: [] }, new Set(["fx-renamed"]))).toEqual([]);
  });
});
