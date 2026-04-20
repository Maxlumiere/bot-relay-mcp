// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import type { Server as HttpServer } from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-http-auth-test-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
// v2.1.3 I8: scrub inherited RELAY_AGENT_* env vars so isolated tests
// do not auth against a parent-shell spawn-agent.sh token.
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
process.env.RELAY_HTTP_SECRET = "test-secret-value-12345";

const { startHttpServer } = await import("../src/transport/http.js");
const { closeDb } = await import("../src/db.js");

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
  delete process.env.RELAY_HTTP_SECRET;
  if (fs.existsSync(TEST_DB_DIR)) {
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  }
});

describe("HTTP auth (shared secret)", () => {
  it("rejects /mcp requests without auth", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("rejects /mcp with wrong secret", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer wrong-secret",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it("accepts /mcp with correct Bearer token", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer test-secret-value-12345",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(200);
  });

  it("accepts /mcp with X-Relay-Secret header", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "X-Relay-Secret": "test-secret-value-12345",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(200);
  });

  it("allows /health without auth (monitoring-friendly)", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.auth_required).toBe(true);
  });

  it("rejects dashboard without auth", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(401);
  });

  it("rejects snapshot API without auth", async () => {
    const res = await fetch(`${baseUrl}/api/snapshot`);
    expect(res.status).toBe(401);
  });
});

// v1.7.1 — timing-safe secret comparison. Closes the HIGH-severity timing
// side-channel where `presented === config.http_secret` leaks the secret
// byte-by-byte via response-timing measurement.
describe("timing-safe secret comparison (v1.7.1)", () => {
  it("(i) correct primary secret still accepted (regression)", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer test-secret-value-12345",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(200);
  });

  it("(ii) wrong-but-same-length secret rejected gracefully (no crash)", async () => {
    // "test-secret-value-12345" is 23 chars. Same length, wrong content.
    const wrongSameLen = "AAAAAAAAAAAAAAAAAAAAAAA"; // 23 A's
    expect(wrongSameLen.length).toBe("test-secret-value-12345".length);
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${wrongSameLen}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it("(iii) wrong-and-shorter secret rejected gracefully — no crypto length-mismatch throw", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer x", // 1 char, secret is 23 chars
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    // Must be 401 (clean reject), NOT 500 (timingSafeEqual throw bubbling up)
    expect(res.status).toBe(401);
  });

  it("(iv) wrong-and-longer secret rejected gracefully — no crypto length-mismatch throw", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer " + "z".repeat(1024), // way longer than secret
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it("(v) source code uses crypto.timingSafeEqual in the auth middleware", async () => {
    const fsMod = await import("fs");
    const pathMod = await import("path");
    const src = fsMod.readFileSync(
      pathMod.resolve(process.cwd(), "src/transport/http.ts"),
      "utf8"
    );
    // Explicit assertion: import + call present
    expect(src).toMatch(/timingSafeEqual/);
    expect(src).toMatch(/from ["']crypto["']|from ["']node:crypto["']/);
    // And the bad pattern the v1.7.1 fix removed is NOT present on the secret path.
    // (We search for the specific expression, not every "===" in the file.)
    expect(src).not.toMatch(/presented === config\.http_secret/);
  });
});
