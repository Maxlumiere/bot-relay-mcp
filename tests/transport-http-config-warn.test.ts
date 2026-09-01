// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Silent-failure class (onboarding launch gate) — transport:"http" from the
 * config FILE must ANNOUNCE itself.
 *
 * The quietest way to make a stdio-spawned MCP server mute is a config file that
 * sets `transport:"http"`: index.ts then runs the HTTP branch only and never
 * speaks MCP on stdin/stdout, so the client that spawned it (e.g. from
 * ~/.claude.json) gets zero relay tools and a 30s timeout with no diagnostic.
 * The stdio daemon-launch guard is itself gated on `transport==="stdio"`, so it
 * never fires to warn. The daemon takes its transport from the RELAY_TRANSPORT
 * *environment* variable, so a file-sourced http value is useless for the daemon
 * AND fatal for every stdio spawn.
 *
 * This spawns the built binary and asserts the warning fires for the FILE source
 * and stays silent for the ENV source (the legitimate daemon / deliberate HTTP).
 * Mirrors tests/v2-4-2-tty-guard.test.ts's subprocess+stderr harness.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { getFreePort } from "./_helpers/port.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..");
const ENTRY = path.join(PROJECT_ROOT, "dist", "index.js");

const WARN_RE = /transport="http" was read from the config FILE/;

/** Collect stderr for up to timeoutMs OR until `pattern` matches; returns what was seen. */
function collectStderr(
  child: ChildProcessWithoutNullStreams,
  pattern: RegExp,
  timeoutMs: number,
): Promise<{ matched: boolean; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = "";
    let done = false;
    const finish = (matched: boolean) => {
      if (done) return;
      done = true;
      child.stderr.removeListener("data", onData);
      resolve({ matched, stderr });
    };
    const onData = (c: Buffer) => {
      stderr += c.toString();
      if (pattern.test(stderr)) finish(true);
    };
    child.stderr.on("data", onData);
    setTimeout(() => finish(pattern.test(stderr)), timeoutMs);
  });
}

beforeAll(() => {
  if (!fs.existsSync(ENTRY)) {
    throw new Error(
      `dist/index.js missing at ${ENTRY}. Run \`npm run build\` before this file — ` +
        `the warning fires at binary startup and can only be exercised against the built artifact.`,
    );
  }
});

describe("transport:http-from-config warning", () => {
  it("(W1) config FILE sets transport:http → the binary warns loudly on stderr", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), ".thttp-warn-"));
    const port = await getFreePort();
    const cfgPath = path.join(tmpDir, "config.json");
    // transport:http lives in the FILE, so sources.transport === "config".
    fs.writeFileSync(cfgPath, JSON.stringify({ transport: "http", http_port: port, http_host: "127.0.0.1" }));
    const devNull = fs.openSync("/dev/null", "r");
    const child = spawn(process.execPath, [ENTRY], {
      stdio: [devNull, "pipe", "pipe"],
      env: {
        ...process.env,
        RELAY_CONFIG_PATH: cfgPath,
        RELAY_DB_PATH: path.join(tmpDir, "relay.db"),
        RELAY_TRANSPORT: "", // empty → NOT env-sourced; the file must win + be labeled "config"
        RELAY_SKIP_TTY_CHECK: "1",
      },
    }) as ChildProcessWithoutNullStreams;

    const { matched, stderr } = await collectStderr(child, WARN_RE, 6000);
    child.kill("SIGTERM");
    expect(matched, `expected the config-file transport:http warning; stderr was:\n${stderr}`).toBe(true);
    // It must be ACTIONABLE — name the fix (remove the key) and the daemon's env path.
    expect(stderr).toMatch(/remove "transport" from the config file/i);
    expect(stderr).toMatch(/RELAY_TRANSPORT/);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 15_000);

  it("(W2) ENV sets transport:http (the daemon / deliberate HTTP) → NO warning", async () => {
    // Negative control: an operator who sets RELAY_TRANSPORT=http made a
    // deliberate choice — the file-source warning must stay silent, or it would
    // cry wolf on every daemon start.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), ".thttp-warn-"));
    const port = await getFreePort();
    const devNull = fs.openSync("/dev/null", "r");
    const child = spawn(process.execPath, [ENTRY], {
      stdio: [devNull, "pipe", "pipe"],
      env: {
        ...process.env,
        RELAY_CONFIG_PATH: path.join(tmpDir, "config.json"), // absent file → transport from ENV only
        RELAY_DB_PATH: path.join(tmpDir, "relay.db"),
        RELAY_TRANSPORT: "http",
        RELAY_HTTP_PORT: String(port),
        RELAY_SKIP_TTY_CHECK: "1",
      },
    }) as ChildProcessWithoutNullStreams;

    // Wait for the server to come up (listening) and give the warning a chance to
    // appear; then assert it did NOT.
    const { stderr } = await collectStderr(child, /HTTP server listening/, 6000);
    child.kill("SIGTERM");
    expect(stderr).not.toMatch(WARN_RE);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 15_000);
});
