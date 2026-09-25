// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0036 S1 — `relay fleet`: the LIST half of "S1 records and lists".
 *
 * Victra's requirement (2026-09-16 04:04Z): the binding event must be visible in
 * `relay fleet`, so that a window becoming X is observable rather than silent.
 *
 * STATUS IS DERIVED, NEVER STORED. tests/adr-0036-s1-agent-bindings-schema.test.ts
 * forbids a `status` / `binding_status` / `needs_resume` / `is_live` column
 * precisely so the listing reads the LIVE anchor at read time (§2.2). This file
 * pins the other end of that rule: the verb must actually derive it.
 *
 * THE TRAP THIS FILE EXISTS TO CATCH — anchorLivenessVerdict takes an AGENTS-shaped
 * row (`{host_id, agent_pid, agent_pid_start}`, src/liveness.ts:442-451), but a
 * binding carries `window_pid` / `window_pid_start`. Hand it a binding row
 * unmapped and `agent_pid` is undefined, the :450 guard fires, and EVERY window
 * reads "unverifiable" — a column that is uniformly plausible and uniformly
 * meaningless. That failure is invisible by inspection: the output still looks
 * like a working listing. So the mapping is pinned directly, and a live window
 * must read `alive` while a provably dead anchor must read `dead`.
 *
 * S1 LISTS, IT DOES NOT ACT. No rebinding, no takeover, no mutation of any kind —
 * automatic rebind is S3-lite (rows 1/4/11). A read-only verb that wrote would be
 * a far worse defect than one that renders badly.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELAY_BIN = path.join(REPO_ROOT, "bin", "relay");

const TEST_ROOT = path.join(os.tmpdir(), `bot-relay-s1-fleet-${process.pid}`);
const TEST_DB_PATH = path.join(TEST_ROOT, "relay.db");
const HOME_DIR = path.join(TEST_ROOT, "home");

process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;

/** A pid that is live on this host, and one that provably is not. */
const LIVE_PID = process.pid;
const DEAD_PID = 2_147_483_646;

