// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.7 Tether Phase 4 — integration test: a long-idle SSE subscriber
 * does NOT get reaped while its stream is held open.
 *
 * Background: pre-Phase-4, an MCP HTTP client that subscribes via
 * `relay://inbox/<agent>` and then sits idle (no follow-up POSTs)
 * would be culled by the daemon's session reaper after the idle
 * threshold elapsed — observed externally as a smoke test
 * disconnecting ~5 min after connect. The Phase 4 fix tracks `openGetStreams` per
 * session and skips reaping while a GET is live.
 *
 * Strategy: spawn a real `node dist/index.js` daemon with the
 * test-mode env seam that cranks the reaper to 1 s tick + 2 s idle
 * threshold — making this test ~6 s instead of the production
 * 6 min wall-clock soak. Subscribe via MCP HTTP, wait long past the
 * 2 s threshold, then have a different process commit a row to the
 * shared DB and assert the original subscriber still receives the
 * notification. If the reaper culled despite an open GET, the
 * subscriber's stream would be dead and the notification would
 * never arrive — the assertion fails loudly.
 *
 * Test path matches shipped path: real subprocess daemon, real
 * `StreamableHTTPClientTransport`, real cross-process producer via
 * better-sqlite3 (same pattern as
 * tests/v2-7-tether-cross-process-notification.test.ts).
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { getFreePort } from "./_helpers/port.js";
import cp from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
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
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error(`HTTP daemon at :${port} did not become healthy within ${timeoutMs}ms`);
}

async function waitForCount(arr: unknown[], atLeast: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs && arr.length < atLeast) {
    await new Promise((res) => setTimeout(res, 25));
  }
}

async function writeFromAnotherProcess(
  dbPath: string,
  toAgent: string,
  fromAgent: string,
): Promise<{ code: number | null; stderr: string }> {
  const childScript = `
    const Database = require('better-sqlite3');
    const crypto = require('crypto');
    const dbPath = process.argv[process.argv.length - 1];
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    const to = ${JSON.stringify(toAgent)};
    const from = ${JSON.stringify(fromAgent)};
    const tx = db.transaction(() => {
      const id = crypto.randomUUID();
      db.prepare(
        "INSERT INTO messages (id, from_agent, to_agent, content, priority, status, created_at) VALUES (?, ?, ?, 'reaper-skip probe', 'normal', 'pending', datetime('now'))"
      ).run(id, from, to);
      db.prepare(
        "INSERT INTO inbox_events (agent_name, reason, created_at, source_pid) VALUES (?, 'message_received', datetime('now'), ?)"
      ).run(to, process.pid);
    });
    tx();
    db.close();
  `;
  return new Promise((resolve, reject) => {
    const child = cp.spawn(process.execPath, ["--input-type=commonjs", "-e", childScript, "--", dbPath]);
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("exit", (code) => resolve({ code, stderr }));
    child.on("error", reject);
  });
}

