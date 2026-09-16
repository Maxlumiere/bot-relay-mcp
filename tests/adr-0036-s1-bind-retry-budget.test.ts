// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0036 S1 — the bind retry budget is a DEADLINE, not an attempt count.
 *
 * FOUND BY AUDIT (codex-5-5, PR #276 round 2). The writer bounded its ATTEMPTS
 * (6) and its OWN sleeps (~115ms) and documented that as the worst case. But
 * `relay bind` opened its handle with `busy_timeout = 5000`, so each failed
 * attempt could sit inside SQLite's own busy wait for a further 5s before the
 * JavaScript catch block ran — a real ceiling near 25-30s against a MEASURED 10s
 * SessionStart hook timeout (~/.claude/settings.json). Two clocks, one budget,
 * and only one of them was counted.
 *
 * WHY THE EXISTING SUITE MISSED IT, which is the point of this file: the
 * 8-process concurrency test asserts the OUTCOME (exactly one current row) and
 * never looks at the CLOCK. It passed on the broken code and would pass again at
 * 30 seconds. A test that proves a bound must MEASURE THE BOUND.
 *
 * SEEN FAILING FIRST: against the pre-fix writer, the held-lock case below takes
 * far longer than the budget (bounded only by 6 x 5s of SQLite busy waiting).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DB = path.join(REPO_ROOT, "dist", "db.js");

const TEST_ROOT = path.join(os.tmpdir(), `bot-relay-s1-budget-${process.pid}`);
const TEST_DB_PATH = path.join(TEST_ROOT, "relay.db");

/** In the repo so Node can resolve better-sqlite3; the DATABASE is what needs isolating. */
const LOCKER = path.join(REPO_ROOT, `.s1-budget-locker-${process.pid}.mjs`);

const HOST_ID = "budget-test-host";
const WINDOW_PID = 515151;
const WINDOW_PID_START = "Mon Sep 15 10:00:00 2026";
const CONV = "budget00-0000-1111-2222-333333333333";

process.env.RELAY_DB_PATH = TEST_DB_PATH;

/**
 * Holds a REAL write lock with BEGIN IMMEDIATE, announces "LOCKED" on stdout so
 * the parent never races the acquisition, holds, then rolls back. Nothing here is
 * simulated: this is the ordinary lock-contention path the concurrency test does
 * not cover.
 */
const LOCKER_SRC = `
const [dbPath, holdMs] = process.argv.slice(2);
const Better = (await import("better-sqlite3")).default;
const db = new Better(dbPath);
db.pragma("busy_timeout = 0");
db.exec("BEGIN IMMEDIATE");
db.prepare("UPDATE schema_info SET last_migrated_at = ? WHERE id = 1").run(new Date().toISOString());
process.stdout.write("LOCKED\\n");
const until = Date.now() + Number(holdMs);
while (Date.now() < until) {}
try { db.exec("ROLLBACK"); } catch {}
try { db.close(); } catch {}
`;

interface Locker {
  child: ReturnType<typeof spawn>;
  release: () => void;
}

/** Start the locker and RESOLVE ONLY once it confirms it holds the lock. */
function holdWriteLock(holdMs: number): Promise<Locker> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [LOCKER, TEST_DB_PATH, String(holdMs)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += String(d);
      if (out.includes("LOCKED")) {
        resolve({
          child,
          release: () => {
            try {
              child.kill("SIGKILL");
            } catch {
              /* already gone */
            }
          },
        });
      }
    });
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("close", (code) => {
      if (!out.includes("LOCKED")) reject(new Error(`locker died before locking: exit=${code} stderr=${err}`));
    });
  });
}

async function seedSchema(): Promise<void> {
  process.env.RELAY_DB_PATH = TEST_DB_PATH;
  const { getDb, closeDb } = await import("../src/db.js");
  getDb();
  closeDb();
}

