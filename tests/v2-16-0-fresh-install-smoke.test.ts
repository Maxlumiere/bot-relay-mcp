// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.16.0 (gate 9) — fresh-install smoke: the ADOPTION acceptance bar.
 *
 * "A stranger on a fresh machine runs ONE command and it just works, and
 * re-running is always safe." This drives the REAL install → REAL Claude Code
 * config → REAL daemon → the SHIPPED SessionStart hook → the vault, and asserts
 * the whole loop is coherent + idempotent:
 *   1. `relay init` in a throwaway HOME writes config.json + ~/.claude.json
 *      (mcpServers) + ~/.claude/settings.json (SessionStart hook), all pointing
 *      at the right absolute paths.
 *   2. A SECOND init with UNRELATED canaries pre-seeded is a structural no-op —
 *      canaries preserved, no clobber, no duplicate hook.
 *   3. The daemon is reachable, and the shipped hook registers the config's
 *      default agent + writes a vault token that bcrypt-authenticates against
 *      the DB token_hash.
 *
 * The launchd daemon is skipped (RELAY_SKIP_DAEMON) — its logic is unit-tested;
 * here we start the daemon directly to exercise the register → vault loop.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import Database from "better-sqlite3";
import { getFreePort } from "./_helpers/port.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const RELAY_BIN = path.join(REPO_ROOT, "bin", "relay");
const DIST_INDEX = path.join(REPO_ROOT, "dist", "index.js");
const HOOK = path.join(REPO_ROOT, "hooks", "check-relay.sh");

async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return;
    } catch {
      /* not up */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`daemon :${port} not healthy in ${timeoutMs}ms`);
}

