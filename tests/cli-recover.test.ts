// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 4o — `relay recover` subcommand integration tests.
 *
 * Seeds a DB with a fake agent + capabilities + messages-to + tasks-to, then
 * invokes `node bin/relay recover ...` via spawnSync and asserts on exit
 * codes + DB state + audit_log entries.
 *
 * The subcommand is filesystem-gated; no HTTP interaction.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const RELAY_BIN = path.join(REPO_ROOT, "bin", "relay");

const TEST_ROOT = path.join(os.tmpdir(), "bot-relay-recover-test-" + process.pid);
const TEST_DB_PATH = path.join(TEST_ROOT, "relay.db");
const TEST_CONFIG_PATH = path.join(TEST_ROOT, "config.json");

process.env.RELAY_DB_PATH = TEST_DB_PATH;
process.env.RELAY_CONFIG_PATH = TEST_CONFIG_PATH;
// Bind test children to an unused port so the daemon-probe stays silent.
process.env.RELAY_HTTP_PORT = "54999";
delete process.env.RELAY_ALLOW_LEGACY;
delete process.env.RELAY_HTTP_SECRET;

function resetRoot() {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
}

async function seedDb(): Promise<void> {
  const { registerAgent, sendMessage, postTask } = await import("../src/db.js");
  registerAgent("victim", "builder", ["tasks", "spawn"]);
  registerAgent("sender", "tester", []);
  sendMessage("sender", "victim", "m1", "normal");
  sendMessage("sender", "victim", "m2", "high");
  sendMessage("sender", "victim", "m3", "normal");
  postTask("sender", "victim", "t1", "first task", "normal");
  postTask("sender", "victim", "t2", "second task", "high");
}