/**
 * The bound, as LOCAL LITERALS rather than imports from db.ts.
 *
 * Deliberate: the red-first check for this file stashes src/db.ts, and an
 * imported constant then arrives `undefined`, turning `budget + slack` into NaN
 * and `toBeLessThan(NaN)` into an assertion that fails for EVERY input — including
 * a correct one. The test would "go red" while proving nothing. A bar must fail
 * for the reason its name claims, so the numbers live here.
 * Keep in step with src/db.ts.
 *
 * WHAT IS BEING ASSERTED, precisely: not a strict whole-operation deadline. The
 * deadline is checked BETWEEN attempts and `busy_timeout` is set per ATTEMPT, so
 * a statement can consume its own bounded wait after the last check and one
 * attempt may hold several. The honest ceiling is therefore
 *   BUDGET + (MAX_LOCKING_STATEMENTS * BUSY_CAP) = 3000 + 3*400 = 4200ms
 * where 3 is the longest write path (supersede UPDATE + INSERT + COMMIT; the
 * SELECT does not block under WAL). Asserting 4200 pins the real guarantee;
 * the previous `budget + 2000` merely ADMITTED the slack without naming it.
 */
const EXPECTED_BUDGET_MS = 3000;
const EXPECTED_BUSY_CAP_MS = 400;
const EXPECTED_MAX_LOCKING_STATEMENTS = 3;
const EXPECTED_WORST_CASE_MS = EXPECTED_BUDGET_MS + EXPECTED_MAX_LOCKING_STATEMENTS * EXPECTED_BUSY_CAP_MS;

/**
 * Opens the contended handle the way `relay bind` SHIPPED WHEN THE DEFECT
 * EXISTED: busy_timeout = 5000.
 *
 * This is the whole point of the fixture. With a small busy_timeout SQLite
 * returns SQLITE_BUSY almost immediately, the old attempt-counted loop burned
 * its six tries in ~85ms, and the red run showed no delay at all — the harness
 * could not express the failure it was built to guard. The ~25-30s ceiling only
 * appears when each failed attempt can sit in SQLite's own 5s busy wait, so the
 * fixture must reproduce that value, not the repaired one.
 *
 * The fixed writer OVERRIDES this per attempt from its remaining deadline; that
 * override is exactly the behaviour under test.
 */
async function openRawHandle(): Promise<import("../src/sqlite-compat.js").CompatDatabase> {
  const Better = (await import("better-sqlite3")).default;
  const db = new Better(TEST_DB_PATH) as unknown as import("../src/sqlite-compat.js").CompatDatabase;
  db.pragma("busy_timeout = 5000");
  return db;
}

const WRITE = {
  hostId: HOST_ID,
  windowPid: WINDOW_PID,
  windowPidStart: WINDOW_PID_START,
  agentName: "budget-agent",
  agentClass: null,
  conversationId: CONV,
  conversationTitle: null,
  cwd: "/tmp/budget",
  boundVia: "launch-intent",
};

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  fs.writeFileSync(LOCKER, LOCKER_SRC);
  const { closeDb } = await import("../src/db.js");
  closeDb();
  process.env.RELAY_DB_PATH = TEST_DB_PATH;
  await seedSchema();
  expect(fs.existsSync(DIST_DB), "dist/db.js missing — run npm run build first").toBe(true);
});

afterEach(async () => {
  const { closeDb } = await import("../src/db.js");
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.rmSync(LOCKER, { force: true });
});

