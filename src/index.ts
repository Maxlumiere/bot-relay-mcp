#!/usr/bin/env node
// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { loadConfig, validateConfigAndEnv, InvalidConfigError, readConfigFileKeys } from "./config.js";
import { startStdioServer } from "./transport/stdio.js";
import { startHttpServer } from "./transport/http.js";
import { closeDb, initializeDb } from "./db.js";
import { log } from "./logger.js";
import { parseCliFlags, applyCliToEnv, usage } from "./cli.js";
import { VERSION } from "./version.js";
import type { Server as HttpServer } from "http";

const MIN_NODE_MAJOR = 18;

function checkNodeVersion(): void {
  const major = parseInt(process.versions.node.split(".")[0], 10);
  if (isNaN(major) || major < MIN_NODE_MAJOR) {
    process.stderr.write(
      `bot-relay-mcp requires Node.js ${MIN_NODE_MAJOR}+ (you have ${process.versions.node}).\n` +
      `Install a newer Node from https://nodejs.org/ or use nvm.\n`
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  checkNodeVersion();

  // v2.2.1 B1: CLI flag parsing. Must run BEFORE loadConfig so CLI values
  // win precedence (CLI > env > file > default). `applyCliToEnv` injects
  // CLI values into process.env so the existing loadConfig env-read path
  // sees them transparently — zero structural change to loadConfig itself.
  const parsed = parseCliFlags(process.argv.slice(2));
  if (parsed.error) {
    process.stderr.write(`${parsed.error.message}\n`);
    process.exit(parsed.error.exitCode);
  }
  if (parsed.help) {
    process.stdout.write(usage());
    process.exit(0);
  }
  if (parsed.version) {
    process.stdout.write(`bot-relay-mcp ${VERSION}\n`);
    process.exit(0);
  }
  // v2.2.1 L2 (Codex audit): pass file-keys set so CLI/env/config/default
  // source tracking labels config-file-won values correctly in the
  // startup log. `readConfigFileKeys()` is a cheap re-parse; the full
  // `loadConfig()` call below picks up the same file content.
  const fileKeys = readConfigFileKeys();
  const sources = applyCliToEnv(parsed.flags, process.env, fileKeys);

  const config = loadConfig();

  // B1: emit a source-log line per resolved value so operators can see which
  // layer won for each knob. Helps diagnose "I set --port=3777 but it's
  // still on 3777 default, why?" confusion by making the resolution path
  // explicit. Written to stderr so stdio transport's stdout stays clean.
  log.info(
    `[config] transport=${config.transport} (source: ${sources.transport}), ` +
      `http_port=${config.http_port} (source: ${sources.http_port}), ` +
      `http_host=${config.http_host} (source: ${sources.http_host}), ` +
      `config_path=${process.env.RELAY_CONFIG_PATH ?? "(default ~/.bot-relay/config.json)"} ` +
      `(source: ${sources.config_path})`
  );

  // v2.0 final (#18): validate config + env BEFORE any init side effects
  // (DB open, port bind, wasm load). Clear aggregate error messages.
  try {
    validateConfigAndEnv(config);
  } catch (err) {
    if (err instanceof InvalidConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  // v2.2.1 B3 (refined in v2.4.2): stdio transport with non-TTY stdin is
  // usually a daemon-launch mistake — `node dist/index.js` from a systemd
  // service or background tab defaults to stdio and exits the moment stdin
  // closes. Loud refusal beats silent daemon death.
  //
  // v2.4.2 refinement — the v2.2.1 guard over-fired on legitimate MCP
  // clients (Claude Code, Cursor, Cline, …) which ALWAYS pipe stdin as
  // part of the JSON-RPC protocol. Every post-v2.2.1 MCP spawn silently
  // failed until the operator set RELAY_SKIP_TTY_CHECK=1 — a plug-and-play
  // regression. New heuristic: if stdio + non-TTY, wait up to 1500ms for
  // any bytes to arrive on stdin. MCP clients send their `initialize`
  // frame within the first hundred ms, so they proceed. Background daemon
  // attempts have no writer, so they hit the timeout + get the helpful
  // error. The received chunk is unshifted back so the MCP transport
  // downstream reads it unchanged.
  //
  // Guard ordering: after config resolution (env + CLI + file have all
  // had a chance to set transport) and BEFORE initializeDb / port-bind
  // (no side effects on the exit path). `RELAY_SKIP_TTY_CHECK=1` stays
  // as the explicit bypass for test harnesses whose first write comes
  // after the 1500ms window.
  if (
    config.transport === "stdio" &&
    !process.stdin.isTTY &&
    process.env.RELAY_SKIP_TTY_CHECK !== "1"
  ) {
    const TTY_GUARD_ERROR =
      "Transport is stdio but stdin is not a TTY, and no MCP client sent a " +
      "frame within 1500ms. The stdio transport will exit the moment stdin " +
      "closes — that's almost certainly not what you want for a daemon.\n\n" +
      "Fix one of:\n" +
      "  (a) set RELAY_TRANSPORT=http (+ RELAY_HTTP_PORT=3777 for the usual port), or\n" +
      "  (b) run `node dist/index.js --transport=http --port=3777` directly, or\n" +
      "  (c) run interactively (attach a real TTY — e.g. a terminal, not a Claude Code bash block).\n\n" +
      "See docs/deployment.md. Override this check with RELAY_SKIP_TTY_CHECK=1 " +
      "if you're piping the session deliberately from a test harness that " +
      "writes its first frame later than 1500ms.\n";
    // Read the configured grace in ms so tests can drive it tight.
    const graceMs = Number(process.env.RELAY_TTY_GRACE_MS) > 0
      ? Number(process.env.RELAY_TTY_GRACE_MS)
      : 1500;
    await new Promise<void>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        process.stdin.removeListener("data", onData);
        process.stdin.removeListener("end", onEnd);
        process.stderr.write(TTY_GUARD_ERROR);
        process.exit(3);
      }, graceMs);
      const onData = (chunk: Buffer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        process.stdin.removeListener("data", onData);
        process.stdin.removeListener("end", onEnd);
        // Hand the bytes back to the stream so the MCP transport reads
        // the frame in full. stdin was put into flowing mode by our
        // listener; pause + unshift restores the pre-guard state.
        process.stdin.pause();
        process.stdin.unshift(chunk);
        resolve();
      };
      const onEnd = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        process.stdin.removeListener("data", onData);
        process.stderr.write(TTY_GUARD_ERROR);
        process.exit(3);
      };
      process.stdin.on("data", onData);
      process.stdin.once("end", onEnd);
    });
  }

  // Pre-initialize the DB so schema + purge run up front.
  // v1.11: async init supports both native (sync under hood) and wasm (async wasm load).
  await initializeDb();

  let httpServer: HttpServer | null = null;

  if (config.transport === "http" || config.transport === "both") {
    httpServer = startHttpServer(config.http_port, config.http_host);
  }

  if (config.transport === "stdio" || config.transport === "both") {
    await startStdioServer();
  }

  if (config.transport === "http" && !httpServer) {
    throw new Error("Failed to start HTTP server");
  }

  const shutdown = () => {
    if (httpServer) {
      httpServer.close();
    }
    closeDb();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log.error("Fatal error:", err);
  closeDb();
  process.exit(1);
});
