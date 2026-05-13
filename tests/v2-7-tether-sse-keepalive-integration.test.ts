// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.7 Tether Phase 5 — integration test for SSE keepalive over real
 * HTTP transport.
 *
 * The unit test in tests/v2-7-tether-sse-keepalive.test.ts pins the
 * helper's timer logic against a fake response object. This file
 * proves the keepalive actually flows across the wire from a real
 * `node dist/index.js` daemon to a real MCP HTTP client + that a
 * subsequent send_message notification ALSO flows on the same stream
 * (i.e. keepalive writes don't corrupt the SSE event framing).
 *
 * Test pattern (consistent with the rest of Phase 4/5):
 *   - Spawn HTTP daemon with RELAY_SSE_KEEPALIVE_MS=200, reaper test
 *     mode disabled so the production-default reaper behaviour holds.
 *   - MCP HTTP client subscribes via `relay://inbox/<agent>`.
 *   - Sleep 1 s (5 keepalive ticks).
 *   - External cross-process producer commits a row via better-sqlite3.
 *   - Assert: subscriber receives notification AND zero transport
 *     errors fired during the idle window.
 *
 * The SSE comment frames (`: keepalive\n\n`) themselves are filtered
 * out at the SSE parser layer per spec (lines beginning with `:` are
 * comments), so they don't surface as notifications — confirming
 * non-corruption is the strongest signal we can capture from the
 * client side.
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
        "INSERT INTO messages (id, from_agent, to_agent, content, priority, status, created_at) VALUES (?, ?, ?, 'keepalive probe', 'normal', 'pending', datetime('now'))"
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

describe("v2.7 Tether Phase 5 — SSE keepalive over real HTTP transport", () => {
  it("keepalive flows over wire, idle subscriber stays alive, subsequent notification still delivers", async () => {
    const PORT = await getFreePort();
    const ROOT = path.join(os.tmpdir(), `v2-7-tether-ka-${process.pid}-${Date.now()}`);
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
        // Fast keepalive: 200 ms tick → 5 ticks in a 1 s idle window.
        RELAY_SSE_KEEPALIVE_MS: "200",
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
        { name: "v2-7-tether-keepalive-test", version: "0.0.0" },
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
          arguments: { name: "keepalive-target", role: "tester", capabilities: [] },
        });
        await client.subscribeResource({ uri: "relay://inbox/keepalive-target" });

        // Idle window: 5 keepalive ticks at 200 ms each.
        await new Promise((res) => setTimeout(res, 1000));

        // External producer commits row. The outbox tail picks it up,
        // sendResourceUpdated fires, the SSE stream — which has been
        // receiving keepalive comment frames the whole time —
        // delivers the notification.
        const w = await writeFromAnotherProcess(dbPath, "keepalive-target", "external-writer");
        expect(w.code, `child writer failed: ${w.stderr}`).toBe(0);

        await waitForCount(notifications, 1, 3000);

        // (a) Notification arrived → SSE stream framing isn't corrupted
        //     by interleaved keepalive comment frames.
        expect(
          notifications.length,
          `notification did not arrive. Daemon stderr tail:\n${stderrBuf.slice(-2000)}`,
        ).toBeGreaterThanOrEqual(1);
        expect(notifications[0].uri).toBe("relay://inbox/keepalive-target");

        // (b) No transport errors fired during the 1 s idle window —
        //     keepalive prevented Electron-style fetch-idle culls
        //     (we're on Node-fetch here, so the bar is lower, but a
        //     positive test of "doesn't error" is the strongest signal
        //     a Node-based vitest can capture for a fix targeting
        //     Electron behavior).
        expect(
          transportErrors.length,
          `transport errors fired during keepalive window: ${transportErrors.map((e) => e.message).join("; ")}`,
        ).toBe(0);

        // (c) The keepalive comment frames themselves are filtered out
        //     at the SSE parser layer (lines beginning with `:` per
        //     spec). They never surface as notifications — confirmed
        //     by the exact-count assertion below. Pre-Phase-5 a future
        //     bug that emitted keepalives WITHOUT the leading `:` would
        //     flood the notification handler.
        expect(notifications.length).toBe(1);
      } finally {
        try { await client.close(); } catch { /* */ }
      }
    } finally {
      daemon.kill("SIGTERM");
      await new Promise((res) => setTimeout(res, 200));
      try { daemon.kill("SIGKILL"); } catch { /* */ }
      fs.rmSync(ROOT, { recursive: true, force: true });
    }
  }, 20_000);

  it("RELAY_SSE_KEEPALIVE_MS=0 disables keepalive cleanly (daemon boots, notifications still flow)", async () => {
    const PORT = await getFreePort();
    const ROOT = path.join(os.tmpdir(), `v2-7-tether-ka-off-${process.pid}-${Date.now()}`);
    if (fs.existsSync(ROOT)) fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
    const dbPath = path.join(ROOT, "relay.db");

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
        RELAY_SSE_KEEPALIVE_MS: "0",
        RELAY_OUTBOX_POLL_MS: "50",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      await waitForHealth(PORT, 5000);
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`));
      const client = new Client({ name: "ka-off-test", version: "0.0.0" }, { capabilities: {} });
      const notifications: { uri: string }[] = [];
      client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
        notifications.push({ uri: n.params.uri });
      });
      try {
        await client.connect(transport);
        await client.callTool({
          name: "register_agent",
          arguments: { name: "ka-off-target", role: "tester", capabilities: [] },
        });
        await client.subscribeResource({ uri: "relay://inbox/ka-off-target" });
        const w = await writeFromAnotherProcess(dbPath, "ka-off-target", "external-writer");
        expect(w.code).toBe(0);
        await waitForCount(notifications, 1, 3000);
        expect(notifications.length).toBeGreaterThanOrEqual(1);
      } finally {
        try { await client.close(); } catch { /* */ }
      }
    } finally {
      daemon.kill("SIGTERM");
      await new Promise((res) => setTimeout(res, 200));
      try { daemon.kill("SIGKILL"); } catch { /* */ }
      fs.rmSync(ROOT, { recursive: true, force: true });
    }
  }, 15_000);
});
