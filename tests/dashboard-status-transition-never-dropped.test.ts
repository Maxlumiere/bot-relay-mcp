// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * A dashboard STATE transition is never silently lost.
 *
 * THE DEFECT: broadcastDashboardEvent rate-limits per `${event}:${entity_id}` (500 ms) and DROPS an event inside the
 * window, and the decay broadcaster recorded the new state as broadcast BEFORE sending it, so a dropped transition
 * was never re-sent: the dashboard kept showing the old state until some later transition.
 *
 * HOW CI REACHED IT (macOS RT1 on main ba5b97a, RT2 at 04adea0, #328's rt-progress): registerAgent stamps last_seen
 * BEFORE its two sync bcrypt hashes, so on a slow runner the broadcaster first sees a new agent already aged by the
 * hash time. Aged 500-1000 ms at first sight, `active` is sent and the first `waiting` tick lands inside the limiter's
 * window: dropped, and (before the fix) never re-sent. R1 below is that sequence on a controlled clock;
 * tests/dashboard-transition-stale-first-sight.test.ts drives it through the real HTTP register.
 *
 * THE RULE: broadcastDashboardEvent returns what happened (sent | rate_limited | no_clients | error), and the
 * broadcaster advances its last-sent state only when the frame was handed to an OPEN client (or no client was
 * connected: nothing on any screen to go stale). A limited transition is re-sent on a later tick, latest state wins.
 * A NEW subscriber (connect or reconnect) resets that baseline: the next tick re-sends every agent's current state.
 *
 * ONE CLOCK: `Date` is faked (only Date: timers and socket I/O stay real), so the broadcaster's clock and the
 * limiter's clock are the same value, set by each test. Every result the broadcaster got is recorded, and every
 * frame a client received is observed on its own socket: a test can never pass on a scheduling pause.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
const ws = await import("../src/transport/websocket.js");
const { broadcastDashboardEvent, _resetDashboardWsForTests } = ws;
const { DashboardStateBroadcaster } = await import("../src/dashboard-state-broadcaster.js");
const { DEFAULT_THRESHOLDS } = await import("../src/agent-state-machine.js");
const { closeDb } = await import("../src/db.js");

let server: HttpServer;
let port: number;

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
/** Set the ONE clock (broadcaster + limiter). */
const at = (ms: number) => vi.setSystemTime(T0 + ms);

beforeEach(async () => {
  _resetDashboardWsForTests();
  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  server = startHttpServer(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 80));
  port = (server.address() as { port: number }).port;
  vi.useFakeTimers({ toFake: ["Date"], now: T0 });
});
afterEach(async () => {
  vi.useRealTimers();
  // Clients FIRST: a test that failed before its own close leaves a socket open, and server.close() would wait on
  // it past the hook timeout, failing every later test for the wrong reason.
  _resetDashboardWsForTests();
  await new Promise<void>((r) => server.close(() => r()));
  closeDb();
  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

const THRESHOLDS = { ...DEFAULT_THRESHOLDS, activeWindowMs: 1000 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One agent "x" whose last_seen the test moves; every broadcast result is recorded as `kind:result`. */
function rig() {
  const agent = { lastSeen: new Date(T0).toISOString() };
  const results: string[] = [];
  const broadcaster = new DashboardStateBroadcaster({
    getAgents: () => [
      {
        name: "x",
        inputs: { lastSeen: agent.lastSeen, signalReceivedAt: null, signalKind: null, unregisteredAt: null, pendingCount: 0, lastDispatchedAt: null, liveness: "unknown" },
      },
    ],
    broadcast: (e) => {
      const r = broadcastDashboardEvent(e);
      results.push(`${e.kind}:${r}`);
      return r;
    },
    subscriberGeneration: ws.dashboardSubscriberGeneration,
    scheduler: { setInterval: () => ({ stop: () => undefined }) }, // never started: ticks are driven by hand
    thresholds: THRESHOLDS,
  });
  return { agent, results, broadcaster };
}

/**
 * A subscribed dashboard client: every frame it receives after the hello, in order. The hello is IDENTIFIED (not
 * dropped unchecked): its arrival proves the server registered this client, so every later frame is buffered for it.
 */
async function subscriber(): Promise<{ frames: Array<{ event: string; entity_id?: string; kind?: string }>; kinds: () => string[]; close: () => void }> {
  const h = await connectWs(port, "/dashboard/ws");
  const hello = JSON.parse(await h.nextMessage()) as { event: string };
  expect(hello.event, "the first frame is the hello").toBe("dashboard.hello");
  const frames: Array<{ event: string; entity_id?: string; kind?: string }> = [];
  h.ws.on("message", (d: Buffer) => frames.push(JSON.parse(d.toString("utf8"))));
  return {
    frames,
    kinds: () => frames.filter((f) => f.event === "agent.status_changed" && f.entity_id === "x").map((f) => f.kind!),
    close: () => h.ws.close(),
  };
}

/** Let in-flight loopback frames land (real time; the faked Date does not move). */
const settle = () => sleep(150);

describe("broadcastDashboardEvent says what happened (typed, never a silent drop)", () => {
  it("no client → no_clients; a client → sent; the same key again inside 500 ms → rate_limited; at 500 ms → sent", async () => {
    const evt = (id: string) => ({ event: "agent.status_changed" as const, entity_id: id, ts: new Date().toISOString(), kind: "active" });
    expect(broadcastDashboardEvent(evt("a"))).toBe("no_clients");
    const s = await subscriber();
    at(0);
    expect(broadcastDashboardEvent(evt("b"))).toBe("sent");
    at(499);
    expect(broadcastDashboardEvent(evt("b"))).toBe("rate_limited");
    at(500);
    expect(broadcastDashboardEvent(evt("b"))).toBe("sent");
    s.close();
  });
});

describe("F1: `sent` means handed to an OPEN client; a failed client is ended, so it reconnects", () => {
  /** A fake server-side socket. `send` behaves per `mode`; `terminated` records whether the server ended it. */
  function fakeClient(readyState: number, mode: "ok" | "throws" | "async-error" | "silent") {
    const c = {
      readyState,
      sent: [] as string[],
      terminated: false,
      send(line: string, cb?: (err?: Error) => void) {
        if (mode === "throws") throw new Error("send failed");
        if (mode === "silent") return; // ws's own behaviour for a CLOSING/CLOSED socket with no callback
        if (mode === "async-error") {
          process.nextTick(() => cb?.(new Error("write EPIPE")));
          return;
        }
        c.sent.push(line);
        process.nextTick(() => cb?.());
      },
      terminate() {
        c.terminated = true;
      },
    };
    return c;
  }
  const OPEN = 1;
  const CLOSING = 2;
  const evt = () => ({ event: "agent.status_changed" as const, entity_id: "f", ts: new Date().toISOString(), kind: "active" });

  it("HARM: the only client is CLOSING → NOT sent (no frame was handed to anyone)", () => {
    const c = fakeClient(CLOSING, "silent");
    ws._addDashboardClientForTests(c);
    expect(broadcastDashboardEvent(evt())).not.toBe("sent");
  });

  it("TWIN: the only client is OPEN → sent, and it got the frame", () => {
    const c = fakeClient(OPEN, "ok");
    ws._addDashboardClientForTests(c);
    expect(broadcastDashboardEvent(evt())).toBe("sent");
    expect(c.sent).toHaveLength(1);
  });

  it("HARM: the only client always throws → error, and the server TERMINATES it (removed, so it reconnects)", () => {
    const c = fakeClient(OPEN, "throws");
    ws._addDashboardClientForTests(c);
    expect(broadcastDashboardEvent(evt())).toBe("error");
    expect(c.terminated, "a client whose send throws is ended, not just forgotten").toBe(true);
    expect(ws._dashboardWsStateForTests().clients).toBe(0);
  });

  it("mixed: one OPEN client + one throwing → sent (to the good one); only the bad one is terminated", () => {
    const good = fakeClient(OPEN, "ok");
    const bad = fakeClient(OPEN, "throws");
    ws._addDashboardClientForTests(good);
    ws._addDashboardClientForTests(bad);
    expect(broadcastDashboardEvent(evt())).toBe("sent");
    expect(good.sent).toHaveLength(1);
    expect(good.terminated).toBe(false);
    expect(bad.terminated).toBe(true);
    expect(ws._dashboardWsStateForTests().clients).toBe(1);
  });

  it("HARM: an ASYNC send error (the write fails after send() returned) → that client is terminated and removed", async () => {
    const c = fakeClient(OPEN, "async-error");
    ws._addDashboardClientForTests(c);
    broadcastDashboardEvent(evt());
    await sleep(10);
    expect(c.terminated, "an async write error ends the socket, so its page reconnects and is re-sent the state").toBe(true);
    expect(ws._dashboardWsStateForTests().clients).toBe(0);
  });
});

describe("EDGE events: a rate-limited drop is counted where an operator can see it", () => {
  it("a second agent.state_changed for the same agent inside 500 ms → rate_limited, /api/snapshot counts it, and the client received exactly ONE frame", async () => {
    const s = await subscriber();
    const evt = { event: "agent.state_changed" as const, entity_id: "y", ts: new Date().toISOString(), kind: "set_status" };
    const drops = async () =>
      ((await (await fetch(`http://127.0.0.1:${port}/api/snapshot`)).json()) as { dashboard_ws?: { rate_limited_drops?: Record<string, number> } }).dashboard_ws?.rate_limited_drops ?? {};
    const before = await drops();
    at(0);
    expect(broadcastDashboardEvent(evt)).toBe("sent");
    at(100);
    expect(broadcastDashboardEvent(evt)).toBe("rate_limited");
    const after = await drops();
    expect((after["agent.state_changed"] ?? 0) - (before["agent.state_changed"] ?? 0)).toBe(1);
    await settle();
    expect(s.frames.filter((f) => f.event === "agent.state_changed" && f.entity_id === "y"), "frames the client actually received").toHaveLength(1);
    s.close();
  });
});

describe("the decay broadcaster never loses a transition to the rate limit", () => {
  it("R1 (the macOS CI red): first seen already 600 ms old → `active` sent, `waiting` rate-limited at 1000 ms → re-sent once the window passes", async () => {
    const { results, broadcaster } = rig();
    const s = await subscriber();
    at(600);
    broadcaster.tick(); // first sight: active, sent
    at(1000);
    broadcaster.tick(); // waiting: 400 ms after the active send → inside the limiter's window
    at(1050);
    broadcaster.tick(); // still inside
    at(1100);
    broadcaster.tick(); // 500 ms after the active send: the window has passed
    at(1200);
    broadcaster.tick(); // steady: nothing more
    await settle();
    // What the screen got FIRST (the observable defect: on main it is ["active"]), then why.
    expect(s.kinds(), "what the dashboard received for x").toEqual(["active", "waiting"]);
    expect(results).toEqual(["active:sent", "waiting:rate_limited", "waiting:rate_limited", "waiting:sent"]);
    s.close();
  });

  it("TWIN: transitions more than 500 ms apart → both sent, once each (no re-send of a sent state)", async () => {
    const { results, broadcaster } = rig();
    const s = await subscriber();
    at(10);
    broadcaster.tick();
    at(1100);
    broadcaster.tick();
    at(1700);
    broadcaster.tick();
    at(2400);
    broadcaster.tick();
    await settle();
    expect(results).toEqual(["active:sent", "waiting:sent"]);
    expect(s.kinds()).toEqual(["active", "waiting"]);
    s.close();
  });

  it("FLAP: active → waiting → active, the last inside the window → limited, then re-sent: the dashboard ends at `active`", async () => {
    const { agent, results, broadcaster } = rig();
    const s = await subscriber();
    at(10);
    broadcaster.tick(); // active, sent
    at(1100);
    broadcaster.tick(); // waiting, sent (1090 ms later)
    agent.lastSeen = new Date(T0 + 1150).toISOString(); // the agent is seen again
    at(1200);
    broadcaster.tick(); // active, 100 ms after the waiting send: limited
    at(1600);
    broadcaster.tick(); // 500 ms after the waiting send: re-sent
    at(1700);
    broadcaster.tick(); // steady
    await settle();
    expect(results).toEqual(["active:sent", "waiting:sent", "active:rate_limited", "active:sent"]);
    expect(s.kinds()).toEqual(["active", "waiting", "active"]);
    s.close();
  });
});

describe("F2: a new subscriber resets the baseline (generation), so a client that joined mid-flap is corrected", () => {
  /** A rig whose state the test flips directly: `active` (seen now) or `waiting` (seen long ago). */
  function flipRig() {
    const r = rig();
    return {
      ...r,
      active: (ms: number) => (r.agent.lastSeen = new Date(T0 + ms).toISOString()),
      waiting: () => (r.agent.lastSeen = new Date(T0 - 60_000).toISOString()),
    };
  }

  it("HARM (Codex's sequence): A sent → B limited → a client connects (its snapshot shows B) → back to A → the new client ends at A", async () => {
    const { results, broadcaster, active, waiting } = flipRig();
    const s1 = await subscriber();
    active(0);
    at(10);
    broadcaster.tick(); // A = active, sent
    waiting();
    at(100);
    broadcaster.tick(); // B = waiting, limited: the broadcaster's baseline stays A
    const s2 = await subscriber(); // joins now; its /api/snapshot would show B
    active(150);
    at(200);
    broadcaster.tick(); // back to A: the generation changed → re-sent, but still inside the window → limited
    at(510);
    broadcaster.tick(); // window passed: A re-sent to every client
    at(700);
    broadcaster.tick(); // steady
    await settle();
    expect(results).toEqual(["active:sent", "waiting:rate_limited", "active:rate_limited", "active:sent"]);
    expect(s2.kinds(), "the joining client's last state").toEqual(["active"]);
    expect(s1.kinds(), "the existing client: A, then the one replay").toEqual(["active", "active"]);
    s1.close();
    s2.close();
  });

  it("TWIN: the same flap with NO new client → no extra frame (A is what every connected screen already shows)", async () => {
    const { results, broadcaster, active, waiting } = flipRig();
    const s1 = await subscriber();
    active(0);
    at(10);
    broadcaster.tick();
    waiting();
    at(100);
    broadcaster.tick();
    active(150);
    at(200);
    broadcaster.tick();
    at(510);
    broadcaster.tick();
    at(700);
    broadcaster.tick();
    await settle();
    expect(results).toEqual(["active:sent", "waiting:rate_limited"]);
    expect(s1.kinds()).toEqual(["active"]);
    s1.close();
  });

  it("a RECONNECT is a connect: the reconnected client gets the current state exactly once, then silence", async () => {
    const { results, broadcaster } = rig();
    const s1 = await subscriber();
    at(10);
    broadcaster.tick(); // active, sent
    s1.close();
    const s2 = await subscriber(); // the same page, reconnected
    at(600);
    broadcaster.tick(); // the generation changed: the current state is re-sent
    at(700);
    broadcaster.tick();
    at(800);
    broadcaster.tick();
    await settle();
    expect(results).toEqual(["active:sent", "active:sent"]);
    expect(s2.kinds()).toEqual(["active"]);
    s2.close();
  });
});
