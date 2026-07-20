// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.16.4 — Codex cold-start launcher (bin/codex-relay) + the wrapper→hook
 * handoff.
 *
 * THE GAP: Codex runs its SessionStart hook's register at the FIRST TURN, not at
 * idle launch, so a freshly-summoned Codex has no host_shell_pids until the user
 * takes a turn → Tether can't PID-bind it. bin/codex-relay closes it by
 * pre-registering the handshake FROM THE SHELL, before exec'ing Codex.
 *
 * THE HANDOFF (codex-5-5's PR #98 audit): the wrapper's launch register + the
 * hook's first-turn register must NOT collide, must NOT reopen the duplicate-
 * live-session hole, and must let host_shell_pids + the exact agent_pid coexist.
 * Design:
 *   - Wrapper registers NON-force (a live same-name session correctly rejects it)
 *     and captures the registered session_id, exported as RELAY_LAUNCH_SESSION.
 *   - The hook SKIPS its register ONLY when that marker equals its OWN row's
 *     current session_id (proof THIS launch registered THIS row) — never on
 *     DB-state alone. agent_pid is NOT sent by the wrapper (the stdio server
 *     stamps the exact Codex process).
 *
 * These tests drive the REAL bin/codex-relay + hooks/codex/codex-session-start.sh
 * against a real daemon. The launcher is stubbed (RELAY_CODEX_LAUNCHER) so Codex
 * never starts.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import net from "net";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { getFreePort } from "./_helpers/port.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const LAUNCHER = path.join(REPO_ROOT, "bin", "codex-relay");
const HOOK = path.join(REPO_ROOT, "hooks", "codex", "codex-session-start.sh");
const DIST_INDEX = path.join(REPO_ROOT, "dist", "index.js");
const RANDOM_UUID = "00000000-dead-beef-0000-000000000000";

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

interface Harness {
  port: number;
  root: string;
  dbPath: string;
  daemon: ReturnType<typeof spawn>;
}

async function startHarness(label: string): Promise<Harness> {
  const port = await getFreePort();
  const root = path.join(os.tmpdir(), `v2-16-4-${label}-${process.pid}-${port}`);
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

/** Register an agent over HTTP; returns its token + fresh session_id + row state. */
async function registerViaHttp(
  port: number,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ token?: string; session_id?: string }> {
  const resp = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "register_agent", arguments: { name, role: "auditor", capabilities: [], ...args } },
    }),
  });
  const text = await resp.text();
  const dataLine = text.split("\n").map((l) => l.trim()).find((l) => l.startsWith("data:"));
  const payload = dataLine ? dataLine.slice(5).trim() : text.trim();
  const inner = JSON.parse(JSON.parse(payload).result.content[0].text) as {
    agent?: { session_id?: string };
    agent_token?: string;
  };
  return { token: inner.agent_token, session_id: inner.agent?.session_id };
}

/** Run bin/codex-relay for `name` with a stub launcher that records env+argv. */
function runLauncher(
  h: Harness,
  name: string,
  opts: { title?: string; extraArgs?: string[]; token?: string; port?: number; inheritedMarker?: string } = {},
): { res: ReturnType<typeof spawnSync>; argvFile: string; envFile: string } {
  const argvFile = path.join(h.root, `argv-${name}.txt`);
  const envFile = path.join(h.root, `env-${name}.txt`);
  const stub = path.join(h.root, `stub-${name}.sh`);
  fs.writeFileSync(
    stub,
    `#!/bin/bash\nprintf '%s\\n' "$@" > '${argvFile}'\nprintf 'RELAY_LAUNCH_SESSION=%s\\n' "\${RELAY_LAUNCH_SESSION:-<none>}" > '${envFile}'\n`,
    { mode: 0o755 },
  );
  const env: Record<string, string> = {
    HOME: h.root,
    PATH: process.env.PATH || "/usr/bin:/bin",
    RELAY_HOME: h.root,
    RELAY_DB_PATH: h.dbPath,
    RELAY_HTTP_HOST: "127.0.0.1",
    RELAY_HTTP_PORT: String(opts.port ?? h.port),
    RELAY_AGENT_ROLE: "auditor",
    RELAY_CODEX_LAUNCHER: stub,
  };
  if (opts.title !== undefined) env.RELAY_TERMINAL_TITLE = opts.title;
  if (opts.token) env.RELAY_AGENT_TOKEN = opts.token;
  // An inherited/leaked marker in the wrapper's own env — the wrapper must clear
  // it at entry and only re-export on its OWN successful register.
  if (opts.inheritedMarker !== undefined) env.RELAY_LAUNCH_SESSION = opts.inheritedMarker;
  const res = spawnSync("bash", [LAUNCHER, name, ...(opts.extraArgs ?? [])], {
    encoding: "utf-8",
    timeout: 15_000,
    env,
    input: "",
  });
  return { res, argvFile, envFile };
}

