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

  // v2.2.1 B3: stdio transport requires a live TTY. Running `node
  // dist/index.js` in a non-interactive shell (Claude Code bash sandbox,
  // systemd service with no pty, background tab) defaults to stdio and
  // exits the moment stdin closes — silent daemon death. Loud refusal
  // beats magical auto-upgrade: operators running the binary as a daemon
  // MUST pick http explicitly, otherwise we tell them why + exit.
  //
  // Guard ordering: after config resolution (so env + CLI + file have all
  // had a chance to set transport) and BEFORE initializeDb/port-bind (no
  // side effects on the exit path). `RELAY_SKIP_TTY_CHECK=1` is the escape
  // hatch for tests that legitimately want stdio piped from a harness.
  if (
    config.transport === "stdio" &&
    !process.stdin.isTTY &&
    process.env.RELAY_SKIP_TTY_CHECK !== "1"
  ) {
    process.stderr.write(
      "Transport is stdio but stdin is not a TTY. The stdio transport will " +
        "exit the moment stdin closes — that's almost certainly not what you " +
        "want for a daemon.\n\n" +
        "Fix one of:\n" +
        "  (a) set RELAY_TRANSPORT=http (+ RELAY_HTTP_PORT=3777 for the usual port), or\n" +
        "  (b) run `node dist/index.js --transport=http --port=3777` directly, or\n" +
        "  (c) run interactively (attach a real TTY — e.g. a terminal, not a Claude Code bash block).\n\n" +
        "See docs/deployment.md. Override this check with RELAY_SKIP_TTY_CHECK=1 " +
        "if you're piping the session deliberately from a test harness.\n"
    );
    process.exit(3);
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
