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
 *  3. Prove readiness: send a real MCP `initialize` frame on stdin and
 *     await the JSON-RPC response on stdout. In `startStdioServer`,
 *     `installAutoUnregister()` runs synchronously BEFORE
 *     `server.connect(transport)`, so a response is a happens-after
 *     proof that the signal handlers are installed — no wall-clock
 *     guess about startup speed.
 *  4. Send the signal under test via `child.kill(signal)`.
 *  5. Await the child's `exit` event — with NO fallback timeout racing
 *     it. The per-test vitest timeout is the only bound, so a genuine
 *     hang fails loudly as a timeout instead of asserting against a
 *     null exitCode from a process that simply hadn't exited yet
 *     (the exact CI flake this replaced: `expected null to be 130`).
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
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    daemon.kill("SIGKILL");
    // SIGKILL cannot be caught, so `exit` always fires — await it rather
    // than sleeping an arbitrary 100ms and hoping the reap finished.
    await waitForExit(daemon);
  }
  daemon = null;
  if (fs.existsSync(TEST_ROOT)) {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  }
});

/**
 * Resolve with the child's termination state. Deliberately has NO
 * fallback timeout: racing a timer against `exit` and resolving silently
 * is what let the assertion run against a still-alive child under CI
 * load. The vitest per-test timeout bounds a genuine hang and reports
 * it as what it is.
 */
function waitForExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

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
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  // Readiness is proven, not guessed: the daemon is an MCP server, so a
  // JSON-RPC response to a real `initialize` frame is a happens-after
  // witness for everything `startStdioServer` does before
  // `server.connect(transport)` — including `installAutoUnregister()`.
  // The previous shape slept a flat 800ms, which under a loaded CI
  // runner left a window where the signal arrived before the handler
  // was installed and the default disposition killed the child with
  // exitCode null.
  await new Promise<void>((resolve, reject) => {
    let stdoutBuf = "";
    let stderrBuf = "";
    const onStdout = (d: Buffer) => {
      stdoutBuf += d.toString();
      const nl = stdoutBuf.indexOf("\n");
      if (nl === -1) return;
      const line = stdoutBuf.slice(0, nl);
      try {
        const msg = JSON.parse(line) as { id?: number };
        if (msg.id !== 1) {
          throw new Error(`unexpected id ${String(msg.id)}`);
        }
      } catch (err) {
        cleanup();
        reject(
          new Error(
            `first stdout line is not the initialize response: ${line} (${String(err)})`,
          ),
        );
        return;
      }
      cleanup();
      resolve();
    };
    const onStderr = (d: Buffer) => {
      stderrBuf += d.toString();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `daemon exited before becoming ready (code ${String(code)}, signal ${String(signal)}): ${stderrBuf}`,
        ),
      );
    };
    const cleanup = () => {
      child.stdout!.off("data", onStdout);
      child.stderr!.off("data", onStderr);
      child.off("exit", onExit);
      // Keep both pipes draining so the child can never block on a full
      // pipe buffer after the handshake.
      child.stdout!.resume();
      child.stderr!.resume();
    };
    child.stdout!.on("data", onStdout);
    child.stderr!.on("data", onStderr);
    child.on("exit", onExit);
    child.stdin!.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "v2-8-sighup-test", version: "0.0.0" },
        },
      }) + "\n",
    );
  });
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
    const exit = await waitForExit(daemon);
    expect(
      exit.signal,
      "child died from the raw signal (default disposition) — the handler was not installed when the signal arrived",
    ).toBeNull();
    expect(
      exit.code,
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
    const exit = await waitForExit(daemon);
    expect(
      exit.signal,
      "child died from the raw signal (default disposition) — the handler was not installed when the signal arrived",
    ).toBeNull();
    expect(exit.code).toBe(130);
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
    const exit = await waitForExit(daemon);
    expect(
      exit.signal,
      "child died from the raw signal (default disposition) — the handler was not installed when the signal arrived",
    ).toBeNull();
    expect(exit.code).toBe(143);
    const row = readAgentSignalCols(NAME);
    expect(row.signal_kind).toBe("SIGTERM");
    expect(row.signal_received_at).not.toBeNull();
    expect(row.agent_status).toBe("idle"); // v2.15.2 — stored neutral, not sticky 'closed'
  }, 15_000);
});
