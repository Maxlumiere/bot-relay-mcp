// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.8 — SIGHUP handler integration test.
 *
 * The test path must match the shipped path: this MUST
 * exercise the actual `installAutoUnregister` chain in the shipped
 * `dist/index.js` via a real OS signal. A mocked signal handler would
 * pass even if the SIGHUP listener was never registered.
 *
 * Test pattern:
 *  1. Fresh DB pre-populated with one agent row (name + session_id known).
 *  2. Spawn `node dist/index.js` in stdio mode pointed at the test DB
 *     with RELAY_AGENT_NAME set so `captureSessionId` finds the row.
 *  3. Wait for the child to come up + finish `installAutoUnregister`.
 *  4. Send the signal under test via `child.kill(signal)`.
 *  5. Wait for the child to exit.
 *  6. Read the DB and assert `signal_received_at` (epoch ms) +
 *     `signal_kind` (string) are populated correctly.
 *
 * Skipped on win32 — POSIX signals only.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const RELAY_BIN = path.join(REPO_ROOT, "dist", "index.js");

const SKIP_PLATFORM = process.platform === "win32";

let TEST_ROOT: string;
let TEST_DB_PATH: string;
let daemon: ChildProcess | null = null;

beforeEach(() => {
  TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bot-relay-v2-8-sighup-"));
  TEST_DB_PATH = path.join(TEST_ROOT, "relay.db");
});

afterEach(async () => {
  if (daemon && daemon.exitCode === null) {
    daemon.kill("SIGKILL");
    await new Promise<void>((r) => setTimeout(r, 100));
  }
  daemon = null;
  if (fs.existsSync(TEST_ROOT)) {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  }
});

/**
 * Pre-populate the test DB with one agent row. Uses the shipped
 * db.ts so the schema migration chain (incl. v2_11 columns) runs
 * once before the spawned daemon attaches. Mirrors what the SessionStart
 * hook would have done in a real spawn.
 */
async function seedAgent(name: string, sessionId: string): Promise<void> {
  // Run a one-shot node command that imports db.ts and writes the row.
  // We can't import the ESM directly in this test (vitest's runner +
  // dist/ side-by-side gets confusing), so shell out to the built bin
  // with a tiny --eval script that imports from dist/.
  const seedScript = `
    process.env.RELAY_DB_PATH = ${JSON.stringify(TEST_DB_PATH)};
    process.env.RELAY_CONFIG_PATH = ${JSON.stringify(path.join(TEST_ROOT, "config.json"))};
    (async () => {
      const dbMod = await import(${JSON.stringify(path.join(REPO_ROOT, "dist", "db.js"))});
      dbMod.initializeDb();
      const db = dbMod.getDb();
      const nowIso = new Date().toISOString();
      // crypto.randomUUID() produces a valid TEXT id; matches the
      // canonical insert at src/db.ts:registerAgent.
      const id = (await import('node:crypto')).randomUUID();
      db.prepare(
        "INSERT INTO agents (id, name, role, capabilities, last_seen, created_at, agent_status, session_id, token_hash) " +
        "VALUES (?, ?, 'builder', '[]', ?, ?, 'idle', ?, ?)"
      ).run(id, ${JSON.stringify(name)}, nowIso, nowIso, ${JSON.stringify(sessionId)}, "test-hash");
    })().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
  `;
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("node", ["-e", seedScript], { stdio: "pipe" });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`seed failed (exit ${code}): ${stderr}`));
      } else {
        resolve();
      }
    });
  });
}

async function startDaemonWithStdioTransport(agentName: string): Promise<ChildProcess> {
  const child = spawn(
    "node",
    [RELAY_BIN],
    {
      env: {
        ...process.env,
        RELAY_TRANSPORT: "stdio",
        // The stdio transport's TTY guard would normally kill the
        // process within 1.5s when stdin isn't a TTY; the SKIP env
        // var bypasses that so we can hold the daemon long enough
        // to signal it.
        RELAY_SKIP_TTY_CHECK: "1",
        RELAY_AGENT_NAME: agentName,
        RELAY_DB_PATH: TEST_DB_PATH,
        RELAY_CONFIG_PATH: path.join(TEST_ROOT, "config.json"),
      },
      stdio: ["pipe", "ignore", "pipe"],
    },
  );
  // Give the child ~500ms to import dist/index.js, run config, init the
  // DB, and call captureSessionId + installAutoUnregister. We don't have
  // a direct readiness signal (stdio transport doesn't expose one), so
  // a small wall-clock wait is the pragmatic choice. The test is
  // bounded above by the 5s vitest default.
  await new Promise<void>((r) => setTimeout(r, 800));
  if (child.exitCode !== null) {
    throw new Error(`daemon exited before signal could be sent (code ${child.exitCode})`);
  }
  return child;
}

