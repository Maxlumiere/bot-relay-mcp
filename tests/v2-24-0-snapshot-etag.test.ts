// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.24.0 — /api/snapshot ETag + Date caching (lumen contract).
 *
 * Two server-side amendments, tested to the HARM:
 *  1. The snapshot body carries ABSOLUTE timestamps only — no server-now — so it
 *     is STABLE between substantive changes. A time-varying field in the body
 *     would change the ETag every poll and kill the 304 path.
 *  2. A strong ETag over that stable body + server-now in the HTTP `Date` header
 *     (NOT the body), so a 304 (which has no body) still delivers an
 *     authoritative clock. Standard If-None-Match -> 304.
 *
 * Harm legs: same-state polls -> same ETag + 304; a 304 still carries `Date`.
 * Innocent twins: a real change -> different ETag + 200 body; no If-None-Match
 * -> normal 200.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import type { Server as HttpServer } from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-snapshot-etag-" + process.pid);
fs.mkdirSync(TEST_DB_DIR, { recursive: true });
// FULL isolation from the real ~/.bot-relay (HOME + db + config), so this test
// does NOT read the operator's real config.json — which on a machine where
// `relay init` has run carries a dashboard_secret, making the endpoint require
// auth (a 401) instead of serving the unauthenticated restricted view. In CI
// (fresh runner) no such config exists, but the test must be hermetic anyway.
process.env.RELAY_HOME = TEST_DB_DIR;
process.env.RELAY_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_CONFIG_PATH = path.join(TEST_DB_DIR, "config.json");
process.env.RELAY_ALLOW_LEGACY = "1";
// Unauthenticated (restricted) snapshot — no dashboard secret configured. The
// ETag/Date/304 contract is identical for the authed view (see boundary note).
delete process.env.RELAY_HTTP_SECRET;
delete process.env.RELAY_DASHBOARD_SECRET;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;

const { startHttpServer } = await import("../src/transport/http.js");
const { closeDb } = await import("../src/db.js");

let server: HttpServer;
let baseUrl: string;

async function snap(headers: Record<string, string> = {}): Promise<{
  status: number;
  etag: string | null;
  date: string | null;
  bodyText: string;
}> {
  const res = await fetch(`${baseUrl}/api/snapshot`, { headers });
  const bodyText = await res.text();
  return { status: res.status, etag: res.headers.get("etag"), date: res.headers.get("date"), bodyText };
}

async function registerAgent(name: string): Promise<void> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "register_agent", arguments: { name, role: "tester", capabilities: [] } },
    }),
  });
  await res.text();
}

beforeAll(async () => {
  server = startHttpServer(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 100));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  // Warm any one-time lazy init (e.g. default dashboard_prefs row) so the tests
  // assert STEADY-STATE stability — the operational reality: lumen polls a warm
  // daemon. Per-poll variance (the bug this guards) still shows as etag drift
  // WITHIN a test, which no warmup can hide.
  await snap();
});

afterAll(() => {
  server.close();
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

describe("v2.24.0 — /api/snapshot ETag + Date caching (lumen contract)", () => {
  it("HARM: two same-state polls produce the SAME ETag, and a conditional GET returns 304", async () => {
    const a = await snap();
    expect(a.status).toBe(200);
    expect(a.etag).toBeTruthy();
    const b = await snap(); // nothing changed between the two polls
    expect(b.status).toBe(200);
    // If these differ, a time-varying field is STILL in the body — that is the bug.
    expect(b.etag).toBe(a.etag);
    const conditional = await snap({ "If-None-Match": a.etag! });
    expect(conditional.status).toBe(304);
    expect(conditional.bodyText).toBe(""); // a 304 has no body
  });

  it("HARM: the 304 still carries a Date header (authoritative clock on a cache HIT)", async () => {
    const a = await snap();
    const conditional = await snap({ "If-None-Match": a.etag! });
    expect(conditional.status).toBe(304);
    expect(conditional.date).toBeTruthy();
    expect(Number.isNaN(new Date(conditional.date!).getTime())).toBe(false); // parseable HTTP-date
  });

  it("HARM: stability holds WITH agents present (no hidden time-varying field in agent rows)", async () => {
    await registerAgent("etag-stable-agent");
    const a = await snap();
    expect(a.status).toBe(200);
    const b = await snap();
    expect(b.etag).toBe(a.etag); // still stable once content exists
    const conditional = await snap({ "If-None-Match": a.etag! });
    expect(conditional.status).toBe(304);
  });

  it("INNOCENT TWIN: a real change (new agent) yields a DIFFERENT ETag and a 200 with a full body", async () => {
    const before = await snap();
    await registerAgent("etag-change-agent");
    const after = await snap({ "If-None-Match": before.etag! });
    expect(after.status).toBe(200); // NOT 304 — the body changed, revalidation must miss
    expect(after.etag).not.toBe(before.etag);
    const parsed = JSON.parse(after.bodyText);
    expect(Array.isArray(parsed.agents)).toBe(true);
    expect(parsed.agents.some((x: { name?: string }) => x.name === "etag-change-agent")).toBe(true);
  });

  it("INNOCENT TWIN: no If-None-Match -> normal 200 with ETag + Date, and NO server-now `timestamp` in the body", async () => {
    const a = await snap();
    expect(a.status).toBe(200);
    expect(a.etag).toBeTruthy();
    expect(a.date).toBeTruthy();
    const parsed = JSON.parse(a.bodyText);
    // Amendment #1: server-now is gone from the body (it lived at `timestamp`).
    expect(parsed.timestamp).toBeUndefined();
    expect(parsed).toHaveProperty("agents");
    expect(parsed).toHaveProperty("content_visibility");
  });
});
