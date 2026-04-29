// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.5.0 R1 — Real-HTTP MCP subscription contract test.
 *
 * The R0 InMemoryTransport test (tests/v2-5-mcp-subscriptions.test.ts)
 * proved the in-process subscription pipeline works. Codex 5.5 R1 audit
 * caught that this is NOT the path the operator hits — the VSCode
 * extension subscribes over StreamableHTTPClientTransport, which requires
 * the daemon to expose a stateful GET /mcp SSE endpoint. Pre-v2.5 R0,
 * GET /mcp returned 405; the extension was structurally incapable of
 * receiving notifications/resources/updated frames.
 *
 * This test pins the SHIPPED-PATH contract by:
 *   1. Spawning the actual built `dist/index.js` daemon as a subprocess
 *      (no in-process Server reuse).
 *   2. Connecting via `StreamableHTTPClientTransport` (the same transport
 *      the VSCode extension uses).
 *   3. Subscribing to `relay://inbox/<X>`.
 *   4. Triggering a real send_message via tool call (which writes to
 *      the daemon's DB + emits an inbox-changed event in-daemon).
 *   5. Asserting a real `notifications/resources/updated` frame arrives
 *      end-to-end via the SSE GET stream.
 *
 * If the GET path 405s again, this test fails. If session cleanup
 * regresses, this test fails. If the SDK's session-id management drifts,
 * this test fails. That's the R1 contract.
 *
 * Q-HTTP-1 — subscribe → real frame arrives end-to-end on real HTTP
 * Q-HTTP-2 — cross-session isolation: subscriber for X doesn't see Y events
 * Q-HTTP-3 — DELETE /mcp closes the session and removes it from the cap
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "fs";
import path from "path";
import os from "os";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..");
const DIST_ENTRY = path.join(PROJECT_ROOT, "dist", "index.js");

interface DaemonHandle {
  child: ChildProcessWithoutNullStreams;
  port: number;
  baseUrl: string;
  tmpDir: string;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("findFreePort: server.address() not an AddressInfo"));
      }
    });
    srv.on("error", reject);
  });
}

