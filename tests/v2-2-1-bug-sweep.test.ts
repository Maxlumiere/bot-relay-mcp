// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.2.1 Part A bug-sweep regressions.
 *
 *   B1 — CLI parser Option A (unknown flag rejection, precedence, --help/--version)
 *   B2 — duplicate-name register race → NAME_COLLISION_ACTIVE + force override
 *   B3 — daemon non-TTY fallback (loud exit(3))
 *   B4 — get_messages since filter UX hint
 *   B5 — multi-IP DNS round-robin failover in deliverPinnedPost
 *
 * Each test file reboots its own state; cross-test isolation preserved by the
 * per-pid TEST_DB_DIR convention.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const DIST_INDEX = path.join(REPO_ROOT, "dist", "index.js");

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v221-bugs-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
delete process.env.RELAY_ALLOW_LEGACY;
delete process.env.RELAY_HTTP_SECRET;
delete process.env.RELAY_DASHBOARD_SECRET;
process.env.RELAY_ALLOW_PRIVATE_WEBHOOKS = "1"; // for B5 loopback receivers

const { parseCliFlags, applyCliToEnv, usage } = await import("../src/cli.js");
const { handleRegisterAgent } = await import("../src/tools/identity.js");
const { handleGetMessages } = await import("../src/tools/messaging.js");
const { handleSendMessage } = await import("../src/tools/messaging.js");
const { closeDb, getDb, registerAgent, sendMessage } = await import("../src/db.js");
const { ERROR_CODES } = await import("../src/error-codes.js");
const { deliverPinnedPost } = await import("../src/webhook-delivery.js");

function parseResult(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text);
}

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
}

beforeEach(() => cleanup());
afterEach(() => cleanup());

// ============================================================================
// B1 — CLI parser
// ============================================================================

describe("v2.2.1 B1 — CLI parser", () => {
  it("(B1.1) no args → empty flags, no error", () => {
    const r = parseCliFlags([]);
    expect(r.error).toBeNull();
    expect(r.help).toBe(false);
    expect(r.version).toBe(false);
    expect(r.flags).toEqual({});
  });

  it("(B1.2) --transport=http --port=3777 → parsed", () => {
    const r = parseCliFlags(["--transport=http", "--port=3777"]);
    expect(r.error).toBeNull();
    expect(r.flags.transport).toBe("http");
    expect(r.flags.port).toBe(3777);
  });

  it("(B1.3) --transport http --port 3777 (space-separated) → parsed", () => {
    const r = parseCliFlags(["--transport", "http", "--port", "3777"]);
    expect(r.error).toBeNull();
    expect(r.flags.transport).toBe("http");
    expect(r.flags.port).toBe(3777);
  });

  it("(B1.4) unknown flag → error with exit code 2", () => {
    const r = parseCliFlags(["--unknown"]);
    expect(r.error).not.toBeNull();
    expect(r.error!.exitCode).toBe(2);
    expect(r.error!.message).toMatch(/Unknown flag/);
  });

  it("(B1.5) invalid --transport value → error", () => {
    const r = parseCliFlags(["--transport=carrier-pigeon"]);
    expect(r.error).not.toBeNull();
    expect(r.error!.message).toMatch(/Invalid value for --transport/);
  });

  it("(B1.6) --port out of range → error", () => {
    const r = parseCliFlags(["--port=99999"]);
    expect(r.error).not.toBeNull();
    expect(r.error!.message).toMatch(/\[1, 65535\]/);
  });

  it("(B1.7) --help → help=true, no error", () => {
    const r = parseCliFlags(["--help"]);
    expect(r.error).toBeNull();
    expect(r.help).toBe(true);
  });

  it("(B1.8) --version → version=true, no error", () => {
    const r = parseCliFlags(["--version"]);
    expect(r.error).toBeNull();
    expect(r.version).toBe(true);
  });

  it("(B1.9) applyCliToEnv: CLI > env precedence", () => {
    const env: NodeJS.ProcessEnv = { RELAY_TRANSPORT: "stdio", RELAY_HTTP_PORT: "1234" };
    const sources = applyCliToEnv({ transport: "http", port: 3777 }, env);
    expect(env.RELAY_TRANSPORT).toBe("http");
    expect(env.RELAY_HTTP_PORT).toBe("3777");
    expect(sources.transport).toBe("cli");
    expect(sources.http_port).toBe("cli");
  });

  it("(B1.10) applyCliToEnv: no CLI → env preserved, source=env", () => {
    const env: NodeJS.ProcessEnv = { RELAY_TRANSPORT: "http" };
    const sources = applyCliToEnv({}, env);
    expect(env.RELAY_TRANSPORT).toBe("http");
    expect(sources.transport).toBe("env");
  });

  it("(B1.11) applyCliToEnv: no CLI + no env → source=default", () => {
    const env: NodeJS.ProcessEnv = {};
    const sources = applyCliToEnv({}, env);
    expect(sources.transport).toBe("default");
  });

  it("(B1.12) usage text mentions every flag + precedence rule", () => {
    const text = usage();
    expect(text).toContain("--transport");
    expect(text).toContain("--port");
    expect(text).toContain("--host");
    expect(text).toContain("--config");
    expect(text).toContain("--help");
    expect(text).toContain("--version");
    expect(text).toMatch(/CLI.*env.*config.*default/i);
  });
});