describe("ADR-0036 S1 — a contended bind fails inside its budget, not the hook's", () => {
  it("a REAL held write lock makes bind fail in ~budget, NOT ~30s (the round-2 defect)", async () => {
    const { upsertAgentBinding } = await import("../src/db.js");
    const lock = await holdWriteLock(20_000); // far longer than the budget
    const db = await openRawHandle();

    const started = Date.now();
    let threw: unknown = null;
    try {
      upsertAgentBinding(db, WRITE);
    } catch (err) {
      threw = err;
    }
    const elapsed = Date.now() - started;

    lock.release();
    try {
      (db as unknown as { close(): void }).close();
    } catch {
      /* best effort */
    }

    expect(threw, "a bind against a held write lock must FAIL, not hang or silently succeed").toBeTruthy();

    // THE BOUND ITSELF — and an honest note about what this line proves.
    //
    // NOT RED-FIRST EVIDENCE. This fixture drives the read-then-write path, which
    // fails with an immediate SQLITE_BUSY (snapshot conflict, no busy wait), so
    // the PRE-FIX writer also finishes well inside this bound: only the message
    // assertion below goes red on old code. Anyone reading this test must not
    // infer that it ever demonstrated a long stall — it did not, and the feared
    // ~25-30s in-loop ceiling was shown to be unreachable through this writer.
    //
    // What it DOES pin: the published ceiling, so a future change that widens the
    // envelope (a bigger cap, another locking statement in the write path, a
    // deadline check removed) fails here.
    expect(
      elapsed,
      `took ${elapsed}ms — published ceiling is ${EXPECTED_WORST_CASE_MS}ms ` +
        `(budget ${EXPECTED_BUDGET_MS} + ${EXPECTED_MAX_LOCKING_STATEMENTS}x${EXPECTED_BUSY_CAP_MS} cap), ` +
        `hook timeout is 10000ms`,
    ).toBeLessThan(EXPECTED_WORST_CASE_MS);

    // And it must say WHY, with the figure, so an operator is not left guessing.
    const msg = threw instanceof Error ? threw.message : String(threw);
    expect(msg).toMatch(/deadline exceeded/i);
    expect(msg).toMatch(/\d+ms/);
  }, 60_000);

  it("an UNRELATED constraint violation throws on the FIRST failure, not after the budget", async () => {
    const { upsertAgentBinding } = await import("../src/db.js");
    const db = await openRawHandle();

    const started = Date.now();
    let threw: unknown = null;
    try {
      // conversation_id is NOT NULL: a real failure, never contention.
      upsertAgentBinding(db, { ...WRITE, conversationId: null as unknown as string });
    } catch (err) {
      threw = err;
    }
    const elapsed = Date.now() - started;
    try {
      (db as unknown as { close(): void }).close();
    } catch {
      /* best effort */
    }

    expect(threw).toBeTruthy();
    const msg = threw instanceof Error ? threw.message : String(threw);
    // It must surface as ITSELF, not be retried to exhaustion and relabelled as
    // contention — the classifier defect codex found alongside the budget one.
    expect(msg, `a NOT NULL violation must not be reported as a deadline: ${msg}`).not.toMatch(/deadline exceeded/i);
    expect(elapsed, `took ${elapsed}ms — a non-contention error must not be retried at all`).toBeLessThan(500);
  }, 30_000);

  it("the INNOCENT TWIN: an uncontended bind still succeeds, and quickly", async () => {
    // Without this, "always throw deadline-exceeded" would pass everything above.
    const { upsertAgentBinding } = await import("../src/db.js");
    const db = await openRawHandle();

    const started = Date.now();
    const result = upsertAgentBinding(db, WRITE);
    const elapsed = Date.now() - started;
    try {
      (db as unknown as { close(): void }).close();
    } catch {
      /* best effort */
    }

    expect(result.action).toBe("created");
    expect(elapsed, `an uncontended bind took ${elapsed}ms`).toBeLessThan(1000);
  }, 30_000);

  it("the budget is configurable and HONOURED: a tiny budget fails proportionally fast", async () => {
    // Pins that the deadline is actually derived from the budget rather than a
    // constant that happens to sit near it.
    const { upsertAgentBinding } = await import("../src/db.js");
    const lock = await holdWriteLock(20_000);
    const db = await openRawHandle();

    const started = Date.now();
    let threw: unknown = null;
    try {
      upsertAgentBinding(db, WRITE, { budgetMs: 400 });
    } catch (err) {
      threw = err;
    }
    const elapsed = Date.now() - started;

    lock.release();
    try {
      (db as unknown as { close(): void }).close();
    } catch {
      /* best effort */
    }

    expect(threw).toBeTruthy();
    expect(elapsed, `a 400ms budget took ${elapsed}ms`).toBeLessThan(2500);
  }, 60_000);
});
