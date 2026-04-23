// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.4.0 Part D.1 — traffic recorder.
 *
 * Env-gated capture of every MCP tool call + response as a JSONL line.
 * Lets operators capture a real traffic snippet, replay it against a
 * future build via `scripts/replay-relay-traffic.ts`, and verify
 * behavioral parity before publishing.
 *
 * Contracts:
 *   - OFF by default. Set `RELAY_RECORD_TRAFFIC=<path>` to enable.
 *   - Never throws. Recording failures log at debug + are swallowed so
 *     a full disk / permission error never breaks the tool call.
 *   - Sensitive fields (tokens, passwords, secrets) redacted at capture
 *     time via `redactArgs` + `redactResponse` helpers. Reuses the
 *     token-field allowlist from existing params_summary redaction.
 *   - Log file is append-only. Operator is responsible for rotation.
 *     Defensive cap: recorder ABORTS cleanly when the log file exceeds
 *     1 GB (guards against runaway disk fill).
 *
 * Format per line:
 *   {ts: ISO8601, tool: string, args: object, response: object,
 *    transport: "stdio"|"http", source_ip: string|null}
 *
 * Replay harness reads the same shape + re-issues each call against a
 * fresh in-memory relay.
 */
import fs from "fs";
import path from "path";
import { log } from "../logger.js";

const MAX_LOG_BYTES = 1024 * 1024 * 1024; // 1 GB

let enabled: boolean | null = null;
let logPath: string | null = null;
let disabledDueToSize = false;

/** Field names whose values must be redacted before capture. */
const REDACT_KEYS: ReadonlySet<string> = new Set([
  "agent_token",
  "token",
  "http_secret",
  "recovery_token",
  "from_agent_token",
  "password",
  "secret",
  "X-From-Agent-Token",
  "plaintext_token",
]);

function isEnabled(): boolean {
  if (enabled !== null) return enabled;
  const raw = process.env.RELAY_RECORD_TRAFFIC;
  if (!raw || raw.length === 0) {
    enabled = false;
    return false;
  }
  logPath = path.resolve(raw);
  // Pre-check: directory exists + writable. Fail-closed on permission
  // problems (still enabled=false, just logs a warn so operators notice).
  try {
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.accessSync(dir, fs.constants.W_OK);
    enabled = true;
  } catch (err) {
    log.warn(
      "[traffic-recorder] RELAY_RECORD_TRAFFIC=" + raw +
        " is not writable; capture disabled: " +
        (err instanceof Error ? err.message : String(err)),
    );
    enabled = false;
  }
  return enabled;
}

/**
 * Deep-redact sensitive fields in-place. Returns a NEW object; the
 * original is untouched (caller may reuse it). Preserves structural
 * shape so replayed calls still parse under the same Zod schemas.
 */
function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (REDACT_KEYS.has(k)) {
        // Preserve shape — just mark the value redacted so replay
        // knows to substitute a test-generated token at replay time.
        out[k] = "<REDACTED>";
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  return value;
}

/**
 * Record one MCP call. No-op when disabled. Never throws.
 */
export function recordCall(entry: {
  tool: string;
  args: unknown;
  response: unknown;
  transport: "stdio" | "http";
  source_ip?: string | null;
}): void {
  if (!isEnabled() || !logPath || disabledDueToSize) return;
  try {
    let size = 0;
    try {
      size = fs.statSync(logPath).size;
    } catch {
      /* file doesn't exist yet — that's fine */
    }
    if (size > MAX_LOG_BYTES) {
      disabledDueToSize = true;
      log.warn(
        "[traffic-recorder] " + logPath +
          " exceeded 1 GB (" + size + " bytes); further capture disabled. " +
          "Rotate the file or unset RELAY_RECORD_TRAFFIC.",
      );
      return;
    }
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      tool: entry.tool,
      args: redact(entry.args),
      response: redact(entry.response),
      transport: entry.transport,
      source_ip: entry.source_ip ?? null,
    }) + "\n";
    // Use openSync + writeSync + fsyncSync so each entry is durable
    // before the tool call returns. Expensive in throughput terms but
    // this is the whole point — replay parity depends on durability.
    const fd = fs.openSync(logPath, "a", 0o600);
    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    log.debug(
      "[traffic-recorder] write failed (swallowed): " +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

/**
 * Reset module-scope cache. Exported for tests only so a test can
 * flip RELAY_RECORD_TRAFFIC and have the recorder pick up the new
 * state without a process restart.
 */
export function _resetTrafficRecorderForTests(): void {
  enabled = null;
  logPath = null;
  disabledDueToSize = false;
}

/** Exported for tests. Returns the redaction helper so fixtures can
 *  assert their sample args get redacted correctly. */
export const _redactForTests = redact;
