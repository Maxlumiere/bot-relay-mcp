// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Tether v0.2.3 (A) — catch-up wake, real-HTTP-daemon integration.
 *
 * The unit test (extensions/vscode/src/catch-up-wake.test.ts) pins the
 * decideWake() decision in isolation. This test proves the SAME contract
 * end-to-end against the SHIPPED HTTP daemon (v2.5 R0 lesson — exercise the
 * real transport, not InMemory): it spawns the built dist/index.js, drives
 * real register_agent / send_message over the stateless POST path, reads the
 * real `relay://inbox/<agent>` snapshot via the MCP StreamableHTTP client (the
 * exact payload the extension's refreshSnapshot() consumes), and feeds those
 * real snapshots through the production decideWake().
 *
 * The load-bearing assertion (Risk-A): a re-read with no new mail does NOT
 * wake again — the high-water mark prevents a double-wake on every reconnect.
 *
 * This is also the shared-harness anchor: v0.2.4 (keepalive) and v0.3
 * (PID-handshake) reuse tests/helpers/relay-http-harness.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  spawnDaemon,
  tearDownDaemon,
  registerAgentViaHttp,
  sendMessageViaHttp,
  connectMcpClient,
  readInboxSnapshot,
  type DaemonHandle,
  type McpClientHandle,
} from "./helpers/relay-http-harness.js";
import { decideWake } from "../extensions/vscode/src/catch-up-wake.js";

const RCPT = "rw-recipient";
const SENDER = "rw-sender";

describe("Tether v0.2.3 — catch-up wake over the real HTTP daemon", () => {
  let daemon: DaemonHandle;
  let mcp: McpClientHandle;
  let senderToken: string;

  beforeAll(async () => {
    daemon = await spawnDaemon();
    senderToken = (await registerAgentViaHttp(daemon.baseUrl, SENDER)).agentToken;
    await registerAgentViaHttp(daemon.baseUrl, RCPT);
    mcp = await connectMcpClient(daemon.baseUrl, "reliable-wake-test");
  }, 20_000);

  afterAll(async () => {
    if (mcp) await mcp.close();
    if (daemon) await tearDownDaemon(daemon);
  });

  /** Poll the inbox snapshot until `predicate` holds (or time out). */
  async function readUntil(
    predicate: (s: Awaited<ReturnType<typeof readInboxSnapshot>>) => boolean,
    timeoutMs = 4000,
  ): Promise<Awaited<ReturnType<typeof readInboxSnapshot>>> {
    const deadline = Date.now() + timeoutMs;
    let last = await readInboxSnapshot(mcp.client, RCPT);
    while (!predicate(last) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      last = await readInboxSnapshot(mcp.client, RCPT);
    }
    return last;
  }

  it("drives catch-up wake → no-double-wake → re-wake on new mail, end-to-end", async () => {
    // Simulate the extension's module-memory high-water mark across a sequence
    // of real snapshots.
    let mark: string | null = null;

    // (1) Empty inbox at subscribe → nothing pending → no wake.
    const empty = await readInboxSnapshot(mcp.client, RCPT);
    expect(empty.pending_count).toBe(0);
    {
      const d = decideWake(empty, { autoInjectInbox: true, lastWokenAt: mark });
      expect(d.shouldWake).toBe(false);
      mark = d.newMark;
    }
    expect(mark).toBe(null);

    // (2) A message is already waiting at (re)subscribe → catch-up fires ONCE.
    await sendMessageViaHttp(daemon.baseUrl, SENDER, senderToken, RCPT, "first-while-away");
    const afterFirst = await readUntil((s) => s.pending_count >= 1);
    expect(afterFirst.pending_count).toBe(1);
    expect(afterFirst.last_message_at).not.toBe(null);
    const T1 = afterFirst.last_message_at;
    {
      const d = decideWake(afterFirst, { autoInjectInbox: true, lastWokenAt: mark });
      expect(d.shouldWake).toBe(true);
      expect(d.newMark).toBe(T1);
      mark = d.newMark;
    }

    // (3) ★ NO DOUBLE-WAKE: a reconnect re-reads the SAME snapshot (no new
    //     mail) → the high-water mark suppresses the wake.
    const reReadSame = await readInboxSnapshot(mcp.client, RCPT);
    expect(reReadSame.last_message_at).toBe(T1);
    {
      const d = decideWake(reReadSame, { autoInjectInbox: true, lastWokenAt: mark });
      expect(d.shouldWake).toBe(false);
      expect(d.newMark).toBe(T1);
      mark = d.newMark;
    }

    // (4) Genuinely new mail arrives → wakes again, advancing the mark.
    await sendMessageViaHttp(daemon.baseUrl, SENDER, senderToken, RCPT, "second-new");
    const afterSecond = await readUntil((s) => s.last_message_at !== T1);
    expect(afterSecond.pending_count).toBe(2);
    const T2 = afterSecond.last_message_at;
    expect(T2).not.toBe(T1);
    {
      const d = decideWake(afterSecond, { autoInjectInbox: true, lastWokenAt: mark });
      expect(d.shouldWake).toBe(true);
      expect(d.newMark).toBe(T2);
      mark = d.newMark;
    }
  }, 20_000);

  it("never wakes when autoInjectInbox is off, even with real pending mail", async () => {
    // The recipient already has pending mail from the prior test.
    const snap = await readInboxSnapshot(mcp.client, RCPT);
    expect(snap.pending_count).toBeGreaterThan(0);
    const d = decideWake(snap, { autoInjectInbox: false, lastWokenAt: null });
    expect(d.shouldWake).toBe(false);
  }, 20_000);
});
