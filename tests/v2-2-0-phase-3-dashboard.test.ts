// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.2.0 Phase 3 — dashboard frontend rewrite.
 *
 * Coverage:
 *   - `GET /dashboard` serves the new HTML with the expected landmark IDs
 *     (cards-per-row toggle, filters, messages list, focused-agent panel).
 *   - The inline JS references `/dashboard/ws` (Phase 2) and
 *     `/api/focus-terminal` (Phase 1) — proves the three phases are wired
 *     end-to-end on the client side.
 *   - `/api/snapshot` includes the new `content_preview` / `*_preview`
 *     fields alongside the raw (encrypted) content — narrow Phase 4d
 *     policy expansion documented in src/dashboard.ts.
 *   - CSS uses the `--cards-per-row` custom property.
 *   - Filter bar renders 3 inputs (role / status / since) with associated
 *     aria-labels.
 *   - Recent-messages list uses <button> rows with aria-expanded (keyboard
 *     navigable ARIA-compliant accordion).
 *
 * Manual verification outstanding (per spec § Success criteria, manual
 * release-validation criteria): live WebSocket push visible on browser, cards-per-row
 * toggle updates grid, click-to-focus raises iTerm2 on macOS.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import type { Server as HttpServer } from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-v220-p3-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
delete process.env.RELAY_ALLOW_LEGACY;
delete process.env.RELAY_HTTP_SECRET;
delete process.env.RELAY_DASHBOARD_SECRET;

const { startHttpServer } = await import("../src/transport/http.js");
const { registerAgent, sendMessage, getDb, closeDb } = await import("../src/db.js");
const { _resetDashboardWsForTests } = await import("../src/transport/websocket.js");

let server: HttpServer;
let port: number;

async function bootServer(): Promise<void> {
  if (server) {
    try { server.close(); } catch { /* ignore */ }
  }
  _resetDashboardWsForTests();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  server = startHttpServer(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 60));
  const addr = server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
}

function getJson(p: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: p }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, json: body ? JSON.parse(body) : null });
        });
      })
      .on("error", reject);
  });
}

function getText(p: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: p }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

beforeEach(async () => {
  await bootServer();
});

