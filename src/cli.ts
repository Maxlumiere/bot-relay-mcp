// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.2.1 B1 — CLI flag parser for `src/index.ts`.
 *
 * Fixes the v2.2.0 papercut where `node dist/index.js --transport=http
 * --port=3777` silently ignored every arg and booted stdio-on-default-port.
 * Operators had no signal that their flags were dropped.
 *
 * Scope: a tight allowlist of operator-facing flags mapped 1:1 onto existing
 * env vars. CLI wins over env wins over config file wins over compiled
 * default. Unknown flag → fast-fail with a clear message, not silent drop.
 *
 * Non-goals: arbitrary config overrides, kebab-case aliases, short flags,
 * repeatable flags. Keep the surface tiny — any operator who wants full
 * control uses the env var or config file.
 *
 * This module is a PURE function — no I/O, no process.exit, no side effects.
 * The caller (src/index.ts) decides whether to log, exit, or mutate env.
 */
import { VERSION } from "./version.js";

export interface CliFlags {
  transport?: "stdio" | "http" | "both";
  port?: number;
  host?: string;
  config?: string;
  help?: boolean;
  version?: boolean;
}

export interface CliParseResult {
  /** Parsed flags. Empty object for `--help`/`--version` callers + empty argv. */
  flags: CliFlags;
  /**
   * True when `--help` was passed. Caller should print usage + exit(0).
   * Checked separately from parse errors so `--help` works even alongside
   * invalid flags (common operator habit: "what do I pass here?").
   */
  help: boolean;
  /** True when `--version` was passed. Caller prints version + exits(0). */
  version: boolean;
  /** Usage error message + exit code. Null when parse succeeded. */
  error: { message: string; exitCode: number } | null;
}

const VALID_TRANSPORTS = ["stdio", "http", "both"] as const;

/**
 * Parse `process.argv.slice(2)` style input. Accepts both `--flag=value` and
 * `--flag value` forms for user convenience.
 */
export function parseCliFlags(argv: readonly string[]): CliParseResult {
  const flags: CliFlags = {};
  let help = false;
  let version = false;

  const take = (arr: readonly string[], i: number): { value: string; skip: number } | null => {
    const arg = arr[i];
    const eq = arg.indexOf("=");
    if (eq >= 0) {
      return { value: arg.slice(eq + 1), skip: 0 };
    }
    const next = arr[i + 1];
    if (next === undefined || next.startsWith("-")) return null;
    return { value: next, skip: 1 };
  };

  // v2.2.1 L2 (Codex audit) — --help wins over parse errors. Pre-L2 a
  // stray unknown flag anywhere in argv suppressed --help output because
  // the parser returned the error result + the caller exited 2 without
  // ever looking at the help flag. Pre-scan for --help / --version first
  // so "what do I pass here?" habits still get usage printed.
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") help = true;
    if (arg === "--version" || arg === "-v") version = true;
  }
  if (help) {
    return { flags: {}, help: true, version: false, error: null };
  }
  if (version) {
    return { flags: {}, help: false, version: true, error: null };
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--version" || arg === "-v") {
      version = true;
      continue;
    }
    // Accept --transport=X or --transport X (same pattern below).
    const flag = arg.split("=")[0];
    switch (flag) {
      case "--transport": {
        const r = take(argv, i);
        if (!r) {
          return errorResult(`Missing value for --transport. Expected one of: ${VALID_TRANSPORTS.join(", ")}.`);
        }
        if (!(VALID_TRANSPORTS as readonly string[]).includes(r.value)) {
          return errorResult(
            `Invalid value for --transport: "${r.value}". Expected one of: ${VALID_TRANSPORTS.join(", ")}.`
          );
        }
        flags.transport = r.value as CliFlags["transport"];
        i += r.skip;
        break;
      }
      case "--port": {
        const r = take(argv, i);
        if (!r) return errorResult("Missing value for --port. Expected an integer in [1, 65535].");
        if (!/^\d+$/.test(r.value)) {
          return errorResult(`Invalid value for --port: "${r.value}". Expected a positive integer.`);
        }
        const n = parseInt(r.value, 10);
        if (n < 1 || n > 65535) {
          return errorResult(`Invalid value for --port: ${n}. Expected an integer in [1, 65535].`);
        }
        flags.port = n;
        i += r.skip;
        break;
      }
      case "--host": {
        const r = take(argv, i);
        if (!r) return errorResult("Missing value for --host. Expected an IP address or hostname.");
        if (r.value.length === 0) {
          return errorResult("Invalid value for --host: empty string.");
        }
        flags.host = r.value;
        i += r.skip;
        break;
      }
      case "--config": {
        const r = take(argv, i);
        if (!r) return errorResult("Missing value for --config. Expected a file path.");
        flags.config = r.value;
        i += r.skip;
        break;
      }
      default:
        if (arg.startsWith("-")) {
          return errorResult(`Unknown flag: ${flag}. Run with --help for usage.`);
        }
        // Positional args aren't meaningful for a long-running daemon; reject.
        return errorResult(
          `Unexpected positional argument: "${arg}". This binary does not accept positional args. ` +
            `Run with --help for usage.`
        );
    }
  }

  return { flags, help, version, error: null };
}

