// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0012 — Codex stale-restart, LAUNCHER → HOOK DEFERRAL path (closes P1a).
 *
 * codex-5-5's P1a named BOTH bin/codex-relay AND codex-session-start.sh as
 * non-force → same B2 collision → stale binding on a Codex relaunch. The fix is
 * hook-only (the hook is the single choke-point every codex stale-restart routes
 * through): the launcher's non-force cold-start pre-register hits the live-<120s
 * B2 collision, the launcher STILL LAUNCHES codex (best-effort, never aborts), and
 * the SessionStart hook then performs the CAS force takeover.
 *
 * This drives the REAL bin/codex-relay (stubbed exec via RELAY_CODEX_LAUNCHER) +
 * the REAL hooks/codex/codex-session-start.sh against a live daemon, so the
 * deferral is OBSERVED end-to-end, not asserted.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { getFreePort } from "./_helpers/port.js";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");
const LAUNCHER = path.join(REPO_ROOT, "bin", "codex-relay");
const HOOK = path.join(REPO_ROOT, "hooks", "codex", "codex-session-start.sh");
const DIST_INDEX = path.join(REPO_ROOT, "dist", "index.js");
const DEAD_PIDS = "[999999]";

async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return;
    } catch {
      /* not up */
    }
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error(`daemon :${port} not healthy in ${timeoutMs}ms`);
}
function sql(dbPath: string, query: string): string {
  const r = spawnSync("sqlite3", [dbPath, query], { encoding: "utf-8", timeout: 5000 });
  if (r.status !== 0) throw new Error(`sqlite3 failed: ${r.stderr}`);
  return (r.stdout ?? "").trim();
}
interface Harness { port: number; root: string; dbPath: string; daemon: ReturnType<typeof spawn>; }
async function startHarness(label: string): Promise<Harness> {
  const port = await getFreePort();
  const root = path.join(os.tmpdir(), `adr0012-codex-${label}-${process.pid}-${port}`);
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, "agents"), { recursive: true, mode: 0o700 });
  expect(fs.existsSync(DIST_INDEX), "dist/index.js missing — run npm run build first").toBe(true);
  const dbPath = path.join(root, "relay.db");
  const daemon = spawn("node", [DIST_INDEX], {
    env: {
      ...process.env,
      RELAY_TRANSPORT: "http", RELAY_HTTP_PORT: String(port), RELAY_HTTP_HOST: "127.0.0.1",
      RELAY_HOME: root, RELAY_DB_PATH: dbPath, RELAY_CONFIG_PATH: path.join(root, "config.json"),
      RELAY_AGENT_TOKEN: "", RELAY_AGENT_NAME: "",
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
async function registerViaHttp(port: number, name: string): Promise<{ token: string; session_id: string }> {
  const resp = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "register_agent", arguments: { name, role: "auditor", capabilities: [] } },
    }),
  });
  const text = await resp.text();
  const dataLine = text.split("\n").map((l) => l.trim()).find((l) => l.startsWith("data:"));
  const inner = JSON.parse(JSON.parse(dataLine ? dataLine.slice(5).trim() : text).result.content[0].text);
  return { token: inner.agent_token as string, session_id: inner.agent.session_id as string };
}
/** Seed a live-<120s row with a DEAD stored chain (a stranded relaunch binding). */
function seedStaleLive(h: Harness, name: string): void {
  sql(
    h.dbPath,
    `UPDATE agents SET last_seen=strftime('%Y-%m-%dT%H:%M:%fZ','now'), agent_status='idle', ` +
      `host_shell_pids='${DEAD_PIDS}', host_id='SEED-HOSTID' WHERE name='${name}';`,
  );
}
/** Run bin/codex-relay with a stubbed exec (records whether it launched). */
function runLauncher(h: Harness, name: string, token: string): { status: number; launched: boolean } {
  const marker = path.join(h.root, `launched-${name}`);
  const stub = path.join(h.root, `stub-${name}.sh`);
  fs.writeFileSync(stub, `#!/bin/bash\ntouch '${marker}'\nexit 0\n`, { mode: 0o755 });
  const res = spawnSync("bash", [LAUNCHER, name], {
    encoding: "utf-8", timeout: 15_000, input: "",
    env: {
      HOME: h.root, PATH: process.env.PATH || "/usr/bin:/bin", RELAY_HOME: h.root, RELAY_DB_PATH: h.dbPath,
      RELAY_HTTP_HOST: "127.0.0.1", RELAY_HTTP_PORT: String(h.port), RELAY_AGENT_ROLE: "auditor",
      RELAY_CODEX_LAUNCHER: stub, RELAY_AGENT_TOKEN: token,
    },
  });
  return { status: res.status ?? -1, launched: fs.existsSync(marker) };
}
function runHook(h: Harness, name: string, token: string): ReturnType<typeof spawnSync> {
  return spawnSync("bash", [HOOK], {
    encoding: "utf-8", timeout: 12_000, input: "",
    env: {
      HOME: h.root, PATH: process.env.PATH || "/usr/bin:/bin", RELAY_HOME: h.root, RELAY_DB_PATH: h.dbPath,
      RELAY_HTTP_HOST: "127.0.0.1", RELAY_HTTP_PORT: String(h.port),
      RELAY_AGENT_NAME: name, RELAY_AGENT_ROLE: "auditor", RELAY_AGENT_TOKEN: token,
      // No RELAY_LAUNCH_SESSION marker → the launcher "deferred" → hook registers.
    },
  });
}
const sid = (h: Harness, n: string) => sql(h.dbPath, `SELECT IFNULL(session_id,'') FROM agents WHERE name='${n}';`);
const pids = (h: Harness, n: string) => sql(h.dbPath, `SELECT IFNULL(host_shell_pids,'') FROM agents WHERE name='${n}';`);

