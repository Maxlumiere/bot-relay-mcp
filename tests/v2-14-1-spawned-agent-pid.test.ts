// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.14.1 — spawned/live agent_pid capture (makes presence real in prod).
 *
 * v2.13.0's liveness probe was inert in production: agent_pid was only populated
 * by the stdio MCP server's ancestry walk, but live agents register via the
 * SessionStart hook over HTTP (which sent host_shell_pids but NOT agent_pid),
 * and the HTTP daemon can't self-detect (its ancestry is launchd). This fixes:
 *   A. the hook computes + sends agent_pid (+ start-time), so every hook-
 *      registered agent captures it.
 *   B. SKIP_REGISTER only skips a live row that ALSO already has host_shell_pids.
 *   C. spawn pre-registers the child OFFLINE, so its first hook run re-registers
 *      (no name-collision) and fills its PIDs.
 *   D. LC_ALL=C so the hook-captured start-time matches the relay's probe.
 *
 * Runs the SHIPPED hook (hooks/check-relay.sh) as a subprocess against a real
 * HTTP daemon, mirroring tests/v2-11-0-hook-liveness-register.test.ts.
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
const HOOK = path.join(REPO_ROOT, "hooks", "check-relay.sh");
const DIST_INDEX = path.join(REPO_ROOT, "dist", "index.js");
const { isPidAlive, processStartedAt } = await import("../src/liveness.js");

async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return;
    } catch { /* not up */ }
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
  const root = path.join(os.tmpdir(), `v2-14-1-${label}-${process.pid}`);
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, "agents"), { recursive: true, mode: 0o700 });
  expect(fs.existsSync(DIST_INDEX), "dist/index.js missing — run npm run build").toBe(true);
  const dbPath = path.join(root, "relay.db");
  const daemon = spawn("node", [DIST_INDEX], {
    env: { ...process.env, RELAY_TRANSPORT: "http", RELAY_HTTP_PORT: String(port), RELAY_HTTP_HOST: "127.0.0.1", RELAY_HOME: root, RELAY_DB_PATH: dbPath, RELAY_CONFIG_PATH: path.join(root, "config.json"), RELAY_AGENT_TOKEN: "", RELAY_AGENT_NAME: "" },
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
async function mcp(port: number, name: string, args: Record<string, unknown>, token?: string): Promise<any> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  if (token) headers["X-Agent-Token"] = token;
  const resp = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await resp.text();
  const dataLine = text.split("\n").map((l) => l.trim()).find((l) => l.startsWith("data:"));
  const payload = dataLine ? dataLine.slice(5).trim() : text.trim();
  return JSON.parse(JSON.parse(payload).result.content[0].text);
}
async function registerAndGetToken(port: number, name: string): Promise<string> {
  const inner = await mcp(port, "register_agent", { name, role: "builder", capabilities: [] });
  expect(inner.agent_token).toMatch(/^[A-Za-z0-9_=.-]{8,128}$/);
  return inner.agent_token as string;
}
// Run the shipped hook. The hook's ancestry here is node(vitest)→…, and the
// default comm matcher includes `node`, so relay_agent_pid resolves this test's
// live node ancestor via comm (NOT via the repo path, which contains "Claude").
function runHook(h: Harness, name: string, token: string): ReturnType<typeof spawnSync> {
  return spawnSync("bash", [HOOK], {
    encoding: "utf-8", timeout: 12_000, input: "",
    env: {
      HOME: h.root, PATH: process.env.PATH || "/usr/bin:/bin", RELAY_HOME: h.root,
      RELAY_AGENT_NAME: name, RELAY_AGENT_ROLE: "builder", RELAY_AGENT_CAPABILITIES: "",
      RELAY_DB_PATH: h.dbPath, RELAY_HTTP_HOST: "127.0.0.1", RELAY_HTTP_PORT: String(h.port),
      RELAY_AGENT_TOKEN: token,
    },
  });
}

describe("v2.14.1 — hook agent_pid capture + spawn-window", () => {
  it("(A) an OFFLINE row (spawn pre-register state) → hook registers + fills agent_pid + host_shell_pids", async () => {
    const h = await startHarness("offline");
    try {
      const name = "spawned-child";
      const token = await registerAndGetToken(h.port, name);
      // Simulate spawn.ts's offline pre-register: session cleared, empty PIDs.
      sql(h.dbPath, `UPDATE agents SET session_id=NULL, agent_status='offline', host_shell_pids=NULL, agent_pid=NULL WHERE name='${name}';`);

      const r = runHook(h, name, token);
      expect(r.status, `hook stderr: ${r.stderr}`).toBe(0);

      // Register ran (offline → no collision): PIDs + agent_pid now populated.
      const chain = sql(h.dbPath, `SELECT IFNULL(host_shell_pids,'') FROM agents WHERE name='${name}';`);
      expect(chain).toMatch(/^\[\d+(,\d+)*\]$/);
      const agentPid = Number(sql(h.dbPath, `SELECT IFNULL(agent_pid,0) FROM agents WHERE name='${name}';`));
      expect(agentPid).toBeGreaterThan(0);
      expect(isPidAlive(agentPid)).toBe(true); // a real live ancestor process
      // the presence derivation reset offline→idle on re-register (comes up available).
      expect(sql(h.dbPath, `SELECT agent_status FROM agents WHERE name='${name}';`)).toBe("idle");
    } finally {
      stopHarness(h);
    }
  }, 25_000);

  it("(B) a populated LIVE row (session + host_shell_pids) → hook SKIPS (agent_pid untouched)", async () => {
    const h = await startHarness("live");
    try {
      const name = "live-builder";
      const token = await registerAndGetToken(h.port, name);
      sql(h.dbPath, `UPDATE agents SET session_id='SEED', last_seen='${new Date().toISOString()}', agent_status='idle', host_shell_pids='[999999]', agent_pid=12345 WHERE name='${name}';`);

      const r = runHook(h, name, token);
      expect(r.status, `hook stderr: ${r.stderr}`).toBe(0);

      // SKIP: nothing rotated/overwritten.
      expect(sql(h.dbPath, `SELECT session_id FROM agents WHERE name='${name}';`)).toBe("SEED");
      expect(sql(h.dbPath, `SELECT host_shell_pids FROM agents WHERE name='${name}';`)).toBe("[999999]");
      expect(sql(h.dbPath, `SELECT agent_pid FROM agents WHERE name='${name}';`)).toBe("12345");
    } finally {
      stopHarness(h);
    }
  }, 25_000);

  it("(D) the hook-captured start-time equals the relay's probe (LC_ALL=C parity)", () => {
    // Both the hook (relay_pid_start) and the relay (processStartedAt) run
    // `LC_ALL=C ps -o lstart=` for a PID → identical string → the stored token
    // matches at probe time (a locale drift would false-read the agent dead).
    const pid = process.pid;
    const hookForm = spawnSync("bash", ["-c", `LC_ALL=C ps -o lstart= -p ${pid} 2>/dev/null | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'`], { encoding: "utf-8" }).stdout.trim();
    const relayForm = processStartedAt(pid);
    expect(hookForm.length).toBeGreaterThan(0);
    expect(relayForm).toBe(hookForm);
  });
});
