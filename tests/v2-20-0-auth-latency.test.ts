// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0003 (v2.20.0) — O(1) HMAC token locator + verified-token cache.
 *
 * The cache is security-critical: a stale entry = accepting a revoked token =
 * auth bypass. This suite proves, per mutation path, that a token whose
 * validity changed NEVER authenticates from cache (the generation counter),
 * that the migration NULL-digest fallback never locks anyone out, that bcrypt
 * stays the sole verifier, and — adversarially — that the drift guard FAILS the
 * build when a mutator omits its bump.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-adr0003-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_ALLOW_LEGACY;
// Ensure no keyring is configured → exercises the persisted-secret lookup key.
delete process.env.RELAY_ENCRYPTION_KEYRING;
delete process.env.RELAY_ENCRYPTION_KEYRING_PATH;
delete process.env.RELAY_ENCRYPTION_KEY;

const db = await import("../src/db.js");
const {
  closeDb,
  getDb,
  registerAgent,
  mintAgentToken,
  rotateAgentToken,
  rotateAgentTokenAdmin,
  revokeAgentToken,
  unregisterAgent,
  expandAgentCapabilities,
  sweepExpiredRotationGrace,
  markAgentOffline,
  resolveAgentByToken,
  findAgentRowByToken,
  getAuthGeneration,
  bumpAuthGeneration,
  getAgentAuthData,
} = db;
const { computeTokenLookup, _resetTokenLookupCacheForTests } = await import("../src/token-lookup.js");
const {
  authCacheClear,
  authCacheGet,
  authCacheSet,
  authCacheSize,
  AUTH_CACHE_MAX_ENTRIES,
} = await import("../src/auth-cache.js");
const { findAuthGenViolations, findUnresolvableBindings, formatRefusal } = await import(
  "../scripts/auth-gen-guard.mjs"
);

function reset() {
  closeDb();
  authCacheClear();
  _resetTokenLookupCacheForTests();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
}

beforeEach(() => {
  reset();
  getDb(); // lazy-init schema (runs migrateSchemaToV2_20)
});
afterEach(() => reset());

/** Register an agent and return its plaintext token. */
function reg(name: string, caps: string[] = [], managed = false): string {
  const { plaintext_token } = registerAgent(name, "worker", caps, { managed });
  return plaintext_token!;
}

