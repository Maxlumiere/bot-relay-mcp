// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import type { Server as HttpServer } from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-rotation-test-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
// v2.1.3 I8: scrub inherited RELAY_AGENT_* env vars so isolated tests
// do not auth against a parent-shell spawn-agent.sh token.
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
process.env.RELAY_ALLOW_LEGACY = "1";
process.env.RELAY_HTTP_SECRET = "primary-secret-v7";
process.env.RELAY_HTTP_SECRET_PREVIOUS = "old-secret-v6,even-older-secret-v5";

const { startHttpServer } = await import("../src/transport/http.js");
const { closeDb } = await import("../src/db.js");

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
  delete process.env.RELAY_HTTP_SECRET;
  delete process.env.RELAY_HTTP_SECRET_PREVIOUS;
  delete process.env.RELAY_ALLOW_LEGACY;
});

async function hitWithSecret(secret: string | null): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (secret) headers["Authorization"] = `Bearer ${secret}`;
  return await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
}

describe("HTTP shared-secret rotation (v1.7)", () => {
  it("primary secret is accepted", async () => {
    const res = await hitWithSecret("primary-secret-v7");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-relay-secret-deprecated")).toBeNull();
  });

  it("previous secret [0] is accepted, with deprecation warning header", async () => {
    const res = await hitWithSecret("old-secret-v6");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-relay-secret-deprecated")).toBe("true");
  });

  it("previous secret [1] is accepted, with deprecation warning", async () => {
    const res = await hitWithSecret("even-older-secret-v5");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-relay-secret-deprecated")).toBe("true");
  });

  it("a never-valid secret is rejected 401", async () => {
    const res = await hitWithSecret("totally-wrong");
    expect(res.status).toBe(401);
  });

  it("no secret is rejected 401", async () => {
    const res = await hitWithSecret(null);
    expect(res.status).toBe(401);
  });
});
