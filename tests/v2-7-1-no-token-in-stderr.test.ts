// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.7.1 [CRITICAL] regression — agent tokens MUST NEVER appear in
 * daemon stderr.
 *
 * Bug class (pre-v2.7.1): src/tools/identity.ts:150-153 interpolated
 * the freshly-minted `plaintext_token` into a `log.info` line on every
 * register_agent success. Every stderr-capturing surface (terminal
 * scrollback, CI logs, journald, Docker logs, log aggregators, SaaS
 * observability) ended up with the token in cleartext at info level.
 * The "shown ONCE in the API response" model was broken from day one.
 *
 * Origin: a security review.
 *
 * Fix landed in v2.7.1: identity.ts log line no longer interpolates
 * the token; the redaction utility in src/logger.ts:redactSecrets
 * scrubs RELAY_AGENT_TOKEN=/Authorization/X-Agent-Token/JSON
 * token+secret+password keys defense-in-depth.
 *
 * Test strategy: spawn a real `node dist/index.js` HTTP daemon
 * subprocess (matches the shipped path; verify by reading source,
 * don't assume — InMemoryTransport
 * would miss any pre-write path that goes through the actual logger).
 * Capture stderr while running register_agent + send_message + the
 * redaction-utility direct test. Assert no token bytes appear in the
 * captured stream.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import cp from "child_process";
import { fileURLToPath } from "url";
import { getFreePort } from "./_helpers/port.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const DIST_INDEX = path.join(REPO_ROOT, "dist", "index.js");

interface DaemonHandle {
  proc: cp.ChildProcessWithoutNullStreams;
  port: number;
  root: string;
  stderr: () => string;
  kill: () => Promise<void>;
}

