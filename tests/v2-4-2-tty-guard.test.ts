// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.4.2 — TTY guard refinement.
 *
 * Coverage (spawns `node dist/index.js` with varying stdin configurations,
 * captures exit code + stderr, asserts the refined guard behavior):
 *   - Background daemon attempt (stdin = /dev/null, no bytes) exits with
 *     code 3 within the grace window (RELAY_TTY_GRACE_MS=300 drives it
 *     tight to keep the test fast).
 *   - MCP-style launch (piped stdin, first bytes within grace window)
 *     does NOT exit — it proceeds to the MCP loop + lives until we kill it.
 *   - `RELAY_SKIP_TTY_CHECK=1` bypasses the guard entirely; proceeds even
 *     with /dev/null stdin.
 *   - stdin-pipe-but-parent-sends-nothing — exits with code 3 within grace.
 *   - Cross-platform: pure Node + process.stdin — no platform-specific
 *     syscalls. Tests are skipped on Windows because they pipe /dev/null
 *     directly; on Windows CI we rely on the darwin + linux job coverage.
 *
 * The dist/index.js binary is rebuilt by the pre-publish gate before this
 * file runs; locally `npm run build` is the prerequisite.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getFreePort } from "./_helpers/port.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..");
const ENTRY = path.join(PROJECT_ROOT, "dist", "index.js");

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
}> {
  return new Promise((resolve) => {
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.on("exit", (code, signal) => resolve({ code, signal, stderr, stdout }));
  });
}

function waitForStartupSignal(child: ChildProcessWithoutNullStreams, pattern: RegExp, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let buf = "";
    const onData = (c: Buffer) => {
      buf += c.toString();
      if (pattern.test(buf)) {
        child.stderr.removeListener("data", onData);
        child.stdout.removeListener("data", onData);
        resolve(true);
      }
    };
    child.stderr.on("data", onData);
    child.stdout.on("data", onData);
    setTimeout(() => {
      child.stderr.removeListener("data", onData);
      child.stdout.removeListener("data", onData);
      resolve(false);
    }, timeoutMs);
  });
}

beforeAll(() => {
  if (!fs.existsSync(ENTRY)) {
    throw new Error(
      `dist/index.js missing at ${ENTRY}. Run \`npm run build\` before this test file — ` +
        `the TTY guard fires at binary startup and can only be exercised against the built artifact.`,
    );
  }
});