/** Run the SessionStart hook, optionally with a RELAY_LAUNCH_SESSION marker. */
function runHook(
  h: Harness,
  name: string,
  opts: { marker?: string; token?: string; title?: string } = {},
): ReturnType<typeof spawnSync> {
  const env: Record<string, string> = {
    HOME: h.root,
    PATH: process.env.PATH || "/usr/bin:/bin",
    RELAY_HOME: h.root,
    RELAY_DB_PATH: h.dbPath,
    RELAY_HTTP_HOST: "127.0.0.1",
    RELAY_HTTP_PORT: String(h.port),
    RELAY_AGENT_NAME: name,
    RELAY_AGENT_ROLE: "auditor",
  };
  if (opts.token) env.RELAY_AGENT_TOKEN = opts.token;
  if (opts.marker !== undefined) env.RELAY_LAUNCH_SESSION = opts.marker;
  if (opts.title !== undefined) env.RELAY_TERMINAL_TITLE = opts.title;
  return spawnSync("bash", [HOOK], { encoding: "utf-8", timeout: 12_000, env, input: "" });
}

const sid = (h: Harness, name: string) =>
  sql(h.dbPath, `SELECT IFNULL(session_id,'') FROM agents WHERE name='${name}';`);
const pids = (h: Harness, name: string) =>
  sql(h.dbPath, `SELECT IFNULL(host_shell_pids,'') FROM agents WHERE name='${name}';`);

