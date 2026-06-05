// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.8 — wire-emit-sites audit tests.
 *
 * The decay broadcaster (src/dashboard-state-broadcaster.ts) covers the
 * passage-of-time side: state transitions surface on a 30s tick even
 * when nothing mutates. This file covers the MUTATION side: every
 * dashboard-meaningful tool call (register_agent, send_message,
 * post_task, set_status, unregister_agent) MUST emit a broadcast
 * within its handler so the dashboard doesn't wait up to a tick for
 * activity events.
 *
 * Per `feedback_test_path_must_match_shipped_path.md`: tests boot the
 * REAL HTTP transport + WebSocket layer + DB. No mocks on the
 * broadcast path — the assertion observes the actual JSON the
 * dashboard would see.
 *
 * Per `feedback_test_asserts_contract_not_proxy.md`: assertions pin
 * exact event names, exact entity_id values, exact kind tags.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server as HttpServer } from "node:http";
import type { WebSocket } from "ws";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v2-8-wire-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_HTTP_SECRET;
delete process.env.RELAY_DASHBOARD_SECRET;
// Disable the decay broadcaster so the only broadcasts in this test
// suite come from wire-emit mutation sites — keeps the assertions
// deterministic.
process.env.RELAY_DECAY_TICK_DISABLED = "1";

const { startHttpServer } = await import("../src/transport/http.js");
const { _resetDashboardWsForTests } = await import("../src/transport/websocket.js");
const { closeDb } = await import("../src/db.js");

import { connectWs as baseConnectWs } from "./_helpers/ws.js";

let server: HttpServer;
let port: number;

async function bootServer(): Promise<void> {
  _resetDashboardWsForTests();
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
  raw: string;
  status: number;
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
  // SSE-wrapped JSON: locate the `data:` line and parse the inner shape.
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  let json: Record<string, unknown> | null = null;
  if (dataLine) {
    const inner = JSON.parse(dataLine.slice(5).trim()) as {
      result?: { content?: Array<{ text?: string }> };
    };
    const innerText = inner.result?.content?.[0]?.text;
    if (innerText) {
      json = JSON.parse(innerText);
    }
  }
  return { ok: res.ok, json, raw: text, status: res.status };
}

