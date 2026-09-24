// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0036 S1 completion, step 2 — a dead anchor NEEDS RESUME; it is not garbage.
 *
 * Row 13 (planned reboot): after login every anchor is dead, so EVERY binding reads
 * needs-resume, and restoring one = open a window in that folder and resume that
 * conversation. The S1 listing told the operator to "Clear one with relay
 * release-binding <name>" instead: after a reboot that points Maxime at deleting
 * exactly the record he needs to restore from. A correct refusal that names the
 * wrong fix is the false-success family (victra's three-state ruling).
 *
 * `liveness` stays the raw anchor verdict (alive | dead | unverifiable), which S1
 * tests pin. `status` is DERIVED from it at read time, never stored (§2.2):
 * live | needs-resume | unverifiable.
 *
 * Harness copied from tests/adr-0036-s1-relay-fleet.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELAY_BIN = path.join(REPO_ROOT, "bin", "relay");

const TEST_ROOT = path.join(os.tmpdir(), `bot-relay-s1c-resume-${process.pid}`);
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

describe("S1 completion — a dead anchor reads needs-resume, and the remedy restores rather than deletes", () => {
  it("--json: a dead anchor keeps liveness=dead and gains status=needs-resume; a live one reads live", async () => {
    await seedBinding({ agentName: "resume-dead", conversationId: CONV_B, pid: DEAD_PID, startedAt: "Mon Sep 15 10:00:00 2026" });
    await seedBinding({ agentName: "resume-live", conversationId: CONV_A, pid: LIVE_PID, startedAt: await realStart(LIVE_PID) });
    const r = runFleet(["--json"]);
    expect(r.status, r.stderr).toBe(0);
    const rows = JSON.parse(r.stdout) as Array<Record<string, unknown>>;
    const dead = rows.find((x) => x.agent_name === "resume-dead")!;
    const live = rows.find((x) => x.agent_name === "resume-live")!;
    expect(dead.liveness).toBe("dead");
    expect(dead.status).toBe("needs-resume");
    expect(live.liveness).toBe("alive");
    expect(live.status).toBe("live");
  }, 30_000);

  it("the table shows needs-resume for the dead window", async () => {
    await seedBinding({ agentName: "resume-dead", conversationId: CONV_B, pid: DEAD_PID, startedAt: "Mon Sep 15 10:00:00 2026" });
    const r = runFleet();
    const line = r.stdout.split("\n").find((l) => l.includes("resume-dead")) ?? "";
    expect(line).toMatch(/needs-resume/);
  }, 30_000);

  it("the remedy says how to RESTORE (folder + resume of that conversation), not how to delete", async () => {
    await seedBinding({
      agentName: "resume-dead",
      conversationId: CONV_B,
      pid: DEAD_PID,
      startedAt: "Mon Sep 15 10:00:00 2026",
      cwd: "/tmp/resume-here",
    });
    const r = runFleet();
    expect(r.stdout).toMatch(/need[s]? resum/i);
    expect(r.stdout).toMatch(/--resume/);
    expect(r.stdout, "the old remedy pointed at deleting the record").not.toMatch(/Clear one with `relay release-binding/);
  }, 30_000);

  it("release-binding is still named, but only for a window you do NOT want back", async () => {
    await seedBinding({ agentName: "resume-dead", conversationId: CONV_B, pid: DEAD_PID, startedAt: "Mon Sep 15 10:00:00 2026" });
    const r = runFleet();
    const line = r.stdout.split("\n").find((l) => l.includes("release-binding")) ?? "";
    expect(line, "if it is named at all, it is qualified").toMatch(/not want|don't want|do not want/i);
  }, 30_000);

  it("a live-only fleet prints no resume advice (nothing to restore)", async () => {
    await seedBinding({ agentName: "resume-live", conversationId: CONV_A, pid: LIVE_PID, startedAt: await realStart(LIVE_PID) });
    const r = runFleet();
    expect(r.stdout).not.toMatch(/--resume/);
  }, 30_000);
});