async function startDaemon(): Promise<DaemonHandle> {
  const port = await getFreePort();
  const root = path.join(os.tmpdir(), `v2-7-1-no-token-${process.pid}-${Date.now()}`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });

  expect(
    fs.existsSync(DIST_INDEX),
    `missing ${DIST_INDEX} — run \`npm run build\` first`,
  ).toBe(true);

  const proc = cp.spawn("node", [DIST_INDEX], {
    env: {
      ...process.env,
      RELAY_TRANSPORT: "http",
      RELAY_HTTP_PORT: String(port),
      RELAY_HTTP_HOST: "127.0.0.1",
      RELAY_HOME: root,
      RELAY_DB_PATH: path.join(root, "relay.db"),
      RELAY_CONFIG_PATH: path.join(root, "config.json"),
      RELAY_AGENT_TOKEN: "",
      RELAY_AGENT_NAME: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderrBuf = "";
  proc.stderr.on("data", (c: Buffer) => { stderrBuf += c.toString("utf-8"); });

  // Wait for /health.
  const start = Date.now();
  while (Date.now() - start < 5000) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }

  return {
    proc,
    port,
    root,
    stderr: () => stderrBuf,
    kill: async () => {
      proc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 200));
      try { proc.kill("SIGKILL"); } catch { /* */ }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

async function rpc(port: number, tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  const parsed = dataLine ? JSON.parse(dataLine.slice(5).trim()) : JSON.parse(text);
  return JSON.parse(parsed.result.content[0].text);
}

describe("v2.7.1 [CRITICAL] — agent tokens are NEVER written to daemon stderr", () => {
  let daemon: DaemonHandle | null = null;

  beforeEach(async () => {
    daemon = await startDaemon();
  });
  afterEach(async () => {
    if (daemon) {
      await daemon.kill();
      daemon = null;
    }
  });

  it("register_agent: minted token does not appear in stderr", async () => {
    const reg = await rpc(daemon!.port, "register_agent", {
      name: "stderr-probe",
      role: "tester",
      capabilities: [],
    });
    expect(reg.success).toBe(true);
    const token = reg.agent_token as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{20,}$/); // sanity-check shape

    // Let any async log lines flush.
    await new Promise((r) => setTimeout(r, 100));
    const captured = daemon!.stderr();

    expect(
      captured.includes(token),
      `daemon stderr leaked the agent token bytes.\nTail of captured stderr:\n${captured.slice(-2000)}`,
    ).toBe(false);

    // Negative test: the agent name SHOULD still appear in stderr (so the
    // operational signal "agent registered" survives the redaction).
    expect(captured).toMatch(/agent_token issued for "stderr-probe"/);
  });

  it("send_message with an X-Agent-Token header: header value does not appear in stderr", async () => {
    const reg = await rpc(daemon!.port, "register_agent", {
      name: "header-probe",
      role: "tester",
      capabilities: [],
    });
    const tok = reg.agent_token as string;

    // POST send_message with X-Agent-Token header, deliberately trigger
    // some log surface (a successful send writes audit + broadcast-trace
    // lines on hot paths).
    const res = await fetch(`http://127.0.0.1:${daemon!.port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "X-Agent-Token": tok,
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "send_message", arguments: { from: "header-probe", to: "header-probe", content: "ping" } },
      }),
    });
    expect(res.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 100));
    const captured = daemon!.stderr();
    expect(
      captured.includes(tok),
      `daemon stderr leaked the X-Agent-Token header value.\nTail of captured stderr:\n${captured.slice(-2000)}`,
    ).toBe(false);
  });
});

/**
 * In-process unit tests for the redaction utility. Faster than the real-
 * daemon tests above and pin the regex contract directly.
 */
describe("v2.7.1 — logger redactSecrets utility", () => {
  it("redacts RELAY_AGENT_TOKEN= env form (the exact bug class)", async () => {
    const { redactSecrets } = await import("../src/logger.js");
    const r = redactSecrets("Save it: RELAY_AGENT_TOKEN=AbCdEf123_secret-value (shown ONCE)");
    expect(r).toContain("RELAY_AGENT_TOKEN=***");
    expect(r).not.toContain("AbCdEf123_secret-value");
  });

  it("redacts Authorization: Bearer headers", async () => {
    const { redactSecrets } = await import("../src/logger.js");
    const r = redactSecrets("incoming request Authorization: Bearer eyJhbGciOiJI...");
    expect(r).toContain("Authorization: Bearer ***");
    expect(r).not.toContain("eyJhbGciOiJI");
  });

  // v2.7.1 R1 — codex audit caught the pre-R1 regex leaving Basic
  // unchanged AND clobbering the scheme word for non-Bearer schemes
  // (`Token abc123` → `*** abc123`). Tests assert the exact
  // contract, not a proxy: each case below
  // asserts the EXACT output string, not just "doesn't contain
  // <credential>" — the proxy check passed pre-R1 even though the
  // actual contract was broken.
  it("(R1) redacts Authorization: Basic <credential> — full base64 redacted, Basic preserved", async () => {
    const { redactSecrets } = await import("../src/logger.js");
    const r = redactSecrets("Authorization: Basic dXNlcjpwYXNz");
    expect(r).toBe("Authorization: Basic ***");
  });

  it("(R1) redacts Authorization: Token <credential> — non-IANA scheme; scheme word preserved", async () => {
    const { redactSecrets } = await import("../src/logger.js");
    const r = redactSecrets("Authorization: Token abc123");
    expect(r).toBe("Authorization: Token ***");
  });

  it("(R1) redacts Authorization: ApiKey <credential> — vendor scheme; scheme word preserved", async () => {
    const { redactSecrets } = await import("../src/logger.js");
    const r = redactSecrets("Authorization: ApiKey abc123");
    expect(r).toBe("Authorization: ApiKey ***");
  });

  it("(R1) redacts scheme-less Authorization: <credential> — no scheme group present", async () => {
    const { redactSecrets } = await import("../src/logger.js");
    const r = redactSecrets("Authorization: abc123");
    expect(r).toBe("Authorization: ***");
  });

  it("redacts X-Agent-Token: headers (case-insensitive)", async () => {
    const { redactSecrets } = await import("../src/logger.js");
    const r1 = redactSecrets("with X-Agent-Token: tok_abc123 success");
    expect(r1).toContain("X-Agent-Token: ***");
    expect(r1).not.toContain("tok_abc123");

    const r2 = redactSecrets("with x-agent-token: tok_xyz789 success");
    expect(r2).toContain("***");
    expect(r2).not.toContain("tok_xyz789");
  });

  it("redacts JSON token/secret/password keys", async () => {
    const { redactSecrets } = await import("../src/logger.js");
    const r1 = redactSecrets('{"agent_token": "tok_super_secret_abc"}');
    expect(r1).toContain('"agent_token": "***"');
    expect(r1).not.toContain("tok_super_secret_abc");

    const r2 = redactSecrets('{"http_secret": "h_secret_xyz", "name": "alice"}');
    expect(r2).toContain('"http_secret": "***"');
    expect(r2).toContain('"name": "alice"'); // non-secret keys untouched
    expect(r2).not.toContain("h_secret_xyz");

    const r3 = redactSecrets('{"password": "p4ssw0rd!"}');
    expect(r3).toContain('"password": "***"');
    expect(r3).not.toContain("p4ssw0rd");
  });

  it("returns input unchanged when there's nothing to redact (no false positives on benign lines)", async () => {
    const { redactSecrets } = await import("../src/logger.js");
    const r = redactSecrets("HTTP server listening on http://127.0.0.1:3777");
    expect(r).toBe("HTTP server listening on http://127.0.0.1:3777");
  });
});
