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
// v2.2.0 Phase 5 (bundled v2.1.7 Item 9 — Codex): IP classification CIDRs
// live in src/ip-classifier.ts. This module stays focused on URL parsing
// + DNS resolution; classification is delegated.
import { isBlockedForSsrf } from "./ip-classifier.js";

export interface UrlValidationResult {
  ok: boolean;
  reason?: string;
  resolvedIps?: string[];
}

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

// v2.2.0 Phase 5: the hand-rolled IPv4 octet checks + IPv6 CIDR list that
// lived here pre-consolidation are now in `src/ip-classifier.ts`. The
// `isBlockedForSsrf` import above is the single entry point — all classification
// lives in one file + reuses `src/cidr.ts` for the actual prefix math.

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
  // v2.2.0 Phase 5: classification delegated to src/ip-classifier.ts.
  if (!allowPrivate) {
    for (const ip of ips) {
      const check = isBlockedForSsrf(ip);
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
