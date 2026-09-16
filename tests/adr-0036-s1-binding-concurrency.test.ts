// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0036 S1 — ONE CURRENT ROW PER WINDOW ANCHOR, under real concurrency.
 *
 * FOUND BY AUDIT (codex-5-5, PR #276 round 1), and it was a design defect, not a
 * detail: `upsertAgentBinding` read `getCurrentBinding()` OUTSIDE the transaction
 * and then decided insert-vs-supersede. SQLite serialises individual writes, not
 * a read-then-write decision spread across autocommit statements, and the anchor
 * index was plain rather than unique — so two concurrent binds could each observe
 * "no current row" and each INSERT. The outcome is the exact harm S1 exists to
 * remove: one physical window with two unsuperseded identities, and `relay fleet`
 * offering both as equally plausible.
 *
 * WHY THIS FILE HAD TO EXIST SEPARATELY. The sequential idempotence tests cannot
 * reach that interleaving — they call the writer one after another, so the read
 * always sees the previous write. A fixture that cannot express the failure is an
 * ABSENT test that reads green forever (CONTRIBUTING §3). This is the second
 * instance of that class in this slice, after the size-bound-not-time-bound hang,
 * which is why it is now a standing check rather than a coincidence.
 *
 * TWO PROCESSES, NOT TWO PROMISES. Separate OS processes with separate SQLite
 * connections are the only way to exercise this: anything in one process shares a
 * connection and a lock, and would pass against the broken code.
 *
 * SEEN FAILING FIRST: with src/db.ts stashed (no partial unique index, read
 * outside the transaction) this test reports MORE THAN ONE current row.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST_DB = path.join(REPO_ROOT, "dist", "db.js");

const TEST_ROOT = path.join(os.tmpdir(), `bot-relay-s1-conc-${process.pid}`);
const TEST_DB_PATH = path.join(TEST_ROOT, "relay.db");

/**
 * The runner lives INSIDE THE REPO, deliberately, while the database stays in
 * $TMPDIR. Node resolves a bare specifier (`better-sqlite3`) by walking up from
 * the importing FILE, so a runner under /var/folders/... finds no node_modules
 * and every child dies with ERR_MODULE_NOT_FOUND before reaching its try block —
 * empty stdout, exit 1, and a result that looks exactly like "zero rows written".
 * That is indistinguishable from the defect reproducing, which is why the first
 * red run here proved nothing.
 *
 * What needs isolating is the DATABASE, not the script. `.mjs` under a name vitest
 * does not collect, removed in afterEach.
 */
const RUNNER = path.join(REPO_ROOT, `.s1-conc-runner-${process.pid}.mjs`);

/** One fixed anchor: every child claims to be the SAME window. */
const HOST_ID = "concurrency-test-host";
const WINDOW_PID = 424242;
const WINDOW_PID_START = "Mon Sep 15 10:00:00 2026";

const CHILDREN = 8;

process.env.RELAY_DB_PATH = TEST_DB_PATH;

/**
 * Each child opens its OWN connection and calls the sanctioned writer once.
 * A shared future start time makes them collide on purpose — without it, process
 * startup jitter serialises them and the race never occurs.
 */
const RUNNER_SRC = `
const [dbPath, distUrl, conv, hostId, pid, pidStart, startAtMs] = process.argv.slice(2);
const Better = (await import("better-sqlite3")).default;
const { upsertAgentBinding } = await import(distUrl);
const db = new Better(dbPath);
db.pragma("busy_timeout = 5000");
while (Date.now() < Number(startAtMs)) { /* spin to the shared barrier */ }
try {
  const r = upsertAgentBinding(db, {
    hostId,
    windowPid: Number(pid),
    windowPidStart: pidStart,
    agentName: "conc-agent",
    agentClass: null,
    conversationId: conv,
    conversationTitle: null,
    cwd: "/tmp/conc",
    boundVia: "launch-intent",
  });
  process.stdout.write(JSON.stringify({ ok: true, action: r.action }));
  process.exit(0);
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, message: String(err && err.message || err) }));
  process.exit(3);
} finally {
  try { db.close(); } catch {}
}
`;

interface ChildOutcome {
  ok: boolean;
  action?: string;
  message?: string;
}

function runChild(conversationId: string, startAtMs: number): Promise<ChildOutcome> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        RUNNER,
        TEST_DB_PATH,
        pathToFileURL(DIST_DB).href,
        conversationId,
        HOST_ID,
        String(WINDOW_PID),
        WINDOW_PID_START,
        String(startAtMs),
      ],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] } as never,
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("error", (e) => {
      err += `spawn error: ${e.message}`;
    });
    child.on("close", (code) => {
      try {
        resolve(JSON.parse(out) as ChildOutcome);
      } catch {
        // A child that dies BEFORE its try block (a failed dynamic import of
        // dist/db.js, a missing native module) writes nothing to stdout and its
        // reason is only on stderr. Surfacing it here is the difference between
        // "the defect reproduced" and "the harness never ran" — which look
        // identical if stderr is discarded.
        resolve({
          ok: false,
          message: `child exit=${code} stdout=${JSON.stringify(out.slice(0, 200))} stderr=${JSON.stringify(err.slice(0, 400))}`,
        });
      }
    });
  });
}

