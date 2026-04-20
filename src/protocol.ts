// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 4i — Bot-relay protocol version.
 *
 * Distinct from the package version (src/version.ts). The package version
 * bumps on every ship (patches, docs, release hygiene). The protocol version
 * bumps only when the tool *surface* or wire semantics change.
 *
 * SemVer for the protocol:
 *   MAJOR — breaking: tool removed, required arg added, response shape
 *           narrowed. Old clients cannot work.
 *   MINOR — additive: new tool, new optional arg, new response field.
 *           Old clients ignore the new stuff; still work.
 *   PATCH — behavior fix without surface change. Rare.
 *
 * Change history:
 *   2.0.0  — v2.0 npm release baseline (22 tools, session_id, channels, etc.)
 *   2.1.0  — v2.1 sweep (Stop hook, legacy migration bypass, backup/restore,
 *            dashboard auth, webhook hardening fields, spawn token
 *            passthrough, etc.). All additive — no breaking changes.
 *
 * Surfaced via `register_agent` + `health_check` response payloads so any
 * client can introspect compatibility before issuing tool calls. The relay
 * REPORTS the version; it does NOT enforce client-side checks.
 *
 * Update rule: modify this string ONLY when a new release changes the tool
 * surface. Bump MAJOR for breaking changes, MINOR for additive, PATCH rarely.
 * This file is intentionally the sole authoritative source — the drift-grep
 * in scripts/pre-publish-check.sh allowlists it alongside src/version.ts.
 */
export const PROTOCOL_VERSION: string = "2.1.0";
