// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0036 S3-lite — the bind/fleet DB-open probe checks the RECORDED SCHEMA
 * VERSION, not whether a table exists.
 *
 * Architect ruling 1 (written 15 Sep, delivered 23 Sep): a table-exists probe on
 * agent_bindings passes after a future column change and then breaks on WRITE.
 * Table-exists is not a version check. Every refusal case below therefore keeps
 * agent_bindings PRESENT, so the S1 probe (hasAgentBindingsTable) passes them —
 * that is the defect, and it is what makes each case discriminating.
 *
 * Victra ruling (23 Sep), all three parts pinned here:
 *   - SUPPORTED RANGE = option (c): MIN_BIND_SCHEMA_VERSION <= v <= MAX_SUPPORTED_SCHEMA.
 *   - THE GUARD SHIPS IN THE SAME COMMIT: a test that FAILS when
 *     CURRENT_SCHEMA_VERSION exceeds MAX_SUPPORTED_SCHEMA, so a migration cannot
 *     ship without a conscious compatibility decision. CI breaks, not a user's bind.
 *   - THREE DISTINCT REFUSAL STATES, each naming its REMEDY: no schema_info table,
 *     version below range, version above MAX. A refusal that points the operator at
 *     the wrong fix is the same family as a false success. "schema not migrated"
 *     stays the below-range phrase (three S1 tests pin it).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELAY_BIN = path.join(REPO_ROOT, "bin", "relay");

const TEST_ROOT = path.join(os.tmpdir(), `bot-relay-s3lite-probe-${process.pid}`);
const TEST_DB_PATH = path.join(TEST_ROOT, "relay.db");
const HOME_DIR = path.join(TEST_ROOT, "home");

process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;

const DETECTED = (await import("../src/liveness.js")).detectAgentProcess();
const ANCHOR_PID = DETECTED?.pid ?? process.pid;
const CONV = "33333333-3333-3333-3333-333333333333";

/** The remedy each state must name — and the ones it must NOT, so no state points at another's fix. */
const BELOW = /schema not migrated/i;
const ABOVE = /newer than this relay build supports/i;
const NO_INFO = /no schema_info table/i;

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function baseEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: HOME_DIR,
    RELAY_HOME: HOME_DIR,
    RELAY_DB_PATH: TEST_DB_PATH,
  };
}

