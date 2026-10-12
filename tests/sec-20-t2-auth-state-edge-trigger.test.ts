// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * SEC-20.T2 at the DATA LAYER: no statement, from any binary, moves an agent's auth_state along an edge the relay's
 * own code paths do not take. A revoked agent stays revoked; a recovery_pending agent becomes active only by
 * consuming its recovery ticket and receiving a NEW credential. The only way back from a revoke is `relay recover`
 * (a DELETE, then a fresh register).
 *
 * Enforced by two persistent SQLite triggers on `agents` (schema v27), so it binds every writer of the database
 * file, including an older binary that never heard of the rule:
 *   - agents_auth_state_edge (BEFORE UPDATE OF auth_state): the edge table below, derived from the sanctioned
 *     sites in src/db.ts; any other edge raises AUTH_STATE_EDGE_REFUSED.
 *   - agents_auth_state_insert (BEFORE INSERT): an INSERT may not land on the name (or id) of a revoked or
 *     recovery_pending row, so `INSERT OR REPLACE` cannot delete-and-recreate one (REPLACE fires no UPDATE trigger).
 *
 * BOUNDARY (stated): DELETE + INSERT is the sanctioned revival (relay recover) and is not constrained. An UPDATE
 * whose SET leaves auth_state out does not fire the edge trigger; validity is keyed on auth_state, so it cannot
 * revive.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELAY_BIN = path.join(REPO, "bin", "relay");