afterEach(() => {
  _resetDashboardWsForTests();
  try { if (server) server.close(); } catch { /* ignore */ }
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

describe("v2.2.0 Phase 3 — dashboard HTML", () => {
  it("(D1) GET /dashboard serves HTML containing all Phase 3 landmark IDs", async () => {
    const r = await getText("/dashboard");
    expect(r.status).toBe(200);
    // Core landmarks the reactive app wires to.
    expect(r.body).toContain('id="agents-grid"');
    expect(r.body).toContain('id="cards-per-row-toggle"');
    expect(r.body).toContain('id="filter-role"');
    expect(r.body).toContain('id="filter-status"');
    expect(r.body).toContain('id="filter-since"');
    expect(r.body).toContain('id="focused-agent"');
    expect(r.body).toContain('id="btn-focus-terminal"');
    expect(r.body).toContain('id="conn-pill"');
  });

  it("(D2) HTML references /dashboard/ws (Phase 2) and /api/focus-terminal (Phase 1)", async () => {
    const r = await getText("/dashboard");
    expect(r.status).toBe(200);
    expect(r.body).toContain("/dashboard/ws");
    expect(r.body).toContain("/api/focus-terminal");
    expect(r.body).toContain("/api/snapshot");
  });

  it("(D3) CSS grid uses --cards-per-row custom property", async () => {
    const r = await getText("/dashboard");
    expect(r.body).toContain("--cards-per-row");
    expect(r.body).toMatch(/grid-template-columns:\s*repeat\(var\(--cards-per-row\)/);
  });

  it("(D4) Recent-messages list uses <button> rows with aria-expanded (accordion)", async () => {
    const r = await getText("/dashboard");
    expect(r.body).toContain('class="msg-row"');
    expect(r.body).toContain('aria-expanded');
    // Keyboard/ARIA: the focused panel is aria-live for screen readers on update.
    expect(r.body).toContain('aria-live="polite"');
  });

  it("(D5) Filter bar inputs have associated aria-labels", async () => {
    const r = await getText("/dashboard");
    expect(r.body).toMatch(/aria-label="Cards per row"/);
    expect(r.body).toMatch(/aria-label="Filter by role"/);
    expect(r.body).toMatch(/aria-label="Filter by agent status"/);
    expect(r.body).toMatch(/aria-label="Time window for messages"/);
  });

  it("(D6) Dashboard served from GET / too (root-alias)", async () => {
    const r = await getText("/");
    expect(r.status).toBe(200);
    expect(r.body).toContain('id="agents-grid"');
  });
});

// ADR-0006 (2026-07-25): "location is not a principal." The HARM is
// "a secret string reached an unauthenticated caller" — so these assert the
// secret is ABSENT FROM THE ENTIRE RESPONSE BODY (field-agnostic), not that one
// derived field is null. That is what catches the raw `content` column (which
// is PLAINTEXT with no keyring — encryption is opt-in) and any field added
// later. The prior version asserted `content_preview===null` while the row
// spread still shipped the plaintext `content` — a proxy that defended the hole
// (codex flipped it to `content===SECRET` and it passed). getJson presents NO
// credential against a no-secret deployment (both secrets deleted at module top).
describe("v2.2.0 /api/snapshot — ADR-0006 harm refused (unauthenticated loopback)", () => {
  const SECRET = "TOPSECRET-cross-agent-plaintext-Zx9";

  it("(S1, NO KEYRING = the default) the message secret is ABSENT from the whole snapshot body", async () => {
    delete process.env.RELAY_ENCRYPTION_KEY; // pass-through → content stored as plaintext
    registerAgent("snap-from", "r", []);
    registerAgent("snap-to", "r", []);
    sendMessage("snap-from", "snap-to", SECRET, "normal");
    const r = await getJson("/api/snapshot");
    expect(r.status).toBe(200);
    expect(r.json.authenticated).toBe(false);
    expect(r.json.content_visibility).toBe("restricted");
    expect(JSON.stringify(r.json)).not.toContain(SECRET); // the harm, field-agnostic
    // Non-vacuity: the message IS still listed with its flow metadata (so the
    // secret is absent because CONTENT was stripped, not because the array is
    // empty). It just carries no content/content_preview of any kind.
    const m = (r.json.messages as any[]).find((x) => x.from_agent === "snap-from");
    expect(m).toBeDefined();
    expect(m.to_agent).toBe("snap-to");
    expect("content" in m).toBe(false);
    expect("content_preview" in m).toBe(false);
  });

  it("(S2) process-identifying agent metadata is absent for an unauthenticated caller; presence stays", async () => {
    registerAgent("agent-with-title", "r", [], { terminal_title_ref: "my-window" });
    const r = await getJson("/api/snapshot");
    expect(r.status).toBe(200);
    const ag = (r.json.agents as any[]).find((a) => a.name === "agent-with-title");
    expect(ag).toBeDefined(); // presence is agent-trust — the agent is still listed
    expect(ag.session_id).toBeUndefined();
    expect(ag.host_shell_pids).toBeUndefined();
    expect(ag.host_id).toBeUndefined();
    expect(JSON.stringify(r.json)).not.toContain("my-window"); // field-agnostic backstop
  });

  it("(S3) task description + result never reach an unauthenticated caller (active AND completed)", async () => {
    delete process.env.RELAY_ENCRYPTION_KEY;
    const ts = new Date().toISOString();
    const ins = getDb().prepare(
      "INSERT INTO tasks (id, from_agent, to_agent, title, description, priority, status, result, created_at, updated_at, required_capabilities) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    );
    ins.run("task-active-1", "boss", "worker", "job A", "SECRET-DESC-active-Q7", "normal", "posted", null, ts, ts, null);
    ins.run("task-done-1", "boss", "worker", "job B", "plain desc", "normal", "completed", "SECRET-RESULT-done-K3", ts, ts, null);
    const body = JSON.stringify((await getJson("/api/snapshot")).json);
    expect(body).not.toContain("SECRET-DESC-active-Q7"); // active task description
    expect(body).not.toContain("SECRET-RESULT-done-K3"); // completed task result
  });
});

// ADR-0015 innocent twin: an authenticated operator (dashboard secret + valid
// Bearer) gets the full content — proving the gate refuses the harm without
// breaking the legitimate operator path. The secret is set for THIS block only.
describe("v2.2.0 /api/snapshot — ADR-0006 innocent twin (authenticated operator sees full content)", () => {
  const SECRET = "test-dashboard-secret-abcdefghijklmnopqrstuv";
  beforeEach(() => {
    process.env.RELAY_DASHBOARD_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.RELAY_DASHBOARD_SECRET;
  });

  function getJsonAuthed(p: string, bearer: string): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
      http
        .get(
          { host: "127.0.0.1", port, path: p, headers: { Authorization: `Bearer ${bearer}` } },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (c) => (body += c));
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 0, json: body ? JSON.parse(body) : null }),
            );
          },
        )
        .on("error", reject);
    });
  }

  it("(A1) an authenticated caller receives the FULL content + metadata (guard doesn't break the dashboard)", async () => {
    const CONTENT = "authed-operator-sees-this-fully";
    registerAgent("snap-from", "r", []);
    registerAgent("snap-to", "r", []);
    registerAgent("agent-with-title", "r", [], { terminal_title_ref: "my-window" });
    sendMessage("snap-from", "snap-to", CONTENT, "normal");
    const r = await getJsonAuthed("/api/snapshot", SECRET);
    expect(r.status).toBe(200);
    expect(r.json.authenticated).toBe(true);
    expect(r.json.content_visibility).toBe("full");
    expect(r.json.messages[0].content_preview).toBe(CONTENT);
    expect(JSON.stringify(r.json)).toContain(CONTENT); // full content DOES reach the authenticated operator
    const ag = (r.json.agents as any[]).find((a) => a.name === "agent-with-title");
    expect(ag.terminal_title_ref).toBe("my-window");
  });

  it("(A2) authenticated preview still truncates at 100 chars", async () => {
    registerAgent("long-from", "r", []);
    registerAgent("long-to", "r", []);
    sendMessage("long-from", "long-to", "x".repeat(500), "normal");
    const r = await getJsonAuthed("/api/snapshot", SECRET);
    const m = (r.json.messages as any[]).find(
      (m) => m.from_agent === "long-from" && m.to_agent === "long-to",
    );
    expect(m).toBeDefined();
    expect(m.content_preview.length).toBe(100);
  });

  it("(A3) with a secret set, a WRONG bearer is refused (401) — loopback is not a bypass", async () => {
    registerAgent("snap-from", "r", []);
    registerAgent("snap-to", "r", []);
    sendMessage("snap-from", "snap-to", "hello dashboard", "normal");
    const r = await getJsonAuthed("/api/snapshot", "wrong-secret");
    expect(r.status).toBe(401);
  });
});
