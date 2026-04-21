// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.2.0 Codex audit H3 — shared transport-boundary checks.
 *
 * Pre-audit the Host-header allowlist + Origin allowlist lived inline in
 * `startHttpServer` as closures over env + config. The Phase 2 WebSocket
 * upgrade handler never called them, leaving `/dashboard/ws` open to
 * DNS-rebinding + cross-origin attack surfaces that the HTTP routes
 * already closed.
 *
 * This module is the single source of truth for both checks. Pure
 * functions — no Express types, no IncomingMessage globbing, no response
 * writes. Callers (the HTTP middleware chain + the WS upgrade handler)
 * wrap the result into their own transport's error response.
 *
 * Invariant the drift-grep should eventually enforce: these two checks
 * are called from EVERY transport surface that exposes dashboard-shaped
 * endpoints. If a third transport lands (SSE, gRPC-web, etc.) it MUST
 * import from here — no reimplementing the allowlist logic.
 */

/**
 * Default loopback hostnames accepted by the Host-header check when no
 * override is configured. Matches the shipping-default bind of the HTTP
 * transport (127.0.0.1) plus the common IPv6 + hostname variants.
 */
const DEFAULT_LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "[::1]",
]);

/**
 * Strip the port from a Host header value for hostname-only comparison.
 * Handles both `host:port` and bracketed IPv6 `[::1]:port`.
 */
function hostnameOnly(hostHeader: string): string {
  const bracket = hostHeader.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracket) return `[${bracket[1]}]`;
  const idx = hostHeader.lastIndexOf(":");
  return idx === -1 ? hostHeader : hostHeader.slice(0, idx);
}

export interface HostCheckResult {
  ok: boolean;
  /** Human-readable reason when ok=false — stable for incident replay + error responses. */
  reason?: string;
  /** The value inspected, for diagnostics. */
  host?: string;
}

/**
 * Parse the `RELAY_HTTP_ALLOWED_HOSTS` / `RELAY_DASHBOARD_HOSTS` env var
 * pair into a Set. Caller passes the result to `checkHostHeader`; parse
 * at startup and cache, not per-request.
 *
 * Entries can be either full `host:port` (exact match) or hostname-only
 * (match regardless of port — common for random-bind dev setups).
 */
export function parseHostAllowlist(env: NodeJS.ProcessEnv = process.env): Set<string> | null {
  const raw = env.RELAY_HTTP_ALLOWED_HOSTS ?? env.RELAY_DASHBOARD_HOSTS;
  if (!raw || !raw.trim()) return null;
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * Pure Host-header check. Returns `{ ok: true }` when the Host header
 * matches the allowlist (or is a loopback literal when no override set).
 *
 * Mismatch → `{ ok: false, reason }` — the caller is responsible for
 * mapping that to a 421 Misdirected Request response on HTTP or a socket
 * destroy on WebSocket upgrade.
 */
export function checkHostHeader(
  hostHeaderRaw: string | undefined,
  override: Set<string> | null
): HostCheckResult {
  const hostHeader = (hostHeaderRaw ?? "").toLowerCase();
  if (override) {
    if (override.has(hostHeader)) return { ok: true, host: hostHeader };
    const hname = hostnameOnly(hostHeader);
    if (override.has(hname)) return { ok: true, host: hostHeader };
    return {
      ok: false,
      host: hostHeader,
      reason:
        "Host not in RELAY_HTTP_ALLOWED_HOSTS (or legacy alias RELAY_DASHBOARD_HOSTS)",
    };
  }
  // Default: strip port, accept if hostname is a loopback literal.
  const hname = hostnameOnly(hostHeader);
  if (DEFAULT_LOOPBACK_HOSTNAMES.has(hname)) return { ok: true, host: hostHeader };
  return {
    ok: false,
    host: hostHeader,
    reason:
      "Host is not a loopback literal (set RELAY_HTTP_ALLOWED_HOSTS to widen)",
  };
}

export interface OriginCheckResult {
  ok: boolean;
  /** Set to the incoming Origin when ok=true; callers echo back in Access-Control-Allow-Origin. */
  origin?: string;
  reason?: string;
}

/**
 * Match an Origin header against an allowlist pattern.
 * Supported forms (same as the pre-v2.2.0 `matchesOrigin` in http.ts):
 *   - exact: "http://localhost" matches only that exact origin
 *   - port glob: "http://localhost:*" matches any port
 *   - host glob (future): "https://*.example.com" — NOT supported yet
 */
export function matchesOrigin(origin: string, pattern: string): boolean {
  if (pattern === origin) return true;
  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -1); // drop the trailing *
    const remainder = origin.slice(prefix.length);
    return origin.startsWith(prefix) && /^\d+(\/.*)?$/.test(remainder);
  }
  return false;
}

/**
 * Pure Origin check. Requests with no Origin header (curl, server-to-
 * server, etc.) pass through unchanged — browsers always send Origin on
 * cross-origin fetches, so this is the distinguishing signal. Caller is
 * responsible for echoing `origin` in `Access-Control-Allow-Origin` when
 * ok=true (the HTTP middleware does that; WS upgrade doesn't need it).
 */
export function checkOrigin(
  originRaw: string | undefined,
  allowedPatterns: string[]
): OriginCheckResult {
  if (!originRaw) return { ok: true }; // non-browser caller
  const allowed = allowedPatterns.some((pattern) => matchesOrigin(originRaw, pattern));
  if (!allowed) {
    return { ok: false, origin: originRaw, reason: "origin not on allowlist" };
  }
  return { ok: true, origin: originRaw };
}
