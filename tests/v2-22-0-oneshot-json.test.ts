// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0005 (v2.22.0) #3 — a non-streaming one-shot POST /mcp returns plain
 * `application/json`, not an `event: message\ndata: {…}` SSE frame, so
 * curl/script callers can JSON.parse the body directly.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import type { Server as HttpServer } from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-2220-oneshot-" + process.pid);
process.env.RELAY_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;

const { startHttpServer } = await import("../src/transport/http.js");
const { closeDb } = await import("../src/db.js");

let server: HttpServer;
let baseUrl: string;

beforeEach(async () => {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  server = startHttpServer(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 80));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterEach(() => {
  try { server?.close(); } catch { /* ignore */ }
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

describe("ADR-0005 #3 — one-shot /mcp returns application/json", () => {
  it("a one-shot tools/call POST responds with application/json, directly JSON.parse-able", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "register_agent", arguments: { name: "oneshot-a", role: "r", capabilities: [] } },
      }),
    });
    // The response Content-Type is plain JSON — NOT text/event-stream.
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    expect(res.headers.get("content-type") ?? "").not.toContain("text/event-stream");
    const text = await res.text();
    // Body is raw JSON — no `event:` / `data:` SSE framing to strip.
    expect(text).not.toMatch(/^event:/m);
    const rpc = JSON.parse(text); // must parse directly (was the #3 papercut)
    const payload = JSON.parse(rpc.result.content[0].text);
    // #2 also verified: agent_token is present + reliably first.
    expect(payload.agent_token).toBeTruthy();
    expect(Object.keys(payload)[0]).toBe("agent_token");
  });
});
