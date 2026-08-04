// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Shared operator-auth test helper (ADR-0006).
 *
 * Operator-power endpoints (kill-agent, wake-agent, focus-terminal,
 * send-message, set-status, operator-identity, keyring, dashboard-theme) are
 * gated by `operatorAuthCheck`: they require a VERIFIED dashboard secret and
 * have NO loopback bypass. State-changing POSTs additionally require the CSRF
 * double-submit. This helper performs the REAL operator handshake — authenticate
 * with Bearer to obtain the `relay_csrf` cookie, then replay with
 * Bearer + `relay_csrf` cookie + `X-Relay-CSRF` header — so a test drives the
 * shipped auth path instead of bypassing it. Set `RELAY_DASHBOARD_SECRET` to
 * OPERATOR_SECRET (before or after boot; the resolver reads env live) so these
 * calls authenticate.
 */
import http from "http";

// >= 32 chars — the config entropy floor for a dashboard secret.
export const OPERATOR_SECRET = "test-operator-dashboard-secret-0123456789abcd";

export interface RawResponse {
  status: number;
  json: any;
  body: string;
  setCookie: string[];
}

function raw(
  port: number,
  method: string,
  path: string,
  body: string | null,
  headers: Record<string, string | number>,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let b = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (b += c));
      res.on("end", () => {
        const sc = res.headers["set-cookie"] || [];
        let json: any = null;
        try { json = b ? JSON.parse(b) : null; } catch { json = null; }
        resolve({ status: res.statusCode ?? 0, json, body: b, setCookie: Array.isArray(sc) ? sc : [sc] });
      });
    });
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

/**
 * Authenticate via Bearer and capture the CSRF token + cookie header issued by
 * dashboardAuthCheck, for reuse on a subsequent operator POST.
 */
export async function operatorHandshake(
  port: number,
  secret: string = OPERATOR_SECRET,
): Promise<{ csrfToken: string; cookieHeader: string }> {
  const r = await raw(port, "GET", "/dashboard", null, { Authorization: `Bearer ${secret}` });
  let csrf = "";
  let auth = "";
  for (const line of r.setCookie) {
    const c = line.match(/^relay_csrf=([^;]+)/);
    if (c) csrf = decodeURIComponent(c[1]);
    const a = line.match(/^relay_dashboard_auth=([^;]+)/);
    if (a) auth = decodeURIComponent(a[1]);
  }
  const cookieHeader = [auth && `relay_dashboard_auth=${auth}`, csrf && `relay_csrf=${csrf}`]
    .filter(Boolean)
    .join("; ");
  return { csrfToken: csrf, cookieHeader };
}

/** GET an operator endpoint (Bearer only — safe method, no CSRF). */
export function operatorGet(
  port: number,
  path: string,
  opts: { secret?: string; extraHeaders?: Record<string, string> } = {},
): Promise<RawResponse> {
  const secret = opts.secret ?? OPERATOR_SECRET;
  return raw(port, "GET", path, null, { Authorization: `Bearer ${secret}`, ...(opts.extraHeaders ?? {}) });
}

/**
 * POST an operator endpoint through the full shipped gate: Bearer (operatorAuth)
 * + CSRF double-submit. `extraCookies` (e.g. `relay_operator_identity=alice`)
 * are merged into the Cookie header; `extraHeaders` override.
 */
export async function operatorPost(
  port: number,
  path: string,
  body: Record<string, unknown> | null,
  opts: { secret?: string; extraHeaders?: Record<string, string>; extraCookies?: string } = {},
): Promise<RawResponse> {
  const secret = opts.secret ?? OPERATOR_SECRET;
  const { csrfToken, cookieHeader } = await operatorHandshake(port, secret);
  const data = body === null ? null : JSON.stringify(body);
  const cookie = [cookieHeader, opts.extraCookies].filter(Boolean).join("; ");
  const headers: Record<string, string | number> = {
    Authorization: `Bearer ${secret}`,
    "X-Relay-CSRF": csrfToken,
    Cookie: cookie,
    ...(opts.extraHeaders ?? {}),
  };
  if (data != null) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(data);
  }
  return raw(port, "POST", path, data, headers);
}

/** Raw request with arbitrary headers (for negative/harm cases — no auto-auth). */
export function rawRequest(
  port: number,
  method: string,
  path: string,
  body: Record<string, unknown> | null,
  headers: Record<string, string> = {},
): Promise<RawResponse> {
  const data = body === null ? null : JSON.stringify(body);
  const h: Record<string, string | number> = { ...headers };
  if (data != null) {
    h["Content-Type"] = "application/json";
    h["Content-Length"] = Buffer.byteLength(data);
  }
  return raw(port, method, path, data, h);
}
