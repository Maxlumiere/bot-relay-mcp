// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * R2: the macOS CI red (RT1 on main ba5b97a, RT2 at 04adea0, #328's rt-progress), through the REAL HTTP register.
 *
 * registerAgent stamps last_seen BEFORE its two sync bcrypt hashes (the token, the registration-recovery handle) and
 * INSERTs the row after them; no tick can run in between (the hashes block the event loop). So the broadcaster first
 * sees a new agent already aged by the hash time. On a slow runner that age lands between ~500 and 1000 ms: `active`
 * is queued, and the first `waiting` attempt comes less than 500 ms later, inside the dashboard rate limiter's window.
 * Before the fix that `waiting` was dropped AND recorded as sent, so it was never re-sent: the subscriber never saw it.
 *
 * Here the two hashes together are held to ~750 ms, timed from BEFORE the first real hash (so the real hash time is
 * inside the hold, not added to it): the slow runner, reproduced on any machine. The stamp itself is NOT moved (ruled:
 * last_seen = when the request arrived; the defect is the broadcaster's dedup).
 *
 * The HARM case REQUIRES the regression window (Codex #329 R2 P3): every broadcast ATTEMPT is recorded (time, kind,
 * result) by wrapping the real broadcastDashboardEvent, and the case asserts `active` first, then a `waiting` attempt
 * less than 500 ms after it (inside the limiter's window), then `waiting` reaching the subscriber. A run that did not
 * enter the window (e.g. a runner whose real hashes alone exceed the hold) is SKIPPED with the reason printed: it is
 * never counted as regression coverage. The deterministic form of the same sequence is R1 in
 * tests/dashboard-status-transition-never-dropped.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server as HttpServer } from "node:http";

const slow = vi.hoisted(() => ({ on: false, calls: 0, holdFrom: 0, holdMs: 750 }));
vi.mock("../src/auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth.js")>();
  return {
    ...actual,
    hashToken: (token: string): string => {
      // A first registration hashes twice (the token, the registration-recovery handle). The hold starts BEFORE the
      // first real hash and ends ~750 ms later, after the second: the real hash time is inside it, not added to it.
      if (slow.on && ++slow.calls === 1) slow.holdFrom = Date.now();
      const h = actual.hashToken(token);
      if (slow.on && slow.calls === 2) {
        while (Date.now() < slow.holdFrom + slow.holdMs) {
          /* the slow runner: a sync hash blocks the event loop, exactly like this */
        }
      }
      return h;
    },
  };
});

/** Every agent.status_changed ATTEMPT the daemon's broadcaster made: when, which state, and what the limiter did. */
const attempts = vi.hoisted(() => [] as Array<{ at: number; entity: string; kind: string; result: unknown }>);
vi.mock("../src/transport/websocket.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/transport/websocket.js")>();
  return {
    ...actual,
    broadcastDashboardEvent: (evt: Parameters<typeof actual.broadcastDashboardEvent>[0]) => {
      const at = Date.now();
      const result = actual.broadcastDashboardEvent(evt);
      if (evt.event === "agent.status_changed") attempts.push({ at, entity: evt.entity_id, kind: String(evt.kind), result });
      return result;
    },
  };
});

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-stale-first-sight-" + process.pid);
process.env.RELAY_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_HTTP_SECRET;
delete process.env.RELAY_DASHBOARD_SECRET;
// The CI configuration that reached the defect: a 100 ms tick (< the 500 ms limiter window), a 1 s active window.
process.env.RELAY_DECAY_TICK_MS = "100";
process.env.RELAY_STATE_ACTIVE_WINDOW_SEC = "1";
delete process.env.RELAY_DECAY_TICK_DISABLED;

const { startHttpServer } = await import("../src/transport/http.js");
const { _resetDashboardWsForTests } = await import("../src/transport/websocket.js");
const { closeDb, getDb } = await import("../src/db.js");
import { connectWs } from "./_helpers/ws.js";
import { mintHeaders } from "./_helpers/mint.js";

let server: HttpServer;
let port: number;

