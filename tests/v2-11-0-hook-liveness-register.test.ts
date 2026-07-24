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

/**
 * Seed the row's session/liveness/handshake columns to a known state.
 * `pids` overrides the stored host_shell_pids (defaults to the dead SEED_PIDS
 * sentinel); v2.23.0 tests pass a chain containing a LIVE FOREIGN pid to model a
 * genuinely-held concurrent binding vs the dead-terminal default.
 */
function seedRow(
  dbPath: string,
  name: string,
  opts: { sessionId: string | null; lastSeenIso: string; pids?: string },
): void {
  const sid = opts.sessionId === null ? "NULL" : `'${opts.sessionId}'`;
  const pids = opts.pids ?? SEED_PIDS;
  sql(
    dbPath,
    `UPDATE agents SET session_id=${sid}, last_seen='${opts.lastSeenIso}', ` +
      `agent_status='idle', host_shell_pids='${pids}', host_id='${SEED_HOSTID}' ` +
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

/**
 * Spawn a real, live process that is NOT an ancestor of the shipped hook (the
 * hook is spawned separately by runHook). Its pid stands in for a CONCURRENT
 * terminal's live shell: seeded into host_shell_pids it must make the LIVE gate
 * SKIP, because relay_binding_live_elsewhere finds a live pid outside this hook's
 * own tree. Caller MUST kill it in `finally`.
 */
function spawnLivePid(): { pid: number; kill: () => void } {
  const p = spawn("sleep", ["30"], { stdio: "ignore", detached: true });
  p.unref();
  const pid = p.pid ?? 0;
  return {
    pid,
    kill: () => {
      try {
        if (pid > 0) process.kill(pid);
      } catch {
        /* already gone */
      }
    },
  };
}

describe("v2.11.0 GAP 1 — check-relay.sh liveness-scoped SKIP_REGISTER (shipped hook)", () => {
  it("(L1) fresh+live row held by a LIVE concurrent terminal → hook SKIPS register: session_id + host_shell_pids + host_id UNCHANGED", async () => {
    const h = await startHarness("live");
    const live = spawnLivePid();
    try {
      const name = "live-builder";
      const token = await registerAndGetToken(h.port, name);
      // Genuinely live: the stored chain contains a LIVE pid that is NOT in this
      // hook's own tree (a concurrent terminal's shell) → the LIVE gate must SKIP
      // so it doesn't clobber the holding terminal. (v2.23.0: "live" is now proven
      // by a real live foreign process — the old fake/overlapping-pid seed can't
      // model it, since a resummon's shared ancestors are in this hook's chain
      // too and must NOT count as "still held".)
      const heldPids = `[${live.pid}]`;
      seedRow(h.dbPath, name, {
        sessionId: SEED_SESSION,
        lastSeenIso: new Date().toISOString(),
        pids: heldPids,
      });

      const r = runHook(h, name, token);
      expect(r.status, `hook stderr: ${r.stderr}`).toBe(0);

      // Register was NOT called → every session-scoped field is exactly the seed.
      expect(sql(h.dbPath, `SELECT session_id FROM agents WHERE name='${name}';`)).toBe(SEED_SESSION);
      expect(sql(h.dbPath, `SELECT host_shell_pids FROM agents WHERE name='${name}';`)).toBe(heldPids);
      expect(sql(h.dbPath, `SELECT host_id FROM agents WHERE name='${name}';`)).toBe(SEED_HOSTID);
    } finally {
      live.kill();
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

/**
 * v2.23.0 — host_shell_pids stale-on-restart.
 *
 * THE BUG (observed in the field): after a resummon/VS-Code reload, an agent
 * became unwakeable — Tether reported "no bound terminal". The row's agent_pid
 * had refreshed (report_liveness via post-tool-use-check.sh, every tool call)
 * but host_shell_pids kept the DEAD prior terminal's chain, because the
 * SessionStart LIVE gate (v2.14.1) SKIPPED re-register inside the 120s window
 * whenever host_shell_pids was merely PRESENT — it could not tell a genuine
 * relaunch (terminal changed) from a still-live binding.
 *
 * THE FIX (measured discriminator): a resummon's stored chain is NOT disjoint
 * from the live chain — the persistent VS Code app ancestors (Code Helper / Code,
 * e.g. 26798/26779) appear in BOTH. A whole-chain intersection therefore misses
 * the common case. The test that works: does the stored chain still have a LIVE
 * process OUTSIDE this hook's own tree? None ⇒ relaunch (dead leaves + shared
 * ancestors that are in MY chain) ⇒ re-register (force=true, since the row still
 * looks actively-held). One ⇒ a live concurrent terminal ⇒ SKIP (don't clobber).
 *
 * R1/R2/R3 assert BOTH directions AND the discriminating shared-ancestor case
 * (guardrail: proving only the disjoint case would trade one bug for another).
 */
describe("v2.23.0 — resummon terminal-change refreshes host_shell_pids (stale-on-restart)", () => {
  it("(R1) live row (<120s) whose stored chain is all DEAD pids → hook RE-REGISTERS: host_shell_pids refreshes off the dead chain, session_id rotates", async () => {
    const h = await startHarness("dead");
    try {
      const name = "resummon-builder";
      const token = await registerAndGetToken(h.port, name);
      // The row still LOOKS live (session set + last_seen now) but its stored
      // host_shell_pids [999999] belongs to the DEAD prior terminal (a sentinel
      // above any real pid → not a running process). Nothing is live-elsewhere →
      // the prior terminal is gone → re-register (force) → host_shell_pids
      // refreshes. Before the fix the 120s gate skipped and this dead chain
      // survived ("no bound terminal").
      seedRow(h.dbPath, name, {
        sessionId: SEED_SESSION,
        lastSeenIso: new Date().toISOString(),
        pids: SEED_PIDS,
      });

      const r = runHook(h, name, token);
      expect(r.status, `hook stderr: ${r.stderr}`).toBe(0);

      const newSession = sql(h.dbPath, `SELECT session_id FROM agents WHERE name='${name}';`);
      expect(newSession, "session_id must rotate — proves register ran").not.toBe(SEED_SESSION);
      expect(newSession.length).toBeGreaterThan(0);
      const newPids = sql(h.dbPath, `SELECT host_shell_pids FROM agents WHERE name='${name}';`);
      expect(newPids, "the dead [999999] chain must be replaced").not.toBe(SEED_PIDS);
      expect(newPids).toMatch(/^\[\d+(,\d+)*\]$/); // a real PID chain
    } finally {
      stopHarness(h);
    }
  }, 25_000);

  it("(R2) live row (<120s) whose stored chain has a LIVE FOREIGN pid (not in this hook's tree) → hook still SKIPS register: the concurrent-terminal binding is preserved", async () => {
    const h = await startHarness("concurrent");
    const live = spawnLivePid();
    try {
      const name = "concurrent-builder";
      const token = await registerAndGetToken(h.port, name);
      // A genuinely-live binding: the stored chain carries a LIVE process that is
      // NOT in this hook's own chain — a real concurrent terminal's shell. The
      // gate must SKIP so it doesn't clobber it.
      const heldPids = `[${live.pid}]`;
      seedRow(h.dbPath, name, {
        sessionId: SEED_SESSION,
        lastSeenIso: new Date().toISOString(),
        pids: heldPids,
      });

      const r = runHook(h, name, token);
      expect(r.status, `hook stderr: ${r.stderr}`).toBe(0);

      // Register was NOT called → session + chain preserved exactly.
      expect(sql(h.dbPath, `SELECT session_id FROM agents WHERE name='${name}';`)).toBe(SEED_SESSION);
      expect(sql(h.dbPath, `SELECT host_shell_pids FROM agents WHERE name='${name}';`)).toBe(heldPids);
    } finally {
      live.kill();
      stopHarness(h);
    }
  }, 25_000);

  it("(R3) live row (<120s), DEAD leaves + a SHARED LIVE ancestor that is in this hook's chain → hook RE-REGISTERS (the real resummon/shared-ancestor case a whole-chain intersection would wrongly SKIP)", async () => {
    const h = await startHarness("shared-ancestor");
    try {
      const name = "shared-ancestor-builder";
      const token = await registerAndGetToken(h.port, name);
      // Model Maxime's measured resummon: DEAD [58354,58176,57631]-style leaves
      // plus a persistent VS-Code-app ancestor that survives into the NEW
      // terminal. process.pid is the parent of the spawned hook shell, so it IS
      // in the hook's live relay_pid_chain — the stand-in for the shared
      // 26798/26779. A whole-chain intersection is NON-EMPTY here ({process.pid})
      // → would SKIP → bug survives. The liveness discriminator excludes the
      // in-my-chain ancestor and finds the leaves dead → re-register.
      const deadLeavesPlusSharedLiveAncestor = `[999997,999998,${process.pid}]`;
      seedRow(h.dbPath, name, {
        sessionId: SEED_SESSION,
        lastSeenIso: new Date().toISOString(),
        pids: deadLeavesPlusSharedLiveAncestor,
      });

      const r = runHook(h, name, token);
      expect(r.status, `hook stderr: ${r.stderr}`).toBe(0);

      // Register WAS called → session rotated, host_shell_pids refreshed off the
      // stale chain to THIS terminal's real chain.
      const newSession = sql(h.dbPath, `SELECT session_id FROM agents WHERE name='${name}';`);
      expect(newSession, "session_id must rotate — the shared-ancestor case must NOT skip").not.toBe(SEED_SESSION);
      expect(newSession.length).toBeGreaterThan(0);
      const newPids = sql(h.dbPath, `SELECT host_shell_pids FROM agents WHERE name='${name}';`);
      expect(newPids, "the stale shared-ancestor chain must be replaced").not.toBe(deadLeavesPlusSharedLiveAncestor);
      expect(newPids).toMatch(/^\[\d+(,\d+)*\]$/);
    } finally {
      stopHarness(h);
    }
  }, 25_000);
});
