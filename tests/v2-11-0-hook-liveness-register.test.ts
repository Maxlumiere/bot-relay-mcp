// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.11.0 GAP 1 — load-bearing regression for the check-relay.sh liveness gate.
 *
 * THE GAP codex caught on PR #66: the +3 pid-handshake tests exercise the
 * DB/HTTP register_agent layer (which already refreshed PIDs + was auth-gated
 * since v0.3.0) and BYPASS the shipped hook entirely. The REAL fix — narrowing
 * `SKIP_REGISTER` in hooks/check-relay.sh so a relaunched offline/stale row
 * re-registers (refreshing its PID chain) while a fresh+live row is still
 * skipped (spawn-handoff / concurrent guard) — had NO test that would fail if
 * the skip regressed to its old unconditional form.
 *
 * This file invokes the ACTUAL hooks/check-relay.sh as a subprocess against a
 * real `node dist/index.js` HTTP daemon and asserts both sides of the gate by
 * observing whether `register_agent` ran. The load-bearing signals are
 * DETERMINISTIC and only happen when register IS called on an existing row:
 *   - session_id ROTATES (the relay rotates it on every re-register)
 *   - host_shell_pids is OVERWRITTEN with this hook subprocess's live chain
 * If SKIP_REGISTER reverts to "skip whenever the row exists", the stale +
 * offline cases below MUST fail (no rotation, seed PIDs preserved).
 *
 * Test path matches shipped path (so the test exercises the real seam):
 * the seam under test is the bash hook itself, not a TS/SQL surrogate.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { getFreePort } from "./_helpers/port.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const HOOK = path.join(REPO_ROOT, "hooks", "check-relay.sh");
const DIST_INDEX = path.join(REPO_ROOT, "dist", "index.js");

const SEED_SESSION = "SEED-SESSION-DO-NOT-ROTATE";
const SEED_PIDS = "[999999]";
const SEED_HOSTID = "SEED-HOSTID";

async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error(`HTTP daemon at :${port} did not become healthy within ${timeoutMs}ms`);
}

/** Run a single-value SQL read against the DB via the sqlite3 CLI (same tool the hook uses). */
function sql(dbPath: string, query: string): string {
  const r = spawnSync("sqlite3", [dbPath, query], { encoding: "utf-8", timeout: 5000 });
  if (r.status !== 0) throw new Error(`sqlite3 failed: ${r.stderr}`);
  return (r.stdout ?? "").trim();
}

/**
 * Best-effort machine GUID using the SAME OS sources as check-relay.sh's
 * relay_machine_guid(). Returns "" when the host has no derivable GUID (e.g.
 * a Linux CI box without /etc/machine-id) — the host_id sub-assertion is then
 * skipped (logged), while the session_id + host_shell_pids assertions, which
 * are the actual SKIP_REGISTER guards, always run.
 */
function machineGuid(): string {
  const plat = process.platform;
  if (plat === "darwin") {
    const r = spawnSync("bash", ["-c", `ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null | sed -nE 's/.*"IOPlatformUUID" = "([^"]+)".*/\\1/p' | head -1`], { encoding: "utf-8" });
    return (r.stdout ?? "").trim();
  }
  if (plat === "linux") {
    try {
      return fs.readFileSync("/etc/machine-id", "utf-8").trim();
    } catch {
      return "";
    }
  }
  return "";
}

interface Harness {
  port: number;
  root: string;
  dbPath: string;
  daemon: ReturnType<typeof spawn>;
}

async function startHarness(label: string): Promise<Harness> {
  const port = await getFreePort();
  const root = path.join(os.tmpdir(), `v2-11-0-hook-${label}-${process.pid}`);
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(root, "agents"), { recursive: true, mode: 0o700 });
  expect(fs.existsSync(DIST_INDEX), "dist/index.js missing — run npm run build first").toBe(true);
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
  await waitForHealth(port, 6000);
  return { port, root, dbPath, daemon };
}

function stopHarness(h: Harness): void {
  try { h.daemon.kill("SIGTERM"); } catch { /* */ }
  try { h.daemon.kill("SIGKILL"); } catch { /* */ }
  try { fs.rmSync(h.root, { recursive: true, force: true }); } catch { /* */ }
}

/** Register an agent over HTTP, mint + return its token (creates the row). */
async function registerAndGetToken(port: number, name: string): Promise<string> {
  const resp = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "register_agent", arguments: { name, role: "builder", capabilities: [] } },
    }),
  });
  const text = await resp.text();
  const dataLine = text.split("\n").map((l) => l.trim()).find((l) => l.startsWith("data:"));
  const payload = dataLine ? dataLine.slice(5).trim() : text.trim();
  const inner = JSON.parse(JSON.parse(payload).result.content[0].text);
  expect(inner.agent_token).toMatch(/^[A-Za-z0-9_=.-]{8,128}$/);
  return inner.agent_token as string;
}

/** Seed the row's session/liveness/handshake columns to a known state. */
function seedRow(
  dbPath: string,
  name: string,
  opts: { sessionId: string | null; lastSeenIso: string },
): void {
  const sid = opts.sessionId === null ? "NULL" : `'${opts.sessionId}'`;
  sql(
    dbPath,
    `UPDATE agents SET session_id=${sid}, last_seen='${opts.lastSeenIso}', ` +
      `agent_status='idle', host_shell_pids='${SEED_PIDS}', host_id='${SEED_HOSTID}' ` +
      `WHERE name='${name}';`,
  );
}

