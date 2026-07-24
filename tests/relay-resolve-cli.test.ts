// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * `relay resolve` — the CLI path for MCP-mute sessions to ack their own inbox.
 *
 * Contract (matches `relay send`'s stream discipline):
 *   - STDOUT carries ONLY the resolved message ids (one per line) — a clean,
 *     parseable capture; the ✓ confirmation goes to STDERR.
 *   - A resolve that changed NOTHING (unknown / foreign / already-resolved ids)
 *     exits NON-ZERO with an empty stdout, so `$(relay resolve …)` fails loudly.
 *   - --json emits the full envelope on stdout.
 *
 * The in-process cases mock the daemon fetch (deterministic + assert the request
 * targets resolve_messages). One end-to-end case drives the REAL daemon +
 * resolve_messages so the wiring is observed, not asserted.
 */
import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import type { Server as HttpServer } from "http";

const SHAPE_VALID_TOKEN = "AbCd1234efGH5678ijKL9012mnOP3456"; // matches TOKEN_SHAPE_RE → env path, no DB

/** SSE-wrap a resolve_messages envelope the way the daemon's /mcp does. */
function mcpEnvelope(inner: Record<string, unknown>): Response {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: JSON.stringify(inner) }] },
  });
  return new Response(`event: message\ndata: ${body}\n\n`, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("`relay resolve` — clean ids on stdout, confirmation on stderr", () => {
  async function runResolve(argv: string[], fetchImpl: typeof fetch) {
    const { run } = await import("../src/cli/resolve.js");
    const saved = process.env.RELAY_AGENT_TOKEN;
    process.env.RELAY_AGENT_TOKEN = SHAPE_VALID_TOKEN;
    const out: string[] = [];
    const err: string[] = [];
    const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(((c: unknown) => {
      out.push(String(c));
      return true;
    }) as typeof process.stdout.write);
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(((c: unknown) => {
      err.push(String(c));
      return true;
    }) as typeof process.stderr.write);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(fetchImpl);
    try {
      const code = await run(argv);
      return { code, out: out.join(""), err: err.join(""), fetchSpy };
    } finally {
      fetchSpy.mockRestore();
      outSpy.mockRestore();
      errSpy.mockRestore();
      if (saved === undefined) delete process.env.RELAY_AGENT_TOKEN;
      else process.env.RELAY_AGENT_TOKEN = saved;
    }
  }

  it("(1) success → ONLY the resolved ids on stdout; the ✓ line on stderr; targets resolve_messages", async () => {
    let seenBody = "";
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seenBody = String(init.body);
      return mcpEnvelope({ success: true, agent: "muted", resolved_ids: ["m-1", "m-2"], resolved_count: 2, requested_count: 2 });
    }) as unknown as typeof fetch;
    const r = await runResolve(["m-1", "m-2", "--agent", "muted"], fetchImpl);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("m-1\nm-2");
    expect(r.out).not.toMatch(/resolved|✓/); // stdout is ids only
    expect(r.err).toMatch(/✓ resolved 2 of 2 message\(s\) for "muted"/);
    // The CLI calls the SAME path resolve_messages uses.
    expect(seenBody).toMatch(/"name":"resolve_messages"/);
    expect(seenBody).toMatch(/"agent_name":"muted"/);
    expect(seenBody).toMatch(/"message_ids":\["m-1","m-2"\]/);
  });

  it("(2) NOTHING resolved (unknown/foreign/already-resolved) → EMPTY stdout + NON-ZERO exit", async () => {
    const fetchImpl = (async () =>
      mcpEnvelope({ success: true, agent: "muted", resolved_ids: [], resolved_count: 0, requested_count: 1 })) as unknown as typeof fetch;
    const r = await runResolve(["nonexistent-id", "--agent", "muted"], fetchImpl);
    expect(r.code).not.toBe(0);
    expect(r.out, `stdout leaked ${r.out.length} bytes`).toBe("");
    expect(r.err).toMatch(/no messages resolved/);
  });

  it("(3) --json → the full envelope on stdout", async () => {
    const fetchImpl = (async () =>
      mcpEnvelope({ success: true, agent: "muted", resolved_ids: ["m-1"], resolved_count: 1, requested_count: 1 })) as unknown as typeof fetch;
    const r = await runResolve(["m-1", "--agent", "muted", "--json"], fetchImpl);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).resolved_ids).toEqual(["m-1"]);
  });

  it("(4) daemon error envelope (success:false) → stderr + non-zero, empty stdout", async () => {
    const fetchImpl = (async () =>
      mcpEnvelope({ success: false, error: "AUTH_FAILED" })) as unknown as typeof fetch;
    const r = await runResolve(["m-1", "--agent", "muted"], fetchImpl);
    expect(r.code).not.toBe(0);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/AUTH_FAILED/);
  });

  it("(5) unreachable daemon → stderr + non-zero, empty stdout", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await runResolve(["m-1", "--agent", "muted"], fetchImpl);
    expect(r.code).not.toBe(0);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/could not reach the daemon/);
  });

  it("(6) MALFORMED success envelope (resolved_count=1 but resolved_ids=[]) → non-zero + EMPTY stdout (no silent empty capture)", async () => {
    // codex's #133 P2 repro: trusting resolved_count over resolved_ids would emit
    // a bare "\n" on stdout at exit 0 + claim "✓ resolved 1". The decision must
    // derive SOLELY from resolved_ids.
    const fetchImpl = (async () =>
      mcpEnvelope({ success: true, agent: "muted", resolved_ids: [], resolved_count: 1, requested_count: 1 })) as unknown as typeof fetch;
    const r = await runResolve(["m-1", "--agent", "muted"], fetchImpl);
    expect(r.code).not.toBe(0);
    expect(r.out, `stdout leaked ${JSON.stringify(r.out)}`).toBe("");
    expect(r.err).not.toMatch(/✓/);
  });

  it("(7) INCONSISTENT envelope (resolved_ids has 1 but resolved_count=2) → non-zero + empty stdout", async () => {
    const fetchImpl = (async () =>
      mcpEnvelope({ success: true, agent: "muted", resolved_ids: ["m-1"], resolved_count: 2, requested_count: 2 })) as unknown as typeof fetch;
    const r = await runResolve(["m-1", "m-2", "--agent", "muted"], fetchImpl);
    expect(r.code).not.toBe(0);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/inconsistent/);
  });

  it("(8) MIXED-type resolved_ids [123, \"m-1\"] → ENFORCED (not filtered): non-zero + empty stdout + NO ✓", async () => {
    // codex #133 GAP 2: filtering non-strings would silently accept a PARTIAL list
    // (filtered=["m-1"], count=1 matches) and exit 0. The locked contract is
    // non-empty ALL-STRING — a mixed array is malformed and must fail closed.
    const fetchImpl = (async () =>
      mcpEnvelope({ success: true, agent: "muted", resolved_ids: [123, "m-1"], resolved_count: 1, requested_count: 2 })) as unknown as typeof fetch;
    const r = await runResolve(["m-1", "m-2", "--agent", "muted"], fetchImpl);
    expect(r.code).not.toBe(0);
    expect(r.out, `stdout leaked ${JSON.stringify(r.out)}`).toBe("");
    expect(r.err).not.toMatch(/✓/);
  });
});

