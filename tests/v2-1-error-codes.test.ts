// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 4g — structured error codes.
 *
 * Every tool error response now carries a stable `error_code` token
 * alongside the existing human-readable `error` string. Tests hit each
 * major code family through the real dispatcher path via HTTP.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import type { Server as HttpServer } from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-error-codes-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
// v2.1.3 I8: scrub inherited RELAY_AGENT_* env vars so isolated tests
// do not auth against a parent-shell spawn-agent.sh token.
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
delete process.env.RELAY_ALLOW_LEGACY;
delete process.env.RELAY_HTTP_SECRET;

const { startHttpServer } = await import("../src/transport/http.js");
const { closeDb, getDb } = await import("../src/db.js");
const { ERROR_CODES } = await import("../src/error-codes.js");
const { importRelayState, exportRelayState } = await import("../src/backup.js");

let server: HttpServer;
let baseUrl: string;

async function rpc(tool: string, args: any): Promise<any> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  const parsed = dataLine ? JSON.parse(dataLine.slice(5).trim()) : JSON.parse(text);
  return JSON.parse(parsed.result.content[0].text);
}

async function register(name: string, caps: string[] = []): Promise<string> {
  const r = await rpc("register_agent", { name, role: "r", capabilities: caps });
  return r.agent_token;
}

function cleanup() {
  try { server?.close(); } catch { /* ignore */ }
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
}

beforeEach(async () => {
  cleanup();
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  server = startHttpServer(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 80));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});
afterEach(cleanup);

