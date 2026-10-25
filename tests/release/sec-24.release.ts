// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * SEC-24 (security/invariants.json): no HTTP request body reaches any schema validator (the relay's or the MCP SDK's)
 * with an array over 1000 elements or nesting over 64 levels; it is refused with HTTP 400, error_code
 * BODY_STRUCTURE_LIMIT, before authentication.
 * SEC-24.T1, on the INSTALLED package: one 1 MB body holding a 500,000-element array is refused with the named 400 on
 * POST /mcp (unauthenticated, and authenticated through a tool whose schema would otherwise validate the array
 * element by element) and on a REST route. The twin: a legitimate resolve_messages of 100 real messages succeeds
 * (the bound refuses structure, never ordinary use). (A guard that refuses everything also passes the harm half.)
 */
import { describe, it, expect, afterEach } from "vitest";
import { sandbox, startHttpDaemon, type HttpDaemon } from "./_installed.js";

const daemons: HttpDaemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop();
});

const MCP = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const HUGE = "[" + Array(500_000).fill("1").join(",") + "]";
const post = async (d: HttpDaemon, route: string, headers: Record<string, string>, body: string) => {
  const r = await fetch(`${d.baseUrl}${route}`, { method: "POST", headers, body });
  const text = await r.text();
  let code: unknown;
  try {
    code = (JSON.parse(text) as { error_code?: unknown }).error_code;
  } catch {
    code = undefined;
  }
  return { status: r.status, code, text: text.slice(0, 300) };
};

describe("SEC-24.T1: no oversized request structure reaches a validator (the installed package)", () => {
  it("SEC-24.T1 HARM a 1 MB body with a 500,000-element array is refused with HTTP 400 BODY_STRUCTURE_LIMIT on /mcp (unauthenticated and authenticated) and on a REST route", async (ctx) => {
    const sb = sandbox("s24-harm");
    const d = await startHttpDaemon(sb);
    daemons.push(d);
    const reg = await d.rpc("register_agent", { name: "sec24-agent", role: "worker", capabilities: [] }, d.mintHeaders());
    const token = reg.agent_token;
    expect(typeof token, `the fixture agent registered: ${JSON.stringify(reg)}`).toBe("string");
    const unauth = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"register_agent","arguments":{"name":"sec24-x","role":"r","capabilities":' + HUGE + "}}}";
    const auth = '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"resolve_messages","arguments":{"agent_name":"sec24-agent","agent_token":' + JSON.stringify(token) + ',"message_ids":' + HUGE + "}}}";
    expect(Math.max(unauth.length, auth.length), "under the 1 MB HTTP limit, so SEC-24 (not the body parser) is what answers").toBeLessThan(1024 * 1024);
    const results = {
      mcpUnauth: await post(d, "/mcp", MCP, unauth),
      mcpAuth: await post(d, "/mcp", { ...MCP, "X-Agent-Token": String(token) }, auth),
      rest: await post(d, "/api/send-message", { "Content-Type": "application/json" }, '{"to":"sec24-agent","content":"x","ids":' + HUGE + "}"),
    };
    // The observation mark (sec-20.release.ts): only now, after every stimulus returned, before the harm assertions.
    ctx.task.meta.stimulus_returned = true;
    for (const [k, r] of Object.entries(results)) {
      expect(r.status, `${k}: ${r.text}`).toBe(400);
      expect(r.code, `${k}: ${r.text}`).toBe("BODY_STRUCTURE_LIMIT");
    }
  });

  it("SEC-24.T1 TWIN a legitimate resolve_messages of 100 real messages succeeds and resolves all 100", async () => {
    const sb = sandbox("s24-twin");
    const d = await startHttpDaemon(sb);
    daemons.push(d);
    const me = await d.rpc("register_agent", { name: "sec24-me", role: "worker", capabilities: [] }, d.mintHeaders());
    const peer = await d.rpc("register_agent", { name: "sec24-peer", role: "worker", capabilities: [] }, d.mintHeaders());
    expect(typeof me.agent_token, JSON.stringify(me)).toBe("string");
    expect(typeof peer.agent_token, JSON.stringify(peer)).toBe("string");
    for (let i = 0; i < 100; i++) {
      const s = await d.rpc("send_message", { from: "sec24-peer", to: "sec24-me", content: `m${i}` }, { "X-Agent-Token": String(peer.agent_token) });
      expect(s.success, JSON.stringify(s)).toBe(true);
    }
    const inbox = await d.rpc("get_messages", { agent_name: "sec24-me", limit: 100, peek: true }, { "X-Agent-Token": String(me.agent_token) });
    const ids = ((inbox.messages ?? []) as Array<{ id: string }>).map((m) => m.id);
    expect(ids.length, JSON.stringify(inbox).slice(0, 300)).toBe(100);
    const r = await d.rpc("resolve_messages", { agent_name: "sec24-me", message_ids: ids }, { "X-Agent-Token": String(me.agent_token) });
    expect(r.success, JSON.stringify(r)).toBe(true);
    expect(r.resolved_count, JSON.stringify(r)).toBe(100);
  });
});
