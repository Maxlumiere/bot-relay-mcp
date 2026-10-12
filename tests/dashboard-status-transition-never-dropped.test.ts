// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * A dashboard STATE transition is never silently lost.
 *
 * THE DEFECT: broadcastDashboardEvent rate-limits per `${event}:${entity_id}` (500 ms) and DROPS an event inside the
 * window, and the decay broadcaster recorded the new state as broadcast BEFORE sending it, so a dropped transition
 * was never re-sent: the dashboard kept showing the old state until some later transition. The `waiting` frame that
 * macOS CI run 38234341596 never saw (RT2) is one shape this mechanism CAN produce (shown possible, not proven: that
 * run kept no per-tick record).
 *
 * THE RULE: broadcastDashboardEvent returns what happened (sent | rate_limited | no_clients | error), and the
 * broadcaster advances its last-sent state only when the frame was SENT (or when no client was connected: nothing on
 * any screen to go stale). A limited transition is re-sent on a later tick, latest state wins.
 *
 * The broadcaster here runs on an INJECTED clock (its `now`), driven tick by tick; the rate limit runs on real time.
 * Two ticks a few ms apart therefore fall inside the limiter's window, deterministically, with no load.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { Server as HttpServer } from "http";
import { connectWs } from "./_helpers/ws.js";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-transition-" + process.pid);
process.env.RELAY_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DECAY_TICK_DISABLED = "1"; // the server's own broadcaster stays off: this test drives its own
delete process.env.RELAY_HTTP_SECRET;
delete process.env.RELAY_DASHBOARD_SECRET;

const { startHttpServer } = await import("../src/transport/http.js");
const { broadcastDashboardEvent, _resetDashboardWsForTests } = await import("../src/transport/websocket.js");
const { DashboardStateBroadcaster } = await import("../src/dashboard-state-broadcaster.js");
const { DEFAULT_THRESHOLDS } = await import("../src/agent-state-machine.js");
const { closeDb } = await import("../src/db.js");

let server: HttpServer;
let port: number;

