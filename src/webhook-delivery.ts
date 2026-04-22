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
  /**
   * Pre-validated IP to connect to. When the caller has multiple safe IPs
   * (DNS returned more than one A/AAAA record for a load-balanced target)
   * use `pinnedIps` instead to get v2.2.1 B5 failover.
   */
  pinnedIp: string;
  /**
   * v2.2.1 B5: full list of validated IPs from `validateWebhookUrl`. When
   * provided, `deliverPinnedPost` tries each in order on connect failure
   * or timeout (max 3 attempts) — recovers load-balanced-target failover
   * that native fetch's internal round-robin previously handled. Each
   * attempt re-uses SNI + Host on the URL hostname; only the connect IP
   * rotates.
   *
   * If both `pinnedIp` and `pinnedIps` are set, `pinnedIps` wins. If only
   * `pinnedIp` is set (pre-B5 callers), behavior is unchanged.
   */
  pinnedIps?: string[];
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
/**
 * v2.2.1 B5: max attempts across validated IPs for a single hop. Cap at 3
 * so the failover window is bounded; load-balanced targets with 10+ IPs
 * don't cause a long retry-storm on total outage.
 */
const MAX_IP_ATTEMPTS = 3;

/**
 * v2.2.1 B5: try the current hop against a list of IPs in order. Returns
 * on the first non-error, non-connect-failure response. Connect-failure
 * and timeout errors trigger failover to the next IP; other errors (TLS
 * cert rejection, server-side 5xx, etc.) return immediately because they
 * aren't fixed by connecting to a sibling replica.
 */
async function sendWithIpFailover(input: DeliveryInput): Promise<SingleResult> {
  const ips =
    input.pinnedIps && input.pinnedIps.length > 0
      ? input.pinnedIps
      : [input.pinnedIp];
  const attempts = Math.min(ips.length, MAX_IP_ATTEMPTS);
  let lastResult: SingleResult = {
    statusCode: null,
    bodyText: "",
    error: "no IPs supplied for delivery",
  };
  for (let i = 0; i < attempts; i++) {
    const attempt = await sendOnce({
      ...input,
      pinnedIp: ips[i],
    });
    lastResult = attempt;
    if (!attempt.error && attempt.statusCode !== null) {
      // Got a real HTTP response — success OR server-side error. Either
      // way, no point trying sibling replicas; the server heard us.
      return attempt;
    }
    // v2.2.1 post-audit (Codex): ONLY retry on clearly pre-connect
    // failures. ECONNRESET used to be on this list but is ambiguous for
    // POST — the peer may have accepted the request body before
    // resetting, so retrying risks at-least-once delivery (duplicate
    // webhooks). Duplicate webhooks are worse than rare one-shot reset
    // losses for operator-run self-hosted tooling (the caller's whole
    // threat model for webhook delivery is "fire-and-forget, best
    // effort"). Pre-connect errors (refused, unreachable, timeouts, DNS
    // retry hints) are safe to retry — the peer never saw the body.
    const err = (attempt.error ?? "").toLowerCase();
    const retryable =
      err.includes("econnrefused") ||
      err.includes("ehostunreach") ||
      err.includes("enetunreach") ||
      err.includes("etimedout") ||
      err.includes("timed out") ||
      err.includes("eai_again");
    if (!retryable) return attempt; // TLS / ECONNRESET / DNS error / etc. — don't loop
  }
  return lastResult;
}

export async function deliverPinnedPost(input: DeliveryInput): Promise<DeliveryResult> {
  let current: DeliveryInput = input;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await sendWithIpFailover(current);
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
    const nextIps = safety.resolvedIps ?? [];
    if (nextIps.length === 0) {
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
    // v2.2.1 B5: propagate the full validated IP list to the next hop so
    // the redirect target's load-balanced replicas also get failover.
    current = {
      url: nextUrl,
      pinnedIp: nextIps[0],
      pinnedIps: nextIps,
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
    // v2.2.3 hotfix (Node 18): req.setTimeout is a SOCKET-level timer —
    // it only fires once a TCP socket exists. On Node 18, pinning to an
    // invalid-route address (e.g. 0.0.0.1 in the B5 test fixture) leaves
    // the kernel in EINPROGRESS indefinitely, the socket never
    // materializes, req.setTimeout never fires, req.on("error") never
    // fires, and sendOnce hangs until GC. Real webhook delivery to a
    // misrouted load-balanced target would block the whole failover loop.
    // Fix: hard JS timer that fires regardless of socket state. Belt +
    // suspenders alongside req.setTimeout (the socket-level timer is
    // still useful when a socket DID connect but then stalled). Every
    // settled-path clears this hard timer so we don't double-resolve.
    const hardTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { req.destroy(new Error("timeout")); } catch { /* ignore */ }
      resolve({
        statusCode: null,
        bodyText: "",
        error: `request timed out after ${input.timeoutMs}ms`,
      });
    }, input.timeoutMs);
    const req = requester(opts, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      const loc = res.headers.location;
      const locationHeader = typeof loc === "string" ? loc : Array.isArray(loc) ? loc[0] : null;
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimer);
        resolve({
          statusCode: res.statusCode ?? null,
          bodyText: Buffer.concat(chunks).toString("utf8"),
          locationHeader,
        });
      });
      res.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimer);
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
      clearTimeout(hardTimer);
      resolve({
        statusCode: null,
        bodyText: "",
        error: err.message,
      });
    });
    // Spec §Phase 4 socket-level timeout parity with the prior
    // AbortController path. Kept alongside the v2.2.3 hard JS timer for
    // the "socket connected but stalled mid-stream" case.
    req.setTimeout(input.timeoutMs, () => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
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