function errorResult(message: string): CliParseResult {
  return { flags: {}, help: false, version: false, error: { message, exitCode: 2 } };
}

/**
 * Usage string. Printed to stdout on `--help` (exit 0). Kept in sync with
 * the flag switch above — add a flag here AND in the parser; drift-grep
 * has no hook for this yet, so it's a shared human-managed contract.
 */
export function usage(): string {
  return [
    `bot-relay-mcp ${VERSION}`,
    "",
    "Usage: node dist/index.js [options]",
    "",
    "Options:",
    "  --transport <mode>   Transport mode: stdio | http | both. (env: RELAY_TRANSPORT)",
    "  --port <N>           HTTP port in [1, 65535]. (env: RELAY_HTTP_PORT)",
    "  --host <ip>          HTTP bind host. (env: RELAY_HTTP_HOST)",
    "  --config <path>      Path to config JSON. (env: RELAY_CONFIG_PATH)",
    "  --help, -h           Show this message and exit.",
    "  --version, -v        Print version and exit.",
    "",
    "Precedence: CLI flag > env var > config file > compiled default.",
    "",
    "Config file format: JSON with keys matching the RelayConfig interface. See",
    "src/config.ts for the full schema. Default path: ~/.bot-relay/config.json",
    "(override via --config or RELAY_CONFIG_PATH).",
    "",
    "Reports bugs to: https://github.com/Maxlumiere/bot-relay-mcp/issues",
    "",
  ].join("\n");
}

/**
 * Pre-loadConfig env injection. CLI flags beat env vars — the simplest way
 * to enforce that without restructuring `loadConfig` is to write the CLI
 * values INTO the matching env vars before loadConfig reads them. Mutation
 * is local to the current process; no child process inherits a different
 * env unless it does so deliberately via child_process.spawn env overrides.
 *
 * Returns a map describing the source of each resolved value, for the
 * startup source-log line requested in the brief.
 *
 * v2.2.1 L2 (Codex audit): source taxonomy widened to `"cli" | "env" |
 * "config" | "default"`. Pre-L2 config-file-won values were mislabeled as
 * "default" because the parser only saw CLI + env layers. We can't know
 * which keys the file sets without reading it here, so we pass a
 * `fileKeys` set (populated by the caller after `loadConfig` reads the
 * file) — keys present in the file AND not overridden by CLI/env are
 * labeled "config" instead of "default".
 */
export type ConfigSource = "cli" | "env" | "config" | "default";

export function applyCliToEnv(
  flags: CliFlags,
  env: NodeJS.ProcessEnv,
  fileKeys: ReadonlySet<string> = new Set()
): Record<string, ConfigSource> {
  const sources: Record<string, ConfigSource> = {};

  const classify = (
    key: string,
    envKey: string,
    cliValue: unknown,
    fileKey: string
  ): ConfigSource => {
    if (cliValue !== undefined) return "cli";
    if (env[envKey]) return "env";
    if (fileKeys.has(fileKey)) return "config";
    return "default";
  };

  if (flags.transport !== undefined) env.RELAY_TRANSPORT = flags.transport;
  sources.transport = classify("transport", "RELAY_TRANSPORT", flags.transport, "transport");

  if (flags.port !== undefined) env.RELAY_HTTP_PORT = String(flags.port);
  sources.http_port = classify("http_port", "RELAY_HTTP_PORT", flags.port, "http_port");

  if (flags.host !== undefined) env.RELAY_HTTP_HOST = flags.host;
  sources.http_host = classify("http_host", "RELAY_HTTP_HOST", flags.host, "http_host");

  if (flags.config !== undefined) env.RELAY_CONFIG_PATH = flags.config;
  sources.config_path = classify(
    "config_path",
    "RELAY_CONFIG_PATH",
    flags.config,
    // `config_path` isn't read from the config file itself (chicken-egg),
    // so fileKeys never contains it. Normal "cli | env | default" logic
    // applies via the classify helper — passing an unreachable fileKey
    // keeps the signature uniform.
    "__unreachable__"
  );

  return sources;
}
