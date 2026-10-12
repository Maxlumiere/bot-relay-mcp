// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The shared WebSocket test helper (tests/_helpers/ws.ts) never LOSES a frame. A `nextMessage` that times out must
 * stop waiting: before this fix its resolver stayed armed, so the next frame to arrive (after the timeout, before
 * the next read) was handed to the dead promise and silently dropped. A test that timed out once and read again
 * then waited for a frame that had already come and gone.
 */
import { describe, it, expect, afterEach } from "vitest";
import http from "http";
import { WebSocketServer } from "ws";
import { connectWs } from "./_helpers/ws.js";

let server: http.Server | undefined;
let wss: WebSocketServer | undefined;
afterEach(async () => {
  // A failed test never reaches its ws.close(): end every connection, or server.close() waits on it forever.
  for (const c of wss?.clients ?? []) c.terminate();
  wss?.close();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
});

/** A server that sends `frame` to each client `afterMs` after it connects. */
async function lateSender(frame: string, afterMs: number): Promise<number> {
  server = http.createServer();
  wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => setTimeout(() => ws.send(frame), afterMs));
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  return (server!.address() as { port: number }).port;
}

describe("the WS test helper: a timed-out read never swallows the next frame", () => {
  it("a frame that arrives AFTER a read timed out, and BEFORE the next read, is delivered to that next read", async () => {
    const port = await lateSender("late-frame", 150);
    const h = await connectWs(port, "/");
    await expect(h.nextMessage(50)).rejects.toThrow(/ws message timeout/);
    await new Promise((r) => setTimeout(r, 300)); // the frame arrives in here, with no read pending
    await expect(h.nextMessage(500)).resolves.toBe("late-frame");
    h.ws.close();
  });

  it("TWIN: a frame that arrives while a read is pending is delivered to it", async () => {
    const port = await lateSender("on-time", 50);
    const h = await connectWs(port, "/");
    await expect(h.nextMessage(1000)).resolves.toBe("on-time");
    h.ws.close();
  });
});
