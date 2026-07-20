// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.16.4 — Codex cold-start launcher (bin/codex-relay).
 *
 * THE GAP: Codex runs its SessionStart hook's register at the FIRST TURN, not at
 * idle launch, so a freshly-summoned Codex has no host_shell_pids until the user
 * takes a turn → Tether can't PID-bind it → the wake does nothing until you talk
 * to it. bin/codex-relay closes this by pre-registering the handshake FROM THE
 * SHELL, before exec'ing Codex.
 *
 * LOAD-BEARING INVARIANT (the whole ballgame): the pre-registered host_shell_pids
 * MUST contain the PID of the process that launched codex-relay — because that is
 * the terminal's controlling shell, i.e. the vscode.Terminal.processId Tether
 * reads. If it's absent, Tether can't bind. R1 asserts exactly that against a
 * real daemon.
 *
 * The launcher is stubbed (RELAY_CODEX_LAUNCHER) so Codex never actually starts.
 * Test path == shipped path: the seam is the real bin/codex-relay script.
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
const LAUNCHER = path.join(REPO_ROOT, "bin", "codex-relay");
const DIST_INDEX = path.join(REPO_ROOT, "dist", "index.js");

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

function sql(dbPath: string, query: string): string {
  const r = spawnSync("sqlite3", [dbPath, query], { encoding: "utf-8", timeout: 5000 });
  if (r.status !== 0) throw new Error(`sqlite3 failed: ${r.stderr}`);
  return (r.stdout ?? "").trim();
}

function machineGuid(): string {
  const plat = process.platform;
  if (plat === "darwin") {
    const r = spawnSync(
      "bash",
      ["-c", `ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null | sed -nE 's/.*"IOPlatformUUID" = "([^"]+)".*/\\1/p' | head -1`],
      { encoding: "utf-8" },
    );
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
  const root = path.join(os.tmpdir(), `v2-16-4-${label}-${process.pid}`);
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
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

/** Run bin/codex-relay for `name` with a stub launcher (Codex never starts).
 *  `launcher` is exec'd in place of `npx @openai/codex`. */
function runLauncher(
  h: Harness,
  name: string,
  launcher: string,
  extra: { title?: string; extraArgs?: string[] } = {},
): ReturnType<typeof spawnSync> {
  const env: Record<string, string> = {
    HOME: h.root,
    PATH: process.env.PATH || "/usr/bin:/bin",
    RELAY_HOME: h.root,
    RELAY_DB_PATH: h.dbPath,
    RELAY_HTTP_HOST: "127.0.0.1",
    RELAY_HTTP_PORT: String(h.port),
    RELAY_AGENT_ROLE: "auditor",
    RELAY_CODEX_LAUNCHER: launcher,
  };
  if (extra.title !== undefined) env.RELAY_TERMINAL_TITLE = extra.title;
  return spawnSync("bash", [LAUNCHER, name, ...(extra.extraArgs ?? [])], {
    encoding: "utf-8",
    timeout: 12_000,
    env,
    input: "",
  });
}

describe("v2.16.4 — bin/codex-relay pre-registers the handshake at launch", () => {
  it("(R1) registers host_shell_pids CONTAINING the launching shell PID (the terminal Tether binds), + host_id, before Codex starts", async () => {
    const h = await startHarness("register");
    try {
      const name = "codex-cold-1";
      // Stub the launcher with /usr/bin/true → Codex never starts; only the
      // pre-register runs. This node process is codex-relay's parent, i.e. the
      // stand-in for the terminal's controlling shell.
      const r = runLauncher(h, name, "/usr/bin/true", { title: "cold summon" });
      expect(r.status, `codex-relay stderr: ${r.stderr}`).toBe(0);

      const pids = sql(h.dbPath, `SELECT IFNULL(host_shell_pids,'') FROM agents WHERE name='${name}';`);
      expect(pids, "host_shell_pids must register at launch (the cold-start fix)").toMatch(/^\[\d+(,\d+)*\]$/);

      // THE load-bearing invariant: the chain contains the PID of the process that
      // launched codex-relay (== the terminal's controlling shell / Terminal.processId).
      const chain = JSON.parse(pids) as number[];
      expect(chain, "host_shell_pids must include the launching process PID so Tether can bind the terminal").toContain(process.pid);

      const guid = machineGuid();
      if (guid) {
        expect(sql(h.dbPath, `SELECT IFNULL(host_id,'') FROM agents WHERE name='${name}';`)).toBe(guid);
      }
      // The allowlisted title rode along.
      expect(sql(h.dbPath, `SELECT IFNULL(terminal_title_ref,'') FROM agents WHERE name='${name}';`)).toBe("cold summon");
    } finally {
      stopHarness(h);
    }
  }, 25_000);

  it("(R2) exec's the launcher with the per-agent -c identity override + forwards extra args", async () => {
    const h = await startHarness("exec");
    try {
      const name = "codex-cold-2";
      // A stub launcher that records its argv, so we can assert the -c override
      // and arg forwarding without starting Codex.
      const argvFile = path.join(h.root, "argv.txt");
      const stub = path.join(h.root, "stub-launcher.sh");
      fs.writeFileSync(stub, `#!/bin/bash\nprintf '%s\\n' "$@" > '${argvFile}'\n`, { mode: 0o755 });

      const r = runLauncher(h, name, stub, { extraArgs: ["--sandbox", "read-only"] });
      expect(r.status, `codex-relay stderr: ${r.stderr}`).toBe(0);
      expect(fs.existsSync(argvFile), "stub launcher should have been exec'd").toBe(true);
      const argv = fs.readFileSync(argvFile, "utf-8").split("\n").filter(Boolean);

      // -c immediately followed by the per-agent identity override (server env key).
      const cIdx = argv.indexOf("-c");
      expect(cIdx, "launcher must receive -c").toBeGreaterThanOrEqual(0);
      expect(argv[cIdx + 1]).toBe(`mcp_servers.bot-relay.env.RELAY_AGENT_NAME="${name}"`);
      // Extra args forwarded after the override.
      expect(argv).toContain("--sandbox");
      expect(argv).toContain("read-only");
    } finally {
      stopHarness(h);
    }
  }, 25_000);
});
