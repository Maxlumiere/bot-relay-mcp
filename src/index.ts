#!/usr/bin/env node
// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { loadConfig, validateConfigAndEnv, InvalidConfigError } from "./config.js";
import { startStdioServer } from "./transport/stdio.js";
import { startHttpServer } from "./transport/http.js";
import { closeDb, initializeDb } from "./db.js";
import { log } from "./logger.js";
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
  const config = loadConfig();

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