/** Invoke the SHIPPED hook for `name` with a valid token + daemon pointer. */
function runHook(h: Harness, name: string, token: string): ReturnType<typeof spawnSync> {
  return spawnSync("bash", [HOOK], {
    encoding: "utf-8",
    timeout: 12_000,
    env: {
      HOME: h.root,
      PATH: process.env.PATH || "/usr/bin:/bin",
      RELAY_HOME: h.root,
      RELAY_AGENT_NAME: name,
      RELAY_AGENT_ROLE: "builder",
      RELAY_AGENT_CAPABILITIES: "",
      RELAY_DB_PATH: h.dbPath,
      RELAY_HTTP_HOST: "127.0.0.1",
      RELAY_HTTP_PORT: String(h.port),
      RELAY_AGENT_TOKEN: token,
    },
    input: "",
  });
}

describe("v2.11.0 GAP 1 — check-relay.sh liveness-scoped SKIP_REGISTER (shipped hook)", () => {
  it("(L1) fresh+live row → hook SKIPS register: session_id + host_shell_pids + host_id UNCHANGED", async () => {
    const h = await startHarness("live");
    try {
      const name = "live-builder";
      const token = await registerAndGetToken(h.port, name);
      // Live: a session claimed just now (< 120s) — the spawn-handoff /
      // concurrent-terminal case the skip must still protect.
      seedRow(h.dbPath, name, { sessionId: SEED_SESSION, lastSeenIso: new Date().toISOString() });

      const r = runHook(h, name, token);
      expect(r.status, `hook stderr: ${r.stderr}`).toBe(0);

      // Register was NOT called → every session-scoped field is exactly the seed.
      expect(sql(h.dbPath, `SELECT session_id FROM agents WHERE name='${name}';`)).toBe(SEED_SESSION);
      expect(sql(h.dbPath, `SELECT host_shell_pids FROM agents WHERE name='${name}';`)).toBe(SEED_PIDS);
      expect(sql(h.dbPath, `SELECT host_id FROM agents WHERE name='${name}';`)).toBe(SEED_HOSTID);
    } finally {
      stopHarness(h);
    }
  }, 25_000);

  it("(L2) stale row (last_seen > 120s) → hook RE-REGISTERS: session_id rotates, host_shell_pids + host_id refresh", async () => {
    const h = await startHarness("stale");
    try {
      const name = "stale-builder";
      const token = await registerAndGetToken(h.port, name);
      // Stale: session_id present but last_seen far in the past → a genuine
      // relaunch of a row whose prior terminal didn't cleanly mark it offline.
      seedRow(h.dbPath, name, { sessionId: SEED_SESSION, lastSeenIso: "2020-01-01T00:00:00.000Z" });

      const r = runHook(h, name, token);
      expect(r.status, `hook stderr: ${r.stderr}`).toBe(0);

      // Register WAS called → session_id rotated off the seed, PIDs overwritten
      // with this hook subprocess's real chain (not the [999999] sentinel).
      const newSession = sql(h.dbPath, `SELECT session_id FROM agents WHERE name='${name}';`);
      expect(newSession).not.toBe(SEED_SESSION);
      expect(newSession.length).toBeGreaterThan(0);
      const newPids = sql(h.dbPath, `SELECT host_shell_pids FROM agents WHERE name='${name}';`);
      expect(newPids).not.toBe(SEED_PIDS);
      expect(newPids).toMatch(/^\[\d+(,\d+)*\]$/); // a real PID chain

      const guid = machineGuid();
      const newHostId = sql(h.dbPath, `SELECT host_id FROM agents WHERE name='${name}';`);
      if (guid) {
        expect(newHostId, "host_id should refresh to this machine's GUID on re-register").toBe(guid);
        expect(newHostId).not.toBe(SEED_HOSTID);
      } else {
        // eslint-disable-next-line no-console
        console.warn("[L2] machine GUID unavailable on this host — host_id refresh sub-assertion skipped (session_id + host_shell_pids assertions still prove register ran)");
      }
    } finally {
      stopHarness(h);
    }
  }, 25_000);

  it("(L3) offline row (session_id NULL) → hook RE-REGISTERS: session_id repopulates, host_shell_pids + host_id refresh (the build-agent case)", async () => {
    const h = await startHarness("offline");
    try {
      const name = "offline-builder";
      const token = await registerAndGetToken(h.port, name);
      // Offline: prior terminal marked the row offline (session_id NULL). This
      // is exactly the build-agent's observed state — empty session_id + empty PIDs.
      seedRow(h.dbPath, name, { sessionId: null, lastSeenIso: new Date().toISOString() });
      expect(sql(h.dbPath, `SELECT IFNULL(session_id,'') FROM agents WHERE name='${name}';`)).toBe("");

      const r = runHook(h, name, token);
      expect(r.status, `hook stderr: ${r.stderr}`).toBe(0);

      // Register WAS called → session_id repopulated (the empty-session_id
      // inbox glitch is healed), PIDs overwritten with the real chain.
      const newSession = sql(h.dbPath, `SELECT IFNULL(session_id,'') FROM agents WHERE name='${name}';`);
      expect(newSession.length).toBeGreaterThan(0);
      const newPids = sql(h.dbPath, `SELECT host_shell_pids FROM agents WHERE name='${name}';`);
      expect(newPids).not.toBe(SEED_PIDS);
      expect(newPids).toMatch(/^\[\d+(,\d+)*\]$/);

      const guid = machineGuid();
      const newHostId = sql(h.dbPath, `SELECT host_id FROM agents WHERE name='${name}';`);
      if (guid) {
        expect(newHostId, "host_id should populate from this machine's GUID on re-register").toBe(guid);
      } else {
        // eslint-disable-next-line no-console
        console.warn("[L3] machine GUID unavailable on this host — host_id refresh sub-assertion skipped");
      }
    } finally {
      stopHarness(h);
    }
  }, 25_000);
});