describe("v2.16.4 — cold-start launcher + wrapper→hook handoff", () => {
  it("(W1) wrapper pre-registers host_shell_pids (incl. launching PID) + host_id, and exports session_id marker == the row's session_id", async () => {
    const h = await startHarness("w1");
    try {
      const name = "codex-w1";
      const { argvFile, envFile } = runLauncher(h, name, { title: "cold summon" });
      // host_shell_pids landed and contains this process's PID (the terminal shell Tether binds).
      const chain = JSON.parse(pids(h, name)) as number[];
      expect(chain).toContain(process.pid);
      // The exported marker equals the registered session_id (the handoff proof).
      expect(fs.existsSync(envFile)).toBe(true);
      const exported = fs.readFileSync(envFile, "utf-8").trim().replace("RELAY_LAUNCH_SESSION=", "");
      expect(exported).toMatch(/^[0-9a-fA-F-]{8,64}$/);
      expect(exported).toBe(sid(h, name));
      // Launcher was exec'd (Codex would have started here).
      expect(fs.existsSync(argvFile)).toBe(true);
    } finally {
      stopHarness(h);
    }
  }, 25_000);

  it("(H1) marker-MATCH → hook SKIPS its register (session_id unchanged, host_shell_pids preserved)", async () => {
    const h = await startHarness("h1");
    try {
      const name = "codex-h1";
      // Simulate the wrapper's launch register (fresh+live, with host_shell_pids).
      const { token, session_id } = await registerViaHttp(h.port, name, { host_shell_pids: [4242, 111], host_id: "GUID" });
      expect(session_id).toBeTruthy();
      const r = runHook(h, name, { marker: session_id!, token });
      expect(r.status, `hook stderr: ${r.stderr}`).toBe(0);
      // SKIPPED → session_id did NOT rotate; the wrapper's host_shell_pids stand.
      expect(sid(h, name)).toBe(session_id);
      expect(pids(h, name)).toBe("[4242,111]");
    } finally {
      stopHarness(h);
    }
  }, 25_000);

  it("(H2) marker-MISMATCH → hook REGISTERS (never skips on someone else's session — duplicate-live safety)", async () => {
    const h = await startHarness("h2");
    try {
      const name = "codex-h2";
      const { token, session_id } = await registerViaHttp(h.port, name, { host_shell_pids: [999], host_id: "GUID" });
      // Age the row out of the collision window so a legit re-register can land + rotate.
      sql(h.dbPath, `UPDATE agents SET last_seen='2020-01-01T00:00:00.000Z' WHERE name='${name}';`);
      // A WRONG marker (a different session) must NOT cause a skip.
      const r = runHook(h, name, { marker: RANDOM_UUID, token });
      expect(r.status, `hook stderr: ${r.stderr}`).toBe(0);
      // REGISTERED → session rotated off the seed; host_shell_pids = the hook's real chain.
      expect(sid(h, name)).not.toBe(session_id);
      expect(pids(h, name)).toMatch(/^\[\d+(,\d+)*\]$/);
    } finally {
      stopHarness(h);
    }
  }, 25_000);

  it("(H3) NO marker (plain codex / failed wrapper) → hook registers WITH host_shell_pids (fallback ordering)", async () => {
    const h = await startHarness("h3");
    try {
      const name = "codex-h3";
      const r = runHook(h, name); // no marker, no prior register → first-turn register
      expect(r.status, `hook stderr: ${r.stderr}`).toBe(0);
      expect(pids(h, name)).toMatch(/^\[\d+(,\d+)*\]$/);
      expect(sid(h, name).length).toBeGreaterThan(0);
    } finally {
      stopHarness(h);
    }
  }, 25_000);

  it("(H4) cross-agent leakage guard: a marker that is ANOTHER agent's session_id never makes this hook skip", async () => {
    const h = await startHarness("h4");
    try {
      // Agent B holds session SB.
      const b = await registerViaHttp(h.port, "codex-b", { host_shell_pids: [1], host_id: "GB" });
      // Agent A exists (stale) with its own session SA.
      const a = await registerViaHttp(h.port, "codex-a", { host_shell_pids: [2], host_id: "GA" });
      sql(h.dbPath, `UPDATE agents SET last_seen='2020-01-01T00:00:00.000Z' WHERE name='codex-a';`);
      // Run A's hook with B's session as the marker → must NOT skip (marker != A's row session).
      const r = runHook(h, "codex-a", { marker: b.session_id!, token: a.token });
      expect(r.status, `hook stderr: ${r.stderr}`).toBe(0);
      expect(sid(h, "codex-a")).not.toBe(a.session_id); // A registered (rotated), did not skip on B's session
    } finally {
      stopHarness(h);
    }
  }, 25_000);

  it("(H5) inherited/supplied marker is CLEARED on a failed LIVE-collision register (no cross-terminal skip)", async () => {
    const h = await startHarness("h5");
    try {
      const name = "codex-h5";
      const { token, session_id } = await registerViaHttp(h.port, name, { host_shell_pids: [7, 8], host_id: "G" });
      // Fresh, actively-held session → a non-force re-register collides (the real
      // duplicate-LIVE case; NOT an aged-out stale row).
      sql(h.dbPath, `UPDATE agents SET agent_status='idle', last_seen='${new Date().toISOString()}' WHERE name='${name}';`);
      // A 2nd launch INHERITS the live session id as a marker + has the token; its
      // non-force register collides. The wrapper must have UNSET the inherited marker
      // at entry, so the exec'd Codex gets NO marker → its hook won't skip the live row.
      const { envFile } = runLauncher(h, name, { token, inheritedMarker: session_id! });
      expect(
        fs.readFileSync(envFile, "utf-8"),
        "inherited marker must be cleared when this launch's register fails",
      ).toContain("RELAY_LAUNCH_SESSION=<none>");
      // The live row was NOT clobbered by the (correctly-rejected) non-force register.
      expect(sid(h, name)).toBe(session_id);
    } finally {
      stopHarness(h);
    }
  }, 25_000);

  it("(T1) daemon DOWN → wrapper still exec's Codex promptly, inherited marker cleared, none exported", async () => {
    const h = await startHarness("t1");
    try {
      const deadPort = await getFreePort(); // nothing listening
      const name = "codex-t1";
      const start = Date.now();
      // Seed an inherited marker: the wrapper must clear it even when the daemon is
      // down (register skipped early) — never leak it to Codex.
      const { res, argvFile, envFile } = runLauncher(h, name, {
        port: deadPort,
        inheritedMarker: "11111111-2222-3333-4444-555555555555",
      });
      const elapsed = Date.now() - start;
      expect(res.status, `stderr: ${res.stderr}`).toBe(0);
      expect(fs.existsSync(argvFile), "launcher must still exec when the daemon is down").toBe(true);
      expect(elapsed, "connection-refused fast-fail — no long delay").toBeLessThan(4000);
      expect(fs.readFileSync(envFile, "utf-8")).toContain("RELAY_LAUNCH_SESSION=<none>"); // no marker
    } finally {
      stopHarness(h);
    }
  }, 25_000);

  it("(T2) daemon HUNG (accepts, never responds) → wrapper exec's within the bounded timeout, no marker", async () => {
    const h = await startHarness("t2");
    const hung = net.createServer(() => { /* accept, never respond */ });
    try {
      const hungPort = await getFreePort();
      await new Promise<void>((r) => hung.listen(hungPort, "127.0.0.1", () => r()));
      const name = "codex-t2";
      const start = Date.now();
      const { res, argvFile, envFile } = runLauncher(h, name, {
        port: hungPort,
        inheritedMarker: "99999999-8888-7777-6666-555555555555",
      });
      const elapsed = Date.now() - start;
      expect(res.status, `stderr: ${res.stderr}`).toBe(0);
      expect(fs.existsSync(argvFile), "launcher must still exec against a hung daemon").toBe(true);
      // health --connect-timeout 1 --max-time 1 bounds the hang; must be well under the old ~4s path.
      expect(elapsed, "bounded-timeout, not unbounded 4s+").toBeLessThan(3500);
      expect(fs.readFileSync(envFile, "utf-8")).toContain("RELAY_LAUNCH_SESSION=<none>");
    } finally {
      hung.close();
      stopHarness(h);
    }
  }, 25_000);

  it("(X1) wrapper exec's the launcher with the per-agent -c identity override + forwards extra args", async () => {
    const h = await startHarness("x1");
    try {
      const name = "codex-x1";
      const { res, argvFile } = runLauncher(h, name, { extraArgs: ["--sandbox", "read-only"] });
      expect(res.status, `stderr: ${res.stderr}`).toBe(0);
      const argv = fs.readFileSync(argvFile, "utf-8").split("\n").filter(Boolean);
      const cIdx = argv.indexOf("-c");
      expect(cIdx).toBeGreaterThanOrEqual(0);
      expect(argv[cIdx + 1]).toBe(`mcp_servers.bot-relay.env.RELAY_AGENT_NAME="${name}"`);
      expect(argv).toContain("--sandbox");
      expect(argv).toContain("read-only");
    } finally {
      stopHarness(h);
    }
  }, 25_000);
});
