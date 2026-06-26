// Tether for bot-relay-mcp (VSCode)
// SPDX-License-Identifier: MIT
//
// v0.2.3 R1 — WakeGate + subscribeInbox unit contract (VSCode-free, fake MCP
// client). The real-daemon round-trip lives in tests/tether-reliable-wake.test.ts;
// this pins the seam's logic fast: catch-up fires once, no double-wake, the live
// notification handler routes through the gate, foreign URIs are ignored.

import { describe, it, expect, vi } from "vitest";
import { WakeGate, subscribeInbox, subscribeInboxes } from "./inbox-subscription.js";

type Notification = { params: { uri: string } };

/** Minimal stand-in for the MCP Client surface subscribeInbox uses. */
function makeFakeClient() {
  let handler: ((n: Notification) => Promise<void>) | undefined;
  const subscribed: string[] = [];
  return {
    setNotificationHandler: (_schema: unknown, h: (n: Notification) => Promise<void>) => {
      handler = h;
    },
    subscribeResource: async (arg: { uri: string }) => {
      subscribed.push(arg.uri);
    },
    /** Test helper — deliver a notification as the daemon would. */
    fire: async (uri: string) => {
      if (handler) await handler({ params: { uri } });
    },
    subscribed,
  };
}

const uri = (a: string) => `relay://inbox/${a}`;
const baseDeps = { applySnapshot: () => {}, showToast: () => {}, isInErrorState: () => false, log: () => {} };

describe("WakeGate", () => {
  it("wakes once for pending mail, then NOT again for the same newest message (no double-wake)", () => {
    const onWake = vi.fn();
    const gate = new WakeGate(onWake);
    const snap = { pending_count: 2, last_message_at: "T1" };
    expect(gate.consider(snap, "x", true)).toBe(true);
    expect(gate.consider(snap, "x", true)).toBe(false);
    expect(onWake).toHaveBeenCalledTimes(1);
    expect(onWake).toHaveBeenCalledWith("x");
  });

  it("wakes again only when a newer message arrives", () => {
    const onWake = vi.fn();
    const gate = new WakeGate(onWake);
    expect(gate.consider({ pending_count: 1, last_message_at: "T1" }, "x", true)).toBe(true);
    expect(gate.consider({ pending_count: 2, last_message_at: "T2" }, "x", true)).toBe(true);
    expect(onWake).toHaveBeenCalledTimes(2);
  });

  it("never wakes when autoInjectInbox is false", () => {
    const onWake = vi.fn();
    const gate = new WakeGate(onWake);
    expect(gate.consider({ pending_count: 5, last_message_at: "T1" }, "x", false)).toBe(false);
    expect(onWake).not.toHaveBeenCalled();
  });
});

describe("subscribeInbox", () => {
  it("subscribes to the agent's inbox URI and fires a catch-up wake when mail is already pending", async () => {
    const onWake = vi.fn();
    const gate = new WakeGate(onWake);
    const client = makeFakeClient();
    await subscribeInbox({
      client: client as never,
      agentName: "alice",
      autoInjectInbox: true,
      buildInboxUri: uri,
      readSnapshot: async () => ({ pending_count: 1, last_message_at: "T1" }),
      wakeGate: gate,
      ...baseDeps,
    });
    expect(client.subscribed).toEqual([uri("alice")]);
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it("routes a LIVE notification for the subscribed URI through the gate; ignores other URIs", async () => {
    const onWake = vi.fn();
    const gate = new WakeGate(onWake);
    const client = makeFakeClient();
    let snap = { pending_count: 0, last_message_at: null as string | null };
    await subscribeInbox({
      client: client as never,
      agentName: "bob",
      autoInjectInbox: true,
      buildInboxUri: uri,
      readSnapshot: async () => snap,
      wakeGate: gate,
      ...baseDeps,
    });
    expect(onWake).not.toHaveBeenCalled(); // nothing pending at subscribe

    snap = { pending_count: 1, last_message_at: "T1" };
    await client.fire(uri("bob")); // real message arrives
    expect(onWake).toHaveBeenCalledTimes(1);

    await client.fire(uri("someone-else")); // foreign inbox → ignored
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it("does not wake on the catch-up path when the error state is set", async () => {
    const onWake = vi.fn();
    const gate = new WakeGate(onWake);
    const client = makeFakeClient();
    await subscribeInbox({
      client: client as never,
      agentName: "carol",
      autoInjectInbox: true,
      buildInboxUri: uri,
      readSnapshot: async () => ({ pending_count: 3, last_message_at: "T1" }),
      wakeGate: gate,
      applySnapshot: () => {},
      showToast: () => {},
      isInErrorState: () => true, // state-lock
      log: () => {},
    });
    expect(onWake).not.toHaveBeenCalled();
  });
});

describe("subscribeInboxes (multi-agent watch-all)", () => {
  const agent = (name: string, gate: WakeGate, primary = false) => ({
    agentName: name,
    autoInjectInbox: true,
    wakeGate: gate,
    primary,
  });

  it("subscribes to EACH agent's inbox and catch-up-wakes each via its OWN gate", async () => {
    const wakeA = vi.fn();
    const wakeB = vi.fn();
    const client = makeFakeClient();
    await subscribeInboxes({
      client: client as never,
      agents: [agent("alice", new WakeGate(wakeA), true), agent("bob", new WakeGate(wakeB))],
      buildInboxUri: uri,
      readSnapshot: async () => ({ pending_count: 1, last_message_at: "T1" }),
      ...baseDeps,
    });
    expect([...client.subscribed].sort()).toEqual([uri("alice"), uri("bob")].sort());
    expect(wakeA).toHaveBeenCalledTimes(1);
    expect(wakeB).toHaveBeenCalledTimes(1); // each agent woken independently
  });

  it("a live notification wakes ONLY the matching agent (dispatch by URI)", async () => {
    const wakeA = vi.fn();
    const wakeB = vi.fn();
    const client = makeFakeClient();
    let snap = { pending_count: 0, last_message_at: null as string | null };
    await subscribeInboxes({
      client: client as never,
      agents: [agent("alice", new WakeGate(wakeA), true), agent("bob", new WakeGate(wakeB))],
      buildInboxUri: uri,
      readSnapshot: async () => snap,
      ...baseDeps,
    });
    snap = { pending_count: 1, last_message_at: "T1" };
    await client.fire(uri("bob")); // only bob's inbox changed
    expect(wakeB).toHaveBeenCalledTimes(1);
    expect(wakeA).not.toHaveBeenCalled(); // alice's terminal NOT woken — no cross-wake
  });

  it("only the PRIMARY agent's snapshot drives the shared status bar", async () => {
    const applied: number[] = [];
    const client = makeFakeClient();
    let snap = { pending_count: 0, last_message_at: null as string | null };
    await subscribeInboxes({
      client: client as never,
      agents: [agent("alice", new WakeGate(() => {}), true), agent("bob", new WakeGate(() => {}))],
      buildInboxUri: uri,
      readSnapshot: async () => snap,
      applySnapshot: (s) => applied.push(s.pending_count),
      showToast: () => {},
      isInErrorState: () => false,
      log: () => {},
    });
    applied.length = 0; // ignore the prime
    snap = { pending_count: 5, last_message_at: "T1" };
    await client.fire(uri("bob")); // non-primary → no status-bar paint
    expect(applied).toEqual([]);
    await client.fire(uri("alice")); // primary → paints
    expect(applied).toEqual([5]);
  });
});
