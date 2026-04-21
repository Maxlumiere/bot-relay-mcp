// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.2.0 Phase 4 — webhook DNS TOCTOU fix (bundled Item 7 from v2.1.7 spec).
 *
 * Problem (pre-v2.2.0):
 *   `validateWebhookUrl()` resolves the hostname + runs SSRF checks on every
 *   resolved IP. Then `fetch(url, ...)` re-resolves the hostname at socket
 *   connect time. A fast-flip authoritative DNS server with sub-second TTLs
 *   can return a safe IP on the validate pass and an attacker IP (127.0.0.1,
 *   169.254.169.254, etc.) on the connect pass. The SSRF defense is bypassed
 *   end-to-end.
 *
 * Fix:
 *   This module delivers the POST request over Node's built-in http / https
 *   modules with the TCP connection pinned to an IP the caller already
 *   validated. The `Host:` header still carries the original hostname so
 *   the server-side virtual-host routing works; for HTTPS the `servername`
 *   option keeps SNI + certificate-validation anchored on the original
 *   hostname.
 *
 * No new dependencies. Node's built-in modules already separate "where to
 * connect" from "what to send in the Host header / present in SNI", which
 * is exactly what fetch() collapsed back together. By dropping down one
 * layer we recover the separation.
 *
 * Caveats documented in SECURITY.md:
 *   - When DNS returns multiple IPs (load-balanced targets), we pin to the
 *     first safe IP. Round-robin / failover across replicas is not a
 *     webhook-delivery concern.
 *   - HTTPS certificate validation uses the system trust store via
 *     `tls.connect`'s defaults. Operators who need a custom CA chain for
 *     webhook targets can set `NODE_EXTRA_CA_CERTS`.
 */
import http, { type IncomingMessage, type RequestOptions as HttpRequestOptions } from "http";
import https, { type RequestOptions as HttpsRequestOptions } from "https";
import { URL } from "url";
import { validateWebhookUrl } from "./url-safety.js";

export interface DeliveryResult {
  statusCode: number | null;
  bodyText: string;
  error?: string;
}

