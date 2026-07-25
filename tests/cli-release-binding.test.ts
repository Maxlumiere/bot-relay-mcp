// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0012 (Fork B) — `relay release-binding` integration + db-level tests.
 *
 * release-binding is the NON-DESTRUCTIVE operator remedy the dead-anchor
 * diagnostic names. It clears EXACTLY the binding (session_id + host_shell_pids +
 * the agent_pid/agent_pid_start anchor) and PRESERVES the identity (token, name,
 * capabilities, host_id) — unlike `relay recover`, which deletes the row and
 * frees the name. And it REFUSES on a live/unverifiable anchor: releasing a live
 * (esp. idle) agent's binding would strand it unwakeable, the exact silent-mute
 * this arc exists to kill.
 *
 * Two layers:
 *   A (host-independent): db.releaseAgentBinding preserves identity; and after a
 *     release the row reads STALE to the hook's LIVE-gate SQL — the sufficiency
 *     proof that a fresh SessionStart takes the register path and rebinds.
 *   B (CLI, exercises the SHIPPED dist/ per the #126 lesson): dead anchor →
 *     releases + preserves + audits + clean stdout; LIVE anchor → REFUSES and
 *     mutates NOTHING; cross-host → refuses; --override releases with a loud note.
 *     Gated on a resolvable same-host GUID (the gate is same-host by design).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { getOwnHostId, processStartedAt } from "../src/liveness.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const RELAY_BIN = path.join(REPO_ROOT, "bin", "relay");

const TEST_ROOT = path.join(os.tmpdir(), "bot-relay-release-binding-test-" + process.pid);
const TEST_DB_PATH = path.join(TEST_ROOT, "relay.db");
const TEST_CONFIG_PATH = path.join(TEST_ROOT, "config.json");

process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
process.env.RELAY_CONFIG_PATH = TEST_CONFIG_PATH;
process.env.RELAY_HTTP_PORT = "54998";
delete process.env.RELAY_ALLOW_LEGACY;
delete process.env.RELAY_HTTP_SECRET;

const OWN_HOST = getOwnHostId(); // real machine GUID; null on hosts without one
const OTHER_HOST = "release-binding-other-host-guid";
const LIVE_PID = process.pid; // the vitest process — alive throughout the child run
const LIVE_START = processStartedAt(LIVE_PID);
const DEAD_PID = 2_147_483_646;

function resetRoot() {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
}

function runRB(args: string[]): { status: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RELAY_DB_PATH: TEST_DB_PATH,
    RELAY_CONFIG_PATH: TEST_CONFIG_PATH,
    RELAY_HTTP_PORT: process.env.RELAY_HTTP_PORT,
  };
  const r = spawnSync("node", [RELAY_BIN, "release-binding", ...args], {
    env,
    encoding: "utf-8",
    timeout: 5_000,
    input: "",
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Register `stale` (+ a bystander) and give `stale` a full binding. */
async function seedBinding(opts: {
  pid: number | null;
  start: string | null;
  host: string | null;
}): Promise<void> {
  const { registerAgent, getDb } = await import("../src/db.js");
  registerAgent("stale", "builder", ["tasks", "spawn"]);
  registerAgent("bystander", "tester", ["review"]);
  getDb()
    .prepare(
      "UPDATE agents SET session_id = ?, host_shell_pids = ?, agent_pid = ?, agent_pid_start = ?, " +
        "host_id = ?, last_alive = ?, agent_status = 'online' WHERE name = ?"
    )
    .run("sess-abc", "[111,222]", opts.pid, opts.start, opts.host, new Date(0).toISOString(), "stale");
}

async function readRow(name = "stale"): Promise<Record<string, unknown> | undefined> {
  const { initializeDb, getDb } = await import("../src/db.js");
  await initializeDb();
  return getDb().prepare("SELECT * FROM agents WHERE name = ?").get(name) as
    | Record<string, unknown>
    | undefined;
}

/**
 * The binding + identity columns — the fields release-binding is responsible for.
 * Deliberately EXCLUDES presence-derived columns (agent_status, last_alive): any
 * DB OPEN re-derives those from last_seen age, so a whole-row compare would flag
 * a read-side effect that release-binding never touched. Comparing this projection
 * is the precise meaning of "mutates nothing".
 */
function binding(row: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!row) return row;
  const { session_id, host_shell_pids, agent_pid, agent_pid_start, token_hash, host_id, name, role, capabilities } =
    row;
  return { session_id, host_shell_pids, agent_pid, agent_pid_start, token_hash, host_id, name, role, capabilities };
}

async function readCaps(name = "stale"): Promise<string[]> {
  const { initializeDb, getDb } = await import("../src/db.js");
  await initializeDb();
  return (
    getDb()
      .prepare("SELECT capability FROM agent_capabilities WHERE agent_name = ? ORDER BY capability")
      .all(name) as { capability: string }[]
  ).map((r) => r.capability);
}

beforeEach(async () => {
  resetRoot();
  const { closeDb } = await import("../src/db.js");
  closeDb();
  // Re-assert OUR db path (a sibling file sharing the worker may have overwritten
  // it at module top); after closeDb so the next getDb() re-reads it.
  process.env.RELAY_DB_PATH = TEST_DB_PATH;
  process.env.RELAY_CONFIG_PATH = TEST_CONFIG_PATH;
});

afterEach(async () => {
  const { closeDb } = await import("../src/db.js");
  closeDb();
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("ADR-0012 Fork B — releaseAgentBinding (db-level, host-independent)", () => {
  it("NULLs the binding fields, PRESERVES token + name + capabilities + host_id", async () => {
    await seedBinding({ pid: DEAD_PID, start: "Mon Jan  1 00:00:00 2020", host: "host-X" });
    const { getDb, releaseAgentBinding } = await import("../src/db.js");

    const before = getDb().prepare("SELECT * FROM agents WHERE name = ?").get("stale") as Record<string, unknown>;
    expect(before.token_hash, "seed must have a token_hash").toBeTruthy();

    const res = releaseAgentBinding("stale");
    expect(res.changed).toBe(true);

    const after = getDb().prepare("SELECT * FROM agents WHERE name = ?").get("stale") as Record<string, unknown>;
    // Binding CLEARED:
    expect(after.session_id).toBeNull();
    expect(after.host_shell_pids).toBeNull();
    expect(after.agent_pid).toBeNull();
    expect(after.agent_pid_start).toBeNull();
    expect(after.agent_status).toBe("offline");
    // Identity PRESERVED:
    expect(after.name).toBe("stale");
    expect(after.token_hash).toBe(before.token_hash);
    expect(after.host_id).toBe("host-X");
    expect(after.role).toBe("builder");
    expect(await readCaps()).toEqual(["spawn", "tasks"]);
  });

  it("SUFFICIENCY: after release the row reads STALE to the hook's LIVE-gate SQL (→ SessionStart re-registers)", async () => {
    await seedBinding({ pid: DEAD_PID, start: null, host: OWN_HOST ?? "host-X" });
    const { initializeDb, getDb, releaseAgentBinding, closeDb } = await import("../src/db.js");
    await initializeDb();

    // The EXACT predicate check-relay.sh uses to decide skip-vs-register.
    const liveGate = (): string =>
      (
        getDb()
          .prepare(
            "SELECT CASE WHEN session_id IS NOT NULL AND session_id != '' " +
              "AND (julianday('now') - julianday(last_seen)) * 86400 < 120 " +
              "AND host_shell_pids IS NOT NULL AND host_shell_pids != '' " +
              "THEN 'LIVE' ELSE 'STALE' END AS v FROM agents WHERE name = ?"
          )
          .get("stale") as { v: string }
      ).v;

    // Freshen last_seen so ONLY the binding (not age) decides — proves the gate
    // flips because session_id/host_shell_pids were cleared, not because it aged out.
    getDb().prepare("UPDATE agents SET last_seen = ? WHERE name = ?").run(new Date().toISOString(), "stale");
    expect(liveGate(), "a freshly-bound row reads LIVE (skip)").toBe("LIVE");

    releaseAgentBinding("stale");
    getDb().prepare("UPDATE agents SET last_seen = ? WHERE name = ?").run(new Date().toISOString(), "stale");
    expect(liveGate(), "after release the row reads STALE → hook falls through to register").toBe("STALE");
    closeDb();
  });
});

describe.skipIf(!OWN_HOST)("ADR-0012 Fork B — relay release-binding CLI gate (shipped dist)", () => {
  it("DEAD anchor → releases, preserves identity, clean stdout, audit row", async () => {
    await seedBinding({ pid: DEAD_PID, start: null, host: OWN_HOST });
    const before = await readRow();
    (await import("../src/db.js")).closeDb();

    const r = runRB(["stale"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("stale\n"); // STDOUT = ONLY the clean released name
    expect(r.stderr).toMatch(/released the binding for "stale"/);

    const after = await readRow();
    expect(after!.session_id).toBeNull();
    expect(after!.agent_pid).toBeNull();
    expect(after!.host_shell_pids).toBeNull();
    expect(after!.token_hash).toBe(before!.token_hash); // identity preserved
    expect(await readCaps()).toEqual(["spawn", "tasks"]);

    const { initializeDb, getDb } = await import("../src/db.js");
    await initializeDb();
    const audit = getDb()
      .prepare("SELECT tool, source FROM audit_log WHERE tool = 'release_binding' AND agent_name = ?")
      .get("stale") as { tool: string; source: string } | undefined;
    expect(audit).toBeDefined();
    expect(audit!.source).toBe("cli");
    (await import("../src/db.js")).closeDb();
  });

  it("LIVE anchor → REFUSES (exit 3) and mutates NOTHING", async () => {
    await seedBinding({ pid: LIVE_PID, start: LIVE_START, host: OWN_HOST });
    const before = await readRow();
    (await import("../src/db.js")).closeDb();

    const r = runRB(["stale"]);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/REFUSING/);
    expect(r.stdout).toBe(""); // nothing on stdout — a capture yields empty, fails loud
    expect(r.stderr).toMatch(/live process|NOT observed dead/);

    const after = await readRow();
    expect(after!.session_id, "the binding must SURVIVE a refusal").toBe("sess-abc");
    expect(binding(after), "binding + identity unchanged after a refusal").toEqual(binding(before));
  });

  it("LIVE anchor + --override → releases with a loud OVERRIDING note", async () => {
    await seedBinding({ pid: LIVE_PID, start: LIVE_START, host: OWN_HOST });
    (await import("../src/db.js")).closeDb();

    const r = runRB(["stale", "--override"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/OVERRIDING/);
    expect(r.stdout).toBe("stale\n");

    const after = await readRow();
    expect(after!.session_id).toBeNull();
    expect(after!.agent_pid).toBeNull();
  });

  it("cross-host row → REFUSES (unverifiable) and mutates nothing", async () => {
    await seedBinding({ pid: LIVE_PID, start: LIVE_START, host: OTHER_HOST });
    const before = await readRow();
    (await import("../src/db.js")).closeDb();

    const r = runRB(["stale"]);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/TAKEOVER_LIVENESS_UNVERIFIABLE/);
    expect(r.stdout).toBe("");

    const after = await readRow();
    expect(after!.session_id, "the binding must SURVIVE a refusal").toBe("sess-abc");
    expect(binding(after), "binding + identity unchanged after a refusal").toEqual(binding(before));
  });

  it("--dry-run on a dead anchor → reports, changes nothing", async () => {
    await seedBinding({ pid: DEAD_PID, start: null, host: OWN_HOST });
    const before = await readRow();
    (await import("../src/db.js")).closeDb();

    const r = runRB(["stale", "--dry-run"]);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/dry-run/);
    expect(r.stdout).toBe(""); // dry-run prints no released-name to stdout

    const after = await readRow();
    expect(after!.session_id, "dry-run must not release the binding").toBe("sess-abc");
    expect(binding(after), "binding + identity unchanged after dry-run").toEqual(binding(before));
  });

  it("missing agent → exit 1, friendly stderr, empty stdout", async () => {
    await seedBinding({ pid: DEAD_PID, start: null, host: OWN_HOST });
    (await import("../src/db.js")).closeDb();

    const r = runRB(["ghost"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not registered/);
    expect(r.stdout).toBe("");
  });
});
