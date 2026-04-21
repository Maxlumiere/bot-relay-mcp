// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.2.0 Phase 5 (bundled v2.1.7 Item 9 from Codex) — single source of truth
 * for IP-address classification across the relay.
 *
 * Before v2.2.0 the classification CIDRs were spread across:
 *   - `src/url-safety.ts` — SSRF block-list for webhook targets. IPv4
 *     hand-rolled octet checks; IPv6 as a CIDR list.
 *   - `src/transport/http.ts` — trusted-proxy detection via
 *     `ipInAnyCidr(peerIp, trustedProxies)` where `trustedProxies` comes
 *     from operator config (NOT a classification; that stays where it is).
 *
 * Codex's v2.1.7 audit flagged this split as a drift risk: adding a new
 * range to the SSRF list required editing url-safety.ts in isolation, and
 * future classification use-cases (dashboard-visible, firewall-exported)
 * would either re-implement or import from the wrong module.
 *
 * This module consolidates every hardcoded classification CIDR in one
 * place. `src/cidr.ts` stays the low-level matcher; `src/url-safety.ts`
 * imports `isBlockedForSsrf` from here; operator-configured trusted-proxy
 * lists remain on the caller side (they're config, not classification).
 *
 * Adding a new blocked range = add one entry in this file. The pre-publish
 * drift-grep guard rejects new CIDR literals anywhere in `src/` outside
 * this module + `src/cidr.ts`.
 */
import net from "net";
import { ipInCidr } from "./cidr.js";

export interface ClassificationResult {
  blocked: boolean;
  /** Stable human-readable reason. Surfaced in SSRF error messages + audit logs. */
  reason?: string;
  /** Which rule matched (CIDR string + category) — exposed for diagnostics. */
  rule?: string;
}

/**
 * Blocked IPv4 ranges for SSRF defense. Ordered by specificity for reason
 * reporting — first match wins. No operational significance to order
 * beyond that; overlapping ranges are fine.
 *
 * Categories mirror RFC 1918 + RFC 3927 + RFC 6598 + AWS/GCP/Azure
 * metadata endpoints. See SECURITY.md § DNS-rebinding defense for
 * why each range is blocked.
 */
const BLOCKED_IPV4_CIDRS: ReadonlyArray<[cidr: string, reason: string]> = [
  ["127.0.0.0/8", "loopback (127.0.0.0/8)"],
  ["10.0.0.0/8", "private (10.0.0.0/8)"],
  ["172.16.0.0/12", "private (172.16.0.0/12)"],
  ["192.168.0.0/16", "private (192.168.0.0/16)"],
  ["169.254.0.0/16", "link-local / cloud metadata (169.254.0.0/16)"],
  ["0.0.0.0/8", "zero (0.0.0.0/8)"],
  ["100.64.0.0/10", "shared address space (100.64.0.0/10)"],
  ["224.0.0.0/4", "multicast (224.0.0.0/4)"],
  ["240.0.0.0/4", "reserved (240.0.0.0/4)"],
];

/**
 * Blocked IPv6 ranges for SSRF defense. Codex's v2.1.7 finding replaced
 * earlier string-prefix checks with real CIDR matching via `src/cidr.ts`;
 * the list is preserved here as the canonical source.
 */
const BLOCKED_IPV6_CIDRS: ReadonlyArray<[cidr: string, reason: string]> = [
  ["::1/128", "IPv6 loopback (::1/128)"],
  ["::/128", "IPv6 unspecified (::/128)"],
  ["fe80::/10", "IPv6 link-local (fe80::/10)"],
  ["fc00::/7", "IPv6 unique local (fc00::/7)"],
  ["ff00::/8", "IPv6 multicast (ff00::/8)"],
  ["64:ff9b::/96", "IPv6 NAT64 synthesis (64:ff9b::/96)"],
  ["2001::/23", "IPv6 IANA special-purpose (2001::/23)"],
  ["2001:db8::/32", "IPv6 documentation (2001:db8::/32, RFC 3849)"],
];

/**
 * Classify an IPv4 address against the SSRF block list. Exported for the
 * IPv4-mapped IPv6 recursion path and for direct callers who already
 * know they have a v4 literal.
 */
export function classifyIPv4(ip: string): ClassificationResult {
  if (!net.isIPv4(ip)) {
    return { blocked: true, reason: `invalid IPv4: "${ip}"`, rule: "invalid" };
  }
  for (const [cidr, reason] of BLOCKED_IPV4_CIDRS) {
    if (ipInCidr(ip, cidr)) return { blocked: true, reason, rule: cidr };
  }
  return { blocked: false };
}

/**
 * Classify an IPv6 address against the SSRF block list. Handles IPv4-
 * mapped IPv6 by delegating to classifyIPv4 with the embedded octets —
 * covered by both dotted-mixed `::ffff:1.2.3.4` and all-hex
 * `::ffff:0102:0304` forms.
 */
export function classifyIPv6(ip: string): ClassificationResult {
  if (!net.isIPv6(ip)) {
    return { blocked: true, reason: `invalid IPv6: "${ip}"`, rule: "invalid" };
  }
  // IPv4-mapped (::ffff:0:0/96) — delegate.
  if (ipInCidr(ip, "::ffff:0:0/96")) {
    const embedded = extractMappedIPv4(ip);
    if (embedded) return classifyIPv4(embedded);
    // Couldn't parse the embedded v4 — block conservatively.
    return {
      blocked: true,
      reason: "IPv4-mapped IPv6 (::ffff:0:0/96) — could not extract embedded IPv4",
      rule: "::ffff:0:0/96",
    };
  }
  for (const [cidr, reason] of BLOCKED_IPV6_CIDRS) {
    if (ipInCidr(ip, cidr)) return { blocked: true, reason, rule: cidr };
  }
  return { blocked: false };
}

/**
 * Unified classifier. Picks family based on `net.isIP`. Safe to call with
 * any string — invalid inputs are reported as blocked.
 */
export function classifyIp(ip: string): ClassificationResult {
  const family = net.isIP(ip);
  if (family === 4) return classifyIPv4(ip);
  if (family === 6) return classifyIPv6(ip);
  return { blocked: true, reason: `invalid IP literal: "${ip}"`, rule: "invalid" };
}

/**
 * Shorthand for SSRF callers that want a boolean + reason. Equivalent to
 * classifyIp but named for readability at webhook-validate + dashboard-
 * focus call sites.
 */
export function isBlockedForSsrf(ip: string): ClassificationResult {
  return classifyIp(ip);
}

/**
 * Helper: pull the embedded IPv4 from an IPv4-mapped IPv6 literal. Handles
 * both `::ffff:a.b.c.d` and `::ffff:abcd:efgh` forms. Returns null for
 * anything that doesn't fit the pattern.
 */
function extractMappedIPv4(ip: string): string | null {
  const lower = ip.toLowerCase().split("%")[0];
  const lastColon = lower.lastIndexOf(":");
  if (lastColon < 0) return null;
  const tail = lower.slice(lastColon + 1);
  // Dotted-mixed form: `::ffff:127.0.0.1`
  if (net.isIPv4(tail)) return tail;
  // All-hex form: `::ffff:7f00:0001` → 127.0.0.1
  if (/^[0-9a-f]{1,4}$/.test(tail) && lastColon >= 2) {
    const prevColon = lower.lastIndexOf(":", lastColon - 1);
    if (prevColon < 0) return null;
    const hi = parseInt(lower.slice(prevColon + 1, lastColon), 16);
    const lo = parseInt(tail, 16);
    if (isNaN(hi) || isNaN(lo)) return null;
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}
