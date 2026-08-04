// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.7.1 [HIGH] regression — dashboard `/api/send-message` MUST require
 * `from_agent_token` when `from` names a registered agent.
 *
 * Bug class (pre-v2.7.1): `src/transport/http.ts` dashboard
 * send_message handler treated `from_agent_token` as an OPTIONAL
 * defense-in-depth signal (v2.2.2 A1 was Option (a) audit-only).
 * Whoever held the dashboard's HTTP secret / session cookie could POST
 * `send_message` with any `from` field and impersonate any registered
 * agent across the relay's full message + task surface.
 *
 * Option A was selected on 2026-05-13 (security review synthesis): make
 * `from_agent_token` REQUIRED when `from` names a registered agent.
 * The dashboard secret + CSRF +
 * origin checks still cover access to the endpoint; the from-token
 * gate stops impersonation if those upstream checks ever leak
 * (stolen cookie, malicious browser extension, etc.).
 *
 * Test path: real `node dist/index.js` HTTP daemon subprocess. Hits
 * the dashboard /api/send-message endpoint directly (no MCP wrapping).
 * ADR-0006: the dashboard endpoint is operator-power — it requires a VERIFIED
 * dashboard secret + CSRF double-submit regardless of network position (no
 * loopback bypass). So the daemon is spawned WITH a dashboard secret and every
 * dashboard call drives the real operator handshake (operatorPost). The
 * from_agent_token impersonation gate is layered UNDERNEATH operator auth: an
 * authenticated operator with a missing/wrong from_agent_token is STILL 403
 * AUTH_FAILED; with the correct from_agent_token it is 200. Those assertions
 * are unchanged.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import cp from "child_process";
import { fileURLToPath } from "url";
import { getFreePort } from "./_helpers/port.js";
import { OPERATOR_SECRET, operatorPost } from "./_helpers/operator-auth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const DIST_INDEX = path.join(REPO_ROOT, "dist", "index.js");

interface DaemonHandle {
  port: number;
  proc: cp.ChildProcessWithoutNullStreams;
  root: string;
  stderr: () => string;
  kill: () => Promise<void>;
}

