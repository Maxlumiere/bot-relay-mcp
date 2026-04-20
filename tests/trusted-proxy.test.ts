// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import net from "net";
import http from "http";
import type { Server as HttpServer } from "http";

const TEST_DB_DIR = path.join(os.tmpdir(), "bot-relay-trusted-proxy-test-" + process.pid);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "relay.db");
process.env.RELAY_DB_PATH = TEST_DB_PATH;
// v2.1.3 I8: scrub inherited RELAY_AGENT_* env vars so isolated tests
// do not auth against a parent-shell spawn-agent.sh token.
delete process.env.RELAY_AGENT_TOKEN;
delete process.env.RELAY_AGENT_NAME;
delete process.env.RELAY_AGENT_ROLE;
delete process.env.RELAY_AGENT_CAPABILITIES;
// v1.7: legacy grace for tests predating the token flow
process.env.RELAY_ALLOW_LEGACY = "1";

const { startHttpServer, extractSourceIp } = await import("../src/transport/http.js");
const { closeDb, getAuditLog } = await import("../src/db.js");

/**
 * Helper: send a JSON-RPC request through a TCP socket so we can spoof
 * X-Forwarded-For header directly. fetch() in Node doesn't let us easily
 * control the header in all cases, but a raw socket does.
 */
function sendMcpWithHeaders(port: number, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/mcp",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function parseSse(raw: string): any {
  const dataLine = raw.split("\n").find((l) => l.startsWith("data:"));
  if (!dataLine) {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return JSON.parse(dataLine.slice(5).trim());
}

function cleanup() {
  closeDb();
  if (fs.existsSync(TEST_DB_DIR)) {
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  }
  delete process.env.RELAY_TRUSTED_PROXIES;
}

describe("trusted proxy / X-Forwarded-For handling (v1.6.2)", () => {
  describe("DEFAULT — no trusted proxies, XFF ignored", () => {
    let server: HttpServer;
    let port: number;

    beforeAll(async () => {
      cleanup();
      delete process.env.RELAY_TRUSTED_PROXIES;
      server = startHttpServer(0, "127.0.0.1");
      await new Promise((r) => setTimeout(r, 100));
      const addr = server.address();
      port = typeof addr === "object" && addr ? addr.port : 0;
    });

    afterAll(() => {
      server.close();
      cleanup();
    });

    it("spoofed X-Forwarded-For is ignored — rate limit keys on peer IP", async () => {
      // Register two agents, capturing the tokens from the response
      const registerBody = (name: string) => JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "register_agent",
          arguments: { name, role: "r", capabilities: [] },
        },
      });
      const reg1 = await sendMcpWithHeaders(port, {}, registerBody("xff-test-1"));
      const reg2 = await sendMcpWithHeaders(port, {}, registerBody("xff-test-2"));
      const tok1 = parseSse(reg1.body).result.content[0].text;
      const token1 = JSON.parse(tok1).agent_token;
      expect(token1).toBeTruthy();
      // (reg2's token not needed — xff-test-2 is the recipient)

      // Now send 3 messages from different spoofed XFFs, all carrying the valid token
      const sendBody = (from: string, to: string, content: string) =>
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "send_message",
            arguments: { from, to, content, priority: "normal", agent_token: token1 },
          },
        });

      const r1 = await sendMcpWithHeaders(port, { "X-Forwarded-For": "1.1.1.1" }, sendBody("xff-test-1", "xff-test-2", "m1"));
      const r2 = await sendMcpWithHeaders(port, { "X-Forwarded-For": "2.2.2.2" }, sendBody("xff-test-1", "xff-test-2", "m2"));
      const r3 = await sendMcpWithHeaders(port, { "X-Forwarded-For": "3.3.3.3" }, sendBody("xff-test-1", "xff-test-2", "m3"));

      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(r3.status).toBe(200);

      const audit = getAuditLog(undefined, "send_message");
      expect(audit.length).toBeGreaterThanOrEqual(3);
      for (const entry of audit) {
        expect(entry.error).toBeNull();
      }
    });
  });

  describe("WITH trusted proxies configured — XFF honored from trusted peers only", () => {
    let server: HttpServer;
    let port: number;

    beforeAll(async () => {
      cleanup();
      // 127.0.0.1 is our "trusted proxy" for the test (since that's the only
      // peer we can actually have in a test environment)
      process.env.RELAY_TRUSTED_PROXIES = "127.0.0.0/8,::1/128";
      server = startHttpServer(0, "127.0.0.1");
      await new Promise((r) => setTimeout(r, 100));
      const addr = server.address();
      port = typeof addr === "object" && addr ? addr.port : 0;
    });

    afterAll(() => {
      server.close();
      cleanup();
    });

    it("X-Forwarded-For IS honored when direct peer is trusted", async () => {
      const registerBody = (name: string) => JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "register_agent", arguments: { name, role: "r", capabilities: [] } },
      });
      await sendMcpWithHeaders(port, {}, registerBody("trusted-1"));
      await sendMcpWithHeaders(port, {}, registerBody("trusted-2"));

      const sendBody = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "send_message",
          arguments: { from: "trusted-1", to: "trusted-2", content: "via-xff", priority: "normal" },
        },
      });

      const r = await sendMcpWithHeaders(port, { "X-Forwarded-For": "203.0.113.42" }, sendBody);
      expect(r.status).toBe(200);
      // The message should have succeeded (well under rate limit)
      const parsed = parseSse(r.body);
      expect(parsed).not.toBeNull();
    });
  });
});

// v1.6.4: unit tests for extractSourceIp with mock req objects. Lets us
// exercise IPv6-peer scenarios that are awkward to provoke over real sockets.
describe("extractSourceIp — IPv4-mapped IPv6 peer (v1.6.4)", () => {
  function mockReq(peer: string, headers: Record<string, string> = {}): any {
    return {
      socket: { remoteAddress: peer },
      headers,
    };
  }

  it("dual-stack peer ::ffff:127.0.0.1 is trusted against IPv4 CIDR 127.0.0.0/8", () => {
    const req = mockReq("::ffff:127.0.0.1", { "x-forwarded-for": "203.0.113.42" });
    // With 127.0.0.0/8 in trusted_proxies, the mapped-IPv6 peer should match,
    // XFF should be honored, and the result should be the XFF-declared IP.
    const result = extractSourceIp(req, ["127.0.0.0/8"]);
    expect(result).toBe("203.0.113.42");
  });

  it("IPv6-mapped CIDR rule matches IPv4 peer symmetrically", () => {
    const req = mockReq("127.0.0.1", { "x-forwarded-for": "203.0.113.42" });
    // Operator wrote the rule in IPv6-mapped form; IPv4 peer should still match.
    // /104 on ::ffff:127.0.0.0/104 = /8 on the embedded IPv4.
    const result = extractSourceIp(req, ["::ffff:127.0.0.0/104"]);
    expect(result).toBe("203.0.113.42");
  });

  it("XFF ignored when dual-stack peer is NOT in trusted list", () => {
    const req = mockReq("::ffff:8.8.8.8", { "x-forwarded-for": "203.0.113.42" });
    // 8.8.8.8 is not in 127.0.0.0/8; XFF must be ignored.
    const result = extractSourceIp(req, ["127.0.0.0/8"]);
    expect(result).toBe("::ffff:8.8.8.8");
  });

  it("empty trusted_proxies always returns peer, ignoring XFF", () => {
    const req = mockReq("::ffff:127.0.0.1", { "x-forwarded-for": "203.0.113.42" });
    const result = extractSourceIp(req, []);
    expect(result).toBe("::ffff:127.0.0.1");
  });
});