interface DaemonCtx {
  rpc: (tool: string, args: Record<string, unknown>, token?: string) => Promise<any>;
  // Drive resolve.run() IN-PROCESS with the REAL daemon fetch (spawnSync would
  // block this event loop and deadlock the in-process HTTP server). An env token
  // keeps run() off the DB, so the only side effect is the real resolve_messages.
  resolveInProcess: (argv: string[], agentName: string, token: string) => Promise<{ code: number; out: string; err: string }>;
}

async function withRealDaemon(label: string, fn: (ctx: DaemonCtx) => Promise<void>): Promise<void> {
  const dbDir = path.join(os.tmpdir(), `relay-resolve-e2e-${label}-${process.pid}-${Date.now()}`);
  const dbPath = path.join(dbDir, "relay.db");
  const cfgPath = path.join(dbDir, "config.json");
  fs.mkdirSync(dbDir, { recursive: true });
  const savedDb = process.env.RELAY_DB_PATH;
  process.env.RELAY_DB_PATH = dbPath;
  delete process.env.RELAY_AGENT_TOKEN;
  delete process.env.RELAY_HTTP_SECRET;
  const { startHttpServer } = await import("../src/transport/http.js");
  const { closeDb } = await import("../src/db.js");
  let server: HttpServer | undefined;
  try {
    server = startHttpServer(0, "127.0.0.1");
    await new Promise((r) => setTimeout(r, 80));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;
    fs.writeFileSync(cfgPath, JSON.stringify({ http_host: "127.0.0.1", http_port: port })); // resolve.ts loads config for host/port

    const rpc = async (tool: string, args: Record<string, unknown>, token?: string) => {
      const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
      if (token) headers["X-Agent-Token"] = token;
      const res = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
      });
      const text = await res.text();
      const dataLine = text.split("\n").map((l) => l.trim()).find((l) => l.startsWith("data:"));
      return JSON.parse(JSON.parse(dataLine ? dataLine.slice(5).trim() : text).result.content[0].text);
    };

    const resolveInProcess = async (argv: string[], agentName: string, token: string) => {
      const { run } = await import("../src/cli/resolve.js");
      const out: string[] = [];
      const err: string[] = [];
      const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(((c: unknown) => { out.push(String(c)); return true; }) as typeof process.stdout.write);
      const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(((c: unknown) => { err.push(String(c)); return true; }) as typeof process.stderr.write);
      const s = { name: process.env.RELAY_AGENT_NAME, tok: process.env.RELAY_AGENT_TOKEN, cfg: process.env.RELAY_CONFIG_PATH };
      process.env.RELAY_AGENT_NAME = agentName;
      process.env.RELAY_AGENT_TOKEN = token;
      process.env.RELAY_CONFIG_PATH = cfgPath;
      try {
        const code = await run(argv);
        return { code, out: out.join(""), err: err.join("") };
      } finally {
        outSpy.mockRestore();
        errSpy.mockRestore();
        if (s.name === undefined) delete process.env.RELAY_AGENT_NAME; else process.env.RELAY_AGENT_NAME = s.name;
        if (s.tok === undefined) delete process.env.RELAY_AGENT_TOKEN; else process.env.RELAY_AGENT_TOKEN = s.tok;
        if (s.cfg === undefined) delete process.env.RELAY_CONFIG_PATH; else process.env.RELAY_CONFIG_PATH = s.cfg;
      }
    };

    await fn({ rpc, resolveInProcess });
  } finally {
    try { server?.close(); } catch { /* */ }
    try { closeDb(); } catch { /* */ }
    if (savedDb === undefined) delete process.env.RELAY_DB_PATH; else process.env.RELAY_DB_PATH = savedDb;
    try { fs.rmSync(dbDir, { recursive: true, force: true }); } catch { /* */ }
  }
}

