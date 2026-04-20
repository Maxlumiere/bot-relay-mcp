// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v1.7 tests for:
 *   - CORS / Origin allow-list on dashboard + /api/snapshot
 *   - Structured JSON audit log entries (with encryption round-trip)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import type { Server as HttpServer } from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-cors-audit-test-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
// v2.1.3 I8: scrub inherited RELAY_AGENT_* env vars so isolated tests
// do not auth against a parent-shell spawn-agent.sh token.
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
process.env.RELAY_ALLOW_LEGACY = "1";
process.env.RELAY_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");

const { startHttpServer } = await import("../src/transport/http.js");
const { closeDb, logAudit, getAuditLog } = await import("../src/db.js");

let server: HttpServer;
let baseUrl: string;

beforeAll(async () => {
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
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
  delete process.env.RELAY_ENCRYPTION_KEY;
  delete process.env.RELAY_ALLOW_LEGACY;
});

describe("CORS / Origin allow-list on dashboard (v1.7)", () => {
  it("no Origin header → allowed (non-browser caller like curl)", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("bot-relay dashboard");
  });

  it("localhost Origin → allowed with CORS header echoed back", async () => {
    const res = await fetch(`${baseUrl}/api/snapshot`, {
      headers: { Origin: "http://localhost:5173" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(res.headers.get("vary")).toContain("Origin");
  });

  it("127.0.0.1 Origin with any port → allowed", async () => {
    const res = await fetch(`${baseUrl}/api/snapshot`, {
      headers: { Origin: "http://127.0.0.1:9999" },
    });
    expect(res.status).toBe(200);
  });

  it("arbitrary external Origin → 403", async () => {
    const res = await fetch(`${baseUrl}/api/snapshot`, {
      headers: { Origin: "https://evil.example.com" },
    });
    expect(res.status).toBe(403);
  });

  it("/health is never Origin-checked (monitoring-friendly)", async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { Origin: "https://evil.example.com" },
    });
    expect(res.status).toBe(200);
  });

  it("HTTPS Origin rejected when only http://localhost is allowed", async () => {
    const res = await fetch(`${baseUrl}/api/snapshot`, {
      headers: { Origin: "https://localhost:5173" },
    });
    expect(res.status).toBe(403);
  });
});

describe("Structured audit log (v1.7)", () => {
  it("logAudit with structured data persists a parseable params_json", () => {
    logAudit(
      "alice",
      "send_message",
      "summary-legacy",
      true,
      null,
      "http",
      { tool: "send_message", agent_name: "alice", auth_method: "http_secret", result: "success" }
    );

    const entries = getAuditLog("alice", "send_message");
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const entry = entries[0];
    expect(entry.params_json).not.toBeNull();
    expect(entry.params_json!.tool).toBe("send_message");
    expect(entry.params_json!.auth_method).toBe("http_secret");
    expect(entry.params_json!.result).toBe("success");
  });

  it("legacy logAudit call (no structured arg) still writes a row", () => {
    logAudit("bob", "get_messages", "summary-only", true, null);
    const entries = getAuditLog("bob", "get_messages");
    expect(entries.length).toBe(1);
    // params_json contains a wrapped legacy_summary
    expect(entries[0].params_json).not.toBeNull();
    expect(entries[0].params_json!.legacy_summary).toBe("summary-only");
  });

  it("audit log params_json is encrypted at rest", async () => {
    logAudit(
      "charlie",
      "post_task",
      "summary",
      true,
      null,
      "http",
      { tool: "post_task", secret_field: "SUPER-SECRET-VALUE" }
    );

    // Read raw SQL to confirm the structured field is encrypted on disk
    const Database = (await import("better-sqlite3")).default;
    const rawDb = new Database(TEST_DB_PATH);
    const row = rawDb
      .prepare("SELECT params_json FROM audit_log WHERE agent_name = 'charlie' AND tool = 'post_task'")
      .get() as { params_json: string };
    rawDb.close();

    expect(row.params_json).not.toContain("SUPER-SECRET-VALUE");
    // v2.1 Phase 4b.3: params_json is now encrypted via the versioned prefix
    // `enc:<key_id>:...`. Legacy `enc1:...` rows are still readable but
    // never produced by encryptContent post-Phase-4b.3.
    expect(row.params_json.startsWith("enc:k1:")).toBe(true);

    // And that getAuditLog decrypts it correctly
    const entries = getAuditLog("charlie", "post_task");
    expect((entries[0].params_json as any).secret_field).toBe("SUPER-SECRET-VALUE");
  });

  it("malformed params_json row returns _parse_error flag, not an exception", async () => {
    // Simulate a malformed row by inserting raw encrypted garbage
    const Database = (await import("better-sqlite3")).default;
    const rawDb = new Database(TEST_DB_PATH);
    rawDb.prepare(
      "INSERT INTO audit_log (id, agent_name, tool, params_summary, params_json, success, error, source, created_at) VALUES ('bad-id', 'corrupted', 'get_task', 'x', 'enc1:ZZZ:ZZZ', 1, NULL, 'http', ?)"
    ).run(new Date().toISOString());
    rawDb.close();

    const entries = getAuditLog("corrupted");
    expect(entries.length).toBe(1);
    expect((entries[0].params_json as any)._parse_error).toBe(true);
  });
});
