// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * URL safety validation for webhook URLs.
 * Blocks SSRF attacks against private networks, cloud metadata endpoints,
 * and non-HTTP(S) schemes.
 */

import { promises as dns } from "dns";
import net from "net";
import { ipInCidr } from "./cidr.js";

export interface UrlValidationResult {
  ok: boolean;
  reason?: string;
  resolvedIps?: string[];
}

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/**
 * Validates that an IPv4 string is NOT in any private/loopback/link-local range
 * or cloud metadata endpoint.
 */
function isBlockedIPv4(ip: string): { blocked: boolean; reason?: string } {
  const parts = ip.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return { blocked: true, reason: "invalid IPv4" };
  }
  const [a, b] = parts;

  if (a === 127) return { blocked: true, reason: "loopback (127.0.0.0/8)" };
  if (a === 10) return { blocked: true, reason: "private (10.0.0.0/8)" };
  if (a === 192 && b === 168) return { blocked: true, reason: "private (192.168.0.0/16)" };
  if (a === 172 && b >= 16 && b <= 31) return { blocked: true, reason: "private (172.16.0.0/12)" };
  if (a === 169 && b === 254) return { blocked: true, reason: "link-local / cloud metadata (169.254.0.0/16)" };
  if (a === 0) return { blocked: true, reason: "zero (0.0.0.0/8)" };
  if (a === 100 && b >= 64 && b <= 127) return { blocked: true, reason: "shared address space (100.64.0.0/10)" };
  if (a >= 224) return { blocked: true, reason: "multicast/reserved (>=224.0.0.0)" };

  return { blocked: false };
}

/**
 * v2.1.7 Item 5 (Codex) — replaces prior string-prefix IPv6 classification
 * with real CIDR matching via `src/cidr.ts`. The pre-v2.1.7 implementation
 * gated link-local on `startsWith('fe80:')`, missing the rest of the fe80::/10
 * range (fe90::, fea0::, feb0::, ...); Codex confirmed a monkey-patched
 * `dns.lookup` returning `fe90::1` passed validation and let a webhook fire
 * against a link-local address on the operator's network segment. Real CIDR
 * matching closes that bypass + makes future rule additions one-line.
 *
 * Each `[cidr, reason]` pair is evaluated in order; first match wins. The
 * IPv4-mapped prefix is handled specially — we extract the embedded IPv4
 * and recurse into the v4 rule set so IPv4 policies apply uniformly.
 *
 * Order matters only for reason-reporting precedence (e.g. loopback before
 * the broader unique-local range, so ::1 reports as "IPv6 loopback" not
 * "IPv6 documentation range"). Coverage, not exclusion, is what matters for
 * security — overlapping CIDRs are fine.
 *
 * Covered ranges (per Codex spec):
 *   - ::1/128           loopback
 *   - ::/128            unspecified (v2.1.x earlier caught only exact "::"
 *                       via lowercase string equality; /128 CIDR is the
 *                       equivalent with no room for compression-form drift)
 *   - fe80::/10         link-local (the core fix)
 *   - fc00::/7          unique local (was prefix-based: startsWith fc/fd)
 *   - ff00::/8          multicast (was prefix-based: startsWith ff)
 *   - ::ffff:0:0/96     IPv4-mapped (delegated to IPv4 classifier)
 *   - 64:ff9b::/96      NAT64 — RFC 6052 well-known prefix. Traffic crosses
 *                       the IPv4 internet on the other side of the 64:ff9b
 *                       gateway; treat as public-but-untrusted for webhook
 *                       destinations.
 *   - 2001::/23         IANA special-purpose block (Teredo 2001::/32,
 *                       documentation 2001:db8::/32, ORCHIDv2, benchmarking,
 *                       etc.). Public IPv6 in 2003::/16, 2400::/12, 2600::/12,
 *                       2a00::/12 etc. is NOT blocked — those are genuine
 *                       globally-routed ranges.
 */
