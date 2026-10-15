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
 * THE RULE: broadcastDashboardEvent returns what happened (queued | rate_limited | no_clients | error), and the
 * broadcaster commits a state only when its frame was QUEUED to an OPEN client (or no client was open: nothing on
 * any screen to go stale). A limited transition is re-sent on a later tick, latest state wins. The baseline is VOIDED,
 * so the next tick re-sends every agent's CURRENT state, by a new subscriber (connect or reconnect) and by any async
 * write error (a queued frame that never arrived): never lost beyond one tick plus the limiter window.
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
    baselineGeneration: ws.dashboardBaselineGeneration,
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
  it("no client → no_clients; a client → queued; the same key again inside 500 ms → rate_limited; at 500 ms → queued", async () => {
    const evt = (id: string) => ({ event: "agent.status_changed" as const, entity_id: id, ts: new Date().toISOString(), kind: "active" });
    expect(broadcastDashboardEvent(evt("a"))).toBe("no_clients");
    const s = await subscriber();
    at(0);
    expect(broadcastDashboardEvent(evt("b"))).toBe("queued");
    at(499);
    expect(broadcastDashboardEvent(evt("b"))).toBe("rate_limited");
    at(500);
    expect(broadcastDashboardEvent(evt("b"))).toBe("queued");
    s.close();
  });
});

/**
 * A fake server-side socket. `send` behaves per `mode`; `terminated` records whether the server ended it.
 * "deferred": every send is accepted (queued) and its write callback is held in `writes` until the test settles it,
 * so a LATE error (after a newer frame was queued) is driven exactly.
 */
function fakeClient(readyState: number, mode: "ok" | "throws" | "async-error" | "silent" | "deferred") {
  const c = {
    readyState,
    sent: [] as string[],
    terminated: false,
    writes: [] as Array<(err?: Error) => void>,
    send(line: string, cb?: (err?: Error) => void) {
      if (mode === "throws") throw new Error("send failed");
      if (mode === "silent") return; // ws's own behaviour for a CLOSING/CLOSED socket with no callback
      if (mode === "async-error") {
        process.nextTick(() => cb?.(new Error("write EPIPE")));
        return;
      }
      c.sent.push(line);
      if (mode === "deferred") c.writes.push(cb ?? (() => undefined));
      else process.nextTick(() => cb?.());
    },
    terminate() {
      c.terminated = true;
    },
  };
  return c;
}
const OPEN = 1;
const CLOSING = 2;
/** The `kind`s of the agent.status_changed frames for "x" that a fake client was handed, in order. */
const kindsOf = (c: { sent: string[] }) =>
  c.sent.map((l) => JSON.parse(l) as { event: string; entity_id: string; kind: string }).filter((f) => f.event === "agent.status_changed" && f.entity_id === "x").map((f) => f.kind);

