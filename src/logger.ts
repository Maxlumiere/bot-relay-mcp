// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Stderr-only logger. NEVER writes to stdout.
 *
 * stdout is the MCP JSON-RPC channel in stdio mode. A single stray
 * console.log there silently breaks the protocol for every user. This
 * module is the safe alternative — every message goes to stderr regardless
 * of transport mode.
 *
 * Usage:
 *   import { log } from "./logger.js";
 *   log.info("server started");
 *   log.warn("config file missing, using defaults");
 *   log.error("webhook delivery failed", err);
 */

const PREFIX = "[bot-relay]";

function ts(): string {
  return new Date().toISOString();
}

type LogLevel = "debug" | "info" | "warn" | "error";
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Returns the current minimum log level. RELAY_LOG_LEVEL wins over the legacy
 * RELAY_LOG_DEBUG=1 flag. Invalid values default to "info".
 */
function minLevel(): number {
  const env = (process.env.RELAY_LOG_LEVEL || "").toLowerCase() as LogLevel;
  if (env in LEVEL_ORDER) return LEVEL_ORDER[env];
  if (process.env.RELAY_LOG_DEBUG === "1") return LEVEL_ORDER.debug;
  return LEVEL_ORDER.info;
}

function write(level: LogLevel, args: unknown[]): void {
  if (LEVEL_ORDER[level] < minLevel()) return;
  const parts = args.map((a) => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === "object") return JSON.stringify(a);
    return String(a);
  });
  process.stderr.write(`${ts()} ${PREFIX} [${level}] ${parts.join(" ")}\n`);
}

export const log = {
  debug: (...args: unknown[]) => write("debug", args),
  info: (...args: unknown[]) => write("info", args),
  warn: (...args: unknown[]) => write("warn", args),
  error: (...args: unknown[]) => write("error", args),
};