function readAgentSignalCols(name: string): {
  signal_received_at: number | null;
  signal_kind: string | null;
  agent_status: string | null;
} {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Better = require("better-sqlite3");
  const db = new Better(TEST_DB_PATH, { readonly: true });
  try {
    const row = db
      .prepare(
        "SELECT signal_received_at, signal_kind, agent_status FROM agents WHERE name = ?",
      )
      .get(name) as {
      signal_received_at: number | null;
      signal_kind: string | null;
      agent_status: string | null;
    } | undefined;
    if (!row) {
      throw new Error(`agent "${name}" not found in DB`);
    }
    return row;
  } finally {
    db.close();
  }
}

describe.skipIf(SKIP_PLATFORM)("v2.8 — SIGHUP handler integration", () => {
  it("(SH1) real SIGHUP fires installAutoUnregister and stamps signal_received_at + signal_kind='SIGHUP'", async () => {
    const NAME = "v2-8-sighup-target";
    const SID = "session-sighup-1";
    await seedAgent(NAME, SID);
    daemon = await startDaemonWithStdioTransport(NAME);
    expect(daemon.pid).toBeTypeOf("number");
    const beforeMs = Date.now();
    daemon.kill("SIGHUP");
    await new Promise<void>((resolve) => {
      daemon!.once("exit", () => resolve());
      setTimeout(() => resolve(), 3000);
    });
    expect(
      daemon.exitCode,
      "SIGHUP should exit with code 129 (128 + signal number 1)",
    ).toBe(129);
    const row = readAgentSignalCols(NAME);
    expect(
      row.signal_kind,
      "signal_kind must be 'SIGHUP' after SIGHUP delivery",
    ).toBe("SIGHUP");
    expect(
      row.signal_received_at,
      "signal_received_at must be populated",
    ).not.toBeNull();
    expect(
      row.signal_received_at,
      "signal_received_at must be a recent epoch ms",
    ).toBeGreaterThanOrEqual(beforeMs);
    expect(row.signal_received_at).toBeLessThanOrEqual(Date.now() + 1000);
    expect(
      row.agent_status,
      "v2.15.2: signal stamps forensics but stores a NEUTRAL 'idle' (no sticky " +
        "terminal status — a stored 'closed'/'offline' would phantom a " +
        "surviving/relaunched agent). getAgents derives 'unknown' with the " +
        "anchor cleared; the dashboard derives 'closed' from the stamp + " +
        "non-alive liveness.",
    ).toBe("idle");
  }, 15_000);

  it("(SH2) SIGINT stamps signal_kind='SIGINT' (regression — pre-v2.8 path still works)", async () => {
    const NAME = "v2-8-sigint-target";
    const SID = "session-sigint-1";
    await seedAgent(NAME, SID);
    daemon = await startDaemonWithStdioTransport(NAME);
    daemon.kill("SIGINT");
    await new Promise<void>((resolve) => {
      daemon!.once("exit", () => resolve());
      setTimeout(() => resolve(), 3000);
    });
    expect(daemon.exitCode).toBe(130);
    const row = readAgentSignalCols(NAME);
    expect(row.signal_kind).toBe("SIGINT");
    expect(row.signal_received_at).not.toBeNull();
    expect(row.agent_status).toBe("idle"); // v2.15.2 — stored neutral, not sticky 'closed'
  }, 15_000);

  it("(SH3) SIGTERM stamps signal_kind='SIGTERM' (regression)", async () => {
    const NAME = "v2-8-sigterm-target";
    const SID = "session-sigterm-1";
    await seedAgent(NAME, SID);
    daemon = await startDaemonWithStdioTransport(NAME);
    daemon.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      daemon!.once("exit", () => resolve());
      setTimeout(() => resolve(), 3000);
    });
    expect(daemon.exitCode).toBe(143);
    const row = readAgentSignalCols(NAME);
    expect(row.signal_kind).toBe("SIGTERM");
    expect(row.signal_received_at).not.toBeNull();
    expect(row.agent_status).toBe("idle"); // v2.15.2 — stored neutral, not sticky 'closed'
  }, 15_000);
});