describe("v2.16.0 — fresh-install smoke (adoption acceptance bar)", () => {
  it("one command → correct Claude config → daemon → hook → vault matches DB hash; re-run is a no-op", async () => {
    expect(fs.existsSync(DIST_INDEX), "run npm run build first").toBe(true);
    const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "v2160-fresh-"));
    const port = await getFreePort();
    const dbPath = path.join(ROOT, "relay.db");
    const configPath = path.join(ROOT, "config.json");
    const claudeJson = path.join(ROOT, ".claude.json");
    const settings = path.join(ROOT, ".claude", "settings.json");
    const env = {
      ...process.env,
      HOME: ROOT,
      RELAY_HOME: ROOT,
      RELAY_DB_PATH: dbPath,
      RELAY_CONFIG_PATH: configPath,
      RELAY_CLAUDE_HOME: ROOT,
      RELAY_SKIP_DAEMON: "1",
    };
    const AGENT = "smoke-agent";
    let daemon: ChildProcess | null = null;

    try {
      // ---- 1. Fresh init on an empty HOME --------------------------------
      const r1 = spawnSync(
        "node",
        [RELAY_BIN, "init", "--yes", "--transport", "http", "--port", String(port), "--agent", AGENT],
        { env, encoding: "utf-8", timeout: 15_000 },
      );
      expect(r1.status, `init failed: ${r1.stderr}`).toBe(0);

      const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      expect(cfg.http_port).toBe(port);
      expect(cfg.transport).toBe("http");
      // v2.16.0 — a local (loopback) install OMITS http_secret entirely, so the
      // SessionStart hook can register without a 401 (and the config validator,
      // which rejects a short secret, is happy). Opt-in via --secret only.
      expect(cfg.http_secret).toBeUndefined();
      expect(cfg.default_agent_name).toBe(AGENT);

      const cj = JSON.parse(fs.readFileSync(claudeJson, "utf-8"));
      expect(cj.mcpServers["bot-relay"].command).toBe("node");
      expect(cj.mcpServers["bot-relay"].args[0]).toMatch(/\/dist\/index\.js$/); // absolute dist path

      const st = JSON.parse(fs.readFileSync(settings, "utf-8"));
      const ssCmd = st.hooks.SessionStart[0].hooks[0].command;
      expect(ssCmd).toMatch(/\/hooks\/check-relay\.sh$/); // absolute hook path
      expect(st.hooks.SessionStart[0].hooks[0].timeout).toBe(10);

      // ---- 2. Re-run with UNRELATED canaries → structural no-op ----------
      const cjWithCanary = JSON.parse(fs.readFileSync(claudeJson, "utf-8"));
      cjWithCanary.mcpServers["canary-server"] = { type: "stdio", command: "canary" };
      cjWithCanary.someUserSetting = "keep-me";
      fs.writeFileSync(claudeJson, JSON.stringify(cjWithCanary, null, 2));
      const stWithCanary = JSON.parse(fs.readFileSync(settings, "utf-8"));
      stWithCanary.hooks.Stop = [{ matcher: "*", hooks: [{ type: "command", command: "/u/stop.sh" }] }];
      fs.writeFileSync(settings, JSON.stringify(stWithCanary, null, 2));

      const r2 = spawnSync("node", [RELAY_BIN, "init", "--yes", "--transport", "http", "--port", String(port), "--agent", AGENT], {
        env,
        encoding: "utf-8",
        timeout: 15_000,
      });
      expect(r2.status, `2nd init failed: ${r2.stderr}`).toBe(0);

      const cj2 = JSON.parse(fs.readFileSync(claudeJson, "utf-8"));
      expect(cj2.mcpServers["canary-server"]).toEqual({ type: "stdio", command: "canary" }); // canary kept
      expect(cj2.someUserSetting).toBe("keep-me");
      expect(cj2.mcpServers["bot-relay"]).toEqual(cjWithCanary.mcpServers["bot-relay"]); // ours unchanged
      const st2 = JSON.parse(fs.readFileSync(settings, "utf-8"));
      expect(st2.hooks.Stop).toBeDefined(); // canary event kept
      expect(st2.hooks.SessionStart.length).toBe(1); // no duplicate SessionStart hook

      // ---- 3. Daemon reachable → shipped hook → vault matches DB hash -----
      daemon = spawn("node", [DIST_INDEX], {
        env: { ...env, RELAY_TRANSPORT: "http", RELAY_HTTP_PORT: String(port), RELAY_HTTP_HOST: "127.0.0.1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      await waitForHealth(port, 8000);

      // Run the SHIPPED hook WITHOUT RELAY_AGENT_NAME — it must resolve the
      // agent from config.default_agent_name, register over HTTP, and write the
      // vault. (Mirrors the stranger opening their first Claude terminal.)
      const hookEnv: Record<string, string> = {
        HOME: ROOT,
        PATH: process.env.PATH || "/usr/bin:/bin",
        RELAY_HOME: ROOT,
        RELAY_DB_PATH: dbPath,
        RELAY_CONFIG_PATH: configPath,
        RELAY_HTTP_HOST: "127.0.0.1",
        RELAY_HTTP_PORT: String(port),
      };
      const hook = spawnSync("bash", [HOOK], { encoding: "utf-8", timeout: 15_000, env: hookEnv, input: "" });
      expect(hook.stderr).toMatch(/using default agent name from config: smoke-agent/);

      // The vault now holds a plaintext token that authenticates against the
      // DB's bcrypt token_hash — the "it just works" credential.
      const vaultFile = path.join(ROOT, "agents", `${AGENT}.token`);
      expect(fs.existsSync(vaultFile), `hook must have written the vault: ${hook.stderr}`).toBe(true);
      const vaultToken = fs.readFileSync(vaultFile, "utf-8").trim();

      const rdb = new Database(dbPath, { readonly: true });
      let hash: string;
      try {
        const row = rdb.prepare("SELECT token_hash FROM agents WHERE name = ?").get(AGENT) as
          | { token_hash: string }
          | undefined;
        expect(row, "agent must be registered in the DB").toBeTruthy();
        hash = row!.token_hash;
      } finally {
        rdb.close();
      }
      expect(bcrypt.compareSync(vaultToken, hash), "vault token must authenticate against the DB hash").toBe(true);
    } finally {
      if (daemon) {
        try { daemon.kill("SIGKILL"); } catch { /* */ }
      }
      fs.rmSync(ROOT, { recursive: true, force: true });
    }
  }, 40_000);
});
