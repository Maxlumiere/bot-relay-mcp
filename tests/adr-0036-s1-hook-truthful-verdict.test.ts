// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0036 S1, §8a D7 amendment (f) — the SessionStart hook's VERDICT must say
 * what actually happened.
 *
 * MEASURED on today's hook (spike (e), 2026-09-15, and by reading check-relay.sh):
 * the hook upgrades to HEALTHY as soon as the config resolves (`:407-409`), and
 * the steps that run AFTER it never touch the verdict. So:
 *   - after a reboot where the daemon never came up, the hook skips register and
 *     still prints HEALTHY: the false-comfort class, on the morning it matters;
 *   - a register that FAILS (NAME_COLLISION_ACTIVE: HTTP 200 + isError, no token)
 *     prints a stderr banner and still prints HEALTHY;
 *   - a stale or never-issued token exits 1 from the token pre-check (`:507`), and
 *     the EXIT trap prints the HEALTHY that was already set.
 *
 * Contract pinned here (each harm case is RED on today's hook):
 *   - daemon unreachable, whether register was attempted (first spawn) or skipped
 *     (a LIVE row) → DEGRADED, naming "daemon unreachable";
 *   - register returned an error → REGISTER_FAILED;
 *   - the token pre-check rejected the token → AUTH_FAILED (still exit 1).
 * Innocent twins (green before and after):
 *   - daemon up + a unique name registers → HEALTHY;
 *   - a LOUDER verdict is never masked: a dead canonical config path stays MUTE
 *     even with the daemon down.
 *
 * Harness notes, copied from the two tests that already proved them:
 *   - the hook runs from a BYTE-IDENTICAL COPY of hooks/ under a path containing
 *     "/bot-relay-mcp/hooks/" (check-relay-dead-anchor): a sibling file transiently
 *     deletes the real hooks/_verdict.sh, and vitest runs files in parallel;
 *   - the daemon is a real `node dist/index.js` on a free port
 *     (hook-register-collision-warn), so collisions and auth errors come from the
 *     actual server;
 *   - HEALTHY needs a canonical ~/.claude.json entry pointing at an existing
 *     dist/index.js, so `npm run build` must have run.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { getFreePort } from "./_helpers/port.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REAL_HOOKS = path.join(REPO_ROOT, "hooks");
const HELPER = path.join(REAL_HOOKS, "_vault-helpers.sh"); // GUID / lstart only, never mutated
const DIST_INDEX = path.join(REPO_ROOT, "dist", "index.js");

const TEST_ROOT = path.join(os.tmpdir(), "bot-relay-s1-verdict-" + process.pid);
const TEST_DB_PATH = path.join(TEST_ROOT, "relay.db");
const HOOK_COPY_DIR = path.join(TEST_ROOT, "bot-relay-mcp", "hooks");
const HOOK = path.join(HOOK_COPY_DIR, "check-relay.sh");

process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;

const OK_ENTRY = { "bot-relay": { type: "stdio", command: "node", args: [DIST_INDEX] } };
const DEAD_ENTRY = { "bot-relay": { type: "stdio", command: "node", args: ["/nonexistent/bot-relay-mcp/dist/index.js"] } };

/** The exact own-host GUID the hook's relay_machine_guid() computes. */
function ownGuid(): string {
  const r = spawnSync("bash", ["-c", `. "$1"; relay_machine_guid`, "bash", HELPER], { encoding: "utf-8" });
  return (r.stdout ?? "").trim();
}
const GUID = ownGuid();

/** The real lstart token for a pid (matches the hook's relay_pid_start). */
function pidStart(pid: number): string {
  const r = spawnSync("bash", ["-c", `. "$1"; relay_pid_start "$2"`, "bash", HELPER, String(pid)], {
    encoding: "utf-8",
  });
  return (r.stdout ?? "").trim();
}

function writeClaudeJson(home: string, mcpServers: Record<string, unknown>): void {
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers }));
}