async function startDaemon(): Promise<DaemonHandle> {
  const port = await getFreePort();
  const root = path.join(os.tmpdir(), `v2-7-1-dash-imp-${process.pid}-${Date.now()}`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });

  expect(
    fs.existsSync(DIST_INDEX),
    `missing ${DIST_INDEX} — run \`npm run build\` first`,
  ).toBe(true);

  const proc = cp.spawn("node", [DIST_INDEX], {
    env: {
      ...process.env,
      RELAY_TRANSPORT: "http",
      RELAY_HTTP_PORT: String(port),
      RELAY_HTTP_HOST: "127.0.0.1",
      RELAY_HOME: root,
      RELAY_DB_PATH: path.join(root, "relay.db"),
      RELAY_CONFIG_PATH: path.join(root, "config.json"),
      RELAY_AGENT_TOKEN: "",
      RELAY_AGENT_NAME: "",
      // ADR-0006: operator-power endpoints require a verified dashboard secret.
      // /mcp stays open (no RELAY_HTTP_SECRET) so mcpRpc register still works.
      RELAY_DASHBOARD_SECRET: OPERATOR_SECRET,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderrBuf = "";
  proc.stderr.on("data", (c: Buffer) => { stderrBuf += c.toString("utf-8"); });

  const start = Date.now();
  while (Date.now() - start < 5000) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }

  return {
    port, proc, root,
    stderr: () => stderrBuf,
    kill: async () => {
      proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 200));
      try { proc.kill("SIGKILL"); } catch { /* */ }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

async function mcpRpc(port: number, tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  const parsed = dataLine ? JSON.parse(dataLine.slice(5).trim()) : JSON.parse(text);
  return JSON.parse(parsed.result.content[0].text);
}

async function dashSendMessage(port: number, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  // ADR-0006: authenticate as operator (dashboard secret + CSRF double-submit)
  // via the shipped handshake. The impersonation gate is layered underneath.
  const r = await operatorPost(port, "/api/send-message", body);
  return { status: r.status, json: (r.json ?? {}) as Record<string, unknown> };
}

describe("v2.7.1 [HIGH] — dashboard send_message impersonation gate", () => {
  let daemon: DaemonHandle | null = null;

  beforeEach(async () => {
    daemon = await startDaemon();
  });
  afterEach(async () => {
    if (daemon) { await daemon.kill(); daemon = null; }
  });

  it("dashboard POST with from=victim and NO from_agent_token → 403 AUTH_FAILED", async () => {
    // Register a victim so `from` resolves to a real row with a token_hash.
    const victim = await mcpRpc(daemon!.port, "register_agent", {
      name: "imp-victim",
      role: "tester",
      capabilities: [],
    });
    expect(victim.success).toBe(true);
    await mcpRpc(daemon!.port, "register_agent", {
      name: "imp-target",
      role: "tester",
      capabilities: [],
    });

    const r = await dashSendMessage(daemon!.port, {
      from: "imp-victim",
      to: "imp-target",
      content: "spoofed by attacker",
      priority: "normal",
    });
    expect(r.status).toBe(403);
    expect(r.json.success).toBe(false);
    expect(r.json.error_code).toBe("AUTH_FAILED");
  });

  it("dashboard POST with from=victim and WRONG from_agent_token → 403 AUTH_FAILED", async () => {
    await mcpRpc(daemon!.port, "register_agent", {
      name: "imp-victim-2",
      role: "tester",
      capabilities: [],
    });
    await mcpRpc(daemon!.port, "register_agent", {
      name: "imp-target-2",
      role: "tester",
      capabilities: [],
    });

    const r = await dashSendMessage(daemon!.port, {
      from: "imp-victim-2",
      to: "imp-target-2",
      content: "spoofed with wrong token",
      priority: "normal",
      from_agent_token: "totally-bogus-token-9999",
    });
    expect(r.status).toBe(403);
    expect(r.json.success).toBe(false);
    expect(r.json.error_code).toBe("AUTH_FAILED");
  });

  it("dashboard POST with from=victim and CORRECT from_agent_token → 200 success (positive control)", async () => {
    const victim = await mcpRpc(daemon!.port, "register_agent", {
      name: "imp-victim-3",
      role: "tester",
      capabilities: [],
    });
    const tok = victim.agent_token as string;
    await mcpRpc(daemon!.port, "register_agent", {
      name: "imp-target-3",
      role: "tester",
      capabilities: [],
    });

    const r = await dashSendMessage(daemon!.port, {
      from: "imp-victim-3",
      to: "imp-target-3",
      content: "legit send with correct from token",
      priority: "normal",
      from_agent_token: tok,
    });
    expect(r.status).toBe(200);
    expect(r.json.success).toBe(true);
    expect(typeof r.json.message_id).toBe("string");
  });

  it("X-From-Agent-Token header path: also enforces required-token (parity with body field)", async () => {
    const victim = await mcpRpc(daemon!.port, "register_agent", {
      name: "imp-victim-hdr",
      role: "tester",
      capabilities: [],
    });
    const tok = victim.agent_token as string;
    await mcpRpc(daemon!.port, "register_agent", {
      name: "imp-target-hdr",
      role: "tester",
      capabilities: [],
    });

    // Missing token via header → 403 (operator-authed, but impersonation gate fires).
    const noToken = await operatorPost(
      daemon!.port,
      "/api/send-message",
      { from: "imp-victim-hdr", to: "imp-target-hdr", content: "hdr no token", priority: "normal" },
    );
    expect(noToken.status).toBe(403);

    // Correct token via header → 200.
    const ok = await operatorPost(
      daemon!.port,
      "/api/send-message",
      { from: "imp-victim-hdr", to: "imp-target-hdr", content: "hdr correct token", priority: "normal" },
      { extraHeaders: { "X-From-Agent-Token": tok } },
    );
    expect(ok.status).toBe(200);
  });
});