const BLOCKED_IPV6_CIDRS: ReadonlyArray<[cidr: string, reason: string]> = [
  ["::1/128", "IPv6 loopback (::1/128)"],
  ["::/128", "IPv6 unspecified (::/128)"],
  ["fe80::/10", "IPv6 link-local (fe80::/10)"],
  ["fc00::/7", "IPv6 unique local (fc00::/7)"],
  ["ff00::/8", "IPv6 multicast (ff00::/8)"],
  ["64:ff9b::/96", "IPv6 NAT64 synthesis (64:ff9b::/96)"],
  ["2001::/23", "IPv6 IANA special-purpose (2001::/23)"],
  // 2001:db8::/32 is separately allocated for documentation (RFC 3849) and
  // sits OUTSIDE 2001::/23 — a webhook URL resolving into it is almost
  // certainly misconfigured or malicious. Blocking keeps the IPv6 policy
  // consistent with the IPv4 classifier (which rejects 169.254.0.0/16 etc.).
  ["2001:db8::/32", "IPv6 documentation (2001:db8::/32, RFC 3849)"],
];

function isBlockedIPv6(ip: string): { blocked: boolean; reason?: string } {
  // IPv4-mapped (::ffff:0:0/96) → delegate to the IPv4 classifier so both
  // families share one policy. Covered via the cidr module's mapped-form
  // normalizer + all-hex `::ffff:0102:0304` form.
  if (ipInCidr(ip, "::ffff:0:0/96")) {
    // Parse the embedded IPv4 from either dotted-decimal `::ffff:1.2.3.4`
    // or all-hex `::ffff:0102:0304`.
    const lower = ip.toLowerCase().split("%")[0];
    let embedded: string | null = null;
    const lastColon = lower.lastIndexOf(":");
    if (lastColon >= 0) {
      const tail = lower.slice(lastColon + 1);
      if (net.isIPv4(tail)) {
        embedded = tail;
      } else if (/^[0-9a-f]{1,4}$/.test(tail) && lastColon >= 2) {
        const prevColon = lower.lastIndexOf(":", lastColon - 1);
        if (prevColon >= 0) {
          const hi = parseInt(lower.slice(prevColon + 1, lastColon), 16);
          const lo = parseInt(tail, 16);
          if (!isNaN(hi) && !isNaN(lo)) {
            embedded = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
          }
        }
      }
    }
    if (embedded && net.isIPv4(embedded)) return isBlockedIPv4(embedded);
    // Fall through: if we can't extract the embedded v4, block conservatively.
    return { blocked: true, reason: "IPv4-mapped IPv6 (::ffff:0:0/96) — unable to extract embedded IPv4" };
  }
  for (const [cidr, reason] of BLOCKED_IPV6_CIDRS) {
    if (ipInCidr(ip, cidr)) return { blocked: true, reason };
  }
  return { blocked: false };
}

/**
 * Validates a webhook URL is safe to call.
 * Resolves DNS at validation time (not delivery time) to prevent rebinding.
 *
 * Set RELAY_ALLOW_PRIVATE_WEBHOOKS=1 to bypass private-IP checks
 * (e.g. for local n8n at http://127.0.0.1:5678).
 */
export async function validateWebhookUrl(rawUrl: string): Promise<UrlValidationResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "URL is malformed" };
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return { ok: false, reason: `scheme '${parsed.protocol}' not allowed (only http: and https:)` };
  }

  if (!parsed.hostname) {
    return { ok: false, reason: "URL has no hostname" };
  }

  // Allow operators to opt-in to private webhooks (local n8n, etc.)
  const allowPrivate = process.env.RELAY_ALLOW_PRIVATE_WEBHOOKS === "1";

  // Resolve hostname to IPs. If hostname is already an IP literal, skip DNS.
  let ips: string[] = [];
  if (net.isIP(parsed.hostname)) {
    ips = [parsed.hostname];
  } else {
    try {
      const records = await dns.lookup(parsed.hostname, { all: true });
      ips = records.map((r) => r.address);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `DNS lookup failed: ${msg}` };
    }
  }

  if (ips.length === 0) {
    return { ok: false, reason: "no IPs resolved for hostname" };
  }

  // Reject if ANY resolved IP is blocked (most restrictive — defends DNS rebinding).
  if (!allowPrivate) {
    for (const ip of ips) {
      const family = net.isIP(ip);
      const check = family === 6 ? isBlockedIPv6(ip) : isBlockedIPv4(ip);
      if (check.blocked) {
        return {
          ok: false,
          reason: `resolved IP ${ip} is in blocked range: ${check.reason}. Set RELAY_ALLOW_PRIVATE_WEBHOOKS=1 to allow private targets (e.g. local n8n).`,
          resolvedIps: ips,
        };
      }
    }
  }

  return { ok: true, resolvedIps: ips };
}