function runBind(): RunResult {
  const r = spawnSync("node", [RELAY_BIN, "bind"], {
    encoding: "utf-8",
    timeout: 30_000,
    input: JSON.stringify({
      session_id: CONV,
      transcript_path: `${HOME_DIR}/.claude/projects/p/${CONV}.jsonl`,
      cwd: path.join(TEST_ROOT, "stdin-cwd"),
      hook_event_name: "SessionStart",
      source: "startup",
    }),
    env: { ...baseEnv(), CLAUDE_PID: String(ANCHOR_PID), RELAY_AGENT_NAME: "s3lite-probe-x" },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function runFleet(): RunResult {
  const r = spawnSync("node", [RELAY_BIN, "fleet"], { encoding: "utf-8", timeout: 20_000, env: baseEnv() });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

async function withRawDb<T>(fn: (db: import("better-sqlite3").Database) => T): Promise<T> {
  const Better = (await import("better-sqlite3")).default;
  const db = new Better(TEST_DB_PATH);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Record `version` WITHOUT touching agent_bindings — the table stays present. */
async function recordVersion(version: number): Promise<void> {
  await withRawDb((db) => {
    db.prepare("UPDATE schema_info SET version = ? WHERE id = 1").run(version);
  });
}

async function state(): Promise<{ version: number | null; bindingRows: number; hasBindings: boolean }> {
  return withRawDb((db) => {
    const hasInfo = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_info'").get();
    const hasBindings = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_bindings'").get();
    const v = hasInfo
      ? ((db.prepare("SELECT version FROM schema_info WHERE id = 1").get() as { version: number } | undefined)?.version ?? null)
      : null;
    const n = hasBindings ? (db.prepare("SELECT COUNT(*) AS c FROM agent_bindings").get() as { c: number }).c : 0;
    return { version: v, bindingRows: n, hasBindings };
  });
}

/**
 * One past the supported ceiling. Falls back to CURRENT_SCHEMA_VERSION only so the
 * VERB cases reach the verb before the constant exists: `undefined + 1` is NaN, and a
 * NaN version fails every case for a reason that has nothing to do with the verb
 * (a vacuous red). The missing export itself is pinned by the guard tests above.
 */
async function aboveMax(): Promise<number> {
  const { CURRENT_SCHEMA_VERSION, MAX_SUPPORTED_SCHEMA } = await import("../src/db.js");
  return ((MAX_SUPPORTED_SCHEMA as number | undefined) ?? CURRENT_SCHEMA_VERSION) + 1;
}

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.mkdirSync(path.join(TEST_ROOT, "stdin-cwd"), { recursive: true });
  const { getDb, closeDb } = await import("../src/db.js");
  closeDb();
  process.env.RELAY_DB_PATH = TEST_DB_PATH;
  getDb(); // full schema, incl. agent_bindings
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db.js");
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE GUARD — ships in the same commit as the range (victra ruling)
// ─────────────────────────────────────────────────────────────────────────────

describe("S3-lite schema range — the compatibility decision is mechanical, not remembered", () => {
  it("MAX_SUPPORTED_SCHEMA is not behind CURRENT_SCHEMA_VERSION (a migration shipped without a bind-compatibility decision)", async () => {
    const { CURRENT_SCHEMA_VERSION, MAX_SUPPORTED_SCHEMA } = await import("../src/db.js");
    expect(typeof MAX_SUPPORTED_SCHEMA, "MAX_SUPPORTED_SCHEMA must be exported").toBe("number");
    expect(
      CURRENT_SCHEMA_VERSION,
      "CURRENT_SCHEMA_VERSION moved past MAX_SUPPORTED_SCHEMA. Decide whether `relay bind` / `relay fleet` are " +
        "correct against the new schema, THEN raise MAX_SUPPORTED_SCHEMA in src/db.ts. Do not raise it blind.",
    ).toBeLessThanOrEqual(MAX_SUPPORTED_SCHEMA as number);
  });

  it("MAX_SUPPORTED_SCHEMA is not AHEAD of CURRENT_SCHEMA_VERSION (no claim of support for a schema that does not exist yet)", async () => {
    const { CURRENT_SCHEMA_VERSION, MAX_SUPPORTED_SCHEMA } = await import("../src/db.js");
    expect(MAX_SUPPORTED_SCHEMA as number).toBeLessThanOrEqual(CURRENT_SCHEMA_VERSION);
  });

  it("the floor is v25, the version agent_bindings arrived in", async () => {
    const { MIN_BIND_SCHEMA_VERSION } = await import("../src/db.js");
    expect(MIN_BIND_SCHEMA_VERSION).toBe(25);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. probeBindSchema (handle-taking, pure read) — three states, three remedies
// ─────────────────────────────────────────────────────────────────────────────

describe("probeBindSchema — reads the RECORDED version on the caller's handle", () => {
  it("in range → ok, with the version it read", async () => {
    const { probeBindSchema, CURRENT_SCHEMA_VERSION } = await import("../src/db.js");
    const r = await withRawDb((db) => probeBindSchema(db as never, TEST_DB_PATH));
    expect(r).toEqual({ ok: true, version: CURRENT_SCHEMA_VERSION });
  });

  it("below range WITH agent_bindings present → below_range (a table-exists probe would pass this)", async () => {
    await recordVersion(24);
    expect((await state()).hasBindings, "precondition: the table is present").toBe(true);
    const { probeBindSchema } = await import("../src/db.js");
    const r = await withRawDb((db) => probeBindSchema(db as never, TEST_DB_PATH));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.state).toBe("below_range");
    expect(!r.ok && r.version).toBe(24);
    expect(!r.ok && r.message).toMatch(BELOW);
    expect(!r.ok && r.message).not.toMatch(ABOVE);
  });

  it("above MAX → above_range, naming an UPGRADE as the remedy, never 'schema not migrated'", async () => {
    const { probeBindSchema, MAX_SUPPORTED_SCHEMA } = await import("../src/db.js");
    await recordVersion((MAX_SUPPORTED_SCHEMA as number) + 1);
    const r = await withRawDb((db) => probeBindSchema(db as never, TEST_DB_PATH));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.state).toBe("above_range");
    expect(!r.ok && r.message).toMatch(ABOVE);
    expect(!r.ok && r.message).toMatch(/upgrade|reinstall/i);
    expect(!r.ok && r.message, "pointing at a migration would send the operator to the wrong fix").not.toMatch(BELOW);
  });

  it("no schema_info table → no_schema_info (the query THROWS; the probe must classify, not crash)", async () => {
    await withRawDb((db) => db.exec("DROP TABLE schema_info"));
    const { probeBindSchema } = await import("../src/db.js");
    const r = await withRawDb((db) => probeBindSchema(db as never, TEST_DB_PATH));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.state).toBe("no_schema_info");
    expect(!r.ok && r.version).toBeNull();
    expect(!r.ok && r.message).toMatch(NO_INFO);
    expect(!r.ok && r.message, "names the path check as the remedy").toMatch(/RELAY_DB_PATH|--db-path|relay doctor/);
    expect(!r.ok && r.message).not.toMatch(BELOW);
    expect(!r.ok && r.message).not.toMatch(ABOVE);
  });

  it("schema_info present but its row missing → the same uninitialized state, not a crash", async () => {
    await withRawDb((db) => db.exec("DELETE FROM schema_info"));
    const { probeBindSchema } = await import("../src/db.js");
    const r = await withRawDb((db) => probeBindSchema(db as never, TEST_DB_PATH));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.state).toBe("no_schema_info");
  });

  it("the probe writes nothing", async () => {
    await recordVersion(24);
    const before = await state();
    const { probeBindSchema } = await import("../src/db.js");
    await withRawDb((db) => probeBindSchema(db as never, TEST_DB_PATH));
    expect(await state()).toEqual(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE SHIPPED VERBS — bind and fleet refuse on the version, table present
// ─────────────────────────────────────────────────────────────────────────────

describe("relay bind — refuses on the recorded version, not on table existence", () => {
  it("PRECONDITION: this fixture reaches the schema branch (anchor + host resolve) and binds in range", async () => {
    const { resolveWindowAnchor } = await import("../src/binding.js");
    const { getOwnHostId } = await import("../src/liveness.js");
    const a = resolveWindowAnchor({ claudePid: ANCHOR_PID, detected: DETECTED });
    expect(a.ok, `anchor did not resolve (${a.ok ? "" : a.reason})`).toBe(true);
    expect(getOwnHostId()).toBeTruthy();
    const r = runBind();
    expect(r.status, `in-range bind must succeed; stderr=${r.stderr}`).toBe(0);
    expect((await state()).bindingRows).toBe(1);
  }, 30_000);

  it("v24 recorded, agent_bindings PRESENT → BIND_FAILED 'schema not migrated', nothing written", async () => {
    await recordVersion(24);
    const r = runBind();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/BIND_FAILED/);
    expect(r.stderr).toMatch(BELOW);
    const s = await state();
    expect(s.bindingRows, "a refused bind must not write a binding").toBe(0);
    expect(s.version, "bind never migrates").toBe(24);
  }, 30_000);

  it("above MAX → BIND_FAILED naming an upgrade, nothing written", async () => {
    const v = await aboveMax();
    await recordVersion(v);
    const r = runBind();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/BIND_FAILED/);
    expect(r.stderr).toMatch(ABOVE);
    expect(r.stderr).not.toMatch(BELOW);
    const s = await state();
    expect(s.bindingRows).toBe(0);
    expect(s.version, "bind never touches the recorded version").toBe(v);
  }, 30_000);

  it("no schema_info table → BIND_FAILED naming the path check, nothing written", async () => {
    await withRawDb((db) => db.exec("DROP TABLE schema_info"));
    const r = runBind();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/BIND_FAILED/);
    expect(r.stderr).toMatch(NO_INFO);
    expect(r.stderr).not.toMatch(BELOW);
    expect((await state()).bindingRows).toBe(0);
  }, 30_000);
});

describe("relay fleet — 'cannot answer' is never reported as an empty fleet", () => {
  it("PRECONDITION: in range → exit 0", () => {
    const r = runFleet();
    expect(r.status, `stderr=${r.stderr}`).toBe(0);
  }, 30_000);

  it("v24 recorded, agent_bindings PRESENT → refuses 'schema not migrated'", async () => {
    await recordVersion(24);
    const r = runFleet();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(BELOW);
    expect(r.stdout, "a refusal must not leave a plausible empty list on stdout").toBe("");
  }, 30_000);

  it("above MAX → refuses naming an upgrade", async () => {
    await recordVersion(await aboveMax());
    const r = runFleet();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(ABOVE);
    expect(r.stderr).not.toMatch(BELOW);
    expect(r.stdout).toBe("");
  }, 30_000);

  it("no schema_info table → refuses naming the path check", async () => {
    await withRawDb((db) => db.exec("DROP TABLE schema_info"));
    const r = runFleet();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(NO_INFO);
    expect(r.stdout).toBe("");
  }, 30_000);
});
