// bot-relay-mcp — Tether for VSCode
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT

/**
 * v0.4.1 — ConnectionLifecycle unit tests.
 *
 * These drive the REAL establish() ordering + shouldReconnectOnClose() guard
 * that ships (extension.ts is dumb wiring over this seam), not a proxy. The
 * harness mirrors extension.ts's onClose wiring exactly: `wire` attaches an
 * onclose that calls `shouldReconnectOnClose(t)` and, if honored, records a
 * "reconnect" (the production analog of `supervisor.handleError`).
 *
 * The headline case is (L2) — a close DURING the connect handshake must be
 * honored, because the new transport is bound as the guard-accepted connecting
 * transport BEFORE connect. That is the mid-connect race that is load-bearing:
 * pre-v0.4.1 a close during the connect handshake was dropped, re-wedging on
 * the exact restart this fixes.
 */
import { describe, it, expect } from "vitest";
import { ConnectionLifecycle } from "./connection-lifecycle.js";

interface FakeTransport {
  name: string;
  onclose?: () => void;
}

function makeHarness() {
  const lifecycle = new ConnectionLifecycle<FakeTransport>();
  // Transports whose close the guard HONORED (→ would call supervisor.handleError).
  const honored: string[] = [];
  const onClose = (t: FakeTransport) => {
    if (lifecycle.shouldReconnectOnClose(t)) honored.push(t.name);
  };
  // Mirrors extension.ts: wireTransportDiagnostics(t, { ..., onClose: () => onClose(t) }).
  const wire = (t: FakeTransport) => {
    t.onclose = () => onClose(t);
  };
  const build = (name: string) => (): FakeTransport => ({ name });
  return { lifecycle, honored, wire, build };
}

describe("ConnectionLifecycle — establish ordering + onClose guard", () => {
  it("(L1) establish promotes to current on success; the live transport's close is honored", async () => {
    const { lifecycle, honored, wire, build } = makeHarness();

    const t = await lifecycle.establish({
      build: build("t1"),
      wire,
      connect: async () => {},
    });
    expect(lifecycle.currentTransport).toBe(t);
    expect(lifecycle.connectingTransport).toBeUndefined();

    // Daemon restart later ends the SSE as a quiet close → honored.
    t.onclose!();
    expect(honored).toEqual(["t1"]);
  });

  it("(L2) LOAD-BEARING — a close DURING the connect handshake is honored (mid-connect race)", async () => {
    const { lifecycle, honored, wire, build } = makeHarness();

    // The connect handshake: the transport closes mid-flight, THEN connect
    // rejects (the realistic daemon-rejects-the-new-SSE shape).
    let sawConnectingBound = false;
    await expect(
      lifecycle.establish({
        build: build("t1"),
        wire,
        connect: async (t) => {
          // At this instant the new transport must already be guard-accepted:
          sawConnectingBound = lifecycle.connectingTransport === t;
          t.onclose!(); // ← close arrives BEFORE connect resolves
          throw new Error("SSE handshake closed");
        },
      }),
    ).rejects.toThrow(/handshake closed/);

    // The close fired during connect() was honored — the exact wedge we fix.
    expect(sawConnectingBound).toBe(true);
    expect(honored).toEqual(["t1"]);
    // A failed establish leaves no transport guard-accepted.
    expect(lifecycle.connectingTransport).toBeUndefined();
    expect(lifecycle.currentTransport).toBeUndefined();
  });

  it("(L2b) a mid-connect close is honored even when connect ultimately RESOLVES", async () => {
    const { lifecycle, honored, wire, build } = makeHarness();
    await lifecycle.establish({
      build: build("t1"),
      wire,
      connect: async (t) => {
        t.onclose!(); // close during handshake, but connect then resolves
      },
    });
    expect(honored).toEqual(["t1"]);
  });

  it("(L3) an INTENTIONAL teardown close is ignored (flag guard)", async () => {
    const { lifecycle, honored, wire, build } = makeHarness();
    const t = await lifecycle.establish({ build: build("t1"), wire, connect: async () => {} });

    // Operator/teardown path: begin the intentional window, then the old
    // transport closes (as disconnect() would close it).
    lifecycle.beginIntentionalDisconnect();
    t.onclose!();
    expect(honored).toEqual([]); // swallowed, no reconnect
  });

  it("(L4) a SUPERSEDED transport's late close is ignored; the new one's close is honored", async () => {
    const { lifecycle, honored, wire, build } = makeHarness();
    const t1 = await lifecycle.establish({ build: build("t1"), wire, connect: async () => {} });

    // Reconnect replaces t1 with t2 (intentional window across the swap).
    lifecycle.beginIntentionalDisconnect();
    const t2 = await lifecycle.establish({ build: build("t2"), wire, connect: async () => {} });
    expect(lifecycle.currentTransport).toBe(t2);

    // t1 fires a late close AFTER being superseded → ignored (identity guard).
    t1.onclose!();
    expect(honored).toEqual([]);

    // t2 (the live one) drops → honored.
    t2.onclose!();
    expect(honored).toEqual(["t2"]);
  });

  it("(L5) a late OLD-transport close during the reconnect's establish window is ignored", async () => {
    // Regression for the currentT-clearing in beginIntentionalDisconnect:
    // establish() resets the intentional flag before connecting the NEW
    // transport, so ONLY dropping currentT on beginIntentionalDisconnect keeps
    // a straggler close from the old transport from being wrongly honored.
    const { lifecycle, honored, wire, build } = makeHarness();
    const t1 = await lifecycle.establish({ build: build("t1"), wire, connect: async () => {} });

    lifecycle.beginIntentionalDisconnect(); // flag up, currentT dropped

    await lifecycle.establish({
      build: build("t2"),
      wire,
      connect: async () => {
        // Mid-establish of t2 (flag already reset to false here), a straggler
        // close from the OLD t1 arrives. It must NOT be honored.
        t1.onclose!();
      },
    });
    expect(honored).toEqual([]); // t1's straggler close ignored
  });

  it("(L6) establish failure unbinds the connecting transport; its later close is ignored", async () => {
    const { lifecycle, honored, wire, build } = makeHarness();
    let failed: FakeTransport | undefined;
    await expect(
      lifecycle.establish({
        build: () => {
          failed = { name: "t1" };
          return failed;
        },
        wire,
        connect: async () => {
          throw new Error("ECONNREFUSED");
        },
      }),
    ).rejects.toThrow(/ECONNREFUSED/);

    expect(lifecycle.connectingTransport).toBeUndefined();
    // A late close from the transport whose connect failed → ignored.
    failed!.onclose!();
    expect(honored).toEqual([]);
  });

  it("(L7) reset() forgets both transports and swallows any subsequent close", async () => {
    const { lifecycle, honored, wire, build } = makeHarness();
    const t = await lifecycle.establish({ build: build("t1"), wire, connect: async () => {} });

    lifecycle.reset();
    expect(lifecycle.currentTransport).toBeUndefined();
    expect(lifecycle.connectingTransport).toBeUndefined();

    t.onclose!();
    expect(honored).toEqual([]);
  });
});