beforeEach(async () => {
  _resetDashboardWsForTests();
  attempts.length = 0;
  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  server = startHttpServer(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 80));
  port = (server.address() as { port: number }).port;
});
afterEach(async () => {
  slow.on = false;
  slow.calls = 0;
  _resetDashboardWsForTests();
  await new Promise<void>((r) => server.close(() => r()));
  closeDb();
  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

async function register(name: string): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...mintHeaders() },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "register_agent", arguments: { name, role: "user", capabilities: ["build"] } } }),
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  const inner = JSON.parse(dataLine ? dataLine.slice(5).trim() : text) as { result?: { content?: Array<{ text?: string }> } };
  const json = JSON.parse(inner.result?.content?.[0]?.text ?? "null") as { success?: boolean } | null;
  if (json?.success !== true) throw new Error(`register_agent ${name} did not succeed: ${text}`);
}

interface Watched {
  sawWaiting: boolean;
  lastSeen: string;
  frames: Array<{ event: string; entity_id: string; ts: string; kind?: string }>;
  mine: Array<{ at: number; kind: string; result: unknown }>;
  detail: string;
}

/** Subscribe, register `name` (with or without the slow hash), and wait up to 5 s for its `waiting` frame. */
async function registerAndWatch(name: string, slowHash: boolean): Promise<Watched> {
  const h = await connectWs(port, "/dashboard/ws");
  expect((JSON.parse(await h.nextMessage()) as { event: string }).event, "the hello: this subscriber is registered").toBe("dashboard.hello");
  slow.calls = 0;
  slow.on = slowHash;
  await register(name);
  slow.on = false;
  const lastSeen = (getDb().prepare("SELECT last_seen FROM agents WHERE name = ?").get(name) as { last_seen: string }).last_seen;

  const frames: Watched["frames"] = [];
  const deadline = Date.now() + 5000;
  let sawWaiting = false;
  while (!sawWaiting && Date.now() < deadline) {
    let raw: string;
    try {
      raw = await h.nextMessage(Math.max(50, deadline - Date.now()));
    } catch {
      break;
    }
    const f = JSON.parse(raw) as Watched["frames"][number];
    frames.push(f);
    sawWaiting = f.event === "agent.status_changed" && f.entity_id === name && f.kind === "waiting";
  }
  h.ws.close();
  const mine = attempts.filter((a) => a.entity === name).map(({ at, kind, result }) => ({ at, kind, result }));
  const firstSightAgeMs = mine.length ? mine[0]!.at - Date.parse(lastSeen) : null;
  const detail =
    `last_seen ${lastSeen}; first-sight age ${firstSightAgeMs} ms; attempts ${JSON.stringify(mine.map((a) => ({ ...a, at: new Date(a.at).toISOString() })))}; ` +
    `frames ${JSON.stringify(frames)}`;
  return { sawWaiting, lastSeen, frames, mine, detail };
}

describe("R2: a new agent first seen 500-1000 ms old still reaches `waiting` on the dashboard", () => {
  it("HARM: the real HTTP register with a slow hash: `active`, a RATE-LIMITED `waiting` attempt, then `waiting` delivered", async (ctx) => {
    const w = await registerAndWatch("rt-stale-first-sight", true);
    // THE REPRODUCTION PRECONDITION, judged from attempt TIMES (so it holds on a tree with or without the fix): the
    // first attempt is `active`, and a `waiting` attempt follows it by less than the limiter's 500 ms window.
    const first = w.mine[0];
    const inWindow = first?.kind === "active" && w.mine.some((a) => a.kind === "waiting" && a.at - first.at < 500);
    if (!inWindow) {
      const note = `R2 PRECONDITION UNMET (not counted as regression coverage): the run never put a \`waiting\` attempt inside the limiter window after \`active\`. ${w.detail}`;
      process.stderr.write(`${note}\n`);
      ctx.skip(note);
    }
    expect(w.sawWaiting, `no waiting frame within 5 s. ${w.detail}`).toBe(true);
    // And WHY it arrived: the in-window attempt was rate-limited, and a later attempt queued it.
    const limited = w.mine.findIndex((a) => a.kind === "waiting" && a.result === "rate_limited");
    expect(limited, `the in-window waiting attempt was rate-limited. ${w.detail}`).toBeGreaterThan(0);
    expect(w.mine.slice(limited + 1).some((a) => a.kind === "waiting" && a.result === "queued"), `then re-sent and queued. ${w.detail}`).toBe(true);
  }, 15_000);

  it("TWIN: the same register at this machine's own hash speed: the subscriber receives waiting", async () => {
    const w = await registerAndWatch("rt-fresh-first-sight", false);
    expect(w.sawWaiting, `no waiting frame within 5 s. ${w.detail}`).toBe(true);
  }, 15_000);
});