async function waitForHealth(baseUrl: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/health`);
      if (r.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `daemon /health never came up at ${baseUrl} within ${timeoutMs}ms${lastErr ? `: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}` : ""}`,
  );
}

async function spawnDaemon(): Promise<DaemonHandle> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-relay-v25-http-"));
  const port = await findFreePort();
  const child = spawn(
    process.execPath,
    [DIST_ENTRY, "--transport=http", `--port=${port}`, "--host=127.0.0.1"],
    {
      env: {
        ...process.env,
        RELAY_DB_PATH: path.join(tmpDir, "relay.db"),
        RELAY_CONFIG_PATH: path.join(tmpDir, "config.json"),
        RELAY_HOME: tmpDir,
        // Tighten the cap + idle so Q-HTTP-3 can verify session reaping
        // without making the test slow.
        RELAY_HTTP_MAX_SESSIONS: "8",
        RELAY_HTTP_SESSION_IDLE_SECONDS: "60",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", () => {
    /* drain — the daemon logs to stderr; stdout is for MCP frames in stdio mode and unused in http mode */
  });
  child.stderr.on("data", (_chunk: Buffer) => {
    /* stderr drained in setup but not echoed; uncomment for debugging */
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);
  return { child, port, baseUrl, tmpDir };
}

async function tearDownDaemon(handle: DaemonHandle): Promise<void> {
  await new Promise<void>((resolve) => {
    handle.child.once("exit", () => resolve());
    handle.child.kill("SIGTERM");
    setTimeout(() => {
      handle.child.kill("SIGKILL");
      resolve();
    }, 2_000).unref?.();
  });
  fs.rmSync(handle.tmpDir, { recursive: true, force: true });
}

async function registerAgentViaHttp(
  baseUrl: string,
  name: string,
): Promise<{ agentToken: string }> {
  // Use the stateless POST path (no mcp-session-id header) so this fixture
  // doesn't depend on the stateful path under test. Body shape mirrors a
  // single-shot tools/call.
  const resp = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "register_agent",
        arguments: { name, role: "test", capabilities: [] },
      },
    }),
  });
  if (!resp.ok) {
    throw new Error(`register_agent HTTP ${resp.status}: ${await resp.text()}`);
  }
  // The stateless transport returns SSE-framed JSON-RPC (event: message\ndata: {...}).
  const raw = await resp.text();
  const dataLine = raw
    .split("\n")
    .find((line) => line.startsWith("data: "));
  if (!dataLine) {
    throw new Error(`register_agent: no SSE data frame in response: ${raw}`);
  }
  const rpc = JSON.parse(dataLine.slice(6)) as {
    result?: { content?: { text?: string }[] };
  };
  const text = rpc.result?.content?.[0]?.text;
  if (!text) throw new Error(`register_agent: missing result.content[0].text`);
  const inner = JSON.parse(text) as { agent_token?: string };
  if (!inner.agent_token) {
    throw new Error(`register_agent: response has no agent_token: ${text}`);
  }
  return { agentToken: inner.agent_token };
}

async function sendMessageViaHttp(
  baseUrl: string,
  from: string,
  fromToken: string,
  to: string,
  content: string,
): Promise<void> {
  const resp = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-Agent-Token": fromToken,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "send_message",
        arguments: { from, to, content },
      },
    }),
  });
  if (!resp.ok) {
    throw new Error(`send_message HTTP ${resp.status}: ${await resp.text()}`);
  }
  await resp.text(); // drain SSE
}

async function waitFor<T>(check: () => T | null, timeoutMs = 4_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  const final = check();
  if (final) return final;
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe("v2.5.0 R1 — real HTTP MCP subscriptions (Option A contract)", () => {
  let daemon: DaemonHandle;
  let aliceToken: string;

  beforeAll(async () => {
    daemon = await spawnDaemon();
    // Seed agents through the stateless path so subscription tests can
    // reference real DB rows. Alice is the sender; bob/carol are inbox
    // owners we subscribe to.
    aliceToken = (await registerAgentViaHttp(daemon.baseUrl, "alice")).agentToken;
    await registerAgentViaHttp(daemon.baseUrl, "bob");
    await registerAgentViaHttp(daemon.baseUrl, "carol");
  }, 15_000);

  afterAll(async () => {
    if (daemon) await tearDownDaemon(daemon);
  });

  it("(Q-HTTP-1) subscribe → real notifications/resources/updated frame arrives end-to-end on HTTP SSE", async () => {
    const transport = new StreamableHTTPClientTransport(new URL("/mcp", daemon.baseUrl));
    const client = new Client(
      { name: "v2.5-http-test", version: "0.0.0" },
      { capabilities: {} },
    );
    const notifications: { uri: string }[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
      notifications.push({ uri: n.params.uri });
    });
    try {
      await client.connect(transport);
      const inboxUri = `relay://inbox/${encodeURIComponent("bob")}`;
      await client.subscribeResource({ uri: inboxUri });

      // Trigger a real DB write via the stateless path (different transport)
      // so we prove the cross-session bus actually fans out.
      await sendMessageViaHttp(daemon.baseUrl, "alice", aliceToken, "bob", "real-http-frame");

      const got = await waitFor(() =>
        notifications.find((n) => n.uri === inboxUri) ?? null,
      );
      expect(got.uri).toBe(inboxUri);
    } finally {
      await client.close();
      await transport.close().catch(() => {});
    }
  }, 15_000);

  it("(Q-HTTP-2) cross-session isolation: subscriber for X is NOT woken by message to Y", async () => {
    const transport = new StreamableHTTPClientTransport(new URL("/mcp", daemon.baseUrl));
    const client = new Client(
      { name: "v2.5-http-iso", version: "0.0.0" },
      { capabilities: {} },
    );
    const notifications: { uri: string }[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
      notifications.push({ uri: n.params.uri });
    });
    try {
      await client.connect(transport);
      const bobUri = `relay://inbox/${encodeURIComponent("bob")}`;
      const carolUri = `relay://inbox/${encodeURIComponent("carol")}`;
      await client.subscribeResource({ uri: bobUri });

      await sendMessageViaHttp(daemon.baseUrl, "alice", aliceToken, "carol", "for-carol-only");
      // Settle window — long enough for any cross-talk to surface.
      await new Promise((r) => setTimeout(r, 400));
      const carolHits = notifications.filter((n) => n.uri === carolUri);
      const bobHits = notifications.filter((n) => n.uri === bobUri);
      expect(carolHits.length).toBe(0);
      expect(bobHits.length).toBe(0);
    } finally {
      await client.close();
      await transport.close().catch(() => {});
    }
  }, 15_000);

  it("(Q-HTTP-3) terminateSession closes the session — subsequent traffic on the id 404s", async () => {
    // Use the SDK's transport.terminateSession() (the spec-canonical
    // client DELETE) rather than a raw-fetch DELETE. Two earlier CI
    // attempts on Node 18 failed with "fetch failed → SocketError:
    // other side closed" because the stateful-initialize response is
    // SSE-framed (the server holds the stream open for future server-
    // to-client frames), and Node 18's undici keep-alive pool refuses
    // to free the socket cleanly when we abort manually mid-stream.
    // The SDK manages its own connection pool + abort sequencing,
    // which Q-HTTP-1 already proved works on Node 18.
    const transport = new StreamableHTTPClientTransport(new URL("/mcp", daemon.baseUrl));
    const client = new Client(
      { name: "v2.5-http-cleanup", version: "0.0.0" },
      { capabilities: {} },
    );
    await client.connect(transport);
    const sessionId = transport.sessionId;
    expect(typeof sessionId).toBe("string");
    expect((sessionId ?? "").length).toBeGreaterThan(0);

    // Send the canonical DELETE through the SDK so connection management
    // stays consistent end-to-end. Per the SDK doc:
    //   "Terminates the current session by sending a DELETE request to
    //    the server."
    await transport.terminateSession();

    // Verify the daemon-side map removal: a separate fetch (different
    // socket from the SDK's pool — Connection: close defends against
    // undici reuse on Node 18) with the now-defunct sessionId must 404.
    // This is the contract that catches a regression where transport
    // teardown is local-only and the server keeps the entry.
    const followup = await fetch(`${daemon.baseUrl}/mcp`, {
      method: "GET",
      headers: { "mcp-session-id": sessionId!, Connection: "close" },
    });
    expect(followup.status).toBe(404);

    // Cleanup the dead client gracefully.
    await client.close().catch(() => {});
  }, 15_000);
});
