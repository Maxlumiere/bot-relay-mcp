// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.8 R1 — closes codex-5-5 P1 (broadcaster never wired to HTTP
 * daemon) + P2 (`last_dispatched_at` is schema-only, no producer
 * writes).
 *
 * Two test groups:
 *   RT — Runtime broadcaster path. Boots the REAL HTTP server with a
 *        short `RELAY_DECAY_TICK_MS`, observes a real `agent.status_changed`
 *        WS event for a TIME-ONLY transition (no mutation). This proves
 *        the broadcaster instance actually ticks in production — the
 *        R0 D1-D19 unit tests proved the class works in isolation but
 *        never proved the daemon emits ticks.
 *
 *   PRD — Producer-write tests for `last_dispatched_at`. Send messages
 *        + post tasks via the real HTTP MCP transport, query the
 *        agents row, assert `last_dispatched_at` populated (or NOT)
 *        per the role-allowlist + priority rules in
 *        `markRecipientDispatched` (src/db.ts).
 *
 * Both groups exercise the SHIPPED runtime path per
 * `feedback_test_path_must_match_shipped_path.md`. No fixture
 * shortcuts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server as HttpServer } from "node:http";
import type { WebSocket } from "ws";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v2-8-r1-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_HTTP_SECRET;
delete process.env.RELAY_DASHBOARD_SECRET;
// Tight thresholds for the runtime test — keeps total runtime under
// vitest's default 5s timeout. The unit suite already covers default-
// threshold semantics exhaustively.
process.env.RELAY_DECAY_TICK_MS = "100";
process.env.RELAY_STATE_ACTIVE_WINDOW_SEC = "1";
delete process.env.RELAY_DECAY_TICK_DISABLED;

const { startHttpServer } = await import("../src/transport/http.js");
const { _resetDashboardWsForTests } = await import("../src/transport/websocket.js");
const { closeDb, getDb } = await import("../src/db.js");

import { connectWs as baseConnectWs } from "./_helpers/ws.js";

let server: HttpServer;
let port: number;

async function bootServer(extraEnv: Record<string, string | undefined> = {}): Promise<void> {
  _resetDashboardWsForTests();
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  server = startHttpServer(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 80));
  const addr = server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
}

async function connectWs(): Promise<{
  ws: WebSocket;
  nextMessage: (timeoutMs?: number) => Promise<string>;
}> {
  return baseConnectWs(port, "/dashboard/ws");
}

interface RpcResult {
  ok: boolean;
  json: Record<string, unknown> | null;
}

async function rpc(
  tool: string,
  args: Record<string, unknown>,
  token?: string,
): Promise<RpcResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (token) headers["X-Agent-Token"] = token;
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  let json: Record<string, unknown> | null = null;
  if (dataLine) {
    const inner = JSON.parse(dataLine.slice(5).trim()) as {
      result?: { content?: Array<{ text?: string }> };
    };
    const innerText = inner.result?.content?.[0]?.text;
    if (innerText) json = JSON.parse(innerText);
  }
  return { ok: res.ok, json };
}

beforeEach(async () => {
  // Re-assert tight env for each test (other test files might mutate
  // process.env when they boot in the same worker).
  process.env.RELAY_DECAY_TICK_MS = "100";
  process.env.RELAY_STATE_ACTIVE_WINDOW_SEC = "1";
  delete process.env.RELAY_DECAY_TICK_DISABLED;
  await bootServer();
});

