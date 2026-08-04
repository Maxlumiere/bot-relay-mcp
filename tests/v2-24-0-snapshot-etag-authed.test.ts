// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.24.0 — /api/snapshot ETag caching on the AUTHENTICATED path.
 *
 * The restricted (unauthenticated) view only exists on an UNCONFIGURED relay.
 * On a CONFIGURED relay (a dashboard secret set — the state of any relay after
 * `relay init`) the three states are:
 *   no secret configured + loopback   -> restricted body
 *   secret configured + not presented -> 401, NO body (no ETag)
 *   secret configured + presented     -> full body
 * So on a configured relay the ONLY path the caching code runs on is the
 * AUTHENTICATED one. This file tests that path directly, and proves the
 * discriminating property: the full-view ETag and the restricted-view ETag over
 * the SAME data DIFFER, so a cache can never cross the two views (e.g. a stale
 * restricted ETag producing a false 304 on the full path across a config change).
 *
 * Mechanism: resolveDashboardSecret() reads RELAY_DASHBOARD_SECRET live per
 * request, so one isolated server (config file carries no secret) flips between
 * unconfigured and configured by toggling the env — letting us capture both
 * views over identical data in one process.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import type { Server as HttpServer } from "http";

const SECRET = "test-dashboard-secret-6f2a9c";
const TEST_DIR = path.join(os.tmpdir(), "bot-relay-snapshot-etag-authed-" + process.pid);
fs.mkdirSync(TEST_DIR, { recursive: true });
// Hermetic: isolate HOME/db/config away from the real ~/.bot-relay. The isolated
// config carries NO dashboard_secret, so resolveDashboardSecret() is driven
// PURELY by the RELAY_DASHBOARD_SECRET env we toggle below.
process.env.RELAY_HOME = TEST_DIR;
process.env.RELAY_DB_PATH = path.join(TEST_DIR, "relay.db");
process.env.RELAY_CONFIG_PATH = path.join(TEST_DIR, "config.json");
process.env.RELAY_ALLOW_LEGACY = "1";
delete process.env.RELAY_HTTP_SECRET;
delete process.env.RELAY_DASHBOARD_SECRET; // start UNCONFIGURED
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;

const { startHttpServer } = await import("../src/transport/http.js");
const { closeDb } = await import("../src/db.js");

let server: HttpServer;
let baseUrl: string;
let restrictedEtag: string | null = null;
let fullEtagSameData: string | null = null;

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
const authed = (extra: Record<string, string> = {}) => snap({ Authorization: `Bearer ${SECRET}`, ...extra });

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

  // Seed one agent so both views describe identical, non-empty state.
  await registerAgent("disc-shared-agent");

  // Capture the RESTRICTED view (env unset -> unconfigured -> loopback restricted).
  restrictedEtag = (await snap()).etag;

  // Configure the relay, then capture the FULL view of the SAME data. From here
  // on the relay is configured for the rest of the file.
  process.env.RELAY_DASHBOARD_SECRET = SECRET;
  fullEtagSameData = (await authed()).etag;
});

afterAll(() => {
  delete process.env.RELAY_DASHBOARD_SECRET;
  server.close();
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("v2.24.0 — /api/snapshot ETag caching on the AUTHENTICATED path", () => {
  it("production reality: on a configured relay, an unauthenticated caller gets 401 with an ERROR body (not a snapshot) — the snapshot caching path never runs", async () => {
    const u = await snap(); // secret configured, none presented
    expect(u.status).toBe(401);
    const parsed = JSON.parse(u.bodyText);
    expect(parsed.error).toBeTruthy(); // an auth error, not relay state
    expect(parsed).not.toHaveProperty("content_visibility");
    expect(parsed).not.toHaveProperty("agents");
    // The 401 does carry an ETag, but it is Express's WEAK auto-tag over the
    // error body (W/"..."), not our STRONG snapshot ETag ("<sha256>") — different
    // format and content, so it can never satisfy a snapshot If-None-Match.
    if (u.etag) expect(u.etag.startsWith('W/')).toBe(true);
  });

  it("HARM: two authed same-state polls produce the SAME ETag, and a conditional GET returns 304 that still carries Date", async () => {
    const a = await authed();
    expect(a.status).toBe(200);
    expect(a.etag).toBeTruthy();
    const b = await authed();
    expect(b.etag).toBe(a.etag); // stable body on the authed path too
    const conditional = await authed({ "If-None-Match": a.etag! });
    expect(conditional.status).toBe(304);
    expect(conditional.bodyText).toBe("");
    expect(conditional.date).toBeTruthy();
    expect(Number.isNaN(new Date(conditional.date!).getTime())).toBe(false);
  });

  it("INNOCENT TWIN: a real change (new agent) yields a DIFFERENT authed ETag and a 200 with a full body", async () => {
    const before = await authed();
    await registerAgent("authed-change-agent");
    const after = await authed({ "If-None-Match": before.etag! });
    expect(after.status).toBe(200);
    expect(after.etag).not.toBe(before.etag);
    const parsed = JSON.parse(after.bodyText);
    expect(parsed.agents.some((x: { name?: string }) => x.name === "authed-change-agent")).toBe(true);
  });

  it("INNOCENT TWIN: authed with no If-None-Match -> 200 full body (content_visibility 'full', ETag + Date, no server-now timestamp)", async () => {
    const a = await authed();
    expect(a.status).toBe(200);
    expect(a.etag).toBeTruthy();
    expect(a.date).toBeTruthy();
    const parsed = JSON.parse(a.bodyText);
    expect(parsed.content_visibility).toBe("full");
    expect(parsed.timestamp).toBeUndefined();
  });

  it("DISCRIMINATING HARM: the full-view ETag differs from the restricted-view ETag over the SAME data — a cache cannot cross the two views", async () => {
    // Both captured in beforeAll over identical state (only disc-shared-agent).
    expect(restrictedEtag).toBeTruthy();
    expect(fullEtagSameData).toBeTruthy();
    // If these ever collided, a stale restricted ETag could yield a false 304 on
    // the authed path (serve a restricted body to an operator) or the reverse.
    // This inequality is exactly what makes the "no Vary header" choice safe.
    expect(fullEtagSameData).not.toBe(restrictedEtag);
  });
});
