// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.2.1 P4 — shared WebSocket test helper.
 *
 * Extracted from tests/v2-2-0-phase-2-websocket.test.ts after the hello-
 * frame race pattern proved re-usable. The race: server sends the first
 * JSON frame from its `connection` handler via `setImmediate` so the
 * client's `message` listener has time to attach after the `open` event.
 * A naive test that attaches `message` AFTER `open` fires can miss the
 * first frame entirely — this helper solves that with an eager-queue
 * pattern: start buffering messages the instant the WebSocket object
 * exists, resolve them from the queue when the test asks.
 *
 * Usage:
 *   const { ws, nextMessage } = await connectWs(port, "/dashboard/ws");
 *   const hello = JSON.parse(await nextMessage());
 *   // ...
 *   ws.close();
 *
 * Callers responsible for closing the socket when done. `nextMessage`
 * accepts an optional timeout (default 1.5s) to surface hangs as
 * assertion failures instead of test-timeout kills.
 */
import { WebSocket } from "ws";

export interface WsTestHandle {
  /** The underlying ws.WebSocket. Callers close it when done. */
  ws: WebSocket;
  /**
   * Pop the next message from the eager queue. If the queue is empty,
   * waits until a frame arrives or `timeoutMs` elapses. Rejects on
   * timeout so the test fails with a clear reason.
   */
  nextMessage: (timeoutMs?: number) => Promise<string>;
}

/**
 * Connect to a WebSocket endpoint AND start buffering messages
 * immediately — so a server that sends a frame on `connection` handler
 * doesn't race the test's listener attach.
 */
export async function connectWs(
  port: number,
  urlPath: string,
  subprotocols?: string[]
): Promise<WsTestHandle> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${urlPath}`, subprotocols);
  const queue: string[] = [];
  let pendingResolve: ((v: string) => void) | null = null;

  ws.on("message", (data: Buffer) => {
    const s = data.toString("utf8");
    if (pendingResolve) {
      pendingResolve(s);
      pendingResolve = null;
    } else {
      queue.push(s);
    }
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("ws connect timeout"));
    }, 2000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    ws.once("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      reject(new Error(`ws rejected: HTTP ${res.statusCode}`));
    });
  });

  return {
    ws,
    nextMessage: (timeoutMs = 1500) =>
      new Promise((resolve, reject) => {
        if (queue.length > 0) {
          resolve(queue.shift()!);
          return;
        }
        const timer = setTimeout(
          () => reject(new Error("ws message timeout")),
          timeoutMs
        );
        pendingResolve = (s) => {
          clearTimeout(timer);
          resolve(s);
        };
      }),
  };
}