export interface DeliveryInput {
  url: string;
  pinnedIp: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

/**
 * v2.2.0 Codex audit M1 — maximum 3xx hops followed before surfacing an
 * error. Matches fetch()'s implicit default (spec'd as 20, but nothing
 * legitimate exceeds 3-5) while keeping attack amplification bounded.
 * Re-validation fires on every hop; an attacker who controls a webhook
 * URL + returns 301 to 169.254.169.254 gets terminated, not followed.
 */
const MAX_REDIRECTS = 5;

/**
 * POST `body` to `url` with the TCP connection pinned to `pinnedIp`.
 *
 * - HTTPS: SNI + cert validation use the URL hostname (servername option).
 * - HTTP: `Host:` header carries the URL hostname; TCP connects to pinnedIp.
 * - v2.2.0 Codex M1: follows 3xx redirects up to MAX_REDIRECTS, re-
 *   validating each redirect target via validateWebhookUrl (SSRF gate) +
 *   re-pinning to the new target's validated IP. Unsafe redirect targets
 *   (private ranges, cloud metadata, etc.) terminate the delivery.
 * - Never throws — any failure surfaces as `{ statusCode: null, error }`.
 */
export async function deliverPinnedPost(input: DeliveryInput): Promise<DeliveryResult> {
  let current: DeliveryInput = input;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await sendOnce(current);
    if (res.error || res.statusCode === null) return res;
    // Only treat 3xx WITH a Location header as a redirect. Others (304
    // Not Modified, etc.) fall through as terminal responses.
    const status = res.statusCode;
    const redirectable = status >= 300 && status < 400 && status !== 304;
    const location = redirectable ? res.locationHeader ?? null : null;
    if (!redirectable || !location) return res;
    if (hop === MAX_REDIRECTS) {
      return {
        statusCode: null,
        bodyText: "",
        error: `too many redirects (> ${MAX_REDIRECTS}) starting at ${input.url}`,
      };
    }
    // Resolve the Location URL relative to the current request URL, then
    // re-validate the new target as if it were a fresh webhook URL. That
    // re-runs the SSRF gate + gives us a fresh pinnedIp from the validated
    // IP set. This is the v2.2.0 M1 invariant: every hop re-enters the
    // same SSRF defense — no implicit trust that "the target redirected
    // us" means the redirect destination is safe.
    let nextUrl: string;
    try {
      nextUrl = new URL(location, current.url).toString();
    } catch (err) {
      return {
        statusCode: null,
        bodyText: "",
        error: `invalid Location header "${location}": ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const safety = await validateWebhookUrl(nextUrl);
    if (!safety.ok) {
      return {
        statusCode: null,
        bodyText: "",
        error: `redirect refused (hop ${hop + 1} → ${nextUrl}): ${safety.reason}`,
      };
    }
    const nextPin = safety.resolvedIps && safety.resolvedIps.length > 0 ? safety.resolvedIps[0] : null;
    if (!nextPin) {
      return {
        statusCode: null,
        bodyText: "",
        error: `redirect refused (hop ${hop + 1} → ${nextUrl}): no validated IP to pin`,
      };
    }
    // Per RFC 7231 / 9110: 301/302/303 SHOULD rewrite POST to GET; 307/308
    // MUST preserve method + body. Webhook semantics expect POST to land
    // at the final endpoint, so we preserve POST across all 3xx codes
    // (matching fetch's behavior for webhook-style flows — operators
    // configuring a 301/302 on a webhook target almost certainly want the
    // POST forwarded, not a silent method rewrite).
    current = {
      url: nextUrl,
      pinnedIp: nextPin,
      headers: current.headers,
      body: current.body,
      timeoutMs: current.timeoutMs,
    };
  }
  // Unreachable — the loop always returns or hits the MAX_REDIRECTS guard.
  return { statusCode: null, bodyText: "", error: "redirect loop exceeded guard (internal)" };
}

interface SingleResult extends DeliveryResult {
  /** Present only when the server returned a Location header (for redirect handling). */
  locationHeader?: string | null;
}

function sendOnce(input: DeliveryInput): Promise<SingleResult> {
  return new Promise((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(input.url);
    } catch (err) {
      resolve({
        statusCode: null,
        bodyText: "",
        error: `invalid URL: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    const isHttps = parsed.protocol === "https:";
    const port = parsed.port
      ? parseInt(parsed.port, 10)
      : isHttps
        ? 443
        : 80;
    const bodyBuf = Buffer.from(input.body, "utf8");
    const mergedHeaders: Record<string, string> = {
      // Explicit Host header covers IP-literal connect targets where Node
      // would otherwise synthesize a Host from the connect address.
      Host: parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname,
      "Content-Length": String(bodyBuf.length),
      ...input.headers,
    };
    const opts: HttpRequestOptions | HttpsRequestOptions = {
      host: input.pinnedIp,
      port,
      method: "POST",
      path: parsed.pathname + parsed.search,
      headers: mergedHeaders,
      // v2.2.0 Phase 4: for HTTPS, SNI + cert validation anchor on the
      // original hostname, NOT the pinned IP. Without this the server
      // would serve the wrong cert and the client would reject (or be
      // fooled by a default vhost cert).
      ...(isHttps ? { servername: parsed.hostname } : {}),
    };
    const requester = isHttps ? https.request : http.request;
    let settled = false;
    const req = requester(opts, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      const loc = res.headers.location;
      const locationHeader = typeof loc === "string" ? loc : Array.isArray(loc) ? loc[0] : null;
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        if (settled) return;
        settled = true;
        resolve({
          statusCode: res.statusCode ?? null,
          bodyText: Buffer.concat(chunks).toString("utf8"),
          locationHeader,
        });
      });
      res.on("error", (err) => {
        if (settled) return;
        settled = true;
        resolve({
          statusCode: null,
          bodyText: "",
          error: err.message,
        });
      });
    });
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      resolve({
        statusCode: null,
        bodyText: "",
        error: err.message,
      });
    });
    // Spec §Phase 4 timeout parity with the prior AbortController path.
    req.setTimeout(input.timeoutMs, () => {
      if (settled) return;
      settled = true;
      try {
        req.destroy(new Error("timeout"));
      } catch {
        /* ignore */
      }
      resolve({
        statusCode: null,
        bodyText: "",
        error: `request timed out after ${input.timeoutMs}ms`,
      });
    });
    req.write(bodyBuf);
    req.end();
  });
}