describe("ADR-0012 — Codex launcher→hook deferral takes over a stale binding", () => {
  it("(C1) launcher non-force pre-register hits B2, STILL LAUNCHES, and the hook's CAS force takes over → session rotates + host_shell_pids refreshes", async () => {
    const h = await startHarness("defer");
    try {
      const name = "codex-relaunch";
      const { token, session_id } = await registerViaHttp(h.port, name);
      // Model the stranded relaunch: live-<120s row, DEAD stored chain.
      seedStaleLive(h, name);
      expect(sid(h, name)).toBe(session_id);
      expect(pids(h, name)).toBe(DEAD_PIDS);

      // 1) LAUNCHER: non-force pre-register → live row → B2 collision → NO
      //    takeover, but the launcher STILL launches codex (best-effort).
      const launch = runLauncher(h, name, token);
      expect(launch.status, "launcher must not abort on a collision").toBe(0);
      expect(launch.launched, "launcher must still exec codex (deferral, not abort)").toBe(true);
      // The non-force collision did NOT touch the row.
      expect(sid(h, name)).toBe(session_id);
      expect(pids(h, name)).toBe(DEAD_PIDS);

      // 2) HOOK: no handoff marker (launcher deferred) → discover → discriminator
      //    ([999999] dead → relaunch) → CAS force with expected=session_id → wins.
      const r = runHook(h, name, token);
      expect(r.status, `hook stderr: ${r.stderr}`).toBe(0);

      expect(sid(h, name), "session_id must rotate — the hook's CAS force won").not.toBe(session_id);
      expect(sid(h, name).length).toBeGreaterThan(0);
      const refreshed = pids(h, name);
      expect(refreshed, "the dead [999999] chain must be replaced").not.toBe(DEAD_PIDS);
      expect(refreshed).toMatch(/^\[\d+(,\d+)*\]$/);
    } finally {
      stopHarness(h);
    }
  }, 30_000);
});