const CONV_A = "aaaaaaaa-0000-1111-2222-333333333333";
const CONV_B = "bbbbbbbb-0000-1111-2222-333333333333";

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runFleet(args: string[] = []): RunResult {
  const r = spawnSync("node", [RELAY_BIN, "fleet", ...args], {
    encoding: "utf-8",
    timeout: 20_000,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: HOME_DIR,
      RELAY_HOME: HOME_DIR,
      RELAY_DB_PATH: TEST_DB_PATH,
    },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** The real start-time token for a pid, so a seeded anchor is genuinely live. */
async function realStart(pid: number): Promise<string> {
  const { processStartedAt } = await import("../src/liveness.js");
  return processStartedAt(pid) ?? "";
}

async function seedSchema(): Promise<void> {
  process.env.RELAY_DB_PATH = TEST_DB_PATH;
  const { getDb, closeDb } = await import("../src/db.js");
  getDb();
  closeDb();
}

/** Write a binding through the SANCTIONED writer, never raw SQL. */
async function seedBinding(opts: {
  agentName: string | null;
  conversationId: string;
  pid: number;
  startedAt: string;
  boundVia?: string;
  cwd?: string | null;
}): Promise<void> {
  const Better = (await import("better-sqlite3")).default;
  const { upsertAgentBinding } = await import("../src/db.js");
  const { getOwnHostId } = await import("../src/liveness.js");
  const db = new Better(TEST_DB_PATH) as never;
  try {
    upsertAgentBinding(db, {
      hostId: getOwnHostId() ?? "test-host",
      windowPid: opts.pid,
      windowPidStart: opts.startedAt,
      agentName: opts.agentName,
      agentClass: null,
      conversationId: opts.conversationId,
      conversationTitle: null,
      cwd: opts.cwd ?? "/tmp/fleet-test",
      boundVia: opts.boundVia ?? "launch-intent",
    });
  } finally {
    (db as unknown as { close(): void }).close();
  }
}

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(HOME_DIR, { recursive: true });
  const { closeDb } = await import("../src/db.js");
  closeDb();
  process.env.RELAY_DB_PATH = TEST_DB_PATH;
  await seedSchema();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db.js");
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("ADR-0036 S1 — relay fleet lists what relay bind recorded", () => {
  it("shows a recorded binding: the name, the conversation and the window", async () => {
    await seedBinding({ agentName: "fleet-alpha", conversationId: CONV_A, pid: LIVE_PID, startedAt: await realStart(LIVE_PID) });

    const r = runFleet();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("fleet-alpha");
    expect(r.stdout).toContain(CONV_A);
    expect(r.stdout).toContain(String(LIVE_PID));
  }, 30_000);

  it("derives LIVENESS from the anchor — a live window reads alive, not unverifiable", async () => {
    await seedBinding({ agentName: "fleet-live", conversationId: CONV_A, pid: LIVE_PID, startedAt: await realStart(LIVE_PID) });

    const r = runFleet(["--json"]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const rows = JSON.parse(r.stdout);
    expect(Array.isArray(rows)).toBe(true);
    const row = rows.find((x: Record<string, unknown>) => x.agent_name === "fleet-live");
    expect(row, r.stdout).toBeTruthy();
    // The whole point: mapping window_pid → the agents-shaped anchor field. Unmapped,
    // this is "unverifiable" and the column silently means nothing.
    expect(row.liveness, "a live window anchor must read alive").toBe("alive");
  }, 30_000);

  it("a provably DEAD anchor reads dead — the stale binding is visible, not hidden", async () => {
    await seedBinding({ agentName: "fleet-dead", conversationId: CONV_B, pid: DEAD_PID, startedAt: "Mon Sep 15 10:00:00 2026" });

    const r = runFleet(["--json"]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const row = JSON.parse(r.stdout).find((x: Record<string, unknown>) => x.agent_name === "fleet-dead");
    expect(row, r.stdout).toBeTruthy();
    expect(row.liveness).toBe("dead");
  }, 30_000);

  it("an UNNAMED window is still listed — row 11: every window ends up on the relay", async () => {
    await seedBinding({ agentName: null, conversationId: CONV_A, pid: LIVE_PID, startedAt: await realStart(LIVE_PID) });

    const r = runFleet(["--json"]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const rows = JSON.parse(r.stdout);
    expect(rows.length, "an unnamed window must not be dropped from the listing").toBe(1);
    expect(rows[0].agent_name).toBeNull();
    expect(rows[0].conversation_id).toBe(CONV_A);
  }, 30_000);

  it("an EMPTY fleet says so plainly and still exits 0 — empty is not an error", async () => {
    const r = runFleet();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/no .*binding|nothing|empty/i);
  }, 30_000);

  it("--json on an empty fleet emits a parseable empty array, never a sentence", async () => {
    const r = runFleet(["--json"]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([]);
  }, 30_000);

  it("a v24-shaped DB (no agent_bindings) refuses LOUDLY and never pretends the fleet is empty", async () => {
    const Better = (await import("better-sqlite3")).default;
    const db = new Better(TEST_DB_PATH);
    db.exec("DROP TABLE IF EXISTS agent_bindings");
    db.prepare("UPDATE schema_info SET version = ?, last_migrated_at = ? WHERE id = 1").run(24, new Date().toISOString());
    db.close();

    const r = runFleet();
    // "0 windows" and "this DB cannot answer" are different facts. Reporting the
    // second as the first is the silence-as-health failure this arc exists to end.
    expect(r.status, "a DB that cannot answer must not exit 0").not.toBe(0);
    expect(r.stderr).toMatch(/schema not migrated/i);
  }, 30_000);

  it("--help goes to STDOUT and exits 0 (stream discipline: requested text IS the data)", async () => {
    const r = runFleet(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Usage: relay fleet/);
    expect(r.stderr).toBe("");
  }, 30_000);

  it("an unknown option fails with usage on STDERR, so a capture yields EMPTY", async () => {
    const r = runFleet(["--bogus"]);
    expect(r.status).not.toBe(0);
    expect(r.stdout, "usage on the error path must never poison a command substitution").toBe("");
    expect(r.stderr).toMatch(/Usage: relay fleet/);
  }, 30_000);

  /**
   * WIDENED after audit round 1 (codex-5-5): the previous version queried
   * agent_bindings and compared rows, which proves only that ONE TABLE is
   * unchanged — not the "writes nothing" claim in the name. A verb that touched
   * `agents`, `schema_info`, or an audit table would have passed it.
   *
   * The claim and the test now match: hash every byte of the database, including
   * the `-wal` and `-shm` sidecars, because under WAL a write lands in the
   * sidecar first and the main file can stay byte-identical for a while.
   */
  it("WRITES NOTHING: listing a fleet leaves every byte of the DB unchanged (S1 lists, never acts)", async () => {
    await seedBinding({ agentName: "fleet-ro", conversationId: CONV_A, pid: LIVE_PID, startedAt: await realStart(LIVE_PID) });

    const crypto = await import("node:crypto");
    /**
     * Hash of the DURABLE database — the main file.
     *
     * MEASURED, and the reason this is not "every file": opening a SQLite database
     * in WAL mode creates `-wal` and `-shm` even on a `readonly: true` connection.
     * Before `relay fleet` runs they are ABSENT; after, both exist, with the WAL at
     * e3b0c44298fc1c14... — the SHA-256 of the empty string, i.e. a zero-byte WAL.
     * The main file is byte-identical throughout (verified across both a plain and
     * a --json run).
     *
     * So hashing the sidecars tests SQLite's open path, not this verb's behaviour.
     * "Writes nothing" properly means NO DURABLE CHANGE to the database. Narrowed
     * to that claim deliberately — not because the wider bar was inconvenient, but
     * because it was measuring the wrong thing. If this ever needs widening again,
     * widen it to the durable content (tables, schema, pages), never to `-shm`.
     */
    const snapshot = (): string =>
      crypto.createHash("sha256").update(fs.readFileSync(TEST_DB_PATH)).digest("hex");

    const before = snapshot();
    const plain = runFleet();
    const json = runFleet(["--json"]);
    expect(plain.status, plain.stderr).toBe(0);
    expect(json.status, json.stderr).toBe(0);
    expect(snapshot(), "relay fleet must not durably write to a guarded DB").toBe(before);

    // And nothing moved inside it either: every table's contents, not just
    // agent_bindings, so a write to `agents` or `schema_info` could not hide.
    const Better = (await import("better-sqlite3")).default;
    const contents = (): string => {
      const db = new Better(TEST_DB_PATH, { readonly: true, fileMustExist: true });
      try {
        const tables = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all() as Array<{ name: string }>;
        return JSON.stringify(
          tables.map((t) => [t.name, db.prepare(`SELECT * FROM "${t.name}"`).all()]),
        );
      } finally {
        db.close();
      }
    };
    const after = contents();
    runFleet();
    expect(contents(), "no table anywhere may change").toBe(after);
  }, 30_000);
});
