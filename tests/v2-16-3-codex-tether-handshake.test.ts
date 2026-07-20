// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.16.3 P0 — Codex SessionStart hook sends the Tether v0.3 PID-handshake.
 *
 * THE BREAK this covers: Tether binds a VSCode terminal to an agent by PID,
 * host-scoped (pid-binding.ts requires the agent's registered `host_shell_pids`
 * AND a `host_id` matching this machine's GUID). The Claude hook
 * (check-relay.sh) has always sent them; the Codex hook
 * (codex/codex-session-start.sh) sent ONLY agent_pid — so Tether could not
 * PID-bind a Codex terminal and "Tether stopped waking Codex."
 *
 * P0 fix: relay_pid_chain() + relay_machine_guid() were moved to the shared
 * _vault-helpers.sh and the Codex hook now reports host_shell_pids + host_id +
 * terminal_title_ref, byte-parity with the Claude hook.
 *
 * This test invokes the ACTUAL hooks/codex/codex-session-start.sh as a
 * subprocess against a real `node dist/index.js` HTTP daemon and asserts the
 * handshake landed in the DB (register carried it). Test path == shipped path:
 * the seam under test is the bash hook itself, not a TS/SQL surrogate.
 *
 * INVARIANT (victra P0): the hook's host_id must equal this machine's GUID from
 * the SAME OS source the extension reader uses (host-identity.ts) — asserted
 * against machineGuid() below, which mirrors relay_machine_guid().
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
const CLAUDE_HOOK = path.join(REPO_ROOT, "hooks", "check-relay.sh");
const CODEX_HOOK = path.join(REPO_ROOT, "hooks", "codex", "codex-session-start.sh");
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

/** Single-value SQL read via the sqlite3 CLI (same tool the hooks use). */
function sql(dbPath: string, query: string): string {
  const r = spawnSync("sqlite3", [dbPath, query], { encoding: "utf-8", timeout: 5000 });
  if (r.status !== 0) throw new Error(`sqlite3 failed: ${r.stderr}`);
  return (r.stdout ?? "").trim();
}

/**
 * Machine GUID from the SAME OS sources as _vault-helpers.sh:relay_machine_guid()
 * (and extensions/vscode/src/host-identity.ts). Returns "" when the host has no
 * derivable GUID (e.g. a Linux CI box without /etc/machine-id) — the host_id
 * sub-assertion is then skipped, while the host_shell_pids assertion (the actual
 * PID-binding requirement) always runs.
 */
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
  const root = path.join(os.tmpdir(), `v2-16-3-codex-hs-${label}-${process.pid}`);
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

/** Invoke a SessionStart hook (Claude or Codex) for `name` — first register,
 *  no token (the daemon mints one). terminalTitle is exported when provided so
 *  the terminal_title_ref branch is exercised. */
function runHook(hook: string, h: Harness, name: string, terminalTitle?: string): ReturnType<typeof spawnSync> {
  const env: Record<string, string> = {
    HOME: h.root,
    PATH: process.env.PATH || "/usr/bin:/bin",
    RELAY_HOME: h.root,
    RELAY_AGENT_NAME: name,
    RELAY_AGENT_ROLE: "auditor",
    RELAY_AGENT_CAPABILITIES: "",
    RELAY_DB_PATH: h.dbPath,
    RELAY_HTTP_HOST: "127.0.0.1",
    RELAY_HTTP_PORT: String(h.port),
  };
  if (terminalTitle !== undefined) env.RELAY_TERMINAL_TITLE = terminalTitle;
  return spawnSync("bash", [hook], { encoding: "utf-8", timeout: 12_000, env, input: "" });
}

describe("v2.16.3 P0 — Codex SessionStart hook sends the Tether PID-handshake", () => {
  it("(C1) registers host_shell_pids + host_id so Tether can PID-bind a Codex terminal", async () => {
    const h = await startHarness("codex");
    try {
      const name = "codex-hs-agent";
      const r = runHook(CODEX_HOOK, h, name, "codex-hs-agent");
      expect(r.status, `codex hook stderr: ${r.stderr}`).toBe(0);

      // host_shell_pids: a real ancestry chain landed (the PID-binding requirement),
      // NOT null — pre-fix the Codex hook omitted this field entirely.
      const pids = sql(h.dbPath, `SELECT IFNULL(host_shell_pids,'') FROM agents WHERE name='${name}';`);
      expect(pids, "Codex hook must register host_shell_pids (was omitted pre-2.16.3)").toMatch(/^\[\d+(,\d+)*\]$/);

      // host_id: present, and equal to this machine's GUID from the SAME OS source
      // the extension uses (the byte-parity invariant).
      const hostId = sql(h.dbPath, `SELECT IFNULL(host_id,'') FROM agents WHERE name='${name}';`);
      const guid = machineGuid();
      if (guid) {
        expect(hostId, "Codex host_id must equal the machine GUID (host-identity.ts parity)").toBe(guid);
      } else {
        expect(hostId.length, "host_id present even when the test can't independently derive the GUID").toBeGreaterThan(0);
        // eslint-disable-next-line no-console
        console.warn("[C1] machine GUID unavailable on this host — host_id==GUID sub-assertion skipped; host_shell_pids assertion still proves the handshake");
      }

      // terminal_title_ref rides along when the launcher exports RELAY_TERMINAL_TITLE.
      const title = sql(h.dbPath, `SELECT IFNULL(terminal_title_ref,'') FROM agents WHERE name='${name}';`);
      expect(title).toBe("codex-hs-agent");
    } finally {
      stopHarness(h);
    }
  }, 25_000);

  it("(C2) Codex host_id is byte-identical to the Claude hook's host_id (shared helper, no drift)", async () => {
    const h = await startHarness("parity");
    try {
      const claudeName = "claude-parity";
      const codexName = "codex-parity";
      const rc = runHook(CLAUDE_HOOK, h, claudeName);
      expect(rc.status, `claude hook stderr: ${rc.stderr}`).toBe(0);
      const rx = runHook(CODEX_HOOK, h, codexName);
      expect(rx.status, `codex hook stderr: ${rx.stderr}`).toBe(0);

      const claudeHostId = sql(h.dbPath, `SELECT IFNULL(host_id,'') FROM agents WHERE name='${claudeName}';`);
      const codexHostId = sql(h.dbPath, `SELECT IFNULL(host_id,'') FROM agents WHERE name='${codexName}';`);
      // Both hooks resolve the GUID from the ONE shared relay_machine_guid() now,
      // so the two agents' host_ids agree on the same machine — the invariant that
      // stops host-scoped matching from silently failing across CLIs.
      if (machineGuid()) {
        expect(codexHostId).toBe(claudeHostId);
        expect(codexHostId.length).toBeGreaterThan(0);
      } else {
        // No derivable GUID: both should be empty (omitted) — still identical.
        expect(codexHostId).toBe(claudeHostId);
        // eslint-disable-next-line no-console
        console.warn("[C2] machine GUID unavailable — parity holds trivially (both empty)");
      }
    } finally {
      stopHarness(h);
    }
  }, 30_000);
});