afterEach(() => {
  _resetDashboardWsForTests();
  try {
    if (server) server.close();
  } catch {
    /* ignore */
  }
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

interface BroadcastFrame {
  event: string;
  entity_id: string;
  ts: string;
  kind?: string;
}

async function collectFrames(
  ws: { ws: WebSocket; nextMessage: (timeoutMs?: number) => Promise<string> },
  expected: number,
  perFrameTimeoutMs = 3000,
): Promise<BroadcastFrame[]> {
  await ws.nextMessage(); // drain hello
  const frames: BroadcastFrame[] = [];
  for (let i = 0; i < expected; i++) {
    try {
      const raw = await ws.nextMessage(perFrameTimeoutMs);
      frames.push(JSON.parse(raw) as BroadcastFrame);
    } catch {
      break;
    }
  }
  return frames;
}

// =====================================================================
// RT — Runtime broadcaster path
// =====================================================================
describe("v2.8 R1 — runtime broadcaster path", () => {
  it("(RT1) HTTP daemon emits agent.status_changed for a time-only transition (active → waiting) WITHOUT any mutation", async () => {
    // Register a fresh agent — broadcaster's first tick observes
    // `active` (last_seen is now). Wait > 1s (the activeWindow) so
    // last_seen ages past the threshold. The next tick observes
    // `waiting` and broadcasts the transition. We capture both the
    // initial 'active' tick AND the 'waiting' transition.
    const reg = await rpc("register_agent", {
      name: "rt-time-only",
      role: "user", // not a dispatch-relevant role → recent dispatch rule won't fire
      capabilities: ["build"],
    });
    expect(reg.ok).toBe(true);

    // Connect WS AFTER register so we don't race the register's own
    // immediate agent.state_changed broadcast. The decay broadcaster
    // ticks every 100ms (RELAY_DECAY_TICK_MS=100). Within ~200ms we
    // expect the FIRST tick to observe active + broadcast a fresh
    // status_changed event (lastBroadcastedState is empty after
    // server startup).
    const wsHandle = await connectWs();
    // Wait 1.5s for last_seen to age past the 1s activeWindow.
    await new Promise((r) => setTimeout(r, 1500));

    // The broadcaster has ticked many times by now. Drain hello +
    // collect up to 5 frames; we expect at least one with
    // entity_id=rt-time-only AND kind=waiting (the time-only
    // transition).
    const frames = await collectFrames(wsHandle, 5);
    const waitingFrame = frames.find(
      (f) =>
        f.event === "agent.status_changed" &&
        f.entity_id === "rt-time-only" &&
        f.kind === "waiting",
    );
    expect(
      waitingFrame,
      `expected agent.status_changed:waiting for rt-time-only. Saw frames: ${JSON.stringify(frames)}`,
    ).toBeDefined();
    wsHandle.ws.close();
  }, 10_000);

  it("(RT2) Dedup correctness: broadcaster does NOT re-emit waiting on subsequent ticks once state has stabilized", async () => {
    await rpc("register_agent", {
      name: "rt-dedup",
      role: "user",
      capabilities: ["build"],
    });
    await new Promise((r) => setTimeout(r, 1500)); // age past activeWindow

    // Connect AFTER the transition has already fired. Should see ZERO
    // further agent.status_changed frames for rt-dedup because state
    // hasn't changed since last tick.
    const wsHandle = await connectWs();
    await new Promise((r) => setTimeout(r, 600)); // 6 more ticks at 100ms
    const frames = await collectFrames(wsHandle, 5, 500);
    const rtDedupFrames = frames.filter(
      (f) => f.entity_id === "rt-dedup" && f.event === "agent.status_changed",
    );
    expect(
      rtDedupFrames,
      `dedup violated: expected 0 status_changed frames for rt-dedup, got ${rtDedupFrames.length}`,
    ).toEqual([]);
    wsHandle.ws.close();
  }, 10_000);

  it("(RT3) RELAY_DECAY_TICK_DISABLED=1 disables the broadcaster — NO time-only emits", async () => {
    // Restart the server with the broadcaster opt-out flag set.
    server.close();
    await bootServer({ RELAY_DECAY_TICK_DISABLED: "1" });
    await rpc("register_agent", {
      name: "rt-disabled",
      role: "user",
      capabilities: ["build"],
    });
    const wsHandle = await connectWs();
    await new Promise((r) => setTimeout(r, 1500));
    const frames = await collectFrames(wsHandle, 5, 500);
    const statusChangedForDisabled = frames.filter(
      (f) =>
        f.event === "agent.status_changed" && f.entity_id === "rt-disabled",
    );
    expect(
      statusChangedForDisabled,
      `RELAY_DECAY_TICK_DISABLED=1 must suppress agent.status_changed, got: ${JSON.stringify(statusChangedForDisabled)}`,
    ).toEqual([]);
    wsHandle.ws.close();
    delete process.env.RELAY_DECAY_TICK_DISABLED;
  }, 10_000);
});

// =====================================================================
// PRD — last_dispatched_at producer writes
// =====================================================================
describe("v2.8 R1 — last_dispatched_at producer writes", () => {
  /** Read last_dispatched_at directly from the agents table. */
  function readLastDispatched(name: string): number | null {
    const row = getDb()
      .prepare("SELECT last_dispatched_at FROM agents WHERE name = ?")
      .get(name) as { last_dispatched_at: number | null } | undefined;
    if (!row) throw new Error(`agent "${name}" not found`);
    return row.last_dispatched_at;
  }

  async function registerWithRole(
    name: string,
    role: string,
  ): Promise<string> {
    // post_task requires `tasks` capability (CAP_DENIED otherwise).
    // Include it so the producer tests for postTask + postTaskAuto
    // can route messages.
    const r = await rpc("register_agent", {
      name,
      role,
      capabilities: ["build", "tasks"],
    });
    expect(r.ok, `register ${name} failed: ${JSON.stringify(r.json)}`).toBe(true);
    return r.json!.agent_token as string;
  }

  it("(PRD1) send_message priority='high' stamps recipient last_dispatched_at (any role)", async () => {
    const senderTok = await registerWithRole("prd-sender", "user");
    await registerWithRole("prd-recipient-user", "user");
    expect(readLastDispatched("prd-recipient-user")).toBeNull();
    const beforeMs = Date.now();
    const send = await rpc(
      "send_message",
      {
        from: "prd-sender",
        to: "prd-recipient-user",
        content: "urgent message",
        priority: "high",
      },
      senderTok,
    );
    expect(send.ok, JSON.stringify(send.json)).toBe(true);
    const stamped = readLastDispatched("prd-recipient-user");
    expect(stamped, "high-priority send must stamp last_dispatched_at").not.toBeNull();
    expect(stamped!).toBeGreaterThanOrEqual(beforeMs);
    expect(stamped!).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("(PRD2) send_message priority='normal' to BUILDER role stamps last_dispatched_at", async () => {
    const senderTok = await registerWithRole("prd-sender-2", "user");
    await registerWithRole("prd-recipient-builder", "builder");
    expect(readLastDispatched("prd-recipient-builder")).toBeNull();
    const beforeMs = Date.now();
    const send = await rpc(
      "send_message",
      {
        from: "prd-sender-2",
        to: "prd-recipient-builder",
        content: "normal message",
        priority: "normal",
      },
      senderTok,
    );
    expect(send.ok).toBe(true);
    const stamped = readLastDispatched("prd-recipient-builder");
    expect(stamped, "send to builder role must stamp last_dispatched_at").not.toBeNull();
    expect(stamped!).toBeGreaterThanOrEqual(beforeMs);
  });

  it("(PRD3) send_message priority='normal' to non-dispatch role does NOT stamp", async () => {
    const senderTok = await registerWithRole("prd-sender-3", "user");
    await registerWithRole("prd-recipient-nondispatch", "user");
    const send = await rpc(
      "send_message",
      {
        from: "prd-sender-3",
        to: "prd-recipient-nondispatch",
        content: "casual",
        priority: "normal",
      },
      senderTok,
    );
    expect(send.ok).toBe(true);
    expect(
      readLastDispatched("prd-recipient-nondispatch"),
      "normal-priority send to non-dispatch role must NOT stamp",
    ).toBeNull();
  });

  it("(PRD4) post_task to BUILDER stamps recipient last_dispatched_at", async () => {
    const posterTok = await registerWithRole("prd-poster", "user");
    await registerWithRole("prd-task-builder", "builder");
    const beforeMs = Date.now();
    const r = await rpc(
      "post_task",
      {
        from: "prd-poster",
        to: "prd-task-builder",
        title: "build thing",
        description: "details",
        priority: "normal",
      },
      posterTok,
    );
    expect(r.ok, JSON.stringify(r.json)).toBe(true);
    const stamped = readLastDispatched("prd-task-builder");
    expect(stamped, "post_task to builder must stamp").not.toBeNull();
    expect(stamped!).toBeGreaterThanOrEqual(beforeMs);
  });

  it("(PRD5) post_task priority='high' to non-dispatch role still stamps (priority overrides role allowlist)", async () => {
    const posterTok = await registerWithRole("prd-poster-2", "user");
    await registerWithRole("prd-task-nonbuilder", "user");
    const r = await rpc(
      "post_task",
      {
        from: "prd-poster-2",
        to: "prd-task-nonbuilder",
        title: "urgent",
        description: "details",
        priority: "high",
      },
      posterTok,
    );
    expect(r.ok, JSON.stringify(r.json)).toBe(true);
    const stamped = readLastDispatched("prd-task-nonbuilder");
    expect(stamped, "post_task priority=high to non-dispatch role must still stamp").not.toBeNull();
  });

  it("(PRD6) all five role allowlist entries stamp on normal-priority dispatch (regression for DISPATCH_RELEVANT_ROLES drift)", async () => {
    const senderTok = await registerWithRole("prd-poly-sender", "user");
    const dispatchRoles = ["builder", "auditor", "researcher", "reviewer", "recon"];
    for (let i = 0; i < dispatchRoles.length; i++) {
      const role = dispatchRoles[i]!;
      const name = `prd-poly-${role}`;
      await registerWithRole(name, role);
      const r = await rpc(
        "send_message",
        {
          from: "prd-poly-sender",
          to: name,
          content: "ping",
          priority: "normal",
        },
        senderTok,
      );
      expect(r.ok).toBe(true);
      expect(
        readLastDispatched(name),
        `role "${role}" must be in DISPATCH_RELEVANT_ROLES`,
      ).not.toBeNull();
    }
  });
});