// ============================================================================
// B2 — Duplicate-name register race
// ============================================================================

describe("v2.2.1 B2 — duplicate-name register race", () => {
  it("(B2.1) re-register on actively-held name without force → NAME_COLLISION_ACTIVE", () => {
    registerAgent("racer", "r", []);
    const r = handleRegisterAgent({
      name: "racer",
      role: "r2",
      capabilities: [],
      managed: false,
    } as any);
    const body = parseResult(r);
    expect(body.success).toBe(false);
    expect(body.error_code).toBe(ERROR_CODES.NAME_COLLISION_ACTIVE);
    expect(body.existing_session_id).toBeTruthy();
  });

  it("(B2.2) re-register WITH force=true → succeeds + rotates session_id", () => {
    const first = registerAgent("racer-2", "r", []);
    const r = handleRegisterAgent({
      name: "racer-2",
      role: "r",
      capabilities: [],
      managed: false,
      force: true,
    } as any);
    const body = parseResult(r);
    expect(body.success).toBe(true);
    expect(body.agent.session_id).not.toBe(first.agent.session_id);
  });

  it("(B2.3) re-register after the row goes stale (last_seen > 120s ago) → succeeds without force", () => {
    registerAgent("stale-racer", "r", []);
    // Backdate last_seen to 300s ago so the check treats the row as stale.
    const past = new Date(Date.now() - 300_000).toISOString();
    getDb()
      .prepare("UPDATE agents SET last_seen = ? WHERE name = ?")
      .run(past, "stale-racer");
    const r = handleRegisterAgent({
      name: "stale-racer",
      role: "r",
      capabilities: [],
      managed: false,
    } as any);
    const body = parseResult(r);
    expect(body.success).toBe(true);
  });
});

// ============================================================================
// B3 — daemon non-TTY fallback (exit(3))
// ============================================================================

describe("v2.2.1 B3 — daemon non-TTY fallback", () => {
  it("(B3.1) stdio transport + non-TTY stdin → exit(3) with actionable message", () => {
    // Run the built binary with RELAY_TRANSPORT=stdio explicitly. stdin is
    // piped from the test harness (non-TTY by definition), so the guard
    // should fire. We feed empty JSON on stdin so the MCP stdio stream
    // doesn't hang; the guard exits BEFORE the MCP handshake regardless.
    const r = spawnSync(
      "node",
      [DIST_INDEX],
      {
        encoding: "utf8",
        timeout: 5_000,
        input: "",
        env: {
          ...process.env,
          RELAY_TRANSPORT: "stdio",
          RELAY_DB_PATH: TEST_DB_PATH,
          RELAY_SKIP_TTY_CHECK: undefined as any, // ensure unset
        },
      }
    );
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/Transport is stdio but stdin is not a TTY/);
    expect(r.stderr).toMatch(/RELAY_TRANSPORT=http/);
  });

  it("(B3.2) stdio transport + RELAY_SKIP_TTY_CHECK=1 → guard bypassed", () => {
    // With the skip env set, the guard doesn't fire. The stdio transport
    // then starts its MCP handshake; we kill it via a short timeout.
    const r = spawnSync(
      "node",
      [DIST_INDEX],
      {
        encoding: "utf8",
        timeout: 500, // force SIGTERM before MCP does anything
        input: "",
        env: {
          ...process.env,
          RELAY_TRANSPORT: "stdio",
          RELAY_DB_PATH: TEST_DB_PATH,
          RELAY_SKIP_TTY_CHECK: "1",
        },
      }
    );
    // Exit code is whatever the kill-by-timeout produces, NOT 3.
    expect(r.status).not.toBe(3);
    expect(r.stderr).not.toMatch(/Transport is stdio but stdin is not a TTY/);
  });
});

// ============================================================================
// B4 — get_messages since UX hint
// ============================================================================

