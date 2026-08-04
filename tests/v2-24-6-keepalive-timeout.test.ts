// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.24.6 — server keep-alive timeout gate.
 *
 * DEFECT: `startHttpServer` did `app.listen(...)` with no keepAliveTimeout
 * override, so Node's 5000ms default applied. The SERVER therefore closes an
 * idle keep-alive socket first; a client that reuses that socket in the window
 * between the server's close and its own gets ECONNRESET on a healthy request.
 * Measured on a throwaway daemon: FIN at ~6001ms idle, raw reuse at 6003ms →
 * ECONNRESET at ~6012ms. undici (the agent our own clients use) evicts its
 * pooled socket at ~4s, before the server's 5s, so it never sees this — which
 * is why the impact is LOW and the exposed population is raw HTTP clients,
 * proxies, and libraries without that client-side eviction.
 *
 * FIX (server-side only): raise keepAliveTimeout above any plausible client
 * window (61s) with headersTimeout above it. The server is then never the one
 * to close first.
 *
 * These tests exercise the SHIPPED path — the real `startHttpServer` server
 * object and a REAL raw TCP socket doing idle-then-reuse. The harm leg fails if
 * the fix is reverted: with the 5s default the socket is gone during the 8s
 * idle and the reuse resets. Deliberately NO client-side retry is tested for,
 * because none was added — a retry-on-ECONNRESET here would only ever mask a
 * silent regression of this very tuning (ADR-0015: no mechanism that hides the
 * failure of the guard it sits behind).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import net from "node:net";
import type { Server as HttpServer } from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-keepalive-test-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
process.env.RELAY_ALLOW_LEGACY = "1";
// v2.1.3 I8: scrub inherited agent env so the server's token resolver does not
// pick up a parent-shell token that does not exist in this fresh isolated DB.
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;

const { startHttpServer } = await import("../src/transport/http.js");
const { closeDb } = await import("../src/db.js");

let server: HttpServer;
let port: number;

beforeAll(async () => {
  server = startHttpServer(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 100));
  const addr = server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
});

afterAll(() => {
  server.close();
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) {
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  }
});

/**
 * Send one raw HTTP/1.1 keep-alive GET on an already-connected socket and
 * resolve with its status once a full Content-Length-framed response arrives.
 * Rejects on socket error, premature close, or timeout — the exact signals a
 * server-closed keep-alive socket produces on reuse.
 */
function sendAndReadOne(
  socket: net.Socket,
  reqPath: string,
  host: string,
  timeoutMs: number,
): Promise<{ status: number; raw: string }> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      socket.removeListener("data", onData);
      socket.removeListener("error", onErr);
      socket.removeListener("close", onClose);
      clearTimeout(timer);
      fn();
    };
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const s = buf.toString("latin1");
      const headerEnd = s.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = s.slice(0, headerEnd);
      const statusMatch = /^HTTP\/1\.1 (\d+)/.exec(s);
      const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
      const clMatch = /content-length:\s*(\d+)/i.exec(header);
      const bodyStart = headerEnd + 4;
      if (clMatch) {
        const len = parseInt(clMatch[1], 10);
        if (buf.length - bodyStart >= len) {
          finish(() => resolve({ status, raw: s.slice(0, bodyStart + len) }));
        }
        return;
      }
      // No Content-Length (unexpected for /health) — resolve at header end.
      finish(() => resolve({ status, raw: s }));
    };
    const onErr = (err: Error) => finish(() => reject(new Error("socket error: " + err.message)));
    const onClose = () => finish(() => reject(new Error("socket closed before response completed")));
    const timer = setTimeout(() => finish(() => reject(new Error("response timeout"))), timeoutMs);
    socket.on("data", onData);
    socket.once("error", onErr);
    socket.once("close", onClose);
    socket.write(`GET ${reqPath} HTTP/1.1\r\nHost: ${host}\r\nConnection: keep-alive\r\n\r\n`);
  });
}

describe("v2.24.6 server keep-alive timeout", () => {
  it("startHttpServer holds keepAliveTimeout above the client window with headersTimeout above it", () => {
    // Direct observation of the SHIPPED server object — not a comment or a
    // config flag, the real net.Server the daemon runs with.
    expect(server.keepAliveTimeout).toBe(61000);
    expect(server.headersTimeout).toBe(65000);
    // Node ordering invariant: headersTimeout must exceed keepAliveTimeout, or a
    // slow-header request could be reaped by the wrong timer.
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
  });

  it(
    "does not close a raw client's idle keep-alive socket inside the client window (harm leg — fails if keepAliveTimeout regresses)",
    async () => {
      const socket = net.connect(port, "127.0.0.1");
      let closedEarly = false;
      socket.on("close", () => {
        closedEarly = true;
      });
      await new Promise<void>((res, rej) => {
        socket.once("connect", () => res());
        socket.once("error", rej);
      });

      // Innocent twin / baseline: a first request on a fresh keep-alive socket
      // succeeds, so any failure below is attributable to the idle-reuse, not a
      // broken harness.
      const first = await sendAndReadOne(socket, "/health", "127.0.0.1", 5000);
      expect(first.status).toBe(200);

      // Idle PAST the old 5s default (server FIN'd at ~6s pre-fix) but far below
      // the new 61s bound. Post-fix the socket survives with ~53s of margin;
      // pre-fix it is already gone.
      await new Promise((r) => setTimeout(r, 8000));
      expect(
        closedEarly,
        "server closed the idle keep-alive socket during the 8s idle — keepAliveTimeout regressed below the client window",
      ).toBe(false);

      // Reuse the SAME socket. Post-fix this is a healthy 200; pre-fix the write
      // lands on a FIN'd socket and the read resets.
      const second = await sendAndReadOne(socket, "/health", "127.0.0.1", 5000);
      expect(second.status).toBe(200);

      socket.destroy();
    },
    20000,
  );
});
