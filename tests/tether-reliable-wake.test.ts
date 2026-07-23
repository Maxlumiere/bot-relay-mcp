// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Tether v0.2.3 (A) — catch-up wake, real-HTTP-daemon integration.
 *
 * R1 (codex): the R0 version read snapshots and called decideWake DIRECTLY, so
 * it would not have failed if the production subscribe→notify→wake wiring
 * drifted (the v2.5 R0 test-path-must-match-shipped-path trap). This version
 * drives the SHIPPED seam — `subscribeInbox` + `WakeGate` from
 * extensions/vscode/src/inbox-subscription.ts, the exact code connect() runs —
 * against the real built dist/index.js daemon over the real MCP StreamableHTTP
 * transport. Only the terminal keystroke (WakeGate's onWake) is spied; a
 * regression in the handler, the subscribe, or the catch-up fails these tests.
 *
 * Shared harness anchor: v0.2.4 (keepalive) + v0.3 (PID handshake) reuse
 * tests/helpers/relay-http-harness.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  spawnDaemon,
  tearDownDaemon,
  registerAgentViaHttp,
  sendMessageViaHttp,
  drainInboxViaHttp,
  connectMcpClient,
  readInboxSnapshot,
  type DaemonHandle,
} from "./helpers/relay-http-harness.js";
import { WakeGate, subscribeInbox } from "../extensions/vscode/src/inbox-subscription.js";

const SENDER = "rw-sender";
const buildInboxUri = (agent: string) => `relay://inbox/${encodeURIComponent(agent)}`;

// Side-effect deps the wake path doesn't assert here (status bar / toast / error
// state / log) — no-ops so the test isolates the wake.
const sinkDeps = {
  applySnapshot: () => {},
  showToast: () => {},
  isInErrorState: () => false,
  log: () => {},
};

describe("Tether v0.2.3 R1 — subscribe→notify→wake through the production seam", () => {
  let daemon: DaemonHandle;
  let senderToken: string;

  beforeAll(async () => {
    daemon = await spawnDaemon();
    senderToken = (await registerAgentViaHttp(daemon.baseUrl, SENDER)).agentToken;
  }, 20_000);

  afterAll(async () => {
    if (daemon) await tearDownDaemon(daemon);
  });

  async function waitForCalls(spy: ReturnType<typeof vi.fn>, n: number, timeoutMs = 5000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (spy.mock.calls.length < n && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    return spy.mock.calls.length;
  }

  it("catch-up wake fires once for mail already waiting, then the LIVE path wakes on a new message AFTER a drain", async () => {
    const RCPT = "rw-a";
    const { agentToken: rcptToken } = await registerAgentViaHttp(daemon.baseUrl, RCPT);
    // Mail waiting BEFORE subscribe — only the catch-up path can deliver it.
    await sendMessageViaHttp(daemon.baseUrl, SENDER, senderToken, RCPT, "waiting-before-subscribe");

    const onWake = vi.fn();
    const gate = new WakeGate(onWake);
    const mcp = await connectMcpClient(daemon.baseUrl, "rw-a");
    try {
      await subscribeInbox({
        client: mcp.client,
        agentName: RCPT,
        autoInjectInbox: true,
        buildInboxUri,
        readSnapshot: readInboxSnapshot,
        wakeGate: gate,
        // ADR-0010: the harness agent has no turn in flight — it IS idle. An
        // idle observation is the flush evidence that re-arms the gate between
        // the catch-up wake and the live one (drain alone no longer re-arms:
        // pending==0 is not consumption).
        observe: async () => ({ state: "idle" as const, busyCoveredByHook: true }),
        ...sinkDeps,
      });
      // Catch-up wake fired THROUGH the production seam.
      expect(onWake).toHaveBeenCalledTimes(1);
      expect(onWake).toHaveBeenLastCalledWith(RCPT);

      // The agent consumes the wake (drains its inbox) before new mail lands.
      await drainInboxViaHttp(daemon.baseUrl, RCPT, rcptToken);
      // The re-arm CONTRACT the wake-gate depends on: a drain drops the
      // RESOURCE's pending_count to 0 (strict status='pending' count). If this
      // assertion fails, rule-1 re-arming is broken at the relay, not in the
      // gate.
      const postDrain = await readInboxSnapshot(mcp.client, RCPT);
      expect(postDrain?.pending_count).toBe(0);

      // LIVE: a new message → real ResourceUpdated notification → the production
      // handler runs → wake. Proves the :handler wiring, not just decideWake.
      await sendMessageViaHttp(daemon.baseUrl, SENDER, senderToken, RCPT, "live-after-subscribe");
      expect(await waitForCalls(onWake, 2)).toBe(2);
    } finally {
      await mcp.close();
    }
  }, 25_000);

  it("★ NO double-wake: a reconnect (re-subscribe, same WakeGate) with no new mail does NOT re-fire", async () => {
    const RCPT = "rw-b";
    await registerAgentViaHttp(daemon.baseUrl, RCPT);
    await sendMessageViaHttp(daemon.baseUrl, SENDER, senderToken, RCPT, "pending-for-b");

    const onWake = vi.fn();
    // ONE gate across both connects — mirrors the activate-time singleton that
    // persists across reconnects (the no-double-wake guarantee).
    const gate = new WakeGate(onWake);

    const mcp1 = await connectMcpClient(daemon.baseUrl, "rw-b-1");
    await subscribeInbox({
      client: mcp1.client,
      agentName: RCPT,
      autoInjectInbox: true,
      buildInboxUri,
      readSnapshot: readInboxSnapshot,
      wakeGate: gate,
      ...sinkDeps,
    });
    expect(onWake).toHaveBeenCalledTimes(1); // catch-up
    await mcp1.close();

    // Reconnect: fresh client + SAME gate, no new mail since the last wake.
    const mcp2 = await connectMcpClient(daemon.baseUrl, "rw-b-2");
    try {
      await subscribeInbox({
        client: mcp2.client,
        agentName: RCPT,
        autoInjectInbox: true,
        buildInboxUri,
        readSnapshot: readInboxSnapshot,
        wakeGate: gate,
        ...sinkDeps,
      });
      await new Promise((r) => setTimeout(r, 300)); // settle window for any stray frame
      expect(onWake).toHaveBeenCalledTimes(1); // STILL once — no double-wake
    } finally {
      await mcp2.close();
    }
  }, 25_000);

  it("autoInjectInbox=false never wakes, even with real pending mail", async () => {
    const RCPT = "rw-c";
    await registerAgentViaHttp(daemon.baseUrl, RCPT);
    await sendMessageViaHttp(daemon.baseUrl, SENDER, senderToken, RCPT, "pending-for-c");

    const onWake = vi.fn();
    const gate = new WakeGate(onWake);
    const mcp = await connectMcpClient(daemon.baseUrl, "rw-c");
    try {
      await subscribeInbox({
        client: mcp.client,
        agentName: RCPT,
        autoInjectInbox: false,
        buildInboxUri,
        readSnapshot: readInboxSnapshot,
        wakeGate: gate,
        ...sinkDeps,
      });
      await new Promise((r) => setTimeout(r, 250));
      expect(onWake).not.toHaveBeenCalled();
    } finally {
      await mcp.close();
    }
  }, 25_000);
});
