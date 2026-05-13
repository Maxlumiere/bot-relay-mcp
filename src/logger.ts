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

/**
 * v2.7.1 [CRITICAL FIX] — secret redaction.
 *
 * Defense-in-depth on top of stripping tokens at every known call site.
 * Even after audit-walking the codebase, the next contributor adding a
 * `log.debug(\`token=${tok}\`)` line will re-introduce the data-leak
 * class. This function scrubs every log line before it hits stderr.
 *
 * Patterns intentionally match the common shapes operators are likely
 * to interpolate into a log message:
 *   - `RELAY_AGENT_TOKEN=<value>` — env-form (the exact shape Hermes
 *     surfaced in src/tools/identity.ts:150-153 pre-fix).
 *   - `Authorization: Bearer <value>` and `Authorization: <value>` —
 *     HTTP request/response headers.
 *   - `X-Agent-Token: <value>` — relay's per-agent header.
 *   - JSON-ish `"token": "<value>"` (any of: token, agent_token,
 *     recovery_token, secret, http_secret, webhook_secret,
 *     password) — surfaces config dumps, error contexts, etc.
 *
 * Replacement is `***` (the value only; the key + framing stay so the
 * log line remains diagnostic).
 *
 * Origin: review-Victra synthesis msg `2b903f9b` / Hermes deep-review.
 */
export function redactSecrets(line: string): string {
  if (!line || typeof line !== "string") return line;
  return (
    line
      // RELAY_AGENT_TOKEN=<value> (env-form; matches trailing
      // whitespace, comma, or end-of-string).
      .replace(/(RELAY_AGENT_TOKEN=)([^\s,"')]+)/g, "$1***")
      // Authorization: <scheme> <credential> — single regex covers EVERY
      // scheme. Pre-v2.7.1-R1 this was two regexes: one specifically for
      // Bearer + a generic one with a Bearer/Basic/Digest negative
      // lookahead. Codex R1 audit caught two failure modes in the prior
      // shape:
      //   - `Authorization: Basic dXNlcjpwYXNz` survived UNREDACTED
      //     (the negative lookahead excluded Basic to avoid double-
      //     capture against the Bearer pattern; net effect: Basic
      //     credentials shipped to stderr).
      //   - `Authorization: Token abc123` got partially redacted to
      //     `Authorization: *** abc123` — the regex captured the SCHEME
      //     word (Token / ApiKey / Digest-without-quote / etc.) as the
      //     credential and missed the actual token bytes.
      //
      // Capture shape: $1 = "Authorization: " framing, $2 = optional
      // "scheme " (Bearer/Basic/Token/ApiKey/any \w+), $3 = credential.
      // Replacement preserves $1 + $2 (scheme name) and replaces $3
      // with `***`. When the input is scheme-less (`Authorization:
      // <cred>`), $2 is empty and replacement becomes
      // `Authorization: ***`.
      .replace(/(Authorization:\s+)(\w+\s+)?([^\s,"')]+)/gi, "$1$2***")
      // X-Agent-Token: <value>
      .replace(/(X-Agent-Token:\s*)([^\s,"')]+)/gi, "$1***")
      // JSON-ish "<key>": "<value>" for common secret-bearing keys.
      // Catches both single + double quotes; non-greedy value match.
      .replace(
        /("(?:token|agent_token|recovery_token|secret|http_secret|webhook_secret|password)"\s*:\s*)"([^"]+)"/gi,
        '$1"***"',
      )
  );
}

function write(level: LogLevel, args: unknown[]): void {
  if (LEVEL_ORDER[level] < minLevel()) return;
  const parts = args.map((a) => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === "object") return JSON.stringify(a);
    return String(a);
  });
  const raw = `${ts()} ${PREFIX} [${level}] ${parts.join(" ")}\n`;
  process.stderr.write(redactSecrets(raw));
}

export const log = {
  debug: (...args: unknown[]) => write("debug", args),
  info: (...args: unknown[]) => write("info", args),
  warn: (...args: unknown[]) => write("warn", args),
  error: (...args: unknown[]) => write("error", args),
};
