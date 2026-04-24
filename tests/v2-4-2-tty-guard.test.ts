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
  it("(T1) background daemon attempt (stdin=/dev/null) exits with code 3 within the grace window", async () => {
    // Fresh in-memory-ish DB path so this test never touches ~/.bot-relay.
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), ".tty-guard-"));
    const devNull = fs.openSync("/dev/null", "r");
    const child = spawn(process.execPath, [ENTRY], {
      stdio: [devNull, "pipe", "pipe"],
      env: {
        ...process.env,
        RELAY_DB_PATH: path.join(tmpDir, "relay.db"),
        RELAY_TRANSPORT: "stdio",
        RELAY_TTY_GRACE_MS: "300",
        RELAY_SKIP_TTY_CHECK: "",
      },
    }) as ChildProcessWithoutNullStreams;

    const start = Date.now();
    const result = await waitForExit(child);
    const elapsed = Date.now() - start;

    expect(result.code).toBe(3);
    expect(result.stderr).toMatch(/Transport is stdio but stdin is not a TTY/);
    expect(result.stderr).toMatch(/no MCP client sent a frame within 1500ms/);
    // Grace is 300ms; leave headroom for node startup + exit flush.
    expect(elapsed).toBeLessThan(5000);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 10_000);

  it("(T2) MCP-style launch (piped stdin + initialize frame within grace) proceeds past the guard", async () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), ".tty-guard-"));
    const child = spawn(process.execPath, [ENTRY], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        RELAY_DB_PATH: path.join(tmpDir, "relay.db"),
        RELAY_TRANSPORT: "stdio",
        RELAY_TTY_GRACE_MS: "800",
        RELAY_SKIP_TTY_CHECK: "",
      },
    }) as ChildProcessWithoutNullStreams;

    // Send a valid MCP initialize frame shortly after spawn — well within
    // the 800ms grace. Any bytes cancel the guard; MCP protocol parsing
    // happens downstream in the SDK's stdio transport layer.
    setTimeout(() => {
      const frame = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "tty-guard-test", version: "0.0.0" },
        },
      });
      child.stdin.write(frame + "\n");
    }, 100);

    // Success signal: the server writes stdio startup lines to stderr
    // (logger). "stdio" appears in the config-initialized message.
    const sawStartup = await waitForStartupSignal(child, /stdio|Initializ/i, 3000);
    expect(sawStartup).toBe(true);
    // Process is still alive (didn't exit via the guard path).
    expect(child.exitCode).toBeNull();
    child.kill("SIGTERM");
    await waitForExit(child);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 10_000);

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
        RELAY_TTY_GRACE_MS: "300",
      },
    }) as ChildProcessWithoutNullStreams;

    // With SKIP=1, the guard never fires. Process proceeds to stdio loop
    // and (because stdin is /dev/null) will exit cleanly on stream end
    // via the MCP transport's own handling — not via code 3.
    const result = await waitForExit(child);
    // Either exits cleanly (0) or via SIGPIPE-ish clean handler; the
    // guard path is "code 3 + the specific stderr message", which is
    // what we're asserting does NOT happen.
    expect(result.stderr).not.toMatch(/Transport is stdio but stdin is not a TTY/);
    expect(result.code).not.toBe(3);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 10_000);

  it("(T4) stdin is a pipe but parent never writes — exits code 3 after grace", async () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), ".tty-guard-"));
    const child = spawn(process.execPath, [ENTRY], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        RELAY_DB_PATH: path.join(tmpDir, "relay.db"),
        RELAY_TRANSPORT: "stdio",
        RELAY_TTY_GRACE_MS: "300",
        RELAY_SKIP_TTY_CHECK: "",
      },
    }) as ChildProcessWithoutNullStreams;

    // Close the stdin pipe without writing — mirrors a parent that
    // spawned the process but died before sending a frame.
    setTimeout(() => child.stdin.end(), 50);

    const result = await waitForExit(child);
    expect(result.code).toBe(3);
    expect(result.stderr).toMatch(/Transport is stdio but stdin is not a TTY/);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 10_000);

  it("(T5) non-stdio transport (http) never engages the guard regardless of stdin", async () => {
    const tmpDir = fs.mkdtempSync(path.join(process.cwd(), ".tty-guard-"));
    const devNull = fs.openSync("/dev/null", "r");
    const child = spawn(process.execPath, [ENTRY], {
      stdio: [devNull, "pipe", "pipe"],
      env: {
        ...process.env,
        RELAY_DB_PATH: path.join(tmpDir, "relay.db"),
        RELAY_TRANSPORT: "http",
        // Random port in the 40000-60000 band avoids collisions with the
        // live :3777 daemon + other tests binding 0. Config rejects port 0.
        RELAY_HTTP_PORT: String(40000 + Math.floor(Math.random() * 20000)),
        RELAY_SKIP_TTY_CHECK: "",
        RELAY_TTY_GRACE_MS: "300",
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
