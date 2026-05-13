// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.6.x / Tether v0.1.1 Phase 2 — broadcast-trace instrumentation
 * validation.
 *
 * Phase 2 added temporary log lines at the daemon's subscribe →
 * emit → fan-out → sendResourceUpdated chain so the Tether VS Code
 * smoke can surface where notifications break inside Electron's fetch
 * runtime. This test runs the same Q-HTTP-1 flow against a real
 * `node dist/index.js` subprocess and asserts the trace lines fire in
 * the expected order. If a future refactor moves any instrumentation
 * site, this test fails loudly.
 *
 * Coverage: spawn → register → subscribe → send_message → wait for
 * notification → assert daemon stderr contains:
 *   1. "[broadcast-trace] resources/subscribe RPC arrived uri=..."
 *   2. "[broadcast-trace] subscribe added server=Sn uri=..."
 *   3. "[broadcast-trace] event emit agent=... reason=message_received"
 *   4. "[broadcast-trace] fanout enter agent=... uri=... subs_for_uri=N"
 *   5. "[broadcast-trace] notifying server=Sn uri=..."
 *   6. "[broadcast-trace] notify accepted server=Sn uri=..."
 *
 * Test path matches shipped path: real `node dist/index.js` subprocess,
 * real `StreamableHTTPClientTransport` (the SDK Tether uses), real
 * stderr capture. Per memory/feedback_test_path_must_match_shipped_path.md.
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
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error(`HTTP daemon at :${port} did not become healthy within ${timeoutMs}ms`);
}

describe("v2.6.x / Tether v0.1.1 Phase 2 — broadcast-trace instrumentation validation", () => {
  it("daemon stderr contains the full subscribe→emit→fanout→accept trace in correct order", async () => {
    const PORT = await getFreePort();
    const ROOT = path.join(os.tmpdir(), "v2-6-tether-trace-" + process.pid);
    if (fs.existsSync(ROOT)) fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
    expect(fs.existsSync(DIST_INDEX), `missing ${DIST_INDEX} — run \`npm run build\` first`).toBe(true);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawn } = require("child_process") as typeof import("child_process");
    const daemon = spawn("node", [DIST_INDEX], {
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
        // v2.7.0 — the per-event trace lines (resources/subscribe RPC
        // arrival, event emit, notifying, notify accepted) were
        // downgraded from info to debug as part of the Phase 2 trace
        // cleanup. This test still asserts the full chain order, so
        // bump the log level to surface them.
        RELAY_LOG_LEVEL: "debug",
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
        { name: "v2-6-tether-trace-test", version: "0.0.0" },
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

        // Register a target agent.
        const reg = await client.callTool({
          name: "register_agent",
          arguments: { name: "trace-target", role: "tester", capabilities: [] },
        });
        const regInner = JSON.parse((reg.content as { text: string }[])[0].text);
        expect(regInner.success).toBe(true);
        const targetToken = regInner.agent_token;

        // Subscribe to that agent's inbox.
        await client.subscribeResource({ uri: "relay://inbox/trace-target" });

        // Send a message to itself, triggering emitInboxChanged → fanout.
        const send = await client.callTool({
          name: "send_message",
          arguments: {
            from: "trace-target",
            to: "trace-target",
            content: "Phase 2 trace validation",
            agent_token: targetToken,
          },
        });
        const sendInner = JSON.parse((send.content as { text: string }[])[0].text);
        expect(sendInner.success).toBe(true);

        // Wait for the notification (proves the chain works end-to-end).
        const start = Date.now();
        while (Date.now() - start < 3000 && notifications.length === 0) {
          await new Promise((res) => setTimeout(res, 50));
        }
        expect(notifications.length).toBeGreaterThanOrEqual(1);
        expect(notifications[0].uri).toBe("relay://inbox/trace-target");
      } finally {
        try { await client.close(); } catch { /* */ }
      }

      // Now assert the trace lines appeared in stderr in the expected order.
      const expectedOrder = [
        /\[broadcast-trace\] resources\/subscribe RPC arrived uri=relay:\/\/inbox\/trace-target/,
        /\[broadcast-trace\] subscribe added server=S\d+ uri=relay:\/\/inbox\/trace-target/,
        /\[broadcast-trace\] event emit agent=trace-target reason=message_received/,
        /\[broadcast-trace\] fanout enter source=(bus|tail) agent=trace-target reason=message_received uri=relay:\/\/inbox\/trace-target/,
        /\[broadcast-trace\] notifying server=S\d+ uri=relay:\/\/inbox\/trace-target/,
        /\[broadcast-trace\] notify accepted server=S\d+ uri=relay:\/\/inbox\/trace-target/,
      ];

      let cursor = 0;
      const failures: string[] = [];
      for (const pattern of expectedOrder) {
        const remaining = stderrBuf.slice(cursor);
        const match = remaining.match(pattern);
        if (!match) {
          failures.push(`MISSING (or out of order): ${pattern}`);
          continue;
        }
        cursor += (match.index ?? 0) + match[0].length;
      }

      expect(
        failures.length,
        `daemon stderr missing trace lines (or wrong order):\n${failures.join("\n")}\n\n=== stderr (last 3KB) ===\n${stderrBuf.slice(-3000)}`,
      ).toBe(0);
    } finally {
      daemon.kill("SIGTERM");
      await new Promise((res) => setTimeout(res, 200));
      try { daemon.kill("SIGKILL"); } catch { /* */ }
      fs.rmSync(ROOT, { recursive: true, force: true });
    }
  }, 20_000);
});
