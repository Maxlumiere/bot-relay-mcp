// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v0.4.1 — Tether auto-reconnect on daemon restart (the acceptance bar).
 *
 * THE DEFECT: a daemon restart (launchctl kickstart, run after every
 * publish/update) drops Tether's SSE connection. Pre-v0.4.1 a clean restart
 * that ended the SSE as a quiet close (onclose), or a silently-swallowed SSE
 * death, left Tether wedged at "connected" until the operator ran "Tether:
 * Reconnect to Relay" by hand. For a shipped product that manual step is
 * unacceptable.
 *
 * THE ACCEPTANCE BAR: kill + restart the REAL daemon, send mail
 * DURING the outage, and assert Tether re-subscribes and delivers EXACTLY ONE
 * wake with ZERO manual reconnect — driving the SHIPPED path, not a proxy.
 *
 * HOW THIS DRIVES THE SHIPPED PATH: it wires the exact VSCode-free seams
 * extension.ts wires — ConnectionLifecycle (the onclose guard + mid-connect
 * ordering), wireTransportDiagnostics (onerror + onClose sinks), the
 * ReconnectSupervisor (indefinite backoff), and subscribeInboxes + WakeGate
 * (re-subscribe + catch-up wake) — against a REAL `node dist/index.js` HTTP
 * daemon over a REAL StreamableHTTPClientTransport. Only two things are
 * test-authored, and both mirror extension.ts exactly: `connectFn` (the
 * connect() body) and `readSnapshot` (extension.ts's refreshSnapshot — reads
 * the relay://inbox/<agent> MCP resource). The supervisor's backoff timer is
 * injected (controllable) so the reconnect fires deterministically instead of
 * racing wall-clock — the same injection reconnect-supervisor.test.ts uses.
 *
 * The onclose-vs-onerror discrimination + the mid-connect race are unit-proven
 * in connection-lifecycle.test.ts (L1–L7); this test proves the end-to-end
 * recovery + catch-up wake against a real daemon regardless of which signal
 * the drop surfaces as.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import cp from "child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getFreePort } from "./_helpers/port.js";

import { ConnectionLifecycle } from "../extensions/vscode/src/connection-lifecycle.js";
import { ReconnectSupervisor } from "../extensions/vscode/src/reconnect-supervisor.js";
import { RestartPolicy } from "../extensions/vscode/src/restart-policy.js";
import { wireTransportDiagnostics } from "../extensions/vscode/src/transport-diagnostics.js";
import { subscribeInboxes, WakeGate } from "../extensions/vscode/src/inbox-subscription.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const DIST_INDEX = path.join(REPO_ROOT, "dist", "index.js");

const WATCHED = "watched-agent";

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

async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 50): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  return predicate();
}

/** Spawn the real daemon on a fixed port + DB (so a restart reuses the same
 *  state). Does NOT delete the root on kill — the caller owns cleanup so the
 *  agent row + inbox survive the restart. */
