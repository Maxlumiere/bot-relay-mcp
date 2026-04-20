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

function isBlockedIPv6(ip: string): { blocked: boolean; reason?: string } {
  const lower = ip.toLowerCase();
  if (lower === "::1") return { blocked: true, reason: "IPv6 loopback" };
  if (lower === "::") return { blocked: true, reason: "IPv6 zero" };
  if (lower.startsWith("fe80:")) return { blocked: true, reason: "IPv6 link-local (fe80::/10)" };
  if (lower.startsWith("fc") || lower.startsWith("fd")) return { blocked: true, reason: "IPv6 unique local (fc00::/7)" };
  if (lower.startsWith("ff")) return { blocked: true, reason: "IPv6 multicast" };
  if (lower.startsWith("::ffff:")) {
    // IPv4-mapped — extract IPv4 and re-check
    const ipv4 = lower.slice(7);
    return isBlockedIPv4(ipv4);
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
