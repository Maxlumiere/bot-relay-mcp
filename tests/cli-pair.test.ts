// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 7r — `relay pair <hub-url>` integration tests.
 *
 * Exercises the new CLI subcommand end-to-end against a live in-process
 * HTTP hub. Three canonical paths per spec §2.1:
 *
 *   (1) happy path  — no secret required → exit 0 + config snippet + token
 *   (2) unreachable — hub not running     → exit 1 + clear error on stderr
 *   (3) bad-secret  — hub 401-rejects     → exit 2 + no token emitted
 *
 * NOTE: pair.ts is a pure HTTP client. The hub IS the in-process server
 * this test starts. That means we MUST spawn the CLI as an async child
 * (not spawnSync) — spawnSync blocks the Node event loop, so the hub
 * cannot answer the child's curl and requests time out with status 000.
 * See tests/regression-plug-and-play.test.ts CANARY 6 for the same
 * discipline on the SessionStart hook.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import type { Server as HttpServer } from "http";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const RELAY_BIN = path.join(REPO_ROOT, "bin", "relay");

const TEST_ROOT = path.join(os.tmpdir(), "bot-relay-pair-test-" + process.pid);
const TEST_DB_PATH = path.join(TEST_ROOT, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;

const { startHttpServer } = await import("../src/transport/http.js");
const { closeDb } = await import("../src/db.js");

let server: HttpServer | null = null;
let baseUrl = "";

function resetRoot() {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
}

async function startHubWithEnv(extraEnv: Record<string, string | undefined>): Promise<{ url: string; port: number }> {
  // Apply env overrides + restart the server. startHttpServer reads the
  // config at call time via loadConfig, which reads process.env.
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  server = startHttpServer(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 80));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  return { url: baseUrl, port };
}

function stopHub() {
  try { server?.close(); } catch { /* ignore */ }
  server = null;
  closeDb();
}

async function runPair(args: string[], extraEnv: Record<string, string | undefined> = {}): Promise<{
  status: number;
  stdout: string;
  stderr: string;
}> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const child = spawn("node", [RELAY_BIN, "pair", ...args], { env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d.toString(); });
  child.stderr.on("data", (d) => { stderr += d.toString(); });
  const exitCode: number = await new Promise((resolve) => {
    const timeout = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve(-1); }, 15_000);
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve(code ?? -1);
    });
  });
  return { status: exitCode, stdout, stderr };
}

beforeEach(() => {
  resetRoot();
  // Ensure a clean env for every test — no bleed-through of secrets or tokens.
  delete process.env.RELAY_HTTP_SECRET;
  delete process.env.RELAY_AGENT_TOKEN;
  delete process.env.RELAY_ALLOW_LEGACY;
});

afterEach(() => {
  stopHub();
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  delete process.env.RELAY_HTTP_SECRET;
  delete process.env.RELAY_AGENT_TOKEN;
});

describe("v2.1 Phase 7r — relay pair CLI", () => {
  it("(1) happy path: no-secret hub → exit 0 + JSON snippet + X-Agent-Token + next-steps guidance", async () => {
    const { url } = await startHubWithEnv({ RELAY_HTTP_SECRET: undefined });
    const r = await runPair([url, "--name", "pair-test-agent", "--role", "tester", "--yes"]);
    expect(r.status, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toBe(0);
    // Hub reachability banner must mention version + protocol_version.
    expect(r.stdout).toMatch(/Hub reachable:/);
    expect(r.stdout).toMatch(/version:/);
    expect(r.stdout).toMatch(/protocol_version:/);
    // Config snippet must be valid JSON with the expected shape.
    const snippetMatch = r.stdout.match(/--- MCP client config snippet ---\n([\s\S]+?)\n--- end snippet ---/);
    expect(snippetMatch, `snippet markers not found in stdout:\n${r.stdout}`).not.toBeNull();
    const parsed = JSON.parse(snippetMatch![1]);
    expect(parsed["bot-relay"]).toBeDefined();
    expect(parsed["bot-relay"].type).toBe("http");
    expect(parsed["bot-relay"].url).toBe(`${url}/mcp`);
    const token = parsed["bot-relay"].headers["X-Agent-Token"];
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(20);
    // Next-steps block surfaces the token for operator persistence + the
    // remote-doctor follow-up.
    expect(r.stdout).toMatch(new RegExp(`RELAY_AGENT_TOKEN=${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    expect(r.stdout).toMatch(/relay doctor --remote/);
  });

  it("(2) hub unreachable: no daemon running → exit 1 + clear error on stderr", async () => {
    // Deliberately do NOT start a hub. 59999 is reserved for this test file.
    const r = await runPair(["http://127.0.0.1:59999", "--name", "unreachable-test", "--yes"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/cannot reach hub|hub health probe/);
  });

  it("(3) bad secret: hub requires secret, caller sends wrong one → exit 2 + no token emitted", async () => {
    const { url } = await startHubWithEnv({ RELAY_HTTP_SECRET: "the-correct-secret-is-32-chars!!!" });
    // --secret wrong-value + --yes → no prompt fallback → exit 2 on 401.
    const r = await runPair([url, "--name", "bad-secret-test", "--secret", "wrong-secret-is-at-least-32-chars", "--yes"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/authentication|rejected|secret/i);
    // No MCP client snippet on failure.
    expect(r.stdout).not.toMatch(/--- MCP client config snippet ---/);
  });
});