describe("F1: `queued` means accepted by an OPEN client; a failed client is ended, so it reconnects", () => {
  const evt = () => ({ event: "agent.status_changed" as const, entity_id: "f", ts: new Date().toISOString(), kind: "active" });

  it("HARM: the only client is CLOSING → NOT queued (no frame was handed to anyone)", () => {
    const c = fakeClient(CLOSING, "silent");
    ws._addDashboardClientForTests(c);
    expect(broadcastDashboardEvent(evt())).not.toBe("queued");
  });

  it("TWIN: the only client is OPEN → queued, and it got the frame", () => {
    const c = fakeClient(OPEN, "ok");
    ws._addDashboardClientForTests(c);
    expect(broadcastDashboardEvent(evt())).toBe("queued");
    expect(c.sent).toHaveLength(1);
  });

  it("HARM: the only client always throws → error, and the server TERMINATES it (removed, so it reconnects)", () => {
    const c = fakeClient(OPEN, "throws");
    ws._addDashboardClientForTests(c);
    expect(broadcastDashboardEvent(evt())).toBe("error");
    expect(c.terminated, "a client whose send throws is ended, not just forgotten").toBe(true);
    expect(ws._dashboardWsStateForTests().clients).toBe(0);
  });

  it("mixed: one OPEN client + one throwing → queued (to the good one); only the bad one is terminated", () => {
    const good = fakeClient(OPEN, "ok");
    const bad = fakeClient(OPEN, "throws");
    ws._addDashboardClientForTests(good);
    ws._addDashboardClientForTests(bad);
    expect(broadcastDashboardEvent(evt())).toBe("queued");
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

describe("an ASYNC write error voids the baseline: the state committed when QUEUED is re-sent if its write failed", () => {
  it("HARM: EPIPE after a queued frame → the NEXT tick re-sends the current state (to the client that remains)", async () => {
    const { results, broadcaster } = rig();
    const good = fakeClient(OPEN, "ok");
    const failing = fakeClient(OPEN, "async-error");
    ws._addDashboardClientForTests(good);
    ws._addDashboardClientForTests(failing);
    at(10);
    broadcaster.tick(); // active: queued to both, committed
    await sleep(10); // the failing client's write reports EPIPE
    at(600);
    broadcaster.tick(); // the baseline was voided: active re-sent
    at(700);
    broadcaster.tick(); // steady
    expect(kindsOf(good), "what the remaining client was handed").toEqual(["active", "active"]);
    expect(failing.terminated).toBe(true);
    expect(results).toEqual(["active:queued", "active:queued"]);
  });

  it("TWIN: no write error → no re-send (a queued state is not repeated)", async () => {
    const { results, broadcaster } = rig();
    const good = fakeClient(OPEN, "ok");
    ws._addDashboardClientForTests(good);
    at(10);
    broadcaster.tick();
    await sleep(10);
    at(600);
    broadcaster.tick();
    at(700);
    broadcaster.tick();
    expect(kindsOf(good)).toEqual(["active"]);
    expect(results).toEqual(["active:queued"]);
  });

  it("a LATE error (arriving after a newer state was queued) → one extra frame of the CURRENT state, never the stale one", async () => {
    const { results, broadcaster } = rig();
    const good = fakeClient(OPEN, "ok");
    const slow = fakeClient(OPEN, "deferred");
    ws._addDashboardClientForTests(good);
    ws._addDashboardClientForTests(slow);
    at(10);
    broadcaster.tick(); // active: queued (slow's write still pending)
    at(1100);
    broadcaster.tick(); // waiting: queued (slow's writes still pending)
    slow.writes[0]!(new Error("write EPIPE")); // the OLD frame (active) fails, after waiting was queued
    at(1700);
    broadcaster.tick(); // the baseline was voided: the CURRENT state (waiting) is re-sent
    at(1800);
    broadcaster.tick(); // steady
    expect(kindsOf(good), "the remaining client: never `active` again").toEqual(["active", "waiting", "waiting"]);
    expect(results).toEqual(["active:queued", "waiting:queued", "waiting:queued"]);
  });

  it("an error on a client that is then terminated → the remaining (real) client gets the re-send, and the reconnect gets its own", async () => {
    const { agent, results, broadcaster } = rig();
    const s = await subscriber();
    const failing = fakeClient(OPEN, "async-error");
    ws._addDashboardClientForTests(failing);
    at(10);
    broadcaster.tick(); // active: queued to both
    await sleep(10); // EPIPE on the fake: it is terminated, the baseline voided
    at(600);
    broadcaster.tick(); // re-sent to the real client that remains
    expect(failing.terminated).toBe(true);
    const back = await subscriber(); // the failed page reconnects: a connect, so the baseline is voided again
    agent.lastSeen = new Date(T0 + 1000).toISOString(); // still active: the state does not change in this case
    at(1200);
    broadcaster.tick(); // re-sent once more, to both
    at(1300);
    broadcaster.tick(); // steady
    await settle();
    expect(s.kinds(), "the client that remained").toEqual(["active", "active", "active"]);
    expect(back.kinds(), "the reconnected client: the current state, once").toEqual(["active"]);
    expect(results).toEqual(["active:queued", "active:queued", "active:queued"]);
    s.close();
    back.close();
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
    expect(broadcastDashboardEvent(evt)).toBe("queued");
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
  it("R1 (the macOS CI red): first seen already 600 ms old → `active` queued, `waiting` rate-limited at 1000 ms → re-sent once the window passes", async () => {
    const { results, broadcaster } = rig();
    const s = await subscriber();
    at(600);
    broadcaster.tick(); // first sight: active, queued
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
    expect(results).toEqual(["active:queued", "waiting:rate_limited", "waiting:rate_limited", "waiting:queued"]);
    s.close();
  });

  it("TWIN: transitions more than 500 ms apart → both queued, once each (no re-send of a queued state)", async () => {
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
    expect(results).toEqual(["active:queued", "waiting:queued"]);
    expect(s.kinds()).toEqual(["active", "waiting"]);
    s.close();
  });

  it("FLAP: active → waiting → active, the last inside the window → limited, then re-sent: the dashboard ends at `active`", async () => {
    const { agent, results, broadcaster } = rig();
    const s = await subscriber();
    at(10);
    broadcaster.tick(); // active, queued
    at(1100);
    broadcaster.tick(); // waiting, queued (1090 ms later)
    agent.lastSeen = new Date(T0 + 1150).toISOString(); // the agent is seen again
    at(1200);
    broadcaster.tick(); // active, 100 ms after the waiting send: limited
    at(1600);
    broadcaster.tick(); // 500 ms after the waiting send: re-sent
    at(1700);
    broadcaster.tick(); // steady
    await settle();
    expect(results).toEqual(["active:queued", "waiting:queued", "active:rate_limited", "active:queued"]);
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

  it("HARM (Codex's sequence): A queued → B limited → a client connects (its snapshot shows B) → back to A → the new client ends at A", async () => {
    const { results, broadcaster, active, waiting } = flipRig();
    const s1 = await subscriber();
    active(0);
    at(10);
    broadcaster.tick(); // A = active, queued
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
    expect(results).toEqual(["active:queued", "waiting:rate_limited", "active:rate_limited", "active:queued"]);
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
    expect(results).toEqual(["active:queued", "waiting:rate_limited"]);
    expect(s1.kinds()).toEqual(["active"]);
    s1.close();
  });

  it("a RECONNECT is a connect: the reconnected client gets the current state exactly once, then silence", async () => {
    const { results, broadcaster } = rig();
    const s1 = await subscriber();
    at(10);
    broadcaster.tick(); // active, queued
    s1.close();
    const s2 = await subscriber(); // the same page, reconnected
    at(600);
    broadcaster.tick(); // the baseline generation changed: the current state is re-sent
    at(700);
    broadcaster.tick();
    at(800);
    broadcaster.tick();
    await settle();
    expect(results).toEqual(["active:queued", "active:queued"]);
    expect(s2.kinds()).toEqual(["active"]);
    s2.close();
  });
});
