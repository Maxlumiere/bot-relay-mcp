// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import type { Server as HttpServer } from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v213-collision-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
// v2.1.3 I8 scrub.
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;

const { startHttpServer } = await import("../src/transport/http.js");
const { closeDb, registerAgent, markAgentOffline, teardownAgent, getAgentAuthData } = await import("../src/db.js");
const { ERROR_CODES } = await import("../src/error-codes.js");
const { performAutoUnregister } = await import("../src/transport/stdio.js");

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
  if (fs.existsSync(TEST_DB_DIR)) {
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  }
});

afterEach(() => {
  // Clean up any rows between tests (keep the HTTP server + DB init).
  // Teardown individually — can't truncate via external query.
});

async function mcpCall(method: string, params: any, id = 1): Promise<any> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  if (!dataLine) {
    try { return JSON.parse(text); } catch { throw new Error(`Unexpected: ${text}`); }
  }
  return JSON.parse(dataLine.slice(5).trim());
}

function parseEnvelope(result: any): any {
  return JSON.parse(result.result.content[0].text);
}

// ============================================================================
// v2.1.3 I5 — register_agent rejects a different-token caller when the
// target row has auth_state='active' AND a live session_id.
//
// Pre-v2.1.3: register_agent upserts. A second terminal with a different
// token could (because of the legacy migration window + the Phase 2b
// null-hash bypass) end up registered under the same name and silently
// compete for the shared inbox.
//
// v2.1.3: distinct error code NAME_COLLISION_ACTIVE with an actionable
// remediation message. Token-match callers still succeed (legitimate
// re-register from the same owner). Offline rows (session_id=NULL) fall
// back to the standard AUTH_FAILED — token still required for identity
// takeover, but the live-vs-offline distinction shapes the error UX.
// ============================================================================

describe("v2.1.3 I5 — NAME_COLLISION_ACTIVE on live session + wrong token", () => {
  it("(a) second terminal with no token on live-session row → NAME_COLLISION_ACTIVE", async () => {
    // First terminal registers and holds session_id.
    const first = await mcpCall("tools/call", {
      name: "register_agent",
      arguments: { name: "collider-1", role: "r", capabilities: [] },
    });
    const body1 = parseEnvelope(first);
    expect(body1.success).toBe(true);
    expect(getAgentAuthData("collider-1")?.session_id).toBeTruthy();

    // Second terminal tries to claim the same name with NO token.
    const second = await mcpCall("tools/call", {
      name: "register_agent",
      arguments: { name: "collider-1", role: "r", capabilities: [] },
    });
    const body2 = parseEnvelope(second);
    expect(body2.success).toBe(false);
    expect(body2.error_code).toBe(ERROR_CODES.NAME_COLLISION_ACTIVE);
    expect(body2.error).toMatch(/live session/i);
    expect(body2.error).toMatch(/relay recover/i);
  });

  it("(b) token-match re-register on live-session row WITHOUT force → NAME_COLLISION_ACTIVE (v2.2.1 B2)", async () => {
    const first = await mcpCall("tools/call", {
      name: "register_agent",
      arguments: { name: "collider-2", role: "r", capabilities: [] },
    });
    const body1 = parseEnvelope(first);
    const token = body1.agent_token;
    expect(token).toBeTruthy();

    // v2.2.1 B2 change: re-registering an actively-held name WITHOUT
    // force:true now returns NAME_COLLISION_ACTIVE regardless of whether
    // the caller presents a valid token. Rationale: two terminals with
    // the same token+name silently race on get_messages and drop mail.
    // Operators must scope names distinctly OR pass force:true to take
    // over explicitly.
    const reRegister = await mcpCall("tools/call", {
      name: "register_agent",
      arguments: { name: "collider-2", role: "r", capabilities: [], agent_token: token },
    });
    const body2 = parseEnvelope(reRegister);
    expect(body2.success).toBe(false);
    expect(body2.error_code).toBe(ERROR_CODES.NAME_COLLISION_ACTIVE);
    expect(body2.existing_session_id).toBe(body1.agent.session_id);
  });

  it("(b2) same-owner re-register WITH force=true → succeeds + rotates session_id (v2.2.1 B2 escape hatch)", async () => {
    const first = await mcpCall("tools/call", {
      name: "register_agent",
      arguments: { name: "collider-2b", role: "r", capabilities: [] },
    });
    const body1 = parseEnvelope(first);
    const token = body1.agent_token;

    const reRegister = await mcpCall("tools/call", {
      name: "register_agent",
      arguments: { name: "collider-2b", role: "r", capabilities: [], agent_token: token, force: true },
    });
    const body2 = parseEnvelope(reRegister);
    expect(body2.success).toBe(true);
    expect(body2.agent.name).toBe("collider-2b");
    expect(body2.agent.session_id).not.toBe(body1.agent.session_id);
  });

  it("(c) after relay recover, fresh register on the freed name → succeeds", async () => {
    // Seed with a row so recover has something to clear.
    registerAgent("collider-3", "r", []);
    teardownAgent("collider-3", "recover");
    expect(getAgentAuthData("collider-3")).toBeNull();

    // Fresh bootstrap — no collision, no auth required.
    const fresh = await mcpCall("tools/call", {
      name: "register_agent",
      arguments: { name: "collider-3", role: "r", capabilities: [] },
    });
    const body = parseEnvelope(fresh);
    expect(body.success).toBe(true);
    expect(body.agent_token).toBeTruthy();
  });

  it("(d) after markAgentOffline (session_id=NULL), re-register with same token → succeeds", async () => {
    // Seed + simulate SIGINT.
    const r = registerAgent("collider-4", "r", []);
    const sid = r.agent.session_id!;
    performAutoUnregister("collider-4", sid, "SIGTERM");

    // Row is preserved but closed. session_id is NULL. (v2.2.2 BUG2:
    // SIGINT transition is now 'closed' rather than 'offline' so
    // dashboards can distinguish retired-by-intent from transient drop.
    // Collision semantics below are unchanged — neither state is live.)
    const row = getAgentAuthData("collider-4");
    expect(row).toBeTruthy();
    expect(row?.session_id).toBeNull();
    expect(row?.agent_status).toBe("closed");

    // Fresh terminal with the existing token resumes the active-state
    // re-register path — no collision (session is not live).
    const resume = await mcpCall("tools/call", {
      name: "register_agent",
      arguments: {
        name: "collider-4",
        role: "r",
        capabilities: [],
        agent_token: r.plaintext_token,
      },
    });
    const body = parseEnvelope(resume);
    expect(body.success).toBe(true);
    expect(body.agent.session_id).not.toBeNull();
  });

  it("(e) offline row + WRONG token → AUTH_FAILED (not NAME_COLLISION_ACTIVE)", async () => {
    const r = registerAgent("collider-5", "r", []);
    markAgentOffline("collider-5", r.agent.session_id!);

    const bad = await mcpCall("tools/call", {
      name: "register_agent",
      arguments: { name: "collider-5", role: "r", capabilities: [], agent_token: "not-the-real-token" },
    });
    const body = parseEnvelope(bad);
    expect(body.success).toBe(false);
    expect(body.error_code).toBe(ERROR_CODES.AUTH_FAILED);
    // Explicitly NOT the collision code — offline row is a token question, not a collision.
    expect(body.error_code).not.toBe(ERROR_CODES.NAME_COLLISION_ACTIVE);
  });
});
