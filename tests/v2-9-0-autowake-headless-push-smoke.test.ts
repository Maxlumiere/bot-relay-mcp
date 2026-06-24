// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.9.0 Ambient Wake — end-to-end autowake verification A.
 *
 * Headless deployment-shape proof that server-initiated push reaches
 * an MCP HTTP client via SSE within a real two-connection scenario,
 * AND a measurement of mail→push latency.
 *
 * Specifically answers a verification gate: "does server-initiated push reach an HTTP client in
 * deployment, the exact thing that was 100% broken pre-v2.5-R1
 * despite passing InMemoryTransport tests?" — with the added
 * constraint that the SEND path goes through `send_message` via a
 * second MCP HTTP client (mirroring the deployment scenario where
 * one agent dispatches to another via the MCP API), NOT via direct
 * SQLite write the way v2-7-tether-sse-keepalive-integration.test.ts
 * already proves.
 *
 * Test shape (compatible with the v2.7 integration pattern):
 *   1. Spawn HTTP daemon (`node dist/index.js`, `RELAY_TRANSPORT=http`)
 *      on a getFreePort port. Production-default keepalive enabled.
 *   2. Client A connects, registers as `autowake-receiver`,
 *      subscribes to `relay://inbox/autowake-receiver`.
 *   3. Client B connects, registers as `autowake-sender`.
 *   4. Capture send timestamp; B calls `send_message` to A.
 *   5. Capture push arrival timestamp inside A's
 *      `ResourceUpdatedNotificationSchema` handler.
 *   6. Assert: notification arrives within timeoutMs. Report latency.
 *
 * This is the verification gate (A) — if it FAILS, autowake doesn't
 * work in deployment regardless of what InMemoryTransport unit tests
 * report. If it PASSES, the cheap-polling-vs-push tradeoff in
 * `docs/ambient-wake.md` is grounded in measured fact.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import cp from "child_process";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { getFreePort } from "./_helpers/port.js";

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

interface NotificationCapture {
  uri: string;
  receivedAt: number;
}

async function waitForCount(
  notifications: NotificationCapture[],
  target: number,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (notifications.length < target && Date.now() - start < timeoutMs) {
    await new Promise((res) => setTimeout(res, 20));
  }
}