// ─────────────────────────────────────────────────────────────────────────────
describe("ADR-0003 A — lookup digest + schema", () => {
  it("computeTokenLookup is deterministic + distinguishes tokens", () => {
    const a = computeTokenLookup("tok-A");
    expect(a).toBe(computeTokenLookup("tok-A"));
    expect(a).not.toBe(computeTokenLookup("tok-B"));
    expect(a).toMatch(/^[0-9a-f]{64}$/); // HMAC-SHA256 hex
  });

  it("register populates token_lookup = HMAC(token) + auth_meta exists", () => {
    const tok = reg("alice");
    const row = getAgentAuthData("alice")!;
    expect(row.token_lookup).toBe(computeTokenLookup(tok));
    expect(typeof getAuthGeneration()).toBe("number");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("ADR-0003 B — O(1) locator", () => {
  it("resolveAgentByToken identifies the caller + caps via the index", () => {
    const tok = reg("bob", ["tasks"]);
    const r = resolveAgentByToken(tok);
    expect(r).toEqual({ name: "bob", capabilities: ["tasks"] });
  });

  it("a non-matching token resolves to null", () => {
    reg("carol");
    expect(resolveAgentByToken("not-a-real-token")).toBeNull();
  });

  it("the locator hit populates the verified-token cache", () => {
    const tok = reg("dave");
    expect(authCacheSize()).toBe(0);
    resolveAgentByToken(tok);
    expect(authCacheSize()).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("ADR-0003 C — cache is consulted, generation invalidates it", () => {
  it("serves a cached verdict without re-running bcrypt (gen unchanged)", () => {
    const tok = reg("erin");
    resolveAgentByToken(tok); // caches under the current generation
    // Corrupt token_hash WITHOUT bumping the generation (simulating a raw write).
    getDb().prepare("UPDATE agents SET token_hash = ? WHERE name = ?").run("$2b$10$corruptedhashvalue", "erin");
    // A cache hit returns the identity even though bcrypt would now fail.
    expect(resolveAgentByToken(tok)).toEqual({ name: "erin", capabilities: [] });
    // Once the generation moves, the cache entry is dead → re-verify → deny.
    bumpAuthGeneration();
    expect(resolveAgentByToken(tok)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("ADR-0003 C — invalidation per mutation path", () => {
  it("REVOKE-TRAP: a revoked token is denied on the next call (token_hash retained)", () => {
    const tok = reg("frank");
    expect(resolveAgentByToken(tok)).not.toBeNull(); // caches
    revokeAgentToken("frank");
    // token_hash is preserved for forensics → still bcrypt-matches — but denied.
    expect(getAgentAuthData("frank")!.token_hash).toBeTruthy();
    expect(resolveAgentByToken(tok)).toBeNull();
  });

  it("ROTATE (unmanaged): old token dies, new token works", () => {
    const oldTok = reg("grace");
    resolveAgentByToken(oldTok); // caches old
    const { newPlaintextToken } = rotateAgentToken("grace", getAgentAuthData("grace")!.token_hash!);
    expect(resolveAgentByToken(oldTok)).toBeNull();
    expect(resolveAgentByToken(newPlaintextToken)).toEqual({ name: "grace", capabilities: [] });
  });

  it("ROTATE (admin): old token dies, new works", () => {
    const oldTok = reg("heidi");
    resolveAgentByToken(oldTok);
    const { newPlaintextToken } = rotateAgentTokenAdmin("heidi");
    expect(resolveAgentByToken(oldTok)).toBeNull();
    expect(resolveAgentByToken(newPlaintextToken)).not.toBeNull();
  });

  it("MANAGED GRACE: both tokens work during grace; only the new token after sweep", () => {
    const oldTok = reg("ivan", [], true);
    const { newPlaintextToken } = rotateAgentToken("ivan", getAgentAuthData("ivan")!.token_hash!, {
      graceSeconds: 3600,
    });
    // Both digests are indexed + both authenticate during the grace window.
    const row = getAgentAuthData("ivan")!;
    expect(row.token_lookup).toBe(computeTokenLookup(newPlaintextToken));
    expect(row.previous_token_lookup).toBe(computeTokenLookup(oldTok));
    expect(resolveAgentByToken(oldTok)).not.toBeNull();
    expect(resolveAgentByToken(newPlaintextToken)).not.toBeNull();
    // Force the grace window into the past, then sweep.
    getDb()
      .prepare("UPDATE agents SET rotation_grace_expires_at = ? WHERE name = ?")
      .run(new Date(Date.now() - 1000).toISOString(), "ivan");
    sweepExpiredRotationGrace();
    expect(resolveAgentByToken(oldTok)).toBeNull(); // old token retired
    expect(resolveAgentByToken(newPlaintextToken)).not.toBeNull();
  });

  it("UNREGISTER: the token no longer resolves", () => {
    const tok = reg("judy");
    resolveAgentByToken(tok);
    unregisterAgent("judy");
    expect(resolveAgentByToken(tok)).toBeNull();
  });

  it("CAPS CHANGE: a cached verdict refreshes to the new capabilities", () => {
    const tok = reg("mallory", ["tasks"]);
    expect(resolveAgentByToken(tok)!.capabilities).toEqual(["tasks"]);
    expandAgentCapabilities("mallory", ["tasks", "admin"]); // superset (expand-only)
    expect(resolveAgentByToken(tok)!.capabilities.sort()).toEqual(["admin", "tasks"]);
  });

  it("NON-INVALIDATING (mark offline): the cached verdict SURVIVES", () => {
    const tok = reg("niaj");
    const sid = getAgentAuthData("niaj")!.session_id!;
    const genBefore = getAuthGeneration();
    resolveAgentByToken(tok);
    markAgentOffline("niaj", sid);
    expect(getAuthGeneration()).toBe(genBefore); // no bump
    expect(resolveAgentByToken(tok)).toEqual({ name: "niaj", capabilities: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("ADR-0003 D — migration NULL fallback + self-heal (no lockout)", () => {
  it("a NULL-token_lookup agent still authenticates (O(N) fallback) + self-heals", () => {
    const tok = reg("olivia");
    // Simulate a legacy pre-migration row: clear the digest columns.
    getDb().prepare("UPDATE agents SET token_lookup = NULL, previous_token_lookup = NULL WHERE name = ?").run("olivia");
    authCacheClear();
    expect(getAgentAuthData("olivia")!.token_lookup).toBeNull();

    // Fallback still authenticates — zero lockout.
    expect(resolveAgentByToken(tok)).toEqual({ name: "olivia", capabilities: [] });
    // ...and lazily self-heals the digest so the next call is O(1).
    expect(getAgentAuthData("olivia")!.token_lookup).toBe(computeTokenLookup(tok));
  });

  it("findAgentRowByToken feeds both call sites (identifies a revoked row too)", () => {
    const tok = reg("peggy");
    revokeAgentToken("peggy");
    const found = findAgentRowByToken(tok);
    // Identification still works (for checkToken's revoked reporting), even
    // though resolveAgentByToken (the caller path) denies it.
    expect(found?.row.name).toBe("peggy");
    expect(found?.row.auth_state).toBe("revoked");
    expect(resolveAgentByToken(tok)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("ADR-0003 E — verified-token cache unit", () => {
  it("generation mismatch → miss", () => {
    authCacheSet("d1", { name: "x", capabilities: [] }, 5, Date.now() + 10_000);
    expect(authCacheGet("d1", 5)).not.toBeNull();
    expect(authCacheGet("d1", 6)).toBeNull(); // stale generation
  });

  it("TTL expiry → miss", () => {
    const now = 1_000_000;
    authCacheSet("d2", { name: "y", capabilities: [] }, 1, now + 5000);
    expect(authCacheGet("d2", 1, now + 4999)).not.toBeNull();
    expect(authCacheGet("d2", 1, now + 5000)).toBeNull(); // at/after hardExpiry
  });

  it("LRU eviction bounds the cache", () => {
    for (let i = 0; i < AUTH_CACHE_MAX_ENTRIES + 50; i++) {
      authCacheSet("k" + i, { name: "a", capabilities: [] }, 1, Date.now() + 10_000);
    }
    expect(authCacheSize()).toBe(AUTH_CACHE_MAX_ENTRIES);
    expect(authCacheGet("k0", 1)).toBeNull(); // oldest evicted
    expect(authCacheGet("k" + (AUTH_CACHE_MAX_ENTRIES + 49), 1)).not.toBeNull(); // newest kept
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("ADR-0003 F — adversarial drift guard (test the guard, not just the code)", () => {
  const dbSource = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/db.ts"),
    "utf-8",
  );

  it("real src/db.ts passes — every token/auth mutator bumps the generation", () => {
    expect(findAuthGenViolations(dbSource, "db.ts")).toEqual([]);
  });

  it("NEGATIVE FIXTURE: the guard FLAGS a mutator that omits the bump", () => {
    const bad = `
      export function silentlyRevoke(name: string): void {
        getDb().prepare("UPDATE agents SET auth_state = 'revoked' WHERE name = ?").run(name);
      }
      export function silentlyDelete(name: string): void {
        getDb().prepare("DELETE FROM agents WHERE name = ?").run(name);
      }`;
    const v = findAuthGenViolations(bad, "bad.ts").map((x: { name: string }) => x.name);
    expect(v).toContain("silentlyRevoke");
    expect(v).toContain("silentlyDelete");
  });

  it("a mutator WITH the bump passes; a non-token UPDATE is not flagged", () => {
    // #151 round 4: the guard now resolves a bump to a real top-level function
    // declaration in the file under analysis, so this fixture must declare it.
    // A free-floating name is refused by design — round 3 trusted unresolved
    // names by spelling, which is how an unrelated import passed the guard.
    const good = `
      export function bumpAuthGeneration(): void {}
      export function properRotate(name: string): void {
        getDb().prepare("UPDATE agents SET token_hash = ? WHERE name = ?").run("h", name);
        bumpAuthGeneration();
      }
      export function touchLastSeen(name: string): void {
        getDb().prepare("UPDATE agents SET last_seen = ? WHERE name = ?").run("t", name);
      }`;
    expect(findAuthGenViolations(good, "good.ts")).toEqual([]);
  });

  // codex ADR-0003 forward-hardening: the two synthetic bypasses codex
  // constructed against the declaration-only / name-pattern-exemption v1.
  it("EVASION 1: a validity-changing mutator NAMED migrateSchemaTo* does NOT evade (explicit allowlist)", () => {
    const evasion = `
      export function migrateSchemaToEvil(name: string): void {
        getDb().prepare("UPDATE agents SET token_hash = ? WHERE name = ?").run("x", name);
      }`;
    const v = findAuthGenViolations(evasion, "ev.ts").map((x: { name: string }) => x.name);
    expect(v).toContain("migrateSchemaToEvil");
    // ...while the genuinely init-only, explicitly-allowlisted migration stays exempt.
    const allowed = `
      function migrateSchemaToV2_1(db: any): void {
        db.prepare("UPDATE agents SET auth_state = 'legacy_bootstrap' WHERE token_hash IS NULL").run();
      }`;
    expect(findAuthGenViolations(allowed, "mig.ts")).toEqual([]);
  });

  it("EVASION 2: arrow-function + function-expression + method mutators do NOT evade", () => {
    const evasion = `
      export const arrowRevoke = (name: string): void => {
        getDb().prepare("UPDATE agents SET auth_state = 'revoked' WHERE name = ?").run(name);
      };
      const exprDelete = function (name: string) {
        getDb().prepare("DELETE FROM agents WHERE name = ?").run(name);
      };
      class Store {
        methodRotate(name: string): void {
          getDb().prepare("UPDATE agents SET token_hash = ? WHERE name = ?").run("h", name);
        }
      }`;
    const v = findAuthGenViolations(evasion, "ev2.ts").map((x: { name: string }) => x.name);
    expect(v).toContain("arrowRevoke");
    expect(v).toContain("exprDelete");
    expect(v).toContain("methodRotate");
  });

  // ── the-fixer, 2026-08-11: hoisted-SQL under-detection (#57) ───────────────
  // The trigger side of the predicate reads ONE function unit's body text, so
  // SQL hoisted to module scope is invisible to it and the hardened must-bump
  // side never runs. Measured LATENT at 0294854 (zero module-scope validity SQL
  // in src/db.ts) — the trigger is a routine readability refactor, not an
  // attack. Direction of failure is UNDER-detection: no bump is ever demanded.
  it("HOISTED SQL: a module-scope validity-SQL constant does NOT evade the trigger", () => {
    const evasion = `
      export function bumpAuthGeneration(): void {}
      const REVOKE_SQL =
        "UPDATE agents SET token_hash = NULL, auth_state = 'revoked' WHERE name = ?";
      const PURGE_SQL = \`DELETE FROM agents WHERE name = ?\`;
      export function hoistedRevoke(name: string): void {
        getDb().prepare(REVOKE_SQL).run(name);
      }
      export function hoistedPurge(name: string): void {
        getDb().prepare(PURGE_SQL).run(name);
      }
      class Store {
        methodRevoke(name: string): void { getDb().prepare(REVOKE_SQL).run(name); }
      }`;
    const v = findAuthGenViolations(evasion, "hoist.ts").map((x: { name: string }) => x.name);
    expect(v).toContain("hoistedRevoke");  // V1 string const
    expect(v).toContain("hoistedPurge");   // V2/V4 template const + DELETE
    expect(v).toContain("methodRevoke");   // V3 class method
  });

  // ATTRIBUTION. A shared module-scope const must blame the unit that skipped
  // the bump and NOT the one that made it — "attribute the SQL to a unit", not
  // "the file contains SQL somewhere".
  it("HOISTED SQL: a shared constant blames only the unit that skipped the bump", () => {
    const shared = `
      export function bumpAuthGeneration(): void {}
      const SQL = "UPDATE agents SET token_hash = NULL WHERE name = ?";
      export function goodUser(name: string): void { getDb().prepare(SQL).run(name); bumpAuthGeneration(); }
      export function badUser(name: string): void  { getDb().prepare(SQL).run(name); }`;
    const s = findAuthGenViolations(shared, "shared.ts").map((x: { name: string }) => x.name);
    expect(s).toContain("badUser");        // V9: the guilty unit
    expect(s).not.toContain("goodUser");   // V9: and ONLY the guilty unit
  });

  // THE REGRESSION BAR — must never go red. A whole-file scan that flags every
  // non-bumping unit would satisfy the two tests above and break this one, which
  // is a louder guard rather than a more correct one.
  it("HOISTED SQL: the fix must not over-flag (bump present / benign column / unused const)", () => {
    const benign = `
      export function bumpAuthGeneration(): void {}
      const ROTATE_SQL = "UPDATE agents SET token_hash = ? WHERE name = ?";
      const TOUCH_SQL  = "UPDATE agents SET last_seen = ? WHERE name = ?";
      const UNUSED_SQL = "UPDATE agents SET token_hash = NULL WHERE name = ?";
      export function properRotate(name: string): void {          // V7: bumps
        getDb().prepare(ROTATE_SQL).run("h", name);
        bumpAuthGeneration();
      }
      export function touchLastSeen(name: string): void {         // V8: not sensitive
        getDb().prepare(TOUCH_SQL).run("t", name);
      }`;
    // V7 + V8 + V10 (UNUSED_SQL names no unit — nothing may be invented).
    expect(findAuthGenViolations(benign, "benign.ts")).toEqual([]);
  });

  // ── codex #192 + victra + the-fixer (Addenda 1+2): paste-ready bars ─────────
  // The indirection axis (depth) and the kind axis (object/array/property) plus
  // the shadow/let over-detection bars. The resolver is BINDING-correct — it
  // reuses guard-ast's resolveName — so shadows stay green STRUCTURALLY, not by a
  // name patrol. Proven-to-bite on the targets and stay-green on the twins is
  // measured in the same commit (see the guard's PR notes).

  it("HOISTED SQL: alias chains resolve transitively, and cycles terminate", () => {
    const chain = `
      export function bumpAuthGeneration(): void {}
      const AUTH_SQL = "UPDATE agents SET token_hash = NULL WHERE name = ?";
      const REVOKE_SQL = AUTH_SQL;
      const AGAIN_SQL = REVOKE_SQL;
      export function oneHop(n: string): void { getDb().prepare(REVOKE_SQL).run(n); }
      export function twoHop(n: string): void { getDb().prepare(AGAIN_SQL).run(n); }`;
    const c = findAuthGenViolations(chain, "chain.ts").map((x: { name: string }) => x.name);
    expect(c).toContain("oneHop");
    expect(c).toContain("twoHop");

    // Cycles must not hang or throw — the assertion is that this RETURNS.
    const cyclic = `
      export function bumpAuthGeneration(): void {}
      const A: string = B;
      const B: string = A;
      export function cyc(n: string): void { getDb().prepare(A).run(n); }`;
    expect(() => findAuthGenViolations(cyclic, "cyc.ts")).not.toThrow();
  });

  // GREEN TODAY — regression bar. Resolve by BINDING, not name (ruling 2).
  it("HOISTED SQL: a SHADOWED name must not be attributed to the module constant", () => {
    const shadowed = `
      export function bumpAuthGeneration(): void {}
      const REVOKE_SQL = "UPDATE agents SET token_hash = NULL WHERE name = ?";
      export function localShadow(n: string): void {
        const REVOKE_SQL = "SELECT 1";
        getDb().prepare(REVOKE_SQL).run(n);
      }
      export function paramShadow(REVOKE_SQL: string, n: string): void {
        getDb().prepare(REVOKE_SQL).run(n);
      }`;
    expect(findAuthGenViolations(shadowed, "shadow.ts")).toEqual([]);
  });

  it("HOISTED SQL: object-property and array-element constants are resolved (ADR-0003 ruling 4)", () => {
    const kinds = `
      export function bumpAuthGeneration(): void {}
      const Q = { revoke: "UPDATE agents SET token_hash = NULL WHERE name = ?" };
      const NESTED = { sql: { purge: "DELETE FROM agents WHERE name = ?" } };
      const LIST = ["UPDATE agents SET auth_state = 'revoked' WHERE name = ?"];
      const ALIASED = Q.revoke;
      export function viaProp(n: string): void   { getDb().prepare(Q.revoke).run(n); }
      export function viaNested(n: string): void { getDb().prepare(NESTED.sql.purge).run(n); }
      export function viaIndex(n: string): void  { getDb().prepare(LIST[0]).run(n); }
      export function viaAlias(n: string): void  { getDb().prepare(ALIASED).run(n); }`;
    const v = findAuthGenViolations(kinds, "kinds.ts").map((x: { name: string }) => x.name);
    expect(v).toEqual(expect.arrayContaining(["viaProp", "viaNested", "viaIndex", "viaAlias"]));
  });

  // The over-detection twins for the kind axis. VACUOUSLY green before the
  // resolver landed (nothing resolved) — they only start testing anything now
  // that it exists: local shadow, benign column, and per-unit attribution.
  it("HOISTED SQL: property resolution must not over-flag (shadowing / benign column / attribution)", () => {
    const benign = `
      export function bumpAuthGeneration(): void {}
      const Q = { revoke: "UPDATE agents SET token_hash = NULL WHERE name = ?" };
      const T = { touch: "UPDATE agents SET last_seen = ? WHERE name = ?" };
      export function shadowed(n: string): void {
        const Q = { revoke: "SELECT 1" };      // local shadows the module object
        getDb().prepare(Q.revoke).run(n);
      }
      export function touchOnly(n: string): void { getDb().prepare(T.touch).run(n); }`;
    expect(findAuthGenViolations(benign, "benign2.ts")).toEqual([]);

    const siblings = `
      export function bumpAuthGeneration(): void {}
      const Q = {
        revoke: "UPDATE agents SET token_hash = NULL WHERE name = ?",
        purge: "DELETE FROM agents WHERE name = ?",
      };
      export function goodOne(n: string): void { getDb().prepare(Q.revoke).run(n); bumpAuthGeneration(); }
      export function badOne(n: string): void  { getDb().prepare(Q.purge).run(n); }`;
    const s = findAuthGenViolations(siblings, "sib.ts").map((x: { name: string }) => x.name);
    expect(s).toContain("badOne");
    expect(s).not.toContain("goodOne");
  });

  // Ruling 3 + "the message is part of the fix" — fail-closed, premise-style (B):
  // exit 2, its own diagnosis. Seam: findUnresolvableBindings + formatRefusal.
  it("HOISTED SQL: an unresolvable binding is REFUSED, and the refusal is actionable", () => {
    const loose = `
      export function bumpAuthGeneration(): void {}
      let REVOKE_SQL = "SELECT 1";
      REVOKE_SQL = "UPDATE agents SET token_hash = NULL WHERE name = ?";
      export function l2(n: string): void { getDb().prepare(REVOKE_SQL).run(n); }`;
    const refusals = findUnresolvableBindings(loose, "loose.ts");
    expect(refusals).toHaveLength(1);

    const msg = formatRefusal(refusals);
    expect(msg).toContain("REVOKE_SQL"); // NAMES the binding
    expect(msg).toMatch(/let|reassign/i); // says WHY it cannot be resolved
    expect(msg).toMatch(/const|inline/i); // says WHAT TO DO instead

    // The exit-1 violation scan stays clean for the same file: the let is handled
    // by the refusal path, not attributed as a mutation-without-bump.
    expect(findAuthGenViolations(loose, "loose.ts")).toEqual([]);
  });

  // ── codex #192 re-review: DESTRUCTURING axis (kind × binding-form) ──────────
  // Object/array destructuring is an ordinary property/array alias — resolveName
  // returns the BindingElement; the resolver must accept it or the SQL is unseen
  // (UNDER-detect). All forms measured.
  it("HOISTED SQL: object/array destructuring aliases are resolved (all forms)", () => {
    const forms = `
      export function bumpAuthGeneration(): void {}
      const QUERIES = { revoke: "UPDATE agents SET token_hash = NULL WHERE name = ?" };
      const { revoke: REVOKE_SQL } = QUERIES;                 // object, renamed
      const LIST = ["DELETE FROM agents WHERE name = ?"];
      const [PURGE_SQL] = LIST;                               // array element
      const NESTED = { sql: { drop: "UPDATE agents SET auth_state = 'revoked' WHERE name = ?" } };
      const { sql: { drop: DROP_SQL } } = NESTED;             // nested pattern
      const REST_SRC = { r: "UPDATE agents SET previous_token_hash = NULL WHERE name = ?" };
      const { ...REST } = REST_SRC;                           // rest
      const EMPTY: { d?: string } = {};
      const { d: DEF_SQL = "UPDATE agents SET recovery_token_hash = NULL WHERE name = ?" } = EMPTY; // default
      export function a(n: string): void { getDb().prepare(REVOKE_SQL).run(n); }
      export function b(n: string): void { getDb().prepare(PURGE_SQL).run(n); }
      export function c(n: string): void { getDb().prepare(DROP_SQL).run(n); }
      export function d(n: string): void { getDb().prepare(REST.r).run(n); }
      export function e(n: string): void { getDb().prepare(DEF_SQL).run(n); }`;
    const v = findAuthGenViolations(forms, "destr.ts").map((x: { name: string }) => x.name);
    expect(v).toEqual(expect.arrayContaining(["a", "b", "c", "d", "e"]));
  });

  // The destructuring over-detection twins — same three bars as the property axis.
  it("HOISTED SQL: destructuring must not over-flag (local shadow / benign column / attribution)", () => {
    const benign = `
      export function bumpAuthGeneration(): void {}
      const Q = { revoke: "UPDATE agents SET token_hash = NULL WHERE name = ?" };
      const T = { touch: "UPDATE agents SET last_seen = ? WHERE name = ?" };
      const { touch: TOUCH_SQL } = T;                         // benign column
      export function shadowed(n: string): void {
        const { revoke: X } = { revoke: "SELECT 1" };         // local destructure shadows nothing sensitive
        getDb().prepare(X).run(n);
      }
      export function touchOnly(n: string): void { getDb().prepare(TOUCH_SQL).run("t", n); }`;
    expect(findAuthGenViolations(benign, "dtwin.ts")).toEqual([]);

    const siblings = `
      export function bumpAuthGeneration(): void {}
      const Q = {
        revoke: "UPDATE agents SET token_hash = NULL WHERE name = ?",
        purge: "DELETE FROM agents WHERE name = ?",
      };
      const { revoke: A, purge: B } = Q;
      export function goodOne(n: string): void { getDb().prepare(A).run(n); bumpAuthGeneration(); }
      export function badOne(n: string): void  { getDb().prepare(B).run(n); }`;
    const s = findAuthGenViolations(siblings, "dsib.ts").map((x: { name: string }) => x.name);
    expect(s).toContain("badOne");
    expect(s).not.toContain("goodOne");

    // Soft (let/var) destructuring that reaches SQL is REFUSED, not read.
    const softDestr = `
      export function bumpAuthGeneration(): void {}
      export function applyAuthStateTransition(): void {}
      let { r: X } = { r: "SELECT 1" };
      X = "UPDATE agents SET token_hash = NULL WHERE name = ?";
      export function u(n: string): void { getDb().prepare(X).run(n); }`;
    expect(findUnresolvableBindings(softDestr, "softd.ts").map((x: { name: string }) => x.name)).toContain("X");
  });

  // ── DIRECTION-OF-FAILURE PIN (victra): the SHARED resolver's destructuring
  // limitation is SAFE on the must-CALL side because that side default-DENIES.
  // A mutator that DOES bump via a destructured alias is OVER-flagged (loud false
  // build failure), never passed clean. This pins the safe direction so a future
  // refactor cannot silently flip it into a missed-hole.
  it("call side over-flags a mutator that bumps via a destructured alias (safe direction)", () => {
    const destructuredBump = `
      export function bumpAuthGeneration(): void {}
      const src = { bumpAuthGeneration: () => {} };
      const { bumpAuthGeneration: bump } = src;
      export function m(n: string): void {
        getDb().prepare("UPDATE agents SET token_hash = NULL WHERE name = ?").run(n);
        bump();
      }`;
    // OVER-flagged (the required call is not credited), NOT a false clean.
    expect(findAuthGenViolations(destructuredBump, "cb.ts").map((x: { name: string }) => x.name)).toContain("m");
    // Control: the same mutator bumping via the DIRECT call is clean.
    const directBump = `
      export function bumpAuthGeneration(): void {}
      export function m(n: string): void {
        getDb().prepare("UPDATE agents SET token_hash = NULL WHERE name = ?").run(n);
        bumpAuthGeneration();
      }`;
    expect(findAuthGenViolations(directBump, "cb2.ts")).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("ADR-0003 G — fold + scoped refusal at prepare()/exec() (#59, issue #193)", () => {
  const H = `export function bumpAuthGeneration(): void {}\nexport function applyAuthStateTransition(): void {}\n`;
  const flags = (src: string) => findAuthGenViolations(src, "t.ts").map((x: { name: string }) => x.name);
  const refuses = (src: string) => findUnresolvableBindings(src, "t.ts").map((x: { name: string }) => x.name);

  // FOLD — the acceptance bar is the SPLIT POINT, not the presence of concatenation
  // (victra + the-fixer): for each protected column, a split INSIDE the column name
  // AND a split inside a SQL keyword must flag. A clean-boundary-only set would
  // certify the very accident this fix removes.
  for (const col of ["token_hash", "auth_state", "token_lookup"]) {
    it(`FOLD: a concat split INSIDE the column "${col}" flags`, () => {
      const mid = Math.ceil(col.length / 2);
      const src = `${H}const A = "UPDATE agents SET ${col.slice(0, mid)}"; const B = "${col.slice(mid)} = NULL WHERE name = ?"; const Q = A + B;
        export function m(n: string): void { getDb().prepare(Q).run(n); }`;
      expect(flags(src)).toContain("m");
    });
  }
  it("FOLD: a concat split INSIDE the keyword UPDATE flags", () => {
    expect(flags(`${H}export function m(n: string): void { getDb().prepare("UPD" + "ATE agents SET token_hash = NULL WHERE name = ?").run(n); }`)).toContain("m");
  });
  it("FOLD: a concat split INSIDE the keyword DELETE flags", () => {
    expect(flags(`${H}export function m(n: string): void { getDb().prepare("DEL" + "ETE FROM agents WHERE name = ?").run(n); }`)).toContain("m");
  });
  // The real-file shape that had an UNEARNED green: revokeAgentToken splits between
  // "UPDATE agents " and "SET auth_state = ?, ...". No operand holds "UPDATE agents
  // SET"; only the fold reconstructs it. (The transition — removing the real bump
  // now FLAGS — is proven on the actual src/db.ts in the guard PR notes.)
  it("FOLD: the revokeAgentToken split shape flags without a bump", () => {
    expect(flags(`${H}export function revokeShape(n: string): void { getDb().prepare("UPDATE agents " + "SET auth_state = ?, revoked_at = ? WHERE name = ?").run("revoked", "t", n); }`)).toContain("revokeShape");
  });

  // EXHAUSTIVE PARTITION — a concat reaching a DB call folds OR refuses, never a
  // silent third: each refuse form is exit 2, never []. (import / fn-call / cycle /
  // non-literal operand.)
  it("REFUSE: a cross-module import reaching prepare() refuses, not silently clean", () => {
    const src = `${H}import { REVOKE } from "./sql.js"; const R = REVOKE;
      export function m(n: string): void { getDb().prepare(R).run(n); }`;
    expect(findAuthGenViolations(src, "t.ts")).toEqual([]); // not a provable violation ...
    expect(refuses(src)).toContain("m"); // ... but REFUSED, never silent
  });
  it("REFUSE: a function-call result reaching prepare() refuses", () => {
    expect(refuses(`${H}function mk(): string { return "x"; } const Q = mk();
      export function m(n: string): void { getDb().prepare(Q).run(n); }`)).toContain("m");
  });
  it("REFUSE: a reference cycle reaching prepare() terminates and refuses", () => {
    const src = `${H}const A: string = B; const B: string = A;
      export function m(n: string): void { getDb().prepare(A).run(n); }`;
    expect(() => findUnresolvableBindings(src, "t.ts")).not.toThrow();
    expect(refuses(src)).toContain("m");
  });
  it("REFUSE: a concat with a non-literal operand (no visible violation) refuses", () => {
    expect(refuses(`${H}export function m(sql: string, n: string): void { getDb().prepare("UPDATE agents SET " + sql).run(n); }`)).toContain("m");
  });

  // PRECEDENCE — PROOF BEATS UNCERTAINTY BEATS SILENCE.
  it("PRECEDENCE: a violation visible in a resolved operand FLAGS even when another operand is unresolvable", () => {
    const src = `${H}function mk(): string { return "y"; }
      export function m(n: string): void { getDb().prepare("UPDATE agents SET token_hash = NULL WHERE name = ?" + mk()).run(n); }`;
    expect(flags(src)).toContain("m"); // exit 1 wins
    expect(refuses(src)).not.toContain("m"); // NOT downgraded to exit 2
  });
  it("PRECEDENCE: an unresolvable operand with NO visible violation refuses (never silent)", () => {
    const src = `${H}function mk(): string { return "y"; }
      export function m(n: string): void { getDb().prepare("UPDATE agents SET " + mk()).run(n); }`;
    expect(findAuthGenViolations(src, "t.ts")).toEqual([]);
    expect(refuses(src)).toContain("m");
  });
  it("a unit that BUMPS is clean even with an unresolvable SQL arg (safe regardless)", () => {
    const src = `${H}function mk(): string { return "y"; }
      export function m(n: string): void { getDb().prepare(mk()).run(n); bumpAuthGeneration(); }`;
    expect(findAuthGenViolations(src, "t.ts")).toEqual([]);
    expect(findUnresolvableBindings(src, "t.ts")).toEqual([]);
  });

  // GREEN BAR — the whole safety argument for the scoping: the real file stays exit
  // 0 on BOTH axes, zero refusals and zero new flags.
  it("real src/db.ts: zero violations AND zero refusals (scoped refusal costs nothing on the real file)", () => {
    const dbSource = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/db.ts"), "utf-8");
    expect(findAuthGenViolations(dbSource, "db.ts")).toEqual([]);
    expect(findUnresolvableBindings(dbSource, "db.ts")).toEqual([]);
  });

  it("the refusal message names the reason and a remedy", () => {
    const src = `${H}import { REVOKE } from "./sql.js"; const R = REVOKE;
      export function m(n: string): void { getDb().prepare(R).run(n); }`;
    const msg = formatRefusal(findUnresolvableBindings(src, "t.ts"));
    expect(msg).toMatch(/import|function-call|cycle|non-literal|let|reassign/i); // WHY
    expect(msg).toMatch(/inline|const/i); // REMEDY
  });
});