/** The single verdict token. Values may carry underscores (REGISTER_FAILED). */
function verdictOf(out: string): string | null {
  const m = out.match(/VERDICT=([A-Z_-]+)/);
  return m ? m[1] : null;
}

interface RunOpts {
  home: string;
  dbPath: string;
  port: number;
  name: string;
  token?: string;
}

function runHook(o: RunOpts): { stdout: string; stderr: string; status: number } {
  const r = spawnSync("bash", [HOOK], {
    encoding: "utf-8",
    timeout: 15_000,
    input: "",
    env: {
      HOME: o.home,
      RELAY_HOME: o.home,
      PATH: process.env.PATH || "/usr/bin:/bin",
      RELAY_DB_PATH: o.dbPath,
      RELAY_AGENT_NAME: o.name,
      RELAY_AGENT_ROLE: "builder",
      RELAY_AGENT_CAPABILITIES: "",
      RELAY_AGENT_TOKEN: o.token ?? "",
      RELAY_HTTP_HOST: "127.0.0.1",
      RELAY_HTTP_PORT: String(o.port),
    },
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? -1 };
}

// --- real daemon harness (hook-register-collision-warn) ---------------------------

async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`daemon at :${port} not healthy within ${timeoutMs}ms`);
}

interface Harness {
  port: number;
  root: string;
  dbPath: string;
  daemon: ReturnType<typeof spawn>;
}

async function startHarness(label: string): Promise<Harness> {
  const port = await getFreePort();
  const root = path.join(os.tmpdir(), `bot-relay-s1-verdict-${label}-${process.pid}`);
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, "agents"), { recursive: true, mode: 0o700 });
  const dbPath = path.join(root, "relay.db");
  const daemon = spawn("node", [DIST_INDEX], {
    env: {
      ...process.env,
      RELAY_TRANSPORT: "http",
      RELAY_HTTP_PORT: String(port),
      RELAY_HTTP_HOST: "127.0.0.1",
      RELAY_HOME: root,
      RELAY_DB_PATH: dbPath,
      RELAY_CONFIG_PATH: path.join(root, "config.json"),
      RELAY_AGENT_TOKEN: "",
      RELAY_AGENT_NAME: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForHealth(port, 8000);
  return { port, root, dbPath, daemon };
}

function stopHarness(h: Harness): void {
  try { h.daemon.kill("SIGTERM"); } catch { /* */ }
  try { h.daemon.kill("SIGKILL"); } catch { /* */ }
  try { fs.rmSync(h.root, { recursive: true, force: true }); } catch { /* */ }
}

/** Register an agent over HTTP so it holds the name live. */
async function registerLive(port: number, name: string): Promise<void> {
  const resp = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "register_agent", arguments: { name, role: "builder", capabilities: [] } },
    }),
  });
  expect(await resp.text(), `register of "${name}" should have minted a token`).toMatch(/agent_token/);
}

beforeEach(async () => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true, mode: 0o700 });
  fs.cpSync(REAL_HOOKS, HOOK_COPY_DIR, { recursive: true });
  const { closeDb } = await import("../src/db.js");
  closeDb();
  // A sibling file sharing this worker may have moved RELAY_DB_PATH; re-assert ours.
  process.env.RELAY_DB_PATH = TEST_DB_PATH;
  expect(fs.existsSync(DIST_INDEX), "dist/index.js missing — run npm run build first").toBe(true);
});