describe("`relay resolve` — end-to-end against a real daemon + resolve_messages", () => {
  it("(E1) resolves a real message so it stops re-surfacing as pending; stdout = the id", async () => {
    await withRealDaemon("e1", async ({ rpc, resolveInProcess }) => {
      const recip = await rpc("register_agent", { name: "muted-agent", role: "r", capabilities: [] });
      const token = recip.agent_token as string;
      const sender = await rpc("register_agent", { name: "sender", role: "r", capabilities: [] });
      const sent = await rpc("send_message", { from: "sender", to: "muted-agent", content: "handle me" }, sender.agent_token);
      const msgId = sent.message_id as string;
      expect(msgId).toBeTruthy();

      const r = await resolveInProcess([msgId], "muted-agent", token);
      expect(r.code, `stderr: ${r.err}`).toBe(0);
      expect(r.out.trim()).toBe(msgId); // clean id on stdout
      expect(r.err).toMatch(/✓ resolved 1 of 1/);

      const after = await rpc("get_messages", { agent_name: "muted-agent", status: "pending", since: "all", peek: true }, token);
      expect((after.messages || []).some((m: { id: string }) => m.id === msgId), "resolved message must not re-surface").toBe(false);
    });
  }, 25_000);

  it("(E2) a SPOOFED recipient is rejected: B's token while the CLI CLAIMS agent-a → auth error, empty stdout, A's mail survives", async () => {
    await withRealDaemon("e2", async ({ rpc, resolveInProcess }) => {
      const a = await rpc("register_agent", { name: "agent-a", role: "r", capabilities: [] });
      const b = await rpc("register_agent", { name: "agent-b", role: "r", capabilities: [] });
      const snd = await rpc("register_agent", { name: "snd", role: "r", capabilities: [] });
      const sent = await rpc("send_message", { from: "snd", to: "agent-a", content: "for A only" }, snd.agent_token);
      const msgIdForA = sent.message_id as string;
      expect(msgIdForA).toBeTruthy();

      // THE IMPERSONATION CASE (codex #133 GAP 1): the CLI CLAIMS agent_name=agent-a
      // but presents B's token. The daemon binds the token to the CLAIMED row
      // (enforceAuth / agentFromArgs exact-row) → B's token does NOT authenticate
      // agent-a → AUTH_FAILED. The resolve is REJECTED outright — not merely
      // recipient-skipped. (Weaker recipient-scoping is already proven by v2-12-0.)
      const r = await resolveInProcess([msgIdForA], "agent-a", b.agent_token as string);
      expect(r.code).not.toBe(0);
      expect(r.out, `stdout leaked ${JSON.stringify(r.out)}`).toBe("");
      expect(r.err).toMatch(/auth|token|AUTH_FAILED|does not authenticate|rejected/i);

      // A's message is STILL pending — the spoof changed nothing.
      const aPending = await rpc("get_messages", { agent_name: "agent-a", status: "pending", since: "all", peek: true }, a.agent_token);
      expect((aPending.messages || []).some((m: { id: string }) => m.id === msgIdForA), "A's message must survive the spoofed resolve").toBe(true);
    });
  }, 25_000);
});