describe("v2.2.1 B4 — get_messages since UX hint", () => {
  it("(B4.1) status=pending + count=0 + since<24h → hint present", () => {
    registerAgent("hinter", "r", []);
    // No messages seeded; mailbox empty.
    const r = handleGetMessages({
      agent_name: "hinter",
      status: "pending",
      limit: 20,
      since: "15m",
    } as any);
    const body = parseResult(r);
    expect(body.count).toBe(0);
    expect(body.hint).toBeTruthy();
    expect(body.hint).toMatch(/since='all'|since='24h'/);
  });

  it("(B4.2) status=pending + count>0 → NO hint (operator has results)", () => {
    registerAgent("sender", "r", []);
    registerAgent("hinter-2", "r", []);
    sendMessage("sender", "hinter-2", "fresh", "normal");
    const r = handleGetMessages({
      agent_name: "hinter-2",
      status: "pending",
      limit: 20,
      since: "1h",
    } as any);
    const body = parseResult(r);
    expect(body.count).toBe(1);
    expect(body.hint).toBeUndefined();
  });

  it("(B4.3) status=pending + count=0 + since='all' → NO hint (already unfiltered)", () => {
    registerAgent("hinter-3", "r", []);
    const r = handleGetMessages({
      agent_name: "hinter-3",
      status: "pending",
      limit: 20,
      since: "all",
    } as any);
    const body = parseResult(r);
    expect(body.count).toBe(0);
    expect(body.hint).toBeUndefined();
  });

  it("(B4.4) status=read + count=0 + since<24h → NO hint (the nudge is pending-specific)", () => {
    registerAgent("hinter-4", "r", []);
    const r = handleGetMessages({
      agent_name: "hinter-4",
      status: "read",
      limit: 20,
      since: "15m",
    } as any);
    const body = parseResult(r);
    expect(body.count).toBe(0);
    expect(body.hint).toBeUndefined();
  });
});

// ============================================================================
// B5 — multi-IP DNS round-robin
// ============================================================================

describe("v2.2.1 B5 — multi-IP DNS round-robin failover", () => {
  it("(B5.1) first IP refused + second succeeds → deliver wins on the second attempt", async () => {
    // Start a live receiver on 127.0.0.1, then try pinning to [0.0.0.1,
    // 127.0.0.1]. 0.0.0.1 on loopback refuses the connect; the failover
    // rolls to 127.0.0.1 and succeeds.
    //
    // Note: 0.0.0.1 is an INVALID-route address on loopback; TCP connect
    // to it returns ECONNREFUSED or EHOSTUNREACH depending on platform,
    // both of which are in the retryable-error list. Functionally it's
    // "a pinned IP that doesn't serve," which is what the B5 failover
    // semantic needs to cover.
    const receiver = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.end("ok-from-live");
    });
    await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", () => r()));
    const port = (receiver.address() as { port: number }).port;

    try {
      const result = await deliverPinnedPost({
        url: `http://example.invalid:${port}/webhook`,
        pinnedIp: "0.0.0.1",
        pinnedIps: ["0.0.0.1", "127.0.0.1"],
        headers: {},
        body: "{}",
        timeoutMs: 2000,
      });
      expect(result.statusCode).toBe(200);
      expect(result.bodyText).toBe("ok-from-live");
    } finally {
      receiver.close();
    }
  });

  it("(B5.2) all IPs refused → final error surfaced (not a silent success)", async () => {
    const result = await deliverPinnedPost({
      url: `http://example.invalid:1/webhook`,
      pinnedIp: "127.0.0.1",
      pinnedIps: ["127.0.0.1", "127.0.0.1", "127.0.0.1"],
      headers: {},
      body: "{}",
      timeoutMs: 1500,
    });
    expect(result.statusCode).toBeNull();
    expect(result.error).toBeTruthy();
  });

  it("(B5.3) non-retryable error (server 5xx) → no failover loop, returns immediately", async () => {
    let callCount = 0;
    const receiver = http.createServer((_req, res) => {
      callCount++;
      res.statusCode = 500;
      res.end("internal");
    });
    await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", () => r()));
    const port = (receiver.address() as { port: number }).port;

    try {
      const result = await deliverPinnedPost({
        url: `http://example.invalid:${port}/webhook`,
        pinnedIp: "127.0.0.1",
        pinnedIps: ["127.0.0.1", "127.0.0.1", "127.0.0.1"],
        headers: {},
        body: "{}",
        timeoutMs: 2000,
      });
      expect(result.statusCode).toBe(500);
      // 500 is a real HTTP response — no point rolling to replicas.
      expect(callCount).toBe(1);
    } finally {
      receiver.close();
    }
  });
});