afterEach(async () => {
  const { closeDb } = await import("../src/db.js");
  closeDb();
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("ADR-0036 S1 (D7 f) — a daemon that cannot be reached never reads HEALTHY", () => {
  it("first spawn (register attempted), daemon unreachable → DEGRADED, naming it", async () => {
    writeClaudeJson(TEST_ROOT, OK_ENTRY);
    const { getDb, closeDb } = await import("../src/db.js");
    getDb(); // full schema, no agent row → the hook attempts register
    closeDb();
    const port = await getFreePort(); // free = nothing listening

    const r = runHook({ home: TEST_ROOT, dbPath: TEST_DB_PATH, port, name: "s1-first" });
    expect(verdictOf(r.stdout), r.stdout + r.stderr).toBe("DEGRADED");
    expect(r.stdout).toMatch(/daemon unreachable/);
    expect((r.stdout.match(/VERDICT=/g) ?? []).length, "exactly one verdict").toBe(1);
  }, 20_000);

  it.skipIf(!GUID)("a LIVE row (register skipped) with a live anchor, daemon unreachable → DEGRADED", async () => {
    writeClaudeJson(TEST_ROOT, OK_ENTRY);
    const { registerAgent, getDb, closeDb } = await import("../src/db.js");
    registerAgent("s1-live", "builder", []);
    getDb()
      .prepare(
        "UPDATE agents SET session_id = ?, host_shell_pids = ?, agent_pid = ?, agent_pid_start = ?, " +
          "host_id = ?, last_seen = ?, agent_status = 'online' WHERE name = ?",
      )
      .run("sess-live", "[111,222]", process.pid, pidStart(process.pid), GUID, new Date().toISOString(), "s1-live");
    closeDb();
    const port = await getFreePort();

    const r = runHook({ home: TEST_ROOT, dbPath: TEST_DB_PATH, port, name: "s1-live", token: "dummy-token-no-daemon" });
    expect(verdictOf(r.stdout), r.stdout + r.stderr).toBe("DEGRADED");
    expect(r.stdout).toMatch(/daemon unreachable/);
    expect(r.stdout, "a live anchor must not false-fire the dead-anchor diagnostic").not.toMatch(/UNWAKEABLE/);
  }, 20_000);
});

describe("ADR-0036 S1 (D7) — a register or token check that failed never reads HEALTHY", () => {
  it("daemon up, name already held by a live agent, no token → REGISTER_FAILED", async () => {
    const h = await startHarness("collide");
    try {
      writeClaudeJson(h.root, OK_ENTRY);
      await registerLive(h.port, "s1-held");

      const r = runHook({ home: h.root, dbPath: h.dbPath, port: h.port, name: "s1-held" });
      expect(verdictOf(r.stdout), r.stdout + r.stderr).toBe("REGISTER_FAILED");
    } finally {
      stopHarness(h);
    }
  }, 30_000);

  it("daemon up, a token that matches no agent (stale / never issued) → exit 1 with AUTH_FAILED", async () => {
    const h = await startHarness("authfail");
    try {
      writeClaudeJson(h.root, OK_ENTRY);

      const r = runHook({
        home: h.root,
        dbPath: h.dbPath,
        port: h.port,
        name: "s1-stale",
        token: "never-issued-token-AAAAAAAA",
      });
      expect(r.stderr, "precondition: the hook took the stale-token path").toMatch(/stale or revoked token/);
      expect(r.status, "the stale-token path still exits 1").toBe(1);
      expect(verdictOf(r.stdout), r.stdout + r.stderr).toBe("AUTH_FAILED");
    } finally {
      stopHarness(h);
    }
  }, 30_000);
});

describe("ADR-0036 S1 (D7) — innocent twins", () => {
  it("daemon up and a unique name registers → HEALTHY", async () => {
    const h = await startHarness("clean");
    try {
      writeClaudeJson(h.root, OK_ENTRY);
      const r = runHook({ home: h.root, dbPath: h.dbPath, port: h.port, name: "s1-unique" });
      expect(verdictOf(r.stdout), r.stdout + r.stderr).toBe("HEALTHY");
    } finally {
      stopHarness(h);
    }
  }, 30_000);

  it("a louder verdict is never masked: dead canonical config path + daemon down stays MUTE", async () => {
    writeClaudeJson(TEST_ROOT, DEAD_ENTRY);
    const { getDb, closeDb } = await import("../src/db.js");
    getDb();
    closeDb();
    const port = await getFreePort();

    const r = runHook({ home: TEST_ROOT, dbPath: TEST_DB_PATH, port, name: "s1-mute" });
    expect(verdictOf(r.stdout), r.stdout + r.stderr).toBe("MUTE");
  }, 20_000);
});
