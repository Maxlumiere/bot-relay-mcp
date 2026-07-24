// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0012 — FORCE = CAS TAKEOVER, NOT BYPASS.
 *
 * codex-5-5's #131 P1b: the old `force` was an unconditional bypass — a
 * lost-update primitive. Two simultaneous relaunches both read the same stale
 * session, both forced, and the db CAS guarded auth/token but NOT session_id, so
 * the last writer clobbered the first. force is REDEFINED as a conditional CAS:
 * it carries expected_session_id (the session_id the caller READ), and the
 * server re-register lands ONLY if the row's session_id still equals it. Exactly
 * ONE of two racers wins; the loser gets FORCE_PRECONDITION_FAILED, MUST re-read
 * (never retry-force), and surfaces loudly (never mute). There is NO
 * unconditional-force bypass left: force without expected_session_id is rejected
 * as malformed.
 *
 * These tests exercise the real MCP surface (register_agent over HTTP → the
 * handler → the db CAS). The "concurrent" double-force is modelled as two
 * takeovers anchored on the SAME session_id applied through SQLite's serialized
 * writer: the first flips the session, so the second — still anchored on the now
 * stale value — matches zero rows and loses. That is the exact race semantics.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import type { Server as HttpServer } from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-adr0012-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;

const { startHttpServer } = await import("../src/transport/http.js");
const { closeDb, markAgentOffline, getAgentAuthData } = await import("../src/db.js");
const { ERROR_CODES } = await import("../src/error-codes.js");

let server: HttpServer;
let baseUrl: string;

beforeAll(async () => {
  server = startHttpServer(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 100));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

async function mcpCall(params: any, id = 1): Promise<any> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params }),
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse(dataLine ? dataLine.slice(5).trim() : text);
}
const env = (r: any) => JSON.parse(r.result.content[0].text);

/** Register a fresh agent and return { token, sid }. */
async function bootstrap(name: string): Promise<{ token: string; sid: string }> {
  const b = env(await mcpCall({ name: "register_agent", arguments: { name, role: "r", capabilities: [] } }));
  expect(b.success).toBe(true);
  return { token: b.agent_token as string, sid: b.agent.session_id as string };
}

function forceTakeover(name: string, token: string, expected: string | null) {
  return mcpCall({
    name: "register_agent",
    arguments: { name, role: "r", capabilities: [], agent_token: token, force: true, expected_session_id: expected },
  });
}

describe("ADR-0012 — force CAS takeover", () => {
  it("(1) force with the CORRECT expected_session_id → wins, session rotates", async () => {
    const { token, sid } = await bootstrap("cas-win");
    const b = env(await forceTakeover("cas-win", token, sid));
    expect(b.success).toBe(true);
    expect(b.agent.session_id).not.toBe(sid);
  });

  it("(2) concurrent double-force → EXACTLY ONE winner; the loser gets FORCE_PRECONDITION_FAILED (loud, never mute)", async () => {
    const { token, sid } = await bootstrap("cas-race");
    // Both racers READ the same session_id (sid) and both force with it.
    const a = env(await forceTakeover("cas-race", token, sid)); // A flips sid → sid_A
    const b = env(await forceTakeover("cas-race", token, sid)); // B still anchored on sid → loses

    const winners = [a, b].filter((x) => x.success === true);
    const losers = [a, b].filter((x) => x.success === false);
    expect(winners.length, "exactly one winner").toBe(1);
    expect(losers.length, "exactly one loser").toBe(1);

    const loser = losers[0];
    // LOUD, not mute: distinct code + an actionable message.
    expect(loser.error_code).toBe(ERROR_CODES.FORCE_PRECONDITION_FAILED);
    expect(typeof loser.error).toBe("string");
    expect(loser.error.length).toBeGreaterThan(0);
    expect(loser.error).toMatch(/compare-and-swap|another live session|do NOT retry/i);
    // The row is held by the winner's fresh session — not the loser's read.
    expect(getAgentAuthData("cas-race")?.session_id).toBe(winners[0].agent.session_id);
  });

  it("(3) offline takeover: expected_session_id=null against a session_id-NULL row → wins (CAS on IS NULL)", async () => {
    const { token, sid } = await bootstrap("cas-offline");
    markAgentOffline("cas-offline", sid); // session_id → NULL
    expect(getAgentAuthData("cas-offline")?.session_id).toBeNull();

    const b = env(await forceTakeover("cas-offline", token, null));
    expect(b.success).toBe(true);
    expect(b.agent.session_id).not.toBeNull();
  });

  it("(4) force=true WITHOUT expected_session_id → malformed reject (VALIDATION), NOT a bypass", async () => {
    const { token } = await bootstrap("cas-malformed");
    const b = env(
      await mcpCall({
        name: "register_agent",
        arguments: { name: "cas-malformed", role: "r", capabilities: [], agent_token: token, force: true },
      }),
    );
    expect(b.success).toBe(false);
    expect(b.error_code).toBe(ERROR_CODES.VALIDATION);
    expect(b.error).toMatch(/expected_session_id/i);
    expect(b.error).toMatch(/no unconditional-force bypass|read the current session_id/i);
  });

  it("(5) force with a STALE/wrong expected_session_id on a live row → FORCE_PRECONDITION_FAILED", async () => {
    const { token } = await bootstrap("cas-stale");
    const b = env(await forceTakeover("cas-stale", token, "some-other-session-that-was-never-real"));
    expect(b.success).toBe(false);
    expect(b.error_code).toBe(ERROR_CODES.FORCE_PRECONDITION_FAILED);
  });
});