describe("v2.9.0 Ambient Wake — end-to-end autowake verification (A)", () => {
  it("MCP send_message from client B reaches subscribed client A via SSE push, latency measured", async () => {
    const PORT = await getFreePort();
    const ROOT = path.join(os.tmpdir(), `v2-9-autowake-${process.pid}-${Date.now()}`);
    if (fs.existsSync(ROOT)) fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
    expect(
      fs.existsSync(DIST_INDEX),
      `missing ${DIST_INDEX} — run \`npm run build\` first`,
    ).toBe(true);

    const daemon = cp.spawn("node", [DIST_INDEX], {
      env: {
        ...process.env,
        RELAY_TRANSPORT: "http",
        RELAY_HTTP_PORT: String(PORT),
        RELAY_HTTP_HOST: "127.0.0.1",
        RELAY_HOME: ROOT,
        RELAY_DB_PATH: path.join(ROOT, "relay.db"),
        RELAY_CONFIG_PATH: path.join(ROOT, "config.json"),
        // Empty so the daemon doesn't pick up the parent vitest's env.
        RELAY_AGENT_TOKEN: "",
        RELAY_AGENT_NAME: "",
        // Tight outbox poll so latency is bounded by the SSE/keepalive
        // ticking, not by the polling interval.
        RELAY_OUTBOX_POLL_MS: "50",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderrBuf = "";
    daemon.stderr!.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf-8");
    });

    let receiverClient: Client | null = null;
    let senderClient: Client | null = null;
    try {
      await waitForHealth(PORT, 5000);

      // --- Connection A: receiver (subscribes for push) ---
      const receiverTransport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${PORT}/mcp`),
      );
      receiverClient = new Client(
        { name: "v2-9-autowake-receiver", version: "0.0.0" },
        { capabilities: {} },
      );
      const notifications: NotificationCapture[] = [];
      receiverClient.setNotificationHandler(
        ResourceUpdatedNotificationSchema,
        (n) => {
          notifications.push({ uri: n.params.uri, receivedAt: Date.now() });
        },
      );
      await receiverClient.connect(receiverTransport);
      const receiverReg = (await receiverClient.callTool({
        name: "register_agent",
        arguments: {
          name: "autowake-receiver",
          role: "tester",
          capabilities: [],
        },
      })) as { content: Array<{ text: string }> };
      const receiverRegPayload = JSON.parse(receiverReg.content[0].text) as {
        success: boolean;
        agent_token?: string;
      };
      expect(receiverRegPayload.success).toBe(true);
      const receiverToken = receiverRegPayload.agent_token!;
      expect(receiverToken).toBeTruthy();
      await receiverClient.subscribeResource({
        uri: "relay://inbox/autowake-receiver",
      });

      // --- Connection B: sender (uses send_message to push) ---
      const senderTransport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${PORT}/mcp`),
      );
      senderClient = new Client(
        { name: "v2-9-autowake-sender", version: "0.0.0" },
        { capabilities: {} },
      );
      await senderClient.connect(senderTransport);
      const senderReg = (await senderClient.callTool({
        name: "register_agent",
        arguments: {
          name: "autowake-sender",
          role: "tester",
          capabilities: [],
        },
      })) as { content: Array<{ text: string }> };
      const senderRegPayload = JSON.parse(senderReg.content[0].text) as {
        success: boolean;
        agent_token?: string;
      };
      expect(senderRegPayload.success).toBe(true);
      const senderToken = senderRegPayload.agent_token!;
      expect(senderToken).toBeTruthy();

      // Brief settle so the subscription is fully wired before send. The
      // server registers the subscription on the resources/subscribe
      // RPC response — but the SSE GET stream that carries
      // notifications/resources/updated is established a tick later.
      // 100ms is generous; latency measurement still starts at the
      // send timestamp.
      await new Promise((res) => setTimeout(res, 100));

      // --- The measurement: B sends, A's notification handler captures ---
      const sentAt = Date.now();
      const send = (await senderClient.callTool({
        name: "send_message",
        arguments: {
          from: "autowake-sender",
          to: "autowake-receiver",
          content: "autowake verification A — push latency probe",
          priority: "normal",
          agent_token: senderToken,
        },
      })) as { content: Array<{ text: string }> };
      const sendPayload = JSON.parse(send.content[0].text) as {
        success: boolean;
      };
      expect(
        sendPayload.success,
        `send_message failed: ${JSON.stringify(sendPayload)}`,
      ).toBe(true);

      // Wait up to 5s for the push to arrive over SSE.
      await waitForCount(notifications, 1, 5000);

      // --- Assertions + latency report ---
      expect(
        notifications.length,
        `notifications/resources/updated did NOT arrive within 5s. ` +
          `Daemon stderr tail:\n${stderrBuf.slice(-2000)}`,
      ).toBeGreaterThanOrEqual(1);
      expect(notifications[0].uri).toBe("relay://inbox/autowake-receiver");

      const latencyMs = notifications[0].receivedAt - sentAt;
      // Report into the test stdout so the run captures the latency.
      // Vitest collects stderr-side reporter output too; both surface
      // in the gate run.
      // eslint-disable-next-line no-console
      console.log(
        `[v2.9.0 autowake A] mail→push latency: ${latencyMs}ms ` +
          `(send_message → notifications/resources/updated)`,
      );
      // Generous upper bound — anything reachable on local HTTP loopback
      // should be well under 1s. If push is broken, waitForCount above
      // would have timed out at 5s; this assertion just pins a sane
      // ceiling so a 4900ms "barely arrived" result doesn't silently
      // pass.
      expect(
        latencyMs,
        `latency ${latencyMs}ms exceeds 2000ms ceiling — push is functional but slow`,
      ).toBeLessThan(2000);
      // Optional: assert receiverToken was issued (sanity for the
      // register_agent path under HTTP — not strictly part of A, but
      // cheap to keep).
      expect(receiverToken.length).toBeGreaterThan(8);
    } finally {
      try { await receiverClient?.close(); } catch { /* */ }
      try { await senderClient?.close(); } catch { /* */ }
      daemon.kill("SIGTERM");
      await new Promise((res) => setTimeout(res, 200));
      try { daemon.kill("SIGKILL"); } catch { /* */ }
      fs.rmSync(ROOT, { recursive: true, force: true });
    }
  }, 20_000);
});
