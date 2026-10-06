// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * PR-E (architect DETAIL c350f046): ONE loopback-peer predicate, isLoopbackPeer (src/cidr.ts), for both
 * surfaces that admit a loopback peer without a credential: the HTTP dashboard gate and the dashboard
 * WebSocket gate (ADR-0015 L4). Each address is written the way a socket can report it, and the SAME
 * matrix is driven through BOTH real gates: the real server boots, and every socket it accepts is
 * given the address under test as its peer, so the whole middleware / upgrade path runs.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import type { AddressInfo, Socket } from "net";
import { WebSocket } from "ws";

const TEST_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bot-relay-pr-e-loopback-"));
process.env.RELAY_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
delete process.env.RELAY_HTTP_SECRET;
delete process.env.RELAY_DASHBOARD_SECRET; // the no-secret posture: the only one with a loopback allow

const { isLoopbackPeer } = await import("../src/cidr.js");
const { startHttpServer } = await import("../src/transport/http.js");
const { _resetDashboardWsForTests } = await import("../src/transport/websocket.js");
const { closeDb } = await import("../src/db.js");

const ALLOWED = ["127.0.0.1", "127.0.0.2", "127.255.255.254", "::ffff:127.0.0.1", "::ffff:7f00:1", "::FFFF:7F00:2", "0:0:0:0:0:ffff:7f00:1", "::1", "0:0:0:0:0:0:0:1"];
const REFUSED = ["10.0.0.1", "::ffff:10.0.0.1", "::ffff:a00:1", "192.168.1.1", "::", "0.0.0.0", "::127.0.0.1", "fe80::1%lo0", "2001:db8::1"];

describe("isLoopbackPeer: canonical first, then 127.0.0.0/8 or ::1", () => {
  it("every spelling of a loopback peer is loopback", () => {
    for (const a of ALLOWED) expect(isLoopbackPeer(a), a).toBe(true);
  });
  it("anything else, a rejected spelling (IPv4-compatible, zone id) included, is not", () => {
    for (const a of REFUSED) expect(isLoopbackPeer(a), a).toBe(false);
  });
  it("a hostname or an absent peer is NOT loopback (fail closed): a socket peer is always an address", () => {
    for (const a of ["localhost", "", undefined, null]) expect(isLoopbackPeer(a), String(a)).toBe(false);
  });
});

describe("the SAME verdict on BOTH real gates (no dashboard secret configured)", () => {
  let server: http.Server;
  let port: number;
  let peer = "127.0.0.1";
  beforeAll(async () => {
    _resetDashboardWsForTests();
    server = startHttpServer(0, "127.0.0.1");
    // Every accepted socket reports the address under test as its peer: both gates read req.socket.remoteAddress.
    server.on("connection", (s: Socket) => Object.defineProperty(s, "remoteAddress", { value: peer, configurable: true }));
    if (!server.listening) await new Promise<void>((r) => server.once("listening", () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    _resetDashboardWsForTests();
    await new Promise<void>((r) => server.close(() => r()));
    closeDb();
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  });

  const httpStatus = () =>
    new Promise<number>((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/api/snapshot", agent: false }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
    });
  const wsOpens = () =>
    new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/dashboard/ws`);
      ws.on("open", () => {
        ws.close();
        resolve(true);
      });
      ws.on("unexpected-response", () => resolve(false));
      ws.on("error", () => resolve(false));
    });

  it("a loopback peer, however written, is ALLOWED on the HTTP gate AND the WS gate", async () => {
    for (const a of ALLOWED.filter((x) => !x.includes("%"))) {
      peer = a;
      expect(await httpStatus(), `HTTP ${a}`).toBe(200);
      expect(await wsOpens(), `WS ${a}`).toBe(true);
    }
  });
  it("a non-loopback peer (mapped and hex spellings included) is REFUSED on the HTTP gate AND the WS gate", async () => {
    for (const a of REFUSED) {
      peer = a;
      expect(await httpStatus(), `HTTP ${a}`).toBe(403);
      expect(await wsOpens(), `WS ${a}`).toBe(false);
    }
  });
  it("control: the harness really drives the peer (a refused address flips to allowed and back)", async () => {
    peer = "10.0.0.1";
    expect(await httpStatus()).toBe(403);
    peer = "127.0.0.1";
    expect(await httpStatus()).toBe(200);
  });
});
