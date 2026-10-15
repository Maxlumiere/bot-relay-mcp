// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The shared WebSocket test helper (tests/_helpers/ws.ts) never LOSES a frame, and allows ONE outstanding read.
 * A `nextMessage` that times out must stop waiting: before the fix its resolver stayed armed, so the next frame to
 * arrive (after the timeout, before the next read) was handed to the settled promise and dropped. Every send here is
 * driven explicitly by the test, and receipt is awaited on the socket itself, so no case depends on timer ordering.
 */
import { describe, it, expect, afterEach } from "vitest";
import http from "http";
import { WebSocketServer, type WebSocket } from "ws";
import { connectWs } from "./_helpers/ws.js";

let server: http.Server | undefined;
let wss: WebSocketServer | undefined;
afterEach(async () => {
  // A failed test never reaches its ws.close(): end every connection, or server.close() waits on it forever.
  for (const c of wss?.clients ?? []) c.terminate();
  wss?.close();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

/** A server whose sends the TEST triggers: resolves with the client handle and the server side of its socket. */
async function controlled(): Promise<{ client: Awaited<ReturnType<typeof connectWs>>; peer: WebSocket }> {
  server = http.createServer();
  wss = new WebSocketServer({ server });
  const peer = new Promise<WebSocket>((r) => wss!.on("connection", (ws) => r(ws)));
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const client = await connectWs((server!.address() as { port: number }).port, "/");
  return { client, peer: await peer };
}
/** Resolves once the client socket has RECEIVED a frame (the helper's own listener, attached first, has run). */
const received = (c: { ws: WebSocket }) => new Promise<void>((r) => c.ws.once("message", () => r()));

describe("the WS test helper: a timed-out read never swallows the next frame", () => {
  it("a frame received AFTER a read timed out, with no read pending, is delivered to the NEXT read", async () => {
    const { client, peer } = await controlled();
    await expect(client.nextMessage(50)).rejects.toThrow(/ws message timeout/);
    const got = received(client);
    peer.send("late-frame");
    await got; // the frame is in, and no read is pending
    await expect(client.nextMessage(500)).resolves.toBe("late-frame");
    client.ws.close();
  });

  it("TWIN: a frame that arrives while a read is pending is delivered to it", async () => {
    const { client, peer } = await controlled();
    const read = client.nextMessage(1000); // the read is pending BEFORE the send
    peer.send("on-time");
    await expect(read).resolves.toBe("on-time");
    client.ws.close();
  });

  it("one outstanding read: a second read while the first is pending is refused at once, and the first still gets the frame", async () => {
    const { client, peer } = await controlled();
    // The first read's outcome is captured AT ONCE (Codex #328 R2 P3): with a handler attached only after the next
    // assertion, a failure there would leave `first` to time out UNHANDLED instead of failing this test.
    const first = client.nextMessage(1000).then(
      (frame) => ({ frame }),
      (err: Error) => ({ error: err.message }),
    );
    await expect(client.nextMessage(1000)).rejects.toThrow(/already pending/);
    peer.send("for-the-first");
    expect(await first).toEqual({ frame: "for-the-first" });
    client.ws.close();
  });
});
