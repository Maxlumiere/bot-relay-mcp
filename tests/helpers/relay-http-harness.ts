// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Shared real-HTTP-daemon harness for Tether integration tests.
 *
 * Introduced in v0.2.3 (Tether "Reliable Wake" — the catch-up-wake
 * integration test needs a real inbox snapshot off the SHIPPED HTTP
 * transport). Extracted as a reusable helper so the v0.2.4 keepalive
 * watchdog and the v0.3 PID-handshake integration tests reuse the SAME
 * daemon-spawn + MCP-client round-trip rather than re-inventing it (the
 * v2.5 R0 lesson: exercise the shipped HTTP daemon, not InMemory).
 *
 * Spawns the actual built `dist/index.js` daemon as a subprocess on a free
 * port with an isolated temp DB, and connects via the same
 * StreamableHTTPClientTransport the VSCode extension uses.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..", "..");
const DIST_ENTRY = path.join(PROJECT_ROOT, "dist", "index.js");

export interface DaemonHandle {
  child: ChildProcessWithoutNullStreams;
  port: number;
  baseUrl: string;
  tmpDir: string;
}

export async function findFreePort(): Promise<number> {
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

export async function waitForHealth(baseUrl: string, timeoutMs = 8000): Promise<void> {
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

export async function spawnDaemon(): Promise<DaemonHandle> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-relay-tether-harness-"));
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
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", () => {
    /* drain — http-mode daemon logs to stderr; stdout unused */
  });
  child.stderr.on("data", () => {
    /* drain — uncomment to debug daemon output */
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);
  return { child, port, baseUrl, tmpDir };
}

export async function tearDownDaemon(handle: DaemonHandle): Promise<void> {
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

/**
 * Parse a stateless POST /mcp response body. ADR-0005 #3 made the one-shot
 * (non-streaming) path reply with plain `application/json`; older SSE framing
 * (`event: message\ndata: {…}`) is still handled for stateful paths.
 */
function parseSseRpc(raw: string): { result?: { content?: { text?: string }[] } } {
  const dataLine = raw.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(dataLine ? dataLine.slice(6) : raw);
}

export async function registerAgentViaHttp(
  baseUrl: string,
  name: string,
): Promise<{ agentToken: string }> {
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
      params: { name: "register_agent", arguments: { name, role: "test", capabilities: [] } },
    }),
  });
  if (!resp.ok) throw new Error(`register_agent HTTP ${resp.status}: ${await resp.text()}`);
  const rpc = parseSseRpc(await resp.text());
  const text = rpc.result?.content?.[0]?.text;
  if (!text) throw new Error(`register_agent: missing result.content[0].text`);
  const inner = JSON.parse(text) as { agent_token?: string };
  if (!inner.agent_token) throw new Error(`register_agent: response has no agent_token: ${text}`);
  return { agentToken: inner.agent_token };
}

export async function sendMessageViaHttp(
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
      params: { name: "send_message", arguments: { from, to, content } },
    }),
  });
  if (!resp.ok) throw new Error(`send_message HTTP ${resp.status}: ${await resp.text()}`);
  await resp.text(); // drain SSE
}

export interface McpClientHandle {
  client: Client;
  transport: StreamableHTTPClientTransport;
  close: () => Promise<void>;
}

/** Connect a real MCP StreamableHTTP client (the same transport the VSCode
 *  extension uses) to the daemon. */
export async function connectMcpClient(baseUrl: string, label = "tether-harness"): Promise<McpClientHandle> {
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", baseUrl));
  const client = new Client({ name: label, version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return {
    client,
    transport,
    close: async () => {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    },
  };
}

export interface InboxSnapshotShape {
  agent_name: string;
  agent_known: boolean;
  pending_count: number;
  total_count: number;
  last_message_at: string | null;
  last_message_from: string | null;
  last_message_priority: string | null;
  last_message_preview: string | null;
  last_message_truncated: boolean;
}

/** Read + parse the `relay://inbox/<agent>` resource snapshot — the exact
 *  payload the VSCode extension's refreshSnapshot() consumes. */
export async function readInboxSnapshot(
  client: Client,
  agentName: string,
): Promise<InboxSnapshotShape> {
  const result = await client.readResource({
    uri: `relay://inbox/${encodeURIComponent(agentName)}`,
  });
  const first = result.contents[0];
  if (!first || !("text" in first) || typeof first.text !== "string") {
    throw new Error(`readInboxSnapshot: no text content for ${agentName}`);
  }
  return JSON.parse(first.text) as InboxSnapshotShape;
}