const TEST_DIR = path.join(os.tmpdir(), "bot-relay-auth-edge-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_ALLOW_LEGACY;

const db = await import("../src/db.js");
const { closeDb, getDb, registerAgent, revokeAgentToken, CURRENT_SCHEMA_VERSION, AGENT_ROW_GUARD_TRIGGERS } = db;

type State = "active" | "legacy_bootstrap" | "rotation_grace" | "recovery_pending" | "revoked";
const STATES: State[] = ["active", "legacy_bootstrap", "rotation_grace", "recovery_pending", "revoked"];

/**
 * THE RULED EDGE TABLE (architect R1, 2026-10-12), derived from today's sanctioned sites. A self-edge is allowed
 * except on revoked (terminal). Conditional edges are listed with the columns that satisfy them.
 */
const RULED: Record<State, State[]> = {
  active: ["active", "legacy_bootstrap", "rotation_grace", "revoked", "recovery_pending"],
  legacy_bootstrap: ["legacy_bootstrap", "active", "revoked", "recovery_pending"],
  rotation_grace: ["rotation_grace", "active", "revoked", "recovery_pending"],
  recovery_pending: ["recovery_pending", "revoked", "active"],
  revoked: [],
};

let seq = 0;
const fresh = (): string => `edge-${process.pid}-${++seq}`;

/** A row in `state`, reached only along ruled edges (active → X), with the columns each state carries. */
function rowIn(state: State): string {
  const name = fresh();
  registerAgent(name, "tester", []);
  const d = getDb();
  if (state === "legacy_bootstrap") d.prepare("UPDATE agents SET auth_state = 'legacy_bootstrap', token_hash = NULL, token_lookup = NULL WHERE name = ?").run(name);
  if (state === "rotation_grace") d.prepare("UPDATE agents SET auth_state = 'rotation_grace', previous_token_hash = token_hash, rotation_grace_expires_at = '2999-01-01T00:00:00.000Z' WHERE name = ?").run(name);
  if (state === "recovery_pending") revokeAgentToken(name, { issueRecovery: true });
  if (state === "revoked") revokeAgentToken(name, { issueRecovery: false });
  expect(stateOf(name), `precondition: the fixture reached ${state}`).toBe(state);
  return name;
}
const stateOf = (name: string): string | undefined => (getDb().prepare("SELECT auth_state FROM agents WHERE name = ?").get(name) as { auth_state: string } | undefined)?.auth_state;

/** The columns that SATISFY a conditional ruled edge (and are harmless on every other edge). */
function satisfying(from: State, to: State): string {
  if (from === "active" && to === "legacy_bootstrap") return ", token_hash = NULL, token_lookup = NULL";
  if (from === "recovery_pending" && to === "active") return ", recovery_token_hash = NULL, token_hash = 'fresh-hash-' || name";
  return "";
}

/** Run a raw UPDATE; return null when it passed, or the error message when a guard refused it. */
function attempt(sql: string, ...args: unknown[]): string | null {
  try {
    getDb().prepare(sql).run(...args);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
const EDGE = /AUTH_STATE_EDGE_REFUSED/;

beforeEach(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
});
afterAll(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("the edge trigger: all 25 (from, to) pairs, enumerated", () => {
  for (const from of STATES) {
    for (const to of STATES) {
      const allowed = RULED[from].includes(to);
      it(`${from} → ${to}: ${allowed ? "passes" : "REFUSED (AUTH_STATE_EDGE_REFUSED)"}`, () => {
        const name = rowIn(from);
        const err = attempt(`UPDATE agents SET auth_state = ?${satisfying(from, to)} WHERE name = ?`, to, name);
        if (allowed) {
          expect(err).toBeNull();
          expect(stateOf(name)).toBe(to);
        } else {
          expect(err).toMatch(EDGE);
          expect(stateOf(name), "the row is unchanged").toBe(from);
        }
      });
    }
  }

  it("an unknown state string is refused, and the test names WHICH guard refused it", () => {
    const name = rowIn("active");
    const err = attempt("UPDATE agents SET auth_state = 'superuser' WHERE name = ?", name);
    // A BEFORE trigger runs before constraint checks (MEASURED here): the edge trigger refuses first.
    expect(err).toMatch(EDGE);
    // Its twin: with the edge trigger absent, the table's CHECK still refuses it (two independent guards).
    getDb().exec("DROP TRIGGER agents_auth_state_edge");
    const err2 = attempt("UPDATE agents SET auth_state = 'superuser' WHERE name = ?", name);
    expect(err2).toMatch(/CHECK constraint failed/);
    expect(err2).not.toMatch(EDGE);
    expect(stateOf(name)).toBe("active");
  });
});

describe("NULL fails closed (Codex #325 R1 P1): a NULL state is refused by the trigger, never by luck", () => {
  // Under UPDATE OR REPLACE, SQLite answers the NOT NULL violation by substituting the column DEFAULT ('active'), so a
  // predicate that evaluates to NULL (and does not raise) would revive the row with its old credential.
  for (const from of STATES) {
    for (const verb of ["UPDATE", "UPDATE OR REPLACE"] as const) {
      it(`${verb} SET auth_state = NULL on a ${from} row: AUTH_STATE_EDGE_REFUSED, row unchanged`, () => {
        const name = rowIn(from);
        const before = getDb().prepare("SELECT * FROM agents WHERE name = ?").get(name);
        const err = attempt(`${verb} agents SET auth_state = NULL, revoked_at = NULL WHERE name = ?`, name);
        expect(err ?? `PASSED: the row is now ${stateOf(name)}`).toMatch(EDGE);
        expect(getDb().prepare("SELECT * FROM agents WHERE name = ?").get(name)).toEqual(before);
      });
    }
  }
});

describe("the conditional edges refuse the shapes that do not satisfy them", () => {
  it("recovery_pending → active with the recovery ticket NOT consumed (hash kept) is refused", () => {
    const name = rowIn("recovery_pending");
    expect(attempt("UPDATE agents SET auth_state = 'active', token_hash = 'fresh-' || name WHERE name = ?", name)).toMatch(EDGE);
    expect(stateOf(name)).toBe("recovery_pending");
  });
  it("recovery_pending → active with the ticket consumed but the OLD credential kept is refused (no new token)", () => {
    const name = rowIn("recovery_pending");
    expect(attempt("UPDATE agents SET auth_state = 'active', recovery_token_hash = NULL WHERE name = ?", name)).toMatch(EDGE);
    expect(attempt("UPDATE agents SET auth_state = 'active', recovery_token_hash = NULL, token_hash = NULL WHERE name = ?", name)).toMatch(EDGE);
    expect(stateOf(name)).toBe("recovery_pending");
  });
  it("active → legacy_bootstrap while the row still holds a token is refused", () => {
    const name = rowIn("active");
    expect(attempt("UPDATE agents SET auth_state = 'legacy_bootstrap' WHERE name = ?", name)).toMatch(EDGE);
    expect(stateOf(name)).toBe("active");
  });
});

describe("two-step revivals are refused at the first step", () => {
  it("revoked → rotation_grace → active", () => {
    const name = rowIn("revoked");
    expect(attempt("UPDATE agents SET auth_state = 'rotation_grace' WHERE name = ?", name)).toMatch(EDGE);
    expect(stateOf(name)).toBe("revoked");
  });
  it("recovery_pending → rotation_grace → active (skipping the ticket)", () => {
    const name = rowIn("recovery_pending");
    expect(attempt("UPDATE agents SET auth_state = 'rotation_grace' WHERE name = ?", name)).toMatch(EDGE);
    expect(stateOf(name)).toBe("recovery_pending");
  });
  it("revoked → legacy_bootstrap (claimable by a plain register) → active", () => {
    const name = rowIn("revoked");
    expect(attempt("UPDATE agents SET auth_state = 'legacy_bootstrap', token_hash = NULL WHERE name = ?", name)).toMatch(EDGE);
    expect(stateOf(name)).toBe("revoked");
  });
});

describe("an OLDER binary's statements are bound too (the trigger lives in the database file)", () => {
  // The pre-SEC-20 mint --force statement, verbatim (git show 9cfd923^:src/db.ts): no revoked guard in its WHERE.
  const OLD_MINT_FORCE =
    "UPDATE agents SET last_seen = ?, token_hash = ?, token_lookup = ?, session_id = NULL, " +
    "agent_status = 'offline', auth_state = 'active', " +
    "previous_token_hash = NULL, previous_token_lookup = NULL, rotation_grace_expires_at = NULL, " +
    "recovery_token_hash = NULL, revoked_at = NULL, " +
    "description = ? " +
    "WHERE name = ?";
  it("its mint --force on a REVOKED row is refused; the row stays revoked", () => {
    const name = rowIn("revoked");
    expect(attempt(OLD_MINT_FORCE, new Date().toISOString(), "h", "l", null, name)).toMatch(EDGE);
    expect(stateOf(name)).toBe("revoked");
  });
  it("STATED RESIDUAL: its mint --force on a recovery_pending row PASSES (a trigger checks shape, not the ticket)", () => {
    // MEASURED: the old statement nulls recovery_token_hash and writes a new token_hash, exactly the shape a real
    // recovery writes. A trigger cannot know the ticket was presented (bcrypt is outside SQL). The realistic writer
    // is an old (pre-SEC-20) operator binary, same-user tooling that already owns `relay recover`. Ruled residual
    // (architect, 2026-10-12): pinned so that a change in it is SEEN, never assumed. revoked stays fully terminal.
    const name = rowIn("recovery_pending");
    expect(attempt(OLD_MINT_FORCE, new Date().toISOString(), "h", "l", null, name)).toBeNull();
    expect(stateOf(name)).toBe("active");
  });
  it("TWIN: the same statement on an ACTIVE row passes", () => {
    const name = rowIn("active");
    expect(attempt(OLD_MINT_FORCE, new Date().toISOString(), "h", "l", null, name)).toBeNull();
    expect(stateOf(name)).toBe("active");
  });
});

describe("the insert guard: REPLACE and UPSERT cannot recreate a revoked or recovery_pending row", () => {
  const cols = "(name, role, capabilities, last_seen, created_at, auth_state, token_hash)";
  const vals = "(?, 'tester', '[]', '2026-01-01', '2026-01-01', 'active', 'new-hash')";
  for (const state of ["revoked", "recovery_pending"] as const) {
    it(`INSERT OR REPLACE over a ${state} row (same name) is refused, and the row is intact`, () => {
      const name = rowIn(state);
      const before = getDb().prepare("SELECT * FROM agents WHERE name = ?").get(name);
      expect(attempt(`INSERT OR REPLACE INTO agents ${cols} VALUES ${vals}`, name)).toMatch(EDGE);
      expect(getDb().prepare("SELECT * FROM agents WHERE name = ?").get(name)).toEqual(before);
    });
    it(`REPLACE through the ${state} row's ID (a different name) is refused`, () => {
      const name = rowIn(state);
      const id = (getDb().prepare("SELECT id FROM agents WHERE name = ?").get(name) as { id: number }).id;
      expect(attempt(`INSERT OR REPLACE INTO agents (id, name, role, capabilities, last_seen, created_at) VALUES (?, ?, 'tester', '[]', '2026-01-01', '2026-01-01')`, id, fresh())).toMatch(EDGE);
      expect(stateOf(name)).toBe(state);
    });
    it(`an UPSERT onto a ${state} name is refused`, () => {
      const name = rowIn(state);
      expect(attempt(`INSERT INTO agents ${cols} VALUES ${vals} ON CONFLICT(name) DO UPDATE SET auth_state = 'active', token_hash = 'new-hash'`, name)).toMatch(EDGE);
      expect(stateOf(name)).toBe(state);
    });
  }
  it("TWIN: an automatic-rowid INSERT (a normal register) passes while protected rows exist", () => {
    // MEASURED (native SQLite 3.53.4 and sql.js): NEW.rowid in a BEFORE INSERT is -1 when the rowid is automatic, so
    // the guard's rowid clause never matches a real row. SQLite documents that value as undefined: if it ever changed,
    // this twin goes RED (an innocent insert refused), never a silent pass.
    rowIn("revoked");
    rowIn("recovery_pending");
    const name = fresh();
    expect(() => registerAgent(name, "tester", [])).not.toThrow();
    expect(stateOf(name)).toBe("active");
  });
  it("TWIN: INSERT OR REPLACE of a brand-new name passes, and over an ACTIVE row passes", () => {
    const name = fresh();
    expect(attempt(`INSERT OR REPLACE INTO agents ${cols} VALUES ${vals}`, name)).toBeNull();
    expect(stateOf(name)).toBe("active");
    const live = rowIn("active");
    expect(attempt(`INSERT OR REPLACE INTO agents ${cols} VALUES ${vals}`, live)).toBeNull();
  });
});

/**
 * SEC-20.T4 (architect ruling, Codex #325 R1 P1 DESIGN): an agent's identity (name, id) never changes after creation;
 * only DELETE + a fresh register replaces one. `UPDATE OR REPLACE ... SET name = <victim>` would otherwise delete the
 * victim through the UNIQUE conflict and leave the donor's row (and token) answering to the victim's name, with no
 * INSERT and no auth_state write for the other two triggers to see.
 */
describe("identity is immutable: no UPDATE changes an agent's name or id", () => {
  const IDENT = /AGENT_IDENTITY_IMMUTABLE/;
  const snapshot = (n: string) => getDb().prepare("SELECT * FROM agents WHERE name = ?").get(n);
  for (const recursive of ["OFF", "ON"] as const) {
    for (const victimState of ["revoked", "active", "recovery_pending"] as const) {
      for (const key of ["name", "id"] as const) {
        for (const verb of ["UPDATE", "UPDATE OR REPLACE", "UPDATE OR IGNORE"] as const) {
          for (const withState of [false, true]) {
            it(`recursive_triggers ${recursive}, ${victimState} victim, by ${key}, ${verb}${withState ? ", auth_state in SET" : ""}: refused, both rows intact`, () => {
              getDb().pragma(`recursive_triggers = ${recursive}`);
              try {
                const victim = rowIn(victimState);
                const donor = rowIn("active");
                const [v0, d0] = [snapshot(victim), snapshot(donor)];
                const target = key === "name" ? "?" : "(SELECT id FROM agents WHERE name = ?)";
                // Codex's repro shape: the donor takes the victim's key AND copies its credential.
                const sql = `${verb} agents SET ${key} = ${target}, token_hash = (SELECT token_hash FROM agents WHERE name = ?)${withState ? ", auth_state = auth_state" : ""} WHERE name = ?`;
                const err = attempt(sql, victim, victim, donor);
                expect(err ?? "PASSED").toMatch(IDENT);
                expect(snapshot(victim), "the victim row is intact").toEqual(v0);
                expect(snapshot(donor), "the donor row is intact").toEqual(d0);
              } finally {
                getDb().pragma("recursive_triggers = OFF");
              }
            });
          }
        }
      }
    }
  }
  // Codex #325 R2 P1: agents is a rowid table, so the hidden rowid is the row's PHYSICAL identity and a third unique
  // key. A REPLACE conflict on it deletes the victim with no name/id change and no auth_state write.
  for (const recursive of ["OFF", "ON"] as const) {
    for (const victimState of ["revoked", "recovery_pending"] as const) {
      for (const alias of ["rowid", "_rowid_", "oid"] as const) {
        it(`recursive_triggers ${recursive}, ${victimState} victim, UPDATE OR REPLACE SET ${alias} = <victim's>: refused, both rows intact`, () => {
          getDb().pragma(`recursive_triggers = ${recursive}`);
          try {
            const victim = rowIn(victimState);
            const donor = rowIn("active");
            const [v0, d0] = [snapshot(victim), snapshot(donor)];
            const err = attempt(`UPDATE OR REPLACE agents SET ${alias} = (SELECT rowid FROM agents WHERE name = ?) WHERE name = ?`, victim, donor);
            expect(err ?? `PASSED: victim ${snapshot(victim) ? "still there" : "DELETED"}`).toMatch(IDENT);
            expect(snapshot(victim), "the victim row is intact").toEqual(v0);
            expect(snapshot(donor), "the donor row is intact").toEqual(d0);
          } finally {
            getDb().pragma("recursive_triggers = OFF");
          }
        });
        it(`recursive_triggers ${recursive}, ${victimState} victim, INSERT OR REPLACE with ${alias} = <victim's> (a new name and id, the victim's credential): refused, victim intact`, () => {
          getDb().pragma(`recursive_triggers = ${recursive}`);
          try {
            const victim = rowIn(victimState);
            const v0 = snapshot(victim);
            const err = attempt(
              `INSERT OR REPLACE INTO agents (${alias}, id, name, role, capabilities, last_seen, created_at, token_hash) ` +
                `SELECT rowid, 'replacement-id-' || rowid, 'replacement-' || rowid, role, capabilities, last_seen, created_at, token_hash FROM agents WHERE name = ?`,
              victim,
            );
            expect(err ?? "PASSED").toMatch(EDGE);
            expect(snapshot(victim), "the victim row is intact").toEqual(v0);
          } finally {
            getDb().pragma("recursive_triggers = OFF");
          }
        });
      }
    }
  }
  it("a rowid change with NO conflict (a fresh, unused rowid) is refused too: identity includes the physical key", () => {
    const n = rowIn("active");
    const before = snapshot(n);
    expect(attempt("UPDATE agents SET rowid = 9000000 WHERE name = ?", n) ?? "PASSED").toMatch(IDENT);
    expect(snapshot(n)).toEqual(before);
  });

  it("TWIN: an UPDATE that leaves name and id unchanged passes (last_seen; and name = name)", () => {
    const n = rowIn("active");
    expect(attempt("UPDATE agents SET last_seen = '2030-01-01T00:00:00.000Z' WHERE name = ?", n)).toBeNull();
    expect(attempt("UPDATE agents SET name = name, id = id WHERE name = ?", n)).toBeNull();
    expect(stateOf(n)).toBe("active");
  });
  it("a NULL name or id is refused by the identity trigger (fail closed), not by luck", () => {
    const n = rowIn("active");
    for (const sql of ["UPDATE OR REPLACE agents SET name = NULL WHERE name = ?", "UPDATE agents SET id = NULL WHERE name = ?"]) {
      expect(attempt(sql, n) ?? "PASSED", sql).toMatch(IDENT);
    }
    expect(stateOf(n)).toBe("active");
  });
});

describe("the relay's own paths, under the triggers", () => {
  it("Q1 STRICT: registerAgent called directly on a revoked row is refused, and the row stays revoked", () => {
    const name = rowIn("revoked");
    expect(() => registerAgent(name, "tester", [])).toThrow(EDGE);
    expect(stateOf(name)).toBe("revoked");
  });

  it("the recovery WRITE shape passes: registerAgent on a recovery_pending row consumes the ticket hash and issues a new token (the ticket itself is checked by the dispatcher, not here)", () => {
    const name = rowIn("active");
    const { recoveryToken } = revokeAgentToken(name, { issueRecovery: true });
    expect(recoveryToken).toBeTruthy();
    const r = registerAgent(name, "tester", []);
    expect(stateOf(name)).toBe("active");
    expect(r.plaintext_token, "a NEW credential was issued").toBeTruthy();
    expect((getDb().prepare("SELECT recovery_token_hash FROM agents WHERE name = ?").get(name) as { recovery_token_hash: string | null }).recovery_token_hash).toBeNull();
  });

  for (const state of ["revoked", "recovery_pending"] as const) {
    it(`relay recover on a ${state} agent (the CLI, a DELETE), then a fresh register: works, and the new token authorizes`, async () => {
      const name = rowIn(state);
      closeDb();
      const r = spawnSync(process.execPath, [RELAY_BIN, "recover", name, "--yes"], {
        env: { ...process.env, RELAY_DB_PATH: TEST_DB_PATH, RELAY_CONFIG_PATH: path.join(TEST_DIR, "config.json"), HOME: TEST_DIR },
        encoding: "utf-8",
        timeout: 30_000,
      });
      expect(r.status, `relay recover: ${r.stdout}\n${r.stderr}`).toBe(0);
      expect(stateOf(name), "recover removed the row").toBeUndefined();
      const fresh2 = registerAgent(name, "tester", []);
      expect(stateOf(name)).toBe("active");
      expect(((await db.resolveAgentByToken(fresh2.plaintext_token as string)) as { name?: string } | null)?.name).toBe(name);
    });
  }
});

describe("the installer: one exact body, on a virgin, an upgraded and a tampered database; no write when current", () => {
  const triggers = (): Record<string, string> =>
    Object.fromEntries((getDb().prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'agents'").all() as Array<{ name: string; sql: string }>).map((t) => [t.name, t.sql]));

  it("a virgin database carries the four row-guard triggers with exactly this binary's SQL, at schema v27", () => {
    getDb();
    expect(triggers()).toEqual(AGENT_ROW_GUARD_TRIGGERS);
    expect(CURRENT_SCHEMA_VERSION).toBe(27);
    expect((getDb().prepare("SELECT version FROM schema_info WHERE id = 1").get() as { version: number }).version).toBe(27);
  });

  it("an UPGRADED database (a v26 file without the triggers) gets them on open", () => {
    getDb();
    for (const n of Object.keys(AGENT_ROW_GUARD_TRIGGERS)) getDb().exec(`DROP TRIGGER ${n}`);
    getDb().prepare("UPDATE schema_info SET version = 26 WHERE id = 1").run();
    expect(triggers()).toEqual({});
    closeDb();
    getDb();
    expect(triggers()).toEqual(AGENT_ROW_GUARD_TRIGGERS);
    expect((getDb().prepare("SELECT version FROM schema_info WHERE id = 1").get() as { version: number }).version).toBe(27);
  });

  it("a TAMPERED trigger (a permissive body under the same name) is restored to the exact body on open", () => {
    getDb();
    getDb().exec("DROP TRIGGER agents_auth_state_edge");
    getDb().exec("CREATE TRIGGER agents_auth_state_edge BEFORE UPDATE OF auth_state ON agents WHEN 0 BEGIN SELECT 1; END");
    closeDb();
    getDb();
    expect(triggers()).toEqual(AGENT_ROW_GUARD_TRIGGERS);
    const name = rowIn("revoked");
    expect(attempt("UPDATE agents SET auth_state = 'active' WHERE name = ?", name)).toMatch(EDGE);
  });

  it("a second open of a current database performs NO schema write (schema cookie and sqlite_master unchanged)", () => {
    getDb();
    const snap = () => ({
      cookie: getDb().pragma("schema_version", { simple: true }),
      master: getDb().prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all(),
    });
    const before = snap();
    closeDb();
    getDb();
    expect(snap()).toEqual(before);
  });
});