async function currentRows(): Promise<Array<Record<string, unknown>>> {
  const Better = (await import("better-sqlite3")).default;
  const db = new Better(TEST_DB_PATH, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare("SELECT * FROM agent_bindings WHERE superseded_at IS NULL ORDER BY binding_id")
      .all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  fs.writeFileSync(RUNNER, RUNNER_SRC);
  const { closeDb } = await import("../src/db.js");
  closeDb();
  process.env.RELAY_DB_PATH = TEST_DB_PATH;
  const { getDb } = await import("../src/db.js");
  getDb(); // full schema incl. v25 agent_bindings + the partial unique index
  closeDb();
  expect(fs.existsSync(DIST_DB), "dist/db.js missing — run npm run build first").toBe(true);
});

afterEach(async () => {
  const { closeDb } = await import("../src/db.js");
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  // The runner sits in the repo so Node can resolve better-sqlite3; it must not
  // survive the test that created it.
  fs.rmSync(RUNNER, { force: true });
});

describe("ADR-0036 S1 — a window anchor holds exactly one current binding under concurrency", () => {
  it(`${CHILDREN} concurrent processes binding the SAME anchor leave exactly ONE current row`, async () => {
    const startAt = Date.now() + 400; // shared barrier, so they genuinely collide
    const outcomes = await Promise.all(
      Array.from({ length: CHILDREN }, (_, i) => runChild(`conv-${i}-0000-1111-2222-333333333333`, startAt)),
    );

    const rows = await currentRows();

    // THE INVARIANT. More than one means a window has two identities and the
    // fleet list can offer either — the S1 harm, returned.
    expect(rows.length, `outcomes: ${JSON.stringify(outcomes)}`).toBe(1);

    // And contention must be HANDLED, not merely survived: no child may fall over
    // with a raw constraint/busy error, because in production that child is a
    // SessionStart hook and its window would go unrecorded.
    const failed = outcomes.filter((o) => !o.ok);
    expect(failed, `children must not surface raw contention errors: ${JSON.stringify(failed)}`).toEqual([]);

    // Exactly one creates; every other must have refreshed or superseded.
    const created = outcomes.filter((o) => o.action === "created");
    expect(created.length, `exactly one child may create: ${JSON.stringify(outcomes)}`).toBe(1);
  }, 60_000);

  it("the survivor is a REAL row, not a partial one — the anchor and a conversation are intact", async () => {
    const startAt = Date.now() + 400;
    await Promise.all(
      Array.from({ length: CHILDREN }, (_, i) => runChild(`conv-${i}-0000-1111-2222-333333333333`, startAt)),
    );

    const rows = await currentRows();
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.host_id).toBe(HOST_ID);
    expect(row.window_pid).toBe(WINDOW_PID);
    expect(row.window_pid_start).toBe(WINDOW_PID_START);
    expect(typeof row.conversation_id).toBe("string");
    expect(String(row.conversation_id).length).toBeGreaterThan(0);
    expect(row.binding_id).toBeTruthy();
  }, 60_000);

  it("the losers are not lost: every superseded row points at its successor", async () => {
    const startAt = Date.now() + 400;
    await Promise.all(
      Array.from({ length: CHILDREN }, (_, i) => runChild(`conv-${i}-0000-1111-2222-333333333333`, startAt)),
    );

    const Better = (await import("better-sqlite3")).default;
    const db = new Better(TEST_DB_PATH, { readonly: true, fileMustExist: true });
    try {
      const superseded = db
        .prepare("SELECT binding_id, superseded_by, supersede_reason FROM agent_bindings WHERE superseded_at IS NOT NULL")
        .all() as Array<Record<string, unknown>>;
      // History must stay navigable — a superseded row with no successor is an
      // orphan, and the chain from any old row to the current one breaks.
      for (const r of superseded) {
        expect(r.superseded_by, `orphaned superseded row ${String(r.binding_id)}`).toBeTruthy();
      }
    } finally {
      db.close();
    }
  }, 60_000);
});
