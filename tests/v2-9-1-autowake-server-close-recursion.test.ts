// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.9.1 — autowake server-side transport.close() recursion regression
 * guard.
 *
 * Origin: the maintainer's live VS Code repro (2026-06-10) — Tether 0.2.0
 * connecting to a v2.9.0 HTTP daemon on 127.0.0.1:3777 crashed the
 * daemon with `RangeError: Maximum call stack size exceeded` repeating
 * ~530 times in unhandled-promise-rejection logs at the SDK's
 * `node_modules/@modelcontextprotocol/sdk/dist/esm/server/
 * webStandardStreamableHttp.js:639` (the closing brace of
 * `async close()` — V8 reports async rejection at the function's
 * declaration end).
 *
 * Root cause (confirmed against source 2026-06-10):
 *
 *   1. Daemon's stateful-init path at src/transport/http.ts:1504-1510
 *      set `transport.onclose = () => { ...; server.close().catch(()=>{}); }`.
 *   2. Server.close() inherits from Protocol.close at
 *      node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js:500-502:
 *        async close() { await this._transport?.close(); }
 *   3. That re-enters the transport's close(), which calls
 *      `this.onclose?.()` again → step 1's handler runs again → step 2
 *      again → infinite recursion → RangeError.
 *
 * Why the bug was latent through v2.5–v2.9.0:
 *   - The full client.close() teardown path used by my v2-9-0-autowake-
 *     headless-push-smoke test goes through a different SSE event-store
 *     cleanup that does NOT re-fire transport.onclose recursively.
 *   - InMemoryTransport unit tests don't hit the streamable-HTTP transport
 *     at all — same v2.5-R1 lesson the codebase already absorbed once.
 *   - Tether 0.2.0's connection lifecycle (specifically the SSE GET
 *     subscribe + the maxRetries:20 reconnection wrapper) triggers a
 *     server-side transport.close() that DOES enter the recursive chain.
 *
 * Fix at src/transport/http.ts:1504-1527 (v2.9.1): remove the
 * `server.close()` call from the transport.onclose handler. Keep the
 * `sessions.delete(id)` cleanup. Subscription cleanup is already wired
 * via the server.onclose hook at src/server.ts:262-272 (v2.5.0 Tether
 * Phase 1 Part S — fires from the transport-close path WITHOUT going
 * through Protocol.close).
 *
 * This test asserts the bug class can't reappear: spawn the daemon,
 * complete a normal connect+subscribe+close cycle, and confirm zero
 * RangeError / "Maximum call stack" / unhandled-rejection lines in
 * daemon stderr. If anyone re-introduces `server.close()` from
 * `transport.onclose` (or any other recursive close path), this test
 * fails loudly with the exact stack trace the maintainer saw.
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

describe("v2.9.1 — autowake server-side transport.close() recursion regression", () => {
  it("DELETE /mcp (Tether's session-termination path) does NOT trigger RangeError or unhandled rejections", async () => {
    const PORT = await getFreePort();
    const ROOT = path.join(os.tmpdir(), `v2-9-1-onclose-${process.pid}-${Date.now()}`);
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
        RELAY_AGENT_TOKEN: "",
        RELAY_AGENT_NAME: "",
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

      // Mirror Tether 0.2.0's transport construction shape — same
      // reconnectionOptions, same URL, same auth-token header injection
      // pattern. The point isn't to test Tether code; it's to exercise
      // the SAME server-side connect/subscribe/close lifecycle that
      // crashed the daemon in the maintainer's 2026-06-10 live repro.
      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${PORT}/mcp`),
        {
          reconnectionOptions: {
            initialReconnectionDelay: 1000,
            maxReconnectionDelay: 30_000,
            reconnectionDelayGrowFactor: 1.5,
            maxRetries: 20,
          },
        },
      );
      const client = new Client(
        { name: "v2-9-1-onclose-test", version: "0.0.0" },
        { capabilities: {} },
      );
      // Subscribe a notification handler — required to match Tether's
      // shape, even though we don't assert notifications in this test
      // (the assertion is "no crash", not "push delivered").
      client.setNotificationHandler(
        ResourceUpdatedNotificationSchema,
        () => { /* drain only */ },
      );

      await client.connect(transport);
      const reg = (await client.callTool({
        name: "register_agent",
        arguments: {
          name: "v2-9-1-onclose-target",
          role: "tester",
          capabilities: [],
        },
      })) as { content: Array<{ text: string }> };
      const regPayload = JSON.parse(reg.content[0].text) as { success: boolean };
      expect(regPayload.success).toBe(true);

      // Subscribe to wire the full SSE channel (Tether-like).
      await client.subscribeResource({
        uri: "relay://inbox/v2-9-1-onclose-target",
      });

      // Pull the session id off the transport — it's the same id the
      // daemon's sessions Map keyed the entry under.
      const sessionId = transport.sessionId;
      expect(
        sessionId,
        "session id missing — handshake did not complete",
      ).toBeTruthy();

      // Brief idle window so the daemon fully wires the stream.
      await new Promise((res) => setTimeout(res, 200));

      // THE TRIGGER — send DELETE /mcp with the mcp-session-id header.
      // This is the SDK's session-termination endpoint at
      // src/transport/http.ts:1691 which does
      //   `await session.transport.close()`
      // server-side. Pre-v2.9.1 that explicit close fired the daemon's
      // transport.onclose handler, which called server.close() →
      // Protocol.close() → transport.close() → handler again →
      // infinite recursion. Post-v2.9.1 the handler does NOT call
      // server.close(), breaking the cycle.
      const delResp = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
        method: "DELETE",
        headers: { "mcp-session-id": sessionId! },
      });
      expect(delResp.status, `DELETE /mcp returned ${delResp.status}`).toBe(204);

      // Give the daemon a moment to flush any post-close work + log
      // any RangeError if recursion fired.
      await new Promise((res) => setTimeout(res, 500));

      // The critical assertions — all about daemon stderr cleanliness.
      // If the recursion fires, stderr fills with hundreds of
      // RangeError stack traces (the maintainer saw ~530 lines).
      expect(
        stderrBuf,
        `daemon stderr contains RangeError (server-side transport.close recursion regressed). ` +
          `Stderr tail:\n${stderrBuf.slice(-2000)}`,
      ).not.toMatch(/RangeError/);
      expect(
        stderrBuf,
        `daemon stderr contains "Maximum call stack" (recursion regressed). ` +
          `Stderr tail:\n${stderrBuf.slice(-2000)}`,
      ).not.toMatch(/Maximum call stack/);
      expect(
        stderrBuf,
        `daemon stderr contains "unhandledRejection" accumulation. ` +
          `Stderr tail:\n${stderrBuf.slice(-2000)}`,
      ).not.toMatch(/unhandledRejection/i);
      // Daemon should still be healthy after the close cycle (not
      // wedged in an error loop).
      const healthAfter = await fetch(`http://127.0.0.1:${PORT}/health`);
      expect(healthAfter.ok, "/health stopped responding after close cycle").toBe(true);
    } finally {
      daemon.kill("SIGTERM");
      await new Promise((res) => setTimeout(res, 200));
      try { daemon.kill("SIGKILL"); } catch { /* */ }
      fs.rmSync(ROOT, { recursive: true, force: true });
    }
  }, 15_000);
});
