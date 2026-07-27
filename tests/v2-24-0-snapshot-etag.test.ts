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
const { closeDb, _setPositiveProbeForTests } = await import("../src/db.js");

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

  it("HARM: stability holds with STATIC agents present (no probe activity — the churning-field case is the separate test below)", async () => {
    // NOTE: this proves stability only for agents whose last_alive is NOT moving
    // (they are never liveness-probed in an isolated test server, so last_alive
    // stays null). It does NOT prove "no time-varying field" — the reopened
    // gate showed last_alive DOES churn on a real 5s cycle; that case is covered
    // by the "last_alive CHURNS" test below, which this one originally missed.
    await registerAgent("etag-stable-agent");
    const a = await snap();
    expect(a.status).toBe(200);
    const b = await snap();
    expect(b.etag).toBe(a.etag); // stable once content exists AND nothing is churning
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

  // v2.24.0 reopened (lumen re-measure over 60s): `last_alive` is a genuine
  // liveness observation that refreshes on a ~5s probe cycle, so it churns on its
  // own cadence. It must be excluded from the ETag INPUT (but stay in the body).
  // The prior "stability with agents" test passed for the WRONG reason — test
  // agents were never liveness-probed, so last_alive never moved. These drive it.
  it("HARM: an agent whose last_alive CHURNS between polls still yields the SAME ETag (last_alive excluded from ETag input) — and the served body genuinely differs", async () => {
    await registerAgent("liveness-churn-agent");
    const base = Date.now();
    _setPositiveProbeForTests("liveness-churn-agent", base - 2000); // last_alive = 2s ago (fresh)
    const p1 = await snap();
    _setPositiveProbeForTests("liveness-churn-agent", base - 1000); // last_alive = 1s ago — CHANGED
    const p2 = await snap();

    // The churn is real: last_alive genuinely moved and the raw bodies differ...
    const la = (t: string) =>
      JSON.parse(t).agents.find((a: { name?: string }) => a.name === "liveness-churn-agent")?.last_alive;
    expect(la(p1.bodyText)).toBeTruthy();
    expect(la(p2.bodyText)).toBeTruthy();
    expect(la(p2.bodyText)).not.toBe(la(p1.bodyText)); // last_alive changed
    expect(p2.bodyText).not.toBe(p1.bodyText); // the served bodies differ

    // ...yet the ETag is STABLE. This assertion is the negative control inline: if
    // last_alive were NOT excluded from the ETag input, the ETag would be over the
    // full (differing) body and p2.etag !== p1.etag would FAIL here.
    expect(p2.etag).toBe(p1.etag);
    // and a conditional GET still 304s despite last_alive having moved:
    const c = await snap({ "If-None-Match": p1.etag! });
    expect(c.status).toBe(304);
  });

  it("INNOCENT TWIN: a substantive change (new agent) still yields a DIFFERENT ETag even though last_alive is excluded", async () => {
    _setPositiveProbeForTests("liveness-churn-agent", Date.now() - 500); // keep last_alive churning
    const before = await snap();
    await registerAgent("substantive-after-churn-agent"); // substantive change
    const after = await snap({ "If-None-Match": before.etag! });
    expect(after.status).toBe(200); // NOT 304 — a real change must still miss
    expect(after.etag).not.toBe(before.etag);
  });
});