describe("v2.1 Phase 4g — error codes", () => {
  it("(1) AUTH_FAILED: bad token on any auth-required tool", async () => {
    await register("a", []);
    const r = await rpc("send_message", {
      from: "a",
      to: "a",
      content: "x",
      agent_token: "totally-wrong-token-1234567890",
    });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe(ERROR_CODES.AUTH_FAILED);
    expect(r.auth_error).toBe(true);
  });

  it("(2) CAP_DENIED: broadcast without 'broadcast' capability", async () => {
    const tok = await register("b", []); // no broadcast cap
    const r = await rpc("broadcast", { from: "b", content: "x", agent_token: tok });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe(ERROR_CODES.CAP_DENIED);
  });

  it("(3) NOT_FOUND: get_task with nonexistent id returns NOT_FOUND, not NOT_PARTY", async () => {
    const tok = await register("c", []);
    const r = await rpc("get_task", { task_id: "does-not-exist", agent_token: tok });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe(ERROR_CODES.NOT_FOUND);
  });

  it("(4) NOT_PARTY: get_task by a third-party agent", async () => {
    const fromTok = await register("pty-from", ["tasks"]);
    await register("pty-to", []);
    const thirdTok = await register("pty-third", []);
    const posted = await rpc("post_task", {
      from: "pty-from",
      to: "pty-to",
      title: "t",
      description: "d",
      agent_token: fromTok,
    });
    expect(posted.success).toBe(true);
    const r = await rpc("get_task", { task_id: posted.task_id, agent_token: thirdTok });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe(ERROR_CODES.NOT_PARTY);
  });

  it("(5) ALREADY_EXISTS: create_channel with an existing name", async () => {
    const tok = await register("ch-creator", ["channels"]);
    await rpc("create_channel", { name: "dup-chan", creator: "ch-creator", agent_token: tok });
    const r = await rpc("create_channel", { name: "dup-chan", creator: "ch-creator", agent_token: tok });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe(ERROR_CODES.ALREADY_EXISTS);
  });

  it("(6) NOT_MEMBER: post_to_channel by a non-member", async () => {
    const creatorTok = await register("nm-owner", ["channels"]);
    const outsiderTok = await register("nm-outsider", ["channels"]);
    await rpc("create_channel", { name: "private-chan", creator: "nm-owner", agent_token: creatorTok });
    const r = await rpc("post_to_channel", {
      channel_name: "private-chan",
      from: "nm-outsider",
      content: "let me in",
      agent_token: outsiderTok,
    });
    expect(r.success).toBe(false);
    expect(r.error_code).toBe(ERROR_CODES.NOT_MEMBER);
  });

  it("(7) PAYLOAD_TOO_LARGE: send_message with content exceeding RELAY_MAX_PAYLOAD_BYTES", async () => {
    // Default RELAY_MAX_PAYLOAD_BYTES = 65536. Craft content just over.
    const tok = await register("pl-a", []);
    await register("pl-b", []);
    const huge = "x".repeat(65_537);
    const r = await rpc("send_message", { from: "pl-a", to: "pl-b", content: huge, agent_token: tok });
    expect(r.success).toBe(false);
    // Zod refine produces a validation-shaped error; accept either code.
    expect([ERROR_CODES.VALIDATION, ERROR_CODES.PAYLOAD_TOO_LARGE]).toContain(r.error_code);
  });

  it("(8) CONCURRENT_UPDATE: simulate lease timeout + conflicting accept", async () => {
    const fromTok = await register("cu-from", ["tasks"]);
    const workerTok = await register("cu-worker", ["tasks"]);
    const posted = await rpc("post_task", {
      from: "cu-from",
      to: "cu-worker",
      title: "cu",
      description: "cu",
      agent_token: fromTok,
    });
    expect(posted.success).toBe(true);
    // Worker accepts → status 'accepted'. Racing accept a second time → CAS
    // sees the status transition has already happened, raises CONCURRENT_UPDATE
    // or INVALID_STATE depending on exact path.
    const a1 = await rpc("update_task", {
      task_id: posted.task_id,
      agent_name: "cu-worker",
      action: "accept",
      agent_token: workerTok,
    });
    expect(a1.success).toBe(true);
    const a2 = await rpc("update_task", {
      task_id: posted.task_id,
      agent_name: "cu-worker",
      action: "accept",
      agent_token: workerTok,
    });
    expect(a2.success).toBe(false);
    expect([ERROR_CODES.CONCURRENT_UPDATE, ERROR_CODES.INVALID_STATE]).toContain(a2.error_code);
  });

  it("(9) INVALID_STATE: cancel a completed task (or at least surface a state error)", async () => {
    const fromTok = await register("is-from", ["tasks"]);
    const workerTok = await register("is-worker", ["tasks"]);
    const posted = await rpc("post_task", {
      from: "is-from",
      to: "is-worker",
      title: "x",
      description: "x",
      agent_token: fromTok,
    });
    await rpc("update_task", { task_id: posted.task_id, agent_name: "is-worker", action: "accept", agent_token: workerTok });
    await rpc("update_task", { task_id: posted.task_id, agent_name: "is-worker", action: "complete", result: "ok", agent_token: workerTok });
    const r = await rpc("update_task", { task_id: posted.task_id, agent_name: "is-from", action: "cancel", agent_token: fromTok });
    expect(r.success).toBe(false);
    expect([ERROR_CODES.INVALID_STATE, ERROR_CODES.CONCURRENT_UPDATE]).toContain(r.error_code);
  });

  it("(10) SCHEMA_MISMATCH: importRelayState with a tampered future-version manifest throws BackupError with code", async () => {
    const { initializeDb, CURRENT_SCHEMA_VERSION } = await import("../src/db.js");
    await initializeDb();
    const exp = await exportRelayState();

    // Tamper with the manifest: bump schema_version past the current.
    const { spawnSync } = await import("child_process");
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), "bad-"));
    try {
      spawnSync("tar", ["-xzf", exp.archive_path, "-C", stage], { encoding: "utf-8" });
      const mfPath = path.join(stage, "manifest.json");
      const mf = JSON.parse(fs.readFileSync(mfPath, "utf-8"));
      mf.schema_version = CURRENT_SCHEMA_VERSION + 1;
      fs.writeFileSync(mfPath, JSON.stringify(mf));
      const tampered = path.join(TEST_DB_DIR, "tampered.tar.gz");
      spawnSync("tar", ["-czf", tampered, "manifest.json", "relay.db"], { cwd: stage, encoding: "utf-8" });

      // Daemon is running on `server`; pass force:true to bypass that check
      // so the schema gate is what fires.
      await expect(importRelayState(tampered, { force: true })).rejects.toMatchObject({
        code: ERROR_CODES.SCHEMA_MISMATCH,
      });
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  });
});
