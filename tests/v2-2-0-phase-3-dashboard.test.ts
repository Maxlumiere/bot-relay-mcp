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
const { registerAgent, sendMessage, registerWebhook, getDb, closeDb } = await import("../src/db.js");
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

// ADR-0006 (2026-07-25): "location is not a principal." The HARM is "an
// operator-authored FREE-TEXT value reached an unauthenticated caller" — the
// text itself, whatever field carries it. Each free-text field gets a DISTINCT
// secret so a failure NAMES which one leaked. No keyring (the default) → every
// value is plaintext at rest. Prior versions each asserted one field / a proxy
// and each missed a different free-text field (content → description → title).
// This asserts the CLASS: no free-text value appears anywhere in the body.
describe("v2.2.0 /api/snapshot — ADR-0006 harm refused (unauthenticated loopback)", () => {
  const S = {
    agent_role: "SECRET-agent-role-Ar",
    agent_capability: "SECRET-agent-capability-Ac",
    agent_description: "SECRET-agent-description-Ad",
    message_content: "SECRET-message-content-Mc",
    message_routed_capability: "SECRET-message-routedcap-Mr",
    task_title: "SECRET-task-title-Tt",
    task_description: "SECRET-task-description-Td",
    task_result: "SECRET-task-result-Tr",
    task_required_capability: "SECRET-task-reqcap-Tq",
    webhook_url_path: "SECRET-webhook-urlpath-Wu", // in the URL path → stripped to host
    webhook_url_userinfo: "SECRET-webhook-userinfo-Wi", // in userinfo → stripped
    webhook_filter: "SECRET-webhook-filter-Wf", // free-text filter → excluded
  };

  function seedAllFreeText(): void {
    delete process.env.RELAY_ENCRYPTION_KEY; // pass-through → plaintext at rest
    registerAgent("sender", S.agent_role, [S.agent_capability]);
    registerAgent("receiver", "worker", []);
    getDb().prepare("UPDATE agents SET description = ? WHERE name = ?").run(S.agent_description, "sender");
    sendMessage("sender", "receiver", S.message_content, "normal");
    const ts = new Date().toISOString();
    getDb()
      .prepare(
        "INSERT INTO messages (id, from_agent, to_agent, content, priority, status, created_at, routed_capability) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run("msg-cap", "sender", "receiver", "plain body", "normal", "pending", ts, S.message_routed_capability);
    const insTask = getDb().prepare(
      "INSERT INTO tasks (id, from_agent, to_agent, title, description, priority, status, result, created_at, updated_at, required_capabilities) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    );
    insTask.run("task-active", "sender", "receiver", S.task_title, S.task_description, "normal", "posted", null, ts, ts, JSON.stringify([S.task_required_capability]));
    insTask.run("task-done", "sender", "receiver", "plain title", "plain desc", "normal", "completed", S.task_result, ts, ts, null);
    // A webhook whose secret is in the PATH (must reduce to host) and one whose
    // secret is in the USERINFO (URL.hostname must never include it); plus a
    // free-text filter (excluded). host `hooks.example.com` is NOT a secret.
    registerWebhook(`https://hooks.example.com/services/${S.webhook_url_path}`, "message.sent", S.webhook_filter);
    registerWebhook(`https://user:${S.webhook_url_userinfo}@host.example.com/hook`, "message.sent");
  }

  it("(HARM, no keyring) NO operator free-text field reaches an unauthenticated caller", async () => {
    seedAllFreeText();
    const r = await getJson("/api/snapshot");
    expect(r.status).toBe(200);
    expect(r.json.authenticated).toBe(false);
    expect(r.json.content_visibility).toBe("restricted");
    const body = JSON.stringify(r.json);
    for (const [field, secret] of Object.entries(S)) {
      expect(body, `${field} leaked to an unauthenticated caller`).not.toContain(secret);
    }
    // Non-vacuity: the entities ARE still listed (flow metadata present), so the
    // secrets are absent because free text was stripped, not because the arrays
    // are empty. No content/preview key survives at all.
    const m = (r.json.messages as any[]).find((x) => x.from_agent === "sender" && x.to_agent === "receiver");
    expect(m).toBeDefined();
    expect("content" in m).toBe(false);
    expect((r.json.agents as any[]).some((a) => a.name === "sender")).toBe(true);
    expect((r.json.active_tasks as any[]).some((t) => t.id === "task-active")).toBe(true);
    // Webhook is still listed (its HOST is safe to show), full url + filter gone.
    const wh = (r.json.webhooks as any[]).find((w) => w.url_host === "hooks.example.com");
    expect(wh).toBeDefined();
    expect("url" in wh).toBe(false);
    expect("filter" in wh).toBe(false);
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

  it("(A1) an authenticated caller receives the free-text fields + full metadata (guard doesn't break the dashboard)", async () => {
    delete process.env.RELAY_ENCRYPTION_KEY;
    registerAgent("sender", "SECRET-role-Ar", ["SECRET-cap-Ac"]);
    getDb().prepare("UPDATE agents SET description = ? WHERE name = ?").run("SECRET-desc-Ad", "sender");
    registerAgent("agent-with-title", "r", [], { terminal_title_ref: "my-window" });
    sendMessage("sender", "agent-with-title", "SECRET-content-Mc", "normal");
    registerWebhook("https://hooks.example.com/services/AUTHED-webhook-path-Wp", "message.sent");
    const r = await getJsonAuthed("/api/snapshot", SECRET);
    expect(r.status).toBe(200);
    expect(r.json.authenticated).toBe(true);
    expect(r.json.content_visibility).toBe("full");
    const body = JSON.stringify(r.json);
    // The authenticated operator DOES get the free text + full webhook url —
    // proves the guard restricts by principal, not by breaking the dashboard.
    expect(body).toContain("SECRET-content-Mc"); // message content
    expect(body).toContain("SECRET-desc-Ad"); // agent description
    expect(body).toContain("SECRET-role-Ar"); // agent role
    expect(body).toContain("AUTHED-webhook-path-Wp"); // full webhook url
    expect(r.json.messages[0].content_preview).toBe("SECRET-content-Mc");
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