beforeEach(async () => {
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

/** Pump WS messages into a queue; the test asserts the queue contents. */
async function collectBroadcasts(
  ws: { ws: WebSocket; nextMessage: (timeoutMs?: number) => Promise<string> },
  /** Drain hello, then how many further frames to wait for. */
  expected: number,
  timeoutPerFrameMs = 1200,
): Promise<BroadcastFrame[]> {
  // drop the hello
  await ws.nextMessage();
  const frames: BroadcastFrame[] = [];
  for (let i = 0; i < expected; i++) {
    try {
      const raw = await ws.nextMessage(timeoutPerFrameMs);
      frames.push(JSON.parse(raw) as BroadcastFrame);
    } catch {
      break;
    }
  }
  return frames;
}

describe("v2.8 — wire-emit-sites — register_agent", () => {
  it("(WE1) register_agent first-time fires agent.state_changed with kind='registered'", async () => {
    const wsHandle = await connectWs();
    const reg = await rpc("register_agent", {
      name: "wire-1",
      role: "builder",
      capabilities: ["build"],
    });
    expect(reg.ok).toBe(true);
    const frames = await collectBroadcasts(wsHandle, 1);
    const evt = frames.find(
      (f) => f.event === "agent.state_changed" && f.entity_id === "wire-1",
    );
    expect(evt, "no agent.state_changed broadcast for register").toBeDefined();
    expect(evt!.kind).toBe("registered");
    wsHandle.ws.close();
  });

  it("(WE2) register_agent re-register fires agent.state_changed with kind='reregistered'", async () => {
    // First registration (capture token).
    const first = await rpc("register_agent", {
      name: "wire-2",
      role: "builder",
      capabilities: ["build"],
    });
    expect(first.ok).toBe(true);
    const token = first.json?.agent_token as string;
    expect(typeof token).toBe("string");
    // Wait > 500ms so the broadcast rate-limit cache for the first-register
    // event (keyed on `agent.state_changed:wire-2`) expires before the
    // re-register's broadcast lands. broadcastDashboardEvent at
    // src/transport/websocket.ts:296 enforces a 500ms-per-key throttle.
    await new Promise((r) => setTimeout(r, 600));
    // Now connect WS and trigger re-register.
    // v2.2.1 B2 hard-rejects re-registration against an actively-held
    // name with NAME_COLLISION_ACTIVE — the pre-existing row's
    // session_id + age < 120s + active status blocks the second call
    // (identity.ts:71-103). Pass `force: true` to take the documented
    // escape-hatch path so this test can exercise the re-register
    // emit without sleeping out the 120s window.
    const wsHandle = await connectWs();
    const reReg = await rpc(
      "register_agent",
      {
        name: "wire-2",
        role: "builder",
        capabilities: ["build"],
        force: true,
      },
      token,
    );
    expect(reReg.ok, JSON.stringify(reReg.json)).toBe(true);
    const frames = await collectBroadcasts(wsHandle, 1);
    const evt = frames.find((f) => f.entity_id === "wire-2");
    expect(evt).toBeDefined();
    expect(evt!.event).toBe("agent.state_changed");
    // Re-register with the same token preserves the hash; plaintext_token
    // is null in the response. My emit logic at identity.ts:194 maps
    // that to kind='reregistered'.
    expect(evt!.kind).toBe("reregistered");
    wsHandle.ws.close();
  });
});

describe("v2.8 — wire-emit-sites — send_message + set_status + unregister", () => {
  // Cross-cutting helper: register sender and recipient, capture tokens,
  // then wait > 500ms for the broadcast rate-limit window on the
  // register-side broadcasts (keyed `agent.state_changed:<name>`) to
  // clear. Without this sleep, downstream set_status/unregister tests
  // that ALSO fire `agent.state_changed:<name>` get rate-limited away.
  async function prepareAgents(): Promise<{
    senderToken: string;
    recipientToken: string;
  }> {
    const a = await rpc("register_agent", {
      name: "wire-sender",
      role: "builder",
      capabilities: ["build"],
    });
    const b = await rpc("register_agent", {
      name: "wire-recipient",
      role: "builder",
      capabilities: ["build"],
    });
    await new Promise((r) => setTimeout(r, 600));
    return {
      senderToken: a.json!.agent_token as string,
      recipientToken: b.json!.agent_token as string,
    };
  }

  it("(WE3) send_message fires message.sent broadcast", async () => {
    const { senderToken } = await prepareAgents();
    const wsHandle = await connectWs();
    const sent = await rpc(
      "send_message",
      {
        from: "wire-sender",
        to: "wire-recipient",
        content: "hello",
        priority: "normal",
      },
      senderToken,
    );
    expect(sent.ok).toBe(true);
    const frames = await collectBroadcasts(wsHandle, 1);
    const msgEvt = frames.find((f) => f.event === "message.sent");
    expect(msgEvt, "send_message must fire message.sent").toBeDefined();
    wsHandle.ws.close();
  });

  it("(WE4) set_status fires agent.state_changed with kind='set_status'", async () => {
    const { senderToken } = await prepareAgents();
    const wsHandle = await connectWs();
    const r = await rpc(
      "set_status",
      { agent_name: "wire-sender", status: "working" },
      senderToken,
    );
    expect(r.ok).toBe(true);
    const frames = await collectBroadcasts(wsHandle, 1);
    const evt = frames.find(
      (f) => f.event === "agent.state_changed" && f.entity_id === "wire-sender",
    );
    expect(evt).toBeDefined();
    expect(evt!.kind).toBe("set_status");
    wsHandle.ws.close();
  });

  it("(WE5) unregister_agent fires agent.state_changed (via webhook → dashboard bridge)", async () => {
    const { senderToken } = await prepareAgents();
    const wsHandle = await connectWs();
    const r = await rpc(
      "unregister_agent",
      { name: "wire-sender" },
      senderToken,
    );
    expect(r.ok).toBe(true);
    // Collect a few frames — unregister can fire the bridge event AND
    // the webhook-side emit. We're looking for at least one
    // agent.state_changed entity_id=wire-sender.
    const frames = await collectBroadcasts(wsHandle, 2);
    const evt = frames.find(
      (f) => f.event === "agent.state_changed" && f.entity_id === "wire-sender",
    );
    expect(evt, "unregister must fire agent.state_changed broadcast").toBeDefined();
    wsHandle.ws.close();
  });
});

describe("v2.8 — wire-emit-sites — post_task", () => {
  it("(WE6) post_task fires task.transitioned broadcast", async () => {
    // The dispatcher requires the caller to hold the `tasks` capability
    // to invoke post_task (CAP_DENIED otherwise — caps are locked at
    // first register per `feedback_relay_caps_immutable.md`). Both
    // poster and taskee must include `tasks` in their initial caps.
    const reg = await rpc("register_agent", {
      name: "wire-poster",
      role: "builder",
      capabilities: ["build", "tasks"],
    });
    const token = reg.json!.agent_token as string;
    await rpc("register_agent", {
      name: "wire-taskee",
      role: "builder",
      capabilities: ["build", "tasks"],
    });
    // PostTaskSchema (src/types.ts:220) requires `description` — without it
    // the dispatcher returns a validation error and no webhook fires.
    const wsHandle = await connectWs();
    const r = await rpc(
      "post_task",
      {
        from: "wire-poster",
        to: "wire-taskee",
        title: "do thing",
        description: "detailed description of the task work",
        priority: "normal",
      },
      token,
    );
    expect(r.ok, JSON.stringify(r.json)).toBe(true);
    const frames = await collectBroadcasts(wsHandle, 3);
    const taskEvt = frames.find((f) => f.event === "task.transitioned");
    expect(
      taskEvt,
      `post_task must fire task.transitioned. Saw frames: ${JSON.stringify(frames)}. RPC response: ${JSON.stringify(r.json)}`,
    ).toBeDefined();
    wsHandle.ws.close();
  });
});