function runRecover(
  args: string[],
  extraEnv: Record<string, string | undefined> = {},
  input?: string
): { status: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RELAY_DB_PATH: TEST_DB_PATH,
    RELAY_CONFIG_PATH: TEST_CONFIG_PATH,
    RELAY_HTTP_PORT: process.env.RELAY_HTTP_PORT,
  };
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const r = spawnSync("node", [RELAY_BIN, "recover", ...args], {
    env,
    encoding: "utf-8",
    timeout: 5_000,
    input: input ?? "",
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

beforeEach(async () => {
  resetRoot();
  const { closeDb } = await import("../src/db.js");
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/db.js");
  closeDb();
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("v2.1 Phase 4o — relay recover CLI", () => {
  it("(1) happy path: --yes deletes agent + caps, preserves messages + tasks, writes audit entry", async () => {
    await seedDb();
    const { closeDb } = await import("../src/db.js");
    closeDb();

    const r = runRecover(["victim", "--yes"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Recovery complete for "victim"/);
    expect(r.stdout).toMatch(/register_agent/);

    // Re-open the DB and verify state.
    const { initializeDb, getDb } = await import("../src/db.js");
    await initializeDb();
    const db = getDb();
    const agentRow = db.prepare("SELECT name FROM agents WHERE name = ?").get("victim");
    expect(agentRow).toBeUndefined();
    const capRows = db
      .prepare("SELECT capability FROM agent_capabilities WHERE agent_name = ?")
      .all("victim");
    expect(capRows.length).toBe(0);
    const msgCount = (
      db.prepare("SELECT COUNT(*) AS c FROM messages WHERE to_agent = ?").get("victim") as {
        c: number;
      }
    ).c;
    expect(msgCount).toBe(3);
    const taskCount = (
      db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE to_agent = ?").get("victim") as {
        c: number;
      }
    ).c;
    expect(taskCount).toBe(2);
    const auditRow = db
      .prepare(
        "SELECT tool, agent_name, source FROM audit_log WHERE tool = 'recovery.cli' AND agent_name = ?"
      )
      .get("victim") as { tool: string; agent_name: string; source: string } | undefined;
    expect(auditRow).toBeDefined();
    expect(auditRow!.tool).toBe("recovery.cli");
    expect(auditRow!.source).toBe("cli");
    expect(auditRow!.agent_name).toBe("victim");
  });

  it("(2) --dry-run does not modify the DB", async () => {
    await seedDb();
    const { closeDb } = await import("../src/db.js");
    closeDb();

    const r = runRecover(["victim", "--dry-run"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/DRY RUN/);

    const { initializeDb, getDb } = await import("../src/db.js");
    await initializeDb();
    const db = getDb();
    const agentRow = db.prepare("SELECT name FROM agents WHERE name = ?").get("victim") as
      | { name: string }
      | undefined;
    expect(agentRow?.name).toBe("victim");
    const capRows = db
      .prepare("SELECT capability FROM agent_capabilities WHERE agent_name = ?")
      .all("victim");
    expect(capRows.length).toBe(2);
  });

  it("(3) --yes with no stdin does not hang (5s timeout harness fails otherwise)", async () => {
    await seedDb();
    const { closeDb } = await import("../src/db.js");
    closeDb();

    const started = Date.now();
    const r = runRecover(["victim", "--yes"]);
    const elapsed = Date.now() - started;
    expect(r.status).toBe(0);
    // Typical CLI startup is well under 2s; spawn timeout is 5s. If the
    // handler regressed to reading stdin under --yes, spawnSync would hit
    // the timeout (~5000ms).
    expect(elapsed).toBeLessThan(4500);
  });

  it("(4) missing agent: exit 0, no DB changes, friendly message", async () => {
    await seedDb();
    const { closeDb } = await import("../src/db.js");
    closeDb();

    const r = runRecover(["ghost", "--yes"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/not registered/);

    const { initializeDb, getDb } = await import("../src/db.js");
    await initializeDb();
    const db = getDb();
    const count = (db.prepare("SELECT COUNT(*) AS c FROM agents").get() as { c: number }).c;
    expect(count).toBe(2); // victim + sender unchanged
  });

  it("(5) --db-path pointing into a non-existent directory: exit 2 with clean error", () => {
    const badPath = path.join(os.tmpdir(), "no-such-dir-" + process.pid, "sub", "relay.db");
    const r = runRecover(["victim", "--yes", "--db-path", badPath]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/parent directory does not exist/);
  });

  it("(6) unknown flag: exit 1 with stderr mentioning the argument", () => {
    const r = runRecover(["victim", "--bogus"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Unknown argument/);
  });

  it("(7) --help: exit 0, prints Usage, leaves DB alone", async () => {
    await seedDb();
    const { closeDb } = await import("../src/db.js");
    closeDb();

    const r = runRecover(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Usage: relay recover/);

    const { initializeDb, getDb } = await import("../src/db.js");
    await initializeDb();
    const db = getDb();
    const count = (db.prepare("SELECT COUNT(*) AS c FROM agents").get() as { c: number }).c;
    expect(count).toBe(2);
  });

  it("(9) refuses to operate on a DB without bot-relay schema (audit LOW #2)", async () => {
    // Seed a DB at the test path with ONLY the `agents` table — no
    // agent_capabilities, no audit_log. That's not a bot-relay DB.
    const foreignDbPath = path.join(TEST_ROOT, "foreign.db");
    const Better = (await import("better-sqlite3")).default;
    const db = new Better(foreignDbPath);
    db.exec("CREATE TABLE agents (name TEXT PRIMARY KEY, note TEXT);");
    db.prepare("INSERT INTO agents (name, note) VALUES (?, ?)").run("victim", "from-elsewhere");
    db.close();

    const r = runRecover(["victim", "--yes", "--db-path", foreignDbPath]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/missing bot-relay-mcp schema/);

    // The foreign DB must remain untouched — no CREATE-IF-NOT-EXISTS leak.
    const probe = new Better(foreignDbPath, { readonly: true });
    const tables = probe
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    probe.close();
    expect(tables.map((t) => t.name).sort()).toEqual(["agents"]);
  });

  it("(8) audit_log entry carries operator username in params_summary", async () => {
    await seedDb();
    const { closeDb } = await import("../src/db.js");
    closeDb();

    const r = runRecover(["victim", "--yes"]);
    expect(r.status).toBe(0);

    const { initializeDb, getDb } = await import("../src/db.js");
    await initializeDb();
    const db = getDb();
    const row = db
      .prepare(
        "SELECT params_summary FROM audit_log WHERE tool = 'recovery.cli' AND agent_name = ?"
      )
      .get("victim") as { params_summary: string } | undefined;
    expect(row).toBeDefined();
    // Username detection via os.userInfo().username is best-effort; we assert
    // the `operator=` prefix appears and is non-empty, not a specific value
    // (CI environments have different usernames).
    expect(row!.params_summary).toMatch(/operator=\S+ target=victim/);
  });
});
