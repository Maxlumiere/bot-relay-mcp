// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.16.1 — the LOAD-BEARING autowake-token regression.
 *
 * The recurring failure: a launcher rotates the agent's token on relaunch, the
 * SessionStart hook rewrites the fresh token to the vault, but Tether keeps its
 * STALE SecretStorage copy and 401s → autowake dies until a manual "Set Agent
 * Token". This drives the SHIPPED Tether token-resolution path
 * (resolveTetherConfig + readVaultToken — the exact code readConfig runs on
 * every reconnect) against a REAL daemon:
 *
 *   1. mint watcher (vault T1). With SecretStorage holding a STALE token,
 *      resolveTetherConfig resolves the VAULT token T1 (not stale) → authenticates.
 *   2. ROTATE (force) → vault now T2; the daemon accepts only T2. SecretStorage
 *      is STILL stale.
 *   3. "Reconnect" = re-run resolveTetherConfig (readConfig re-reads the vault on
 *      every reconnect). It resolves T2 → authenticates. ZERO manual set. The
 *      stale SecretStorage token would have failed.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn, type ChildProcess } from "child_process";
import { fileURLToPath } from "url";
import { getFreePort } from "./_helpers/port.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DIST_INDEX = path.join(REPO_ROOT, "dist", "index.js");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "v2161-autowake-"));
process.env.RELAY_HOME = ROOT;
process.env.RELAY_DB_PATH = path.join(ROOT, "relay.db");
process.env.RELAY_CONFIG_PATH = path.join(ROOT, "config.json");
delete process.env.RELAY_AGENT_TOKEN; // no explicit env override → vault must win over SecretStorage
delete process.env.RELAY_AGENT_NAME;

const db = await import("../src/db.js");
const { stableMintOrReuse, forceRotateAndVault } = await import("../src/mint-reuse.js");
// The SHIPPED Tether resolution path (root vitest can import the ext seams).
const { resolveTetherConfig } = await import("../extensions/vscode/src/config.js");
const { readVaultToken } = await import("../extensions/vscode/src/vault-path.js");

const AGENT = "watcher";
const STALE_SECRET = "OLDsecretStorageTokenThatNoLongerAuthenticates11";

async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`daemon :${port} not healthy`);
}

/** POST health_check with the token; returns whether the daemon ACCEPTED it. */
async function tokenAuthenticates(port: number, token: string): Promise<boolean> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "X-Agent-Token": token },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "health_check", arguments: {} } }),
  });
  const text = await res.text();
  const dataLine = text.split("\n").map((l) => l.trim()).find((l) => l.startsWith("data:"));
  const inner = JSON.parse(JSON.parse(dataLine ? dataLine.slice(5).trim() : text).result.content[0].text);
  // health_check echoes token_validated:true + auth_error:boolean when a token is presented.
  return inner.token_validated === true && inner.auth_error === false;
}

/** The SHIPPED resolution readConfig runs (re-invoked on every reconnect). */
function resolveTetherToken(staleSecret: string): string {
  return resolveTetherConfig(
    (key) => (key === "agentName" ? AGENT : undefined),
    process.env as Record<string, string | undefined>,
    staleSecret, // SecretStorage — deliberately stale throughout
    true,
    (name) => readVaultToken(name, process.env as Record<string, string | undefined>, os.homedir(), () => {}),
  ).agentToken;
}

describe("v2.16.1 — autowake token auto-syncs across a rotation (shipped reconnect path)", () => {
  it("rotate + hook rewrites vault while SecretStorage stays stale → reconnect authenticates with the vault, ZERO manual set", async () => {
    expect(fs.existsSync(DIST_INDEX), "run npm run build first").toBe(true);
    const port = await getFreePort();
    let daemon: ChildProcess | null = null;
    try {
      // Mint the agent + vault (T1) in-process; the daemon shares the DB.
      const c = await stableMintOrReuse(AGENT, "builder", []);
      expect(c.status).toBe("created");
      const T1 = c.status === "created" ? c.token : "";

      daemon = spawn("node", [DIST_INDEX], {
        env: { ...process.env, RELAY_TRANSPORT: "http", RELAY_HTTP_PORT: String(port), RELAY_HTTP_HOST: "127.0.0.1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      await waitForHealth(port, 8000);

      // 1. SecretStorage is STALE, but resolution picks the VAULT (T1) + authenticates.
      expect(resolveTetherToken(STALE_SECRET), "vault must win over stale SecretStorage").toBe(T1);
      expect(await tokenAuthenticates(port, T1), "T1 (vault) must authenticate").toBe(true);
      expect(await tokenAuthenticates(port, STALE_SECRET), "the stale SecretStorage token must NOT authenticate").toBe(false);

      // 2. ROTATE — force-mint rewrites the vault to T2; the daemon now accepts only T2.
      db._resetLivenessProbeCacheForTests?.();
      const rot = await forceRotateAndVault(AGENT, "builder", []);
      const T2 = rot.token;
      expect(T2).not.toBe(T1);

      // 3. "Reconnect" = re-run the shipped resolution. SecretStorage is STILL
      //    stale; the vault re-read yields T2, which authenticates. No manual set.
      expect(resolveTetherToken(STALE_SECRET), "reconnect must re-read the rotated vault").toBe(T2);
      expect(await tokenAuthenticates(port, T2), "T2 (rotated vault) authenticates on reconnect").toBe(true);
      expect(await tokenAuthenticates(port, T1), "the pre-rotation token no longer authenticates").toBe(false);
    } finally {
      if (daemon) try { daemon.kill("SIGKILL"); } catch { /* */ }
      db.closeDb();
      fs.rmSync(ROOT, { recursive: true, force: true });
    }
  }, 40_000);
});