describe("v2.4.2 — TTY guard", () => {
  it("(T1) background daemon attempt (stdin=/dev/null) exits code 3 IMMEDIATELY on EOF", async () => {
    // Fresh in-memory-ish DB path so this test never touches ~/.bot-relay.
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), ".tty-guard-"));
    const devNull = fs.openSync("/dev/null", "r");
    const child = spawn(process.execPath, [ENTRY], {
      stdio: [devNull, "pipe", "pipe"],
      env: {
        ...process.env,
        RELAY_DB_PATH: path.join(tmpDir, "relay.db"),
        RELAY_TRANSPORT: "stdio",
        RELAY_SKIP_TTY_CHECK: "",
      },
    }) as ChildProcessWithoutNullStreams;

    const start = Date.now();
    const result = await waitForExit(child);
    const elapsed = Date.now() - start;

    expect(result.code).toBe(3);
    expect(result.stderr).toMatch(/received no MCP client, and stdin closed immediately/);
    // The message must be ACTIONABLE for the person who hits it — someone
    // running us from systemd or a background tab. It names the HTTP remedy and
    // deliberately never mentions TTYs, which were only ever a proxy for "is a
    // human here" and read as a riddle to anyone in a container.
    expect(result.stderr).toMatch(/RELAY_TRANSPORT=http/);
    // Must not DIAGNOSE in terms of TTYs — "attach a real terminal" is a riddle
    // to someone in a container who never typed anything. (RELAY_SKIP_TTY_CHECK
    // still appears as the override's name; that is the variable, not advice.)
    expect(result.stderr).not.toMatch(/not a TTY/);
    expect(result.stderr).not.toMatch(/attach a real TTY/);
    // DECIDED, not waited for: the old guard sat out a 1500ms grace before it
    // could act. EOF is immediate, so this must be fast — and being fast is the
    // observable proof that no timer is involved any more.
    expect(elapsed).toBeLessThan(1200);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 10_000);

  it("(T2) MCP-style launch — real SDK client connects + lists tools (THE contract, not a proxy)", async () => {
    // Codex repro for v2.4.2 R0 proved that the previous pause+unshift
    // approach left the first frame stranded in process.stdin while the
    // SDK's StdioServerTransport was attached to a different reader path
    // — Client.connect() timed out at 4s. R1 hands a PassThrough proxy to
    // startStdioServer so the buffered first chunk reaches the SDK
    // transport intact. This test is the contract: a real
    // @modelcontextprotocol/sdk Client must complete connect() + list
    // tools through the spawned binary with the guard ENGAGED. Anything
    // less is testing a proxy, not the path operators actually use.
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), ".tty-guard-"));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY],
      env: {
        ...process.env,
        RELAY_DB_PATH: path.join(tmpDir, "relay.db"),
        RELAY_TRANSPORT: "stdio",
        // Default grace; the SDK sends its initialize frame far inside
        // the window. Don't override — closer to the operator path.
        RELAY_SKIP_TTY_CHECK: "",
      },
    });
    const client = new Client(
      { name: "v2-4-2-tty-guard-test", version: "0.0.0" },
      { capabilities: {} },
    );
    try {
      await Promise.race([
        client.connect(transport),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Client.connect timed out (5s)")), 5000),
        ),
      ]);
      const tools = await client.listTools();
      // Tool count is set by createServer(); we only assert "non-empty +
      // realistic" here so the test doesn't drift every time a tool is
      // added / removed. The contract is "client can list tools at all".
      expect(Array.isArray(tools.tools)).toBe(true);
      expect(tools.tools.length).toBeGreaterThanOrEqual(25);
    } finally {
      try { await client.close(); } catch { /* swallow */ }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("(T3) RELAY_SKIP_TTY_CHECK=1 bypasses the guard even with /dev/null stdin", async () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), ".tty-guard-"));
    const devNull = fs.openSync("/dev/null", "r");
    const child = spawn(process.execPath, [ENTRY], {
      stdio: [devNull, "pipe", "pipe"],
      env: {
        ...process.env,
        RELAY_DB_PATH: path.join(tmpDir, "relay.db"),
        RELAY_TRANSPORT: "stdio",
        RELAY_SKIP_TTY_CHECK: "1",
      },
    }) as ChildProcessWithoutNullStreams;

    // With SKIP=1, the guard never fires. Process proceeds to stdio loop
    // and (because stdin is /dev/null) will exit cleanly on stream end
    // via the MCP transport's own handling — not via code 3.
    const result = await waitForExit(child);
    // Either exits cleanly (0) or via SIGPIPE-ish clean handler; the
    // guard path is "code 3 + the specific stderr message", which is
    // what we're asserting does NOT happen.
    expect(result.stderr).not.toMatch(/received no MCP client, and stdin closed immediately/);
    expect(result.code).not.toBe(3);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 10_000);

  it("(T4) parent CLOSES stdin without writing — exits code 3 (daemon-launch mistake)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), ".tty-guard-"));
    const child = spawn(process.execPath, [ENTRY], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        RELAY_DB_PATH: path.join(tmpDir, "relay.db"),
        RELAY_TRANSPORT: "stdio",
        RELAY_SKIP_TTY_CHECK: "",
      },
    }) as ChildProcessWithoutNullStreams;

    // Close the stdin pipe without writing — mirrors a parent that
    // spawned the process but died before sending a frame.
    setTimeout(() => child.stdin.end(), 50);

    const result = await waitForExit(child);
    expect(result.code).toBe(3);
    expect(result.stderr).toMatch(/received no MCP client, and stdin closed immediately/);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 10_000);

  it("(T6) parent HOLDS stdin OPEN and never writes — server STAYS ALIVE (was exit 3)", async () => {
    // THE REGRESSION THAT WAS NEVER COVERED. Every container, supervisor and
    // MCP proxy starts the server before a client speaks and holds stdin open.
    // The old 1500ms grace killed that at ~1675ms, measured against the
    // published binary. T4 above LOOKS like this case but is not: it calls
    // stdin.end(), so it is really "parent closed without writing". The
    // genuinely broken shape had no test at all, which is how it shipped.
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), ".tty-guard-"));
    const child = spawn(process.execPath, [ENTRY], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, RELAY_DB_PATH: path.join(tmpDir, "relay.db"), RELAY_TRANSPORT: "stdio", RELAY_SKIP_TTY_CHECK: "" },
    }) as ChildProcessWithoutNullStreams;
    let exited = false;
    child.on("exit", () => { exited = true; });
    await new Promise((r) => setTimeout(r, 2500)); // well past the old window
    expect(exited, "server exited while a client was merely slow to connect").toBe(false);
    child.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 15_000);

  it("(T7) client sends its first frame LATE — still served (was exit 3)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), ".tty-guard-"));
    const child = spawn(process.execPath, [ENTRY], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, RELAY_DB_PATH: path.join(tmpDir, "relay.db"), RELAY_TRANSPORT: "stdio", RELAY_SKIP_TTY_CHECK: "" },
    }) as ChildProcessWithoutNullStreams;
    let exited = false;
    child.on("exit", () => { exited = true; });
    await new Promise((r) => setTimeout(r, 2200));
    expect(exited, "server died before the late client could speak").toBe(false);
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    }) + "\n");
    await new Promise((r) => setTimeout(r, 600));
    expect(exited, "server died after the late client spoke").toBe(false);
    child.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 15_000);

  it("(T5) non-stdio transport (http) never engages the guard regardless of stdin", async () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), ".tty-guard-"));
    const devNull = fs.openSync("/dev/null", "r");
    const child = spawn(process.execPath, [ENTRY], {
      stdio: [devNull, "pipe", "pipe"],
      env: {
        ...process.env,
        RELAY_DB_PATH: path.join(tmpDir, "relay.db"),
        RELAY_TRANSPORT: "http",
        // v2.6.3: pre-allocated free port via getFreePort (kernel-assigned
        // 127.0.0.1 port, released microseconds before daemon binds).
        // Replaces pre-v2.6.3 random-in-range pattern; config still rejects
        // RELAY_HTTP_PORT=0, but pre-allocation passes a specific port
        // number so config validation accepts it.
        RELAY_HTTP_PORT: String(await getFreePort()),
        RELAY_SKIP_TTY_CHECK: "",
      },
    }) as ChildProcessWithoutNullStreams;

    // HTTP mode: stdin is ignored. Server should print its "listening"
    // message to stderr (logger) and stay alive.
    const sawListen = await waitForStartupSignal(child, /HTTP server listening/, 5000);
    expect(sawListen).toBe(true);
    expect(child.exitCode).toBeNull();
    child.kill("SIGTERM");
    await waitForExit(child);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 15_000);
});
