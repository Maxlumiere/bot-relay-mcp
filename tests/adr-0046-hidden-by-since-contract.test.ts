// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0046 rule 1 — R5 (ADR-0045) as a CONTRACT test on the ACTUAL tool response,
 * through the real MCP transport (HTTP /mcp → dispatcher → handler), not a handler
 * call and not a scan of the source.
 *
 * The syntactic guard proved the point: a mutation that REMOVED the response
 * fields produced zero violations, because it checked something beside the
 * contract. This test checks the contract itself: with pending mail outside the
 * caller's window, the response carries hidden_by_since == N and total_pending ==
 * the canonical count (computed here, independently, from the #53 predicate).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import type { Server as HttpServer } from "http";

const DIR = path.join(os.tmpdir(), "bot-relay-adr0046-contract-" + process.pid);
process.env.RELAY_DB_PATH = path.join(DIR, "relay.db");
for (const k of ["RELAY_AGENT_TOKEN", "RELAY_AGENT_NAME", "RELAY_ALLOW_LEGACY", "RELAY_HTTP_SECRET"]) delete process.env[k];

const { startHttpServer } = await import("../src/transport/http.js");
const db = await import("../src/db.js");

let server: HttpServer;
let base = "";

async function tool(name: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  const rpc = JSON.parse(line ? line.slice(5).trim() : text);
  return JSON.parse(rpc.result.content[0].text);
}

let token = "";
const R = "a46-contract";

/** The canonical pending count, computed independently of the tool: the #53 predicate, NO window. */
function canonicalPending(): number {
  const d = db.getDb();
  const s = (d.prepare("SELECT session_id FROM agents WHERE name = ?").get(R) as { session_id: string | null }).session_id;
  const pc = db.pendingForSessionClause(s ?? "");
  return (d.prepare(`SELECT COUNT(*) AS c FROM messages WHERE to_agent = ? AND ${pc.sql}`).get(R, ...pc.params) as { c: number }).c;
}

beforeAll(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  server = startHttpServer(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 100));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const sender = (await tool("register_agent", { name: "a46-c-sender", role: "r", capabilities: [] })).agent_token;
  token = (await tool("register_agent", { name: R, role: "r", capabilities: [] })).agent_token;
  for (const content of ["aged, read by a prior session", "another aged one", "fresh"]) {
    await tool("send_message", { from: "a46-c-sender", to: R, content, agent_token: sender });
  }
  // Two messages a PRIOR session read 3 days ago: pending (unfinished work), outside a 1h window.
  db.getDb()
    .prepare("UPDATE messages SET created_at = ?, read_by_session = 'prior', status = 'read' WHERE to_agent = ? AND content != 'fresh'")
    .run(new Date(Date.now() - 3 * 86_400_000).toISOString(), R);
});
afterAll(() => {
  server.close();
  db.closeDb();
  fs.rmSync(DIR, { recursive: true, force: true });
});

describe("ADR-0046 — the R5 contract, on the actual tool response", () => {
  it("PRECONDITION: 3 canonical pending, 2 of them outside a 1h window", () => {
    expect(canonicalPending()).toBe(3);
  });

  it("get_messages(pending, since='1h'): hidden_by_since == 2, total_pending == canonical, count == 1", async () => {
    const r = await tool("get_messages", { agent_name: R, status: "pending", since: "1h", peek: true, agent_token: token });
    expect(r.count).toBe(1);
    expect(r.hidden_by_since).toBe(2);
    expect(r.total_pending).toBe(canonicalPending());
  });

  it("get_messages_summary(pending, since='1h'): hidden_by_since == 2, total_pending == canonical (beside the windowed total)", async () => {
    const r = await tool("get_messages_summary", { agent_name: R, status: "pending", since: "1h", agent_token: token });
    expect(r.count).toBe(1);
    expect(r.hidden_by_since).toBe(2);
    expect(r.total, "total stays the WINDOWED match count (the has_more signal)").toBe(1);
    expect(r.total_pending, "the canonical, unwindowed count").toBe(canonicalPending());
  });

  it("no window given (pending defaults to 'all'): nothing hidden, so no hidden_by_since; total_pending == canonical", async () => {
    const r = await tool("get_messages", { agent_name: R, status: "pending", peek: true, agent_token: token });
    expect(r.count).toBe(3);
    expect(r).not.toHaveProperty("hidden_by_since");
    expect(r.total_pending).toBe(canonicalPending());
  });
});