describe("v2.7 Tether Phase 4 — reaper skips sessions with open SSE GET stream", () => {
  it("subscriber idle past 2x reaper threshold still receives notifications (real-time, env-seam-accelerated)", async () => {
    const PORT = await getFreePort();
    const ROOT = path.join(os.tmpdir(), `v2-7-tether-reaper-${process.pid}-${Date.now()}`);
    if (fs.existsSync(ROOT)) fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
    const dbPath = path.join(ROOT, "relay.db");
    expect(fs.existsSync(DIST_INDEX), `missing ${DIST_INDEX} — run \`npm run build\` first`).toBe(true);

    const daemon = cp.spawn("node", [DIST_INDEX], {
      env: {
        ...process.env,
        RELAY_TRANSPORT: "http",
        RELAY_HTTP_PORT: String(PORT),
        RELAY_HTTP_HOST: "127.0.0.1",
        RELAY_HOME: ROOT,
        RELAY_DB_PATH: dbPath,
        RELAY_CONFIG_PATH: path.join(ROOT, "config.json"),
        RELAY_AGENT_TOKEN: "",
        RELAY_AGENT_NAME: "",
        // Env seam: crank the reaper down to 1 s tick + 2 s idle so a
        // ~6-second test exercises what would otherwise take ~6 min.
        RELAY_HTTP_REAPER_TEST_MODE: "1",
        RELAY_HTTP_REAPER_INTERVAL_MS: "1000",
        RELAY_HTTP_SESSION_IDLE_SECONDS: "2",
        RELAY_OUTBOX_POLL_MS: "50",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderrBuf = "";
    daemon.stderr!.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf-8");
    });

    try {
      await waitForHealth(PORT, 5000);

      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`));
      const client = new Client(
        { name: "v2-7-tether-reaper-test", version: "0.0.0" },
        { capabilities: {} },
      );
      const transportErrors: Error[] = [];
      transport.onerror = (err) => transportErrors.push(err);
      const notifications: { uri: string }[] = [];
      client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
        notifications.push({ uri: n.params.uri });
      });

      try {
        await client.connect(transport);
        await client.callTool({
          name: "register_agent",
          arguments: { name: "reaper-target", role: "tester", capabilities: [] },
        });
        await client.subscribeResource({ uri: "relay://inbox/reaper-target" });

        // Now sit idle WELL past the 2 s idle threshold. Pre-Phase-4 the
        // reaper would close the transport at ~3 s (next 1 s tick after
        // idle>2s). Post-fix it must skip because openGetStreams===1.
        await new Promise((res) => setTimeout(res, 4500)); // 4.5 s idle — 2.25× threshold

        // External cross-process write commits a row to the shared DB.
        // The Phase 3 outbox tail picks it up and dispatches to the
        // subscription registry. If the reaper culled our subscriber,
        // the notification arrives at a dead transport — observable as
        // either notifications stays empty OR transportErrors gains an
        // entry. Both surfaces are asserted.
        const w = await writeFromAnotherProcess(dbPath, "reaper-target", "external-writer");
        expect(w.code, `child writer failed: ${w.stderr}`).toBe(0);

        await waitForCount(notifications, 1, 3000);

        // Primary assertion: the long-idle subscriber received the
        // notification on its still-live SSE stream.
        expect(
          notifications.length,
          `notification did not reach long-idle subscriber. Daemon stderr tail:\n${stderrBuf.slice(-2500)}`,
        ).toBeGreaterThanOrEqual(1);
        expect(notifications[0].uri).toBe("relay://inbox/reaper-target");

        // Secondary assertion: no transport-level error fired. Pre-fix
        // a reaper-driven close surfaced as "SSE stream disconnected"
        // here.
        expect(
          transportErrors.length,
          `transport errors fired during the idle window (would indicate the reaper still culled). Errors: ${transportErrors.map((e) => e.message).join("; ")}`,
        ).toBe(0);

        // Tertiary: daemon stderr should NOT contain a reaping line for
        // our session. The debug log line fires at log.debug, so we
        // grep for the "reaping idle MCP session" prefix.
        expect(
          /\[http\] reaping idle MCP session /.test(stderrBuf),
          `daemon reaped a session despite open GET. Daemon stderr:\n${stderrBuf.slice(-2500)}`,
        ).toBe(false);
      } finally {
        try { await client.close(); } catch { /* */ }
      }
    } finally {
      daemon.kill("SIGTERM");
      await new Promise((res) => setTimeout(res, 200));
      try { daemon.kill("SIGKILL"); } catch { /* */ }
      fs.rmSync(ROOT, { recursive: true, force: true });
    }
  }, 25_000);

  it("env seam off: production defaults (30s floor on idle) still hold", async () => {
    // Smoke test for the env-seam discipline note: when
    // RELAY_HTTP_REAPER_TEST_MODE is unset and NODE_ENV != "test", the
    // 30 s floor on RELAY_HTTP_SESSION_IDLE_SECONDS applies. We can't
    // easily inspect the daemon's parsed config without a /admin
    // endpoint, so the more direct check is: the daemon's startup
    // doesn't error AND a basic ping works. Failure of this test would
    // mean my env-seam logic broke production parsing.
    const PORT = await getFreePort();
    const ROOT = path.join(os.tmpdir(), `v2-7-tether-reaper-prod-${process.pid}-${Date.now()}`);
    if (fs.existsSync(ROOT)) fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });

    const daemon = cp.spawn("node", [DIST_INDEX], {
      env: {
        ...process.env,
        RELAY_TRANSPORT: "http",
        RELAY_HTTP_PORT: String(PORT),
        RELAY_HTTP_HOST: "127.0.0.1",
        RELAY_HOME: ROOT,
        RELAY_DB_PATH: path.join(ROOT, "relay.db"),
        RELAY_CONFIG_PATH: path.join(ROOT, "config.json"),
        RELAY_AGENT_TOKEN: "",
        RELAY_AGENT_NAME: "",
        // Try to set a 1 s idle — production floor should keep this at 30 s.
        RELAY_HTTP_SESSION_IDLE_SECONDS: "1",
        // Critical: do NOT set RELAY_HTTP_REAPER_TEST_MODE. Explicitly
        // override NODE_ENV in case the test runner set it.
        NODE_ENV: "production",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      await waitForHealth(PORT, 5000);
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      expect(r.ok).toBe(true);
    } finally {
      daemon.kill("SIGTERM");
      await new Promise((res) => setTimeout(res, 200));
      try { daemon.kill("SIGKILL"); } catch { /* */ }
      fs.rmSync(ROOT, { recursive: true, force: true });
    }
  }, 10_000);
});
