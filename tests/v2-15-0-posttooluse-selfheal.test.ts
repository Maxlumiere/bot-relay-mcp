// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.15.0 — HOOK-LEVEL regression for the PostToolUse presence self-heal.
 *
 * Runs the SHIPPED hooks/post-tool-use-check.sh as a subprocess against a real
 * daemon and proves its self-heal gate keys on the FULL anchor (agent_pid AND
 * agent_pid_start), not just the PID: a row with the SAME agent_pid but a STALE
 * agent_pid_start is restamped to the correct start, and session_id is never
 * rotated (no read reflood). If the shell gate ever regresses to PID-only, the
 * stale start survives and this test fails.
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
const HOOK = path.join(REPO_ROOT, "hooks", "post-tool-use-check.sh");
const DIST_INDEX = path.join(REPO_ROOT, "dist", "index.js");
const STALE_START = "Mon Jan  1 00:00:00 2020";

async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch { /* */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`daemon :${port} not healthy in ${timeoutMs}ms`);
}
function sql(dbPath: string, query: string): string {
  const r = spawnSync("sqlite3", [dbPath, query], { encoding: "utf-8", timeout: 5000 });
  if (r.status !== 0) throw new Error(`sqlite3 failed: ${r.stderr}`);
  return (r.stdout ?? "").trim();
}
interface Harness { port: number; root: string; dbPath: string; daemon: ReturnType<typeof spawn>; }
async function startHarness(): Promise<Harness> {
  const port = await getFreePort();
  const root = path.join(os.tmpdir(), `v2-15-0-ptu-${process.pid}-${port}`);
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
async function registerAndToken(port: number, name: string): Promise<string> {
  const resp = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "register_agent", arguments: { name, role: "builder", capabilities: [] } } }),
  });
  const text = await resp.text();
  const dl = text.split("\n").map((l) => l.trim()).find((l) => l.startsWith("data:"));
  const inner = JSON.parse(JSON.parse(dl ? dl.slice(5).trim() : text).result.content[0].text);
  expect(inner.agent_token).toMatch(/^[A-Za-z0-9_=.-]{8,128}$/);
  return inner.agent_token as string;
}
function runPostToolUse(h: Harness, name: string, token: string): ReturnType<typeof spawnSync> {
  return spawnSync("bash", [HOOK], {
    encoding: "utf-8", timeout: 12_000, input: "",
    env: {
      HOME: h.root, PATH: process.env.PATH || "/usr/bin:/bin", RELAY_HOME: h.root,
      RELAY_AGENT_NAME: name, RELAY_DB_PATH: h.dbPath,
      RELAY_HTTP_HOST: "127.0.0.1", RELAY_HTTP_PORT: String(h.port), RELAY_AGENT_TOKEN: token,
    },
  });
}

describe("v2.15.0 — PostToolUse self-heal gates on the FULL (agent_pid, agent_pid_start) anchor", () => {
  it("same-PID + STALE start → hook restamps the correct start (NOT PID-only), session_id unchanged", async () => {
    const h = await startHarness();
    try {
      const name = "healme";
      const token = await registerAndToken(h.port, name);

      // Run 1: fresh row (agent_pid NULL) → the hook computes its own agent_pid
      // (ancestry comm=node) + start and self-heals via report_liveness.
      let r = runPostToolUse(h, name, token);
      expect(r.status, `hook stderr: ${r.stderr}`).toBe(0);
      const pid = sql(h.dbPath, `SELECT IFNULL(agent_pid,'') FROM agents WHERE name='${name}';`);
      const start0 = sql(h.dbPath, `SELECT IFNULL(agent_pid_start,'') FROM agents WHERE name='${name}';`);
      const sid0 = sql(h.dbPath, `SELECT IFNULL(session_id,'') FROM agents WHERE name='${name}';`);
      expect(Number(pid)).toBeGreaterThan(0); // captured a live ancestor pid
      expect(start0.length).toBeGreaterThan(0); // captured a real start-time

      // Corrupt ONLY the start-time (keep the SAME agent_pid) — a live process
      // that a PID-only gate would wrongly leave stale (→ read 'dead').
      sql(h.dbPath, `UPDATE agents SET agent_pid_start='${STALE_START}' WHERE name='${name}';`);

      // Run 2: the gate must notice the start-time mismatch (same pid) and restamp.
      r = runPostToolUse(h, name, token);
      expect(r.status, `hook stderr: ${r.stderr}`).toBe(0);
      const startAfter = sql(h.dbPath, `SELECT IFNULL(agent_pid_start,'') FROM agents WHERE name='${name}';`);
      const pidAfter = sql(h.dbPath, `SELECT IFNULL(agent_pid,'') FROM agents WHERE name='${name}';`);
      const sidAfter = sql(h.dbPath, `SELECT IFNULL(session_id,'') FROM agents WHERE name='${name}';`);

      expect(pidAfter).toBe(pid); // same process
      expect(startAfter).not.toBe(STALE_START); // ← the load-bearing bit: start WAS restamped
      expect(startAfter).toBe(start0); // back to the real current start
      expect(sidAfter).toBe(sid0); // report_liveness NEVER rotates session_id (no read reflood)
    } finally {
      stopHarness(h);
    }
  }, 30_000);

  it("steady state (anchor already correct) → the hook does NOT churn the row", async () => {
    const h = await startHarness();
    try {
      const name = "steady";
      const token = await registerAndToken(h.port, name);
      runPostToolUse(h, name, token); // heal once → anchor now correct
      const snap1 = sql(h.dbPath, `SELECT agent_pid||'|'||IFNULL(agent_pid_start,'')||'|'||IFNULL(session_id,'') FROM agents WHERE name='${name}';`);
      runPostToolUse(h, name, token); // second run — should be a no-op (matched anchor)
      const snap2 = sql(h.dbPath, `SELECT agent_pid||'|'||IFNULL(agent_pid_start,'')||'|'||IFNULL(session_id,'') FROM agents WHERE name='${name}';`);
      expect(snap2).toBe(snap1); // no restamp, no session rotation — zero churn
    } finally {
      stopHarness(h);
    }
  }, 30_000);
});
