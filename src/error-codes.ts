// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 4g — stable, machine-readable error codes for tool responses.
 *
 * Every tool that returns `{ success: false, error: "..." }` also returns an
 * `error_code: "<token>"` picked from this catalog. Clients branch on the
 * code (stable across versions) instead of string-matching the `error` text
 * (which we rephrase freely for UX polish).
 *
 * Stability guarantee
 * ───────────────────
 * • Codes here are FOREVER. Never remove or rename within a major version.
 * • Additions are a MINOR-version change (new optional code; old clients
 *   ignore it, new clients branch on it).
 * • Removals / renames are MAJOR — they break every client in the field.
 *
 * Add a new code:
 *   1. Append to ERROR_CODES below with a one-line comment.
 *   2. Wire at least one handler to emit it.
 *   3. Add a test. Add a row in docs/error-codes.md.
 *   4. Consider whether to bump PROTOCOL_VERSION (MINOR) at release time.
 */

export const ERROR_CODES = {
  // Auth + identity ---------------------------------------------------------
  /** Missing / invalid / mismatched agent_token. Includes signature failures. */
  AUTH_FAILED: "AUTH_FAILED",
  /** Caller is authenticated but lacks the capability required by the tool. */
  CAP_DENIED: "CAP_DENIED",
  /** spawn_agent / register_agent where a row with that name already exists. */
  NAME_COLLISION: "NAME_COLLISION",

  // Resource lookup ---------------------------------------------------------
  /** Task / message / channel / agent / webhook not found. */
  NOT_FOUND: "NOT_FOUND",
  /** Creating something that already exists (e.g. create_channel). */
  ALREADY_EXISTS: "ALREADY_EXISTS",

  // Authz on existing resources --------------------------------------------
  /** v2.1 Phase 4k — caller is not from/to_agent on a task they're reading. */
  NOT_PARTY: "NOT_PARTY",
  /** Caller is not a member of the channel they're posting/reading. */
  NOT_MEMBER: "NOT_MEMBER",

  // Validation --------------------------------------------------------------
  /** Zod / shape / format failure. */
  VALIDATION: "VALIDATION",
  /** Exceeds RELAY_MAX_PAYLOAD_BYTES or similar size cap. */
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",

  // State / concurrency -----------------------------------------------------
  /** CAS write lost a race — re-read and retry. */
  CONCURRENT_UPDATE: "CONCURRENT_UPDATE",
  /** State-transition violation (e.g., cancel a completed task). */
  INVALID_STATE: "INVALID_STATE",

  // Rate + capacity ---------------------------------------------------------
  /** Rate-limit bucket exceeded. */
  RATE_LIMITED: "RATE_LIMITED",

  // Network policy ----------------------------------------------------------
  /** v2.1 Phase 4e — webhook URL or DNS resolution in blocked range. */
  SSRF_REFUSED: "SSRF_REFUSED",

  // Schema / version --------------------------------------------------------
  /** v2.1 Phase 4c.3 — import schema_version mismatches relay. */
  SCHEMA_MISMATCH: "SCHEMA_MISMATCH",

  // Daemon state ------------------------------------------------------------
  /** v2.1 Phase 2c — restore refused while relay daemon appears to be running. */
  DAEMON_RUNNING: "DAEMON_RUNNING",

  // Fallback ----------------------------------------------------------------
  /** Unexpected failure. Should be rare; indicates an actual bug. */
  INTERNAL: "INTERNAL",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
