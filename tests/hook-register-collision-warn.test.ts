// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Silent-failure class (onboarding launch gate) — a first-spawn registration that
 * FAILS must announce itself.
 *
 * On a first spawn the agent has no token, so the hook's health_check auth probe
 * is skipped. The hook then calls register_agent. If that fails for a non-auth
 * reason — the realistic one is NAME_COLLISION_ACTIVE, another live agent already
 * holds the name — the daemon returns HTTP 200 with `isError:true` and NO
 * agent_token (identity.ts:126,135). The hook mints nothing, RELAY_AGENT_TOKEN
 * stays empty, and the response is swallowed (check-relay.sh:744-751 unless
 * RELAY_HOOK_DEBUG). The agent then reads mail fine via the sqlite3 path but every
 * SEND fails AUTH_FAILED — registered-looking, mute, unannounced.
 *
 * Uses a real `node dist/index.js` daemon (mirrors v2-11-0-hook-liveness-register)
 * so the collision is produced by the actual server, not a mock. The precondition
 * assertion proves the collision really happened (isError in the debug body) so a
 * missing warning can only mean "swallowed", never "no collision".
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { getFreePort } from "./_helpers/port.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(REPO_ROOT, "hooks", "check-relay.sh");
const DIST_INDEX = path.join(REPO_ROOT, "dist", "index.js");

async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`daemon at :${port} not healthy within ${timeoutMs}ms`);
}

interface Harness { port: number; root: string; dbPath: string; daemon: ReturnType<typeof spawn>; }

async function startHarness(label: string): Promise<Harness> {
  const port = await getFreePort();
  const root = path.join(os.tmpdir(), `hook-collide-${label}-${process.pid}`);
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

/** Register an agent over HTTP so it holds the name live (creates the row + a session). */
async function registerLive(port: number, name: string): Promise<void> {
  const resp = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "register_agent", arguments: { name, role: "builder", capabilities: [] } } }),
  });
  const text = await resp.text();
  expect(text, `register of "${name}" should have minted a token`).toMatch(/agent_token/);
}

/** Run the SHIPPED hook as a FIRST spawn (no token) for `name`, pointed at the daemon. */
function runHookNoToken(h: Harness, name: string, extraEnv: Record<string, string> = {}): { out: string } {
  const r = spawnSync("bash", [HOOK], {
    encoding: "utf-8", timeout: 12_000, input: "",
    env: {
      HOME: h.root, PATH: process.env.PATH || "/usr/bin:/bin", RELAY_HOME: h.root,
      RELAY_AGENT_NAME: name, RELAY_AGENT_ROLE: "builder", RELAY_AGENT_CAPABILITIES: "",
      RELAY_DB_PATH: h.dbPath, RELAY_HTTP_HOST: "127.0.0.1", RELAY_HTTP_PORT: String(h.port),
      RELAY_AGENT_TOKEN: "", // FIRST SPAWN — no token
      ...extraEnv,
    },
  });
  return { out: (r.stdout ?? "") + (r.stderr ?? "") };
}

describe("first-spawn registration failure must announce itself (NAME_COLLISION)", () => {
  it("a swallowed NAME_COLLISION leaves the agent mute — the hook must say so", async () => {
    const h = await startHarness("collide");
    try {
      // 1. Another agent already holds the name, live.
      await registerLive(h.port, "collide");

      // 2. PRECONDITION — a no-token register of the held name really collides
      //    (HTTP 200 + isError:true, no token). Proven via the debug body so a
      //    missing warning below can only mean "swallowed", never "no collision".
      const dbg = runHookNoToken(h, "collide", { RELAY_HOOK_DEBUG: "1" });
      expect(dbg.out, "precondition: the no-token register must collide (isError in body)")
        .toMatch(/isError|NAME_COLLISION|already registered and online/i);

      // 3. THE CONTRACT (RED-first): WITHOUT debug, the failure must be announced —
      //    an agent that cannot send must not look connected.
      const run = runHookNoToken(h, "collide");
      expect(run.out, "a swallowed NAME_COLLISION left the agent mute with NO announcement")
        .toMatch(/CANNOT SEND|registration failed|not able to send/i);
    } finally {
      stopHarness(h);
    }
  }, 30_000);

  it("a clean first spawn (unique name) mints a token and does NOT warn", async () => {
    const h = await startHarness("clean");
    try {
      const run = runHookNoToken(h, "fresh-unique-agent");
      // No collision → token minted → no failure banner.
      expect(run.out).not.toMatch(/CANNOT SEND|registration failed/i);
    } finally {
      stopHarness(h);
    }
  }, 30_000);
});