beforeEach(async () => {
  _resetDashboardWsForTests();
  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  server = startHttpServer(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 80));
  port = (server.address() as { port: number }).port;
});
afterEach(async () => {
  // Clients FIRST: a test that failed before its own close leaves a socket open, and server.close() would wait on
  // it past the hook timeout, failing every later test for the wrong reason.
  _resetDashboardWsForTests();
  await new Promise<void>((r) => server.close(() => r()));
  closeDb();
  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const THRESHOLDS = { ...DEFAULT_THRESHOLDS, activeWindowMs: 1000 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One agent whose last_seen the test moves; the broadcaster's clock is `clock.now`. */
function rig() {
  const clock = { now: T0 };
  const agent = { lastSeen: new Date(T0).toISOString() };
  const broadcaster = new DashboardStateBroadcaster({
    getAgents: () => [
      {
        name: "x",
        inputs: { lastSeen: agent.lastSeen, signalReceivedAt: null, signalKind: null, unregisteredAt: null, pendingCount: 0, lastDispatchedAt: null, liveness: "unknown" },
      },
    ],
    broadcast: broadcastDashboardEvent,
    scheduler: { setInterval: () => ({ stop: () => undefined }) }, // never started: ticks are driven by hand
    thresholds: THRESHOLDS,
    now: () => clock.now,
  });
  return { clock, agent, broadcaster };
}

/** A subscribed dashboard client: every `agent.status_changed` kind it receives for "x", in order. */
async function subscriber(): Promise<{ kinds: string[]; close: () => void }> {
  const h = await connectWs(port, "/dashboard/ws");
  await h.nextMessage(); // the hello: this client is registered
  const kinds: string[] = [];
  h.ws.on("message", (d: Buffer) => {
    const f = JSON.parse(d.toString("utf8")) as { event: string; entity_id?: string; kind?: string };
    if (f.event === "agent.status_changed" && f.entity_id === "x" && f.kind) kinds.push(f.kind);
  });
  return { kinds, close: () => h.ws.close() };
}

/** Real-time ticks (the broadcaster's clock frozen) for `ms`: what the running interval would do. */
async function tickFor(b: { tick: () => void }, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    b.tick();
    await sleep(100);
  }
}

describe("broadcastDashboardEvent says what happened (typed, never a silent drop)", () => {
  it("no client → no_clients; a client → sent; the same key again inside 500 ms → rate_limited", async () => {
    const evt = (id: string) => ({ event: "agent.status_changed" as const, entity_id: id, ts: new Date().toISOString(), kind: "active" });
    expect(broadcastDashboardEvent(evt("a"))).toBe("no_clients");
    const s = await subscriber();
    expect(broadcastDashboardEvent(evt("b"))).toBe("sent");
    expect(broadcastDashboardEvent(evt("b"))).toBe("rate_limited");
    s.close();
  });
});

describe("EDGE events: a rate-limited drop is counted where an operator can see it", () => {
  it("a second agent.state_changed for the same agent inside 500 ms → rate_limited, and /api/snapshot counts it", async () => {
    const s = await subscriber();
    const evt = { event: "agent.state_changed" as const, entity_id: "y", ts: new Date().toISOString(), kind: "set_status" };
    const before = ((await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as { dashboard_ws?: { rate_limited_drops?: Record<string, number> } }).dashboard_ws?.rate_limited_drops ?? {};
    expect(broadcastDashboardEvent(evt)).toBe("sent");
    expect(broadcastDashboardEvent(evt)).toBe("rate_limited");
    const after = ((await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as { dashboard_ws?: { rate_limited_drops?: Record<string, number> } }).dashboard_ws?.rate_limited_drops ?? {};
    expect((after["agent.state_changed"] ?? 0) - (before["agent.state_changed"] ?? 0)).toBe(1);
    s.close();
  });
});

describe("the decay broadcaster never loses a transition to the rate limit", () => {
  it("HARM: active then waiting inside the 500 ms window → the dashboard still ends at `waiting`", async () => {
    const { clock, broadcaster } = rig();
    const s = await subscriber();
    clock.now = T0 + 10;
    broadcaster.tick(); // active (sent)
    clock.now = T0 + 1100;
    broadcaster.tick(); // waiting, a few ms of REAL time later: inside the limiter's window
    await tickFor(broadcaster, 1200); // the interval keeps ticking; the clock is frozen at T0+1100
    expect(s.kinds, "the dashboard's last state for x").toEqual(["active", "waiting"]);
    s.close();
  });

  it("TWIN: transitions more than 500 ms apart → both sent, once each (no re-send of a sent state)", async () => {
    const { clock, broadcaster } = rig();
    const s = await subscriber();
    clock.now = T0 + 10;
    broadcaster.tick();
    await sleep(600);
    clock.now = T0 + 1100;
    broadcaster.tick();
    await tickFor(broadcaster, 700);
    expect(s.kinds).toEqual(["active", "waiting"]);
    s.close();
  });

  it("FLAP: active → waiting → active, the last two inside the window → the dashboard ends at `active` (no stale `waiting` left on screen)", async () => {
    const { clock, agent, broadcaster } = rig();
    const s = await subscriber();
    clock.now = T0 + 10;
    broadcaster.tick(); // active (sent)
    await sleep(600);
    clock.now = T0 + 1100;
    broadcaster.tick(); // waiting (sent: > 500 ms after active)
    agent.lastSeen = new Date(T0 + 1100).toISOString(); // the agent is seen again: active
    broadcaster.tick(); // active, a few ms later: inside the window
    await tickFor(broadcaster, 1200);
    expect(s.kinds.at(-1), `frames for x: ${JSON.stringify(s.kinds)}`).toBe("active");
    s.close();
  });
});