function spawnDaemon(port: number, root: string, dbPath: string): {
  proc: cp.ChildProcessWithoutNullStreams;
  stderr: () => string;
} {
  const proc = cp.spawn("node", [DIST_INDEX], {
    env: {
      ...process.env,
      RELAY_TRANSPORT: "http",
      RELAY_HTTP_PORT: String(port),
      RELAY_HTTP_HOST: "127.0.0.1",
      RELAY_HOME: root,
      RELAY_DB_PATH: dbPath,
      RELAY_CONFIG_PATH: path.join(root, "config.json"),
      RELAY_AGENT_TOKEN: "",
      RELAY_AGENT_NAME: "",
      RELAY_OUTBOX_POLL_MS: "50",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderrBuf = "";
  proc.stderr.on("data", (c: Buffer) => (stderrBuf += c.toString("utf-8")));
  return { proc, stderr: () => stderrBuf };
}

async function killProc(proc: cp.ChildProcessWithoutNullStreams): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise<void>((res) => proc.once("exit", () => res()));
  proc.kill("SIGKILL"); // decisive, deterministic drop of the SSE socket
  await Promise.race([exited, new Promise((res) => setTimeout(res, 2000))]);
}

/** A throwaway MCP client — used to register the agent and to send mail during
 *  the outage window, independent of the Tether-under-test connection. */
async function withClient<T>(port: number, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "v0-4-1-helper", version: "0.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    try { await client.close(); } catch { /* */ }
  }
}

function toolJson(res: unknown): Record<string, unknown> {
  const content = (res as { content?: { text?: string }[] }).content;
  return JSON.parse(content?.[0]?.text ?? "{}");
}

describe("v0.4.1 — Tether auto-reconnect on real daemon restart", () => {
  it("kill+restart daemon, mail sent during outage → EXACTLY ONE catch-up wake, ZERO manual reconnect", async () => {
    expect(fs.existsSync(DIST_INDEX), `missing ${DIST_INDEX} — run \`npm run build\` first`).toBe(true);

    const port = await getFreePort();
    const root = path.join(os.tmpdir(), `v0-4-1-autoreconnect-${process.pid}-${Date.now()}`);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const dbPath = path.join(root, "relay.db");

    let daemon = spawnDaemon(port, root, dbPath);
    // Tether-under-test state.
    let curClient: Client | undefined;
    let curTransport: StreamableHTTPClientTransport | undefined;
    const wakes: string[] = [];
    let manualReconnectCalls = 0; // must stay 0 — we never manually reconnect
    let errorState = false;
    const log = (_l: string) => { /* quiet; flip to console.error to debug */ };

    try {
      await waitForHealth(port, 10_000);

      // Register the watched agent + capture its token (used to self-send the
      // outage mail). The agent row + inbox persist in dbPath across restart.
      const token = await withClient(port, async (c) => {
        const reg = toolJson(
          await c.callTool({ name: "register_agent", arguments: { name: WATCHED, role: "tester", capabilities: [] } }),
        );
        expect(reg.success).toBe(true);
        return reg.agent_token as string;
      });

      // ---- Shipped-seam wiring (mirrors extension.ts connect()) ------------
      const lifecycle = new ConnectionLifecycle<StreamableHTTPClientTransport>();
      const wakeGate = new WakeGate((name) => wakes.push(name)); // ONE gate, reused across reconnects
      const isInErrorState = () => errorState;
      const buildInboxUri = (name: string) => `relay://inbox/${encodeURIComponent(name)}`;
      const readSnapshot = async (
        client: Client,
        agentName: string,
      ): Promise<{ pending_count: number; last_message_at: string | null } | null> => {
        try {
          const r = (await client.readResource({ uri: buildInboxUri(agentName) })) as {
            contents?: { text?: string }[];
          };
          const parsed = JSON.parse(r.contents?.[0]?.text ?? "null");
          if (!parsed) return null;
          return { pending_count: parsed.pending_count, last_message_at: parsed.last_message_at };
        } catch {
          return null;
        }
      };

      // Forward-declared so wire()'s onerror/onClose can reach the supervisor.
      let supervisor: ReconnectSupervisor;

      const connectFn = async (): Promise<boolean> => {
        // Tear down the OLD transport (intentional → its close is swallowed).
        lifecycle.beginIntentionalDisconnect();
        if (curClient) { try { await curClient.close(); } catch { /* */ } }
        if (curTransport) { try { await curTransport.close(); } catch { /* */ } }
        curClient = undefined;
        curTransport = undefined;
        errorState = false; // resetErrorState()

        const url = new URL(`http://127.0.0.1:${port}/mcp`);
        const requestInit: RequestInit = { headers: { "X-Agent-Token": token } };
        const client = new Client({ name: "bot-relay-tether-vscode", version: "0.4.1" }, { capabilities: {} });

        const transport = await lifecycle.establish({
          build: () =>
            new StreamableHTTPClientTransport(url, {
              requestInit,
              reconnectionOptions: {
                initialReconnectionDelay: 1000,
                maxReconnectionDelay: 30_000,
                reconnectionDelayGrowFactor: 1.5,
                maxRetries: 3,
              },
            }),
          wire: (t) =>
            wireTransportDiagnostics(t, {
              log,
              setError: (msg) => supervisor.handleError(msg),
              onClose: () => {
                if (!lifecycle.shouldReconnectOnClose(t)) return;
                supervisor.handleError("transport closed");
              },
            }),
          connect: (t) => client.connect(t),
        });
        curClient = client;
        curTransport = transport;

        await subscribeInboxes({
          client,
          agents: [{ agentName: WATCHED, autoInjectInbox: true, wakeGate, primary: true }],
          buildInboxUri,
          readSnapshot,
          applySnapshot: () => {},
          showToast: () => {},
          isInErrorState,
          log,
        });
        return !isInErrorState();
      };

      // Controllable backoff timer — capture the scheduled reconnect and fire
      // it on demand (deterministic; no wall-clock race).
      let pendingTimer: { fn: () => void } | null = null;
      supervisor = new ReconnectSupervisor({
        policy: new RestartPolicy({ neverGiveUp: true, equalJitter: true }),
        connect: connectFn,
        setTimer: (fn) => {
          const handle = { fn };
          pendingTimer = handle;
          return handle;
        },
        clearTimer: (h) => {
          if (pendingTimer === h) pendingTimer = null;
        },
        log,
        onReconnecting: () => { errorState = true; },
        onReconnected: () => { errorState = false; },
        onUnrecoverable: () => { errorState = true; },
      });
      const flushTimer = () => {
        const t = pendingTimer;
        pendingTimer = null;
        if (t) t.fn();
      };

      // ---- 1) Initial connect + subscribe (inbox empty → no wake) ----------
      const healthy0 = await connectFn();
      supervisor.notifyExternalConnect(healthy0);
      expect(healthy0, "initial connect should be healthy").toBe(true);
      expect(wakes.length, "no wake before any mail arrives").toBe(0);

      // ---- 2) Kill the daemon → the drop must schedule an auto-reconnect ---
      await killProc(daemon.proc);
      const scheduled = await waitFor(() => pendingTimer !== null, 20_000);
      expect(
        scheduled,
        "a transport drop after daemon kill must auto-schedule a reconnect (onerror/onClose → supervisor)",
      ).toBe(true);
      expect(manualReconnectCalls, "ZERO manual reconnect — recovery is automatic").toBe(0);

      // ---- 3) Restart the daemon on the same port + DB --------------------
      daemon = spawnDaemon(port, root, dbPath);
      await waitForHealth(port, 10_000);

      // ---- 4) Mail sent DURING the outage (Tether not yet reconnected) ----
      await withClient(port, async (c) => {
        const send = toolJson(
          await c.callTool({
            name: "send_message",
            arguments: { from: WATCHED, to: WATCHED, content: "mail during outage", agent_token: token },
          }),
        );
        expect(send.success, "outage mail should send to the restarted daemon").toBe(true);
      });

      // ---- 5) Fire the reconnect(s) until the catch-up wake lands ----------
      const woke = await waitFor(
        () => {
          if (wakes.length >= 1) return true;
          flushTimer(); // drive a reconnect attempt; on failure the supervisor reschedules
          return wakes.length >= 1;
        },
        25_000,
        200,
      );

      // ---- 6) Assert the acceptance bar -----------------------------------
      expect(woke, "reconnect + catch-up wake must fire with no manual input").toBe(true);
      expect(wakes, "exactly one wake, for the watched agent").toEqual([WATCHED]);
      expect(manualReconnectCalls, "still ZERO manual reconnect").toBe(0);

      // No double-wake: give the watermark a chance to (wrongly) re-fire.
      flushTimer();
      await new Promise((res) => setTimeout(res, 300));
      expect(wakes, "catch-up wake fires exactly once (no double-wake across reconnects)").toEqual([WATCHED]);
    } finally {
      if (curClient) { try { await curClient.close(); } catch { /* */ } }
      await killProc(daemon.proc);
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
    }
  }, 90_000);
});
