// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import express, { type Request, type Response, type NextFunction } from "express";
import { randomUUID, timingSafeEqual, createHmac, randomBytes } from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "../server.js";
import { renderDashboard, snapshotApi, keyringApi } from "../dashboard.js";
import { loadConfig } from "../config.js";
import { log } from "../logger.js";
import { requestContext } from "../request-context.js";
import { ipInAnyCidr } from "../cidr.js";
import { VERSION } from "../version.js";
import { PROTOCOL_VERSION } from "../protocol.js";
import type { Server } from "http";

/**
 * Extract the rate-limit source IP for an incoming request.
 *
 * DEFAULT (no trusted proxies configured): always use the direct socket peer
 * IP. X-Forwarded-For is IGNORED — otherwise any client could spoof the
 * header and bypass rate limits.
 *
 * When trusted_proxies is configured: walk the X-Forwarded-For chain from
 * right to left, skipping entries that fall inside a trusted proxy CIDR.
 * The first untrusted entry (or the direct peer if the whole chain is trusted)
 * is the "real" client IP. This is the leftmost-untrusted-hop rule from
 * RFC 7239 §7.4.
 */
export /**
 * Match an Origin header against an allowlist pattern.
 * Supported forms:
 *   - exact: "http://localhost" matches only that exact origin
 *   - port glob: "http://localhost:*" matches any port
 *   - host glob (future): "https://*.example.com" — NOT supported yet, keep simple
 */
function matchesOrigin(origin: string, pattern: string): boolean {
  if (pattern === origin) return true;
  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -1); // drop the trailing *
    // origin must start with prefix and then have a port number (digits) followed by end or a path
    const remainder = origin.slice(prefix.length);
    return origin.startsWith(prefix) && /^\d+(\/.*)?$/.test(remainder);
  }
  return false;
}

/**
 * Constant-time string equality on UTF-8 byte content. Returns false on any
 * length mismatch (without peeking at content). crypto.timingSafeEqual throws
 * on length-mismatched buffers, so we MUST length-check first. The secret's
 * length is not sensitive (an attacker can already observe response timing /
 * traffic patterns to infer length) — the security goal is to prevent
 * byte-by-byte content leakage, which timingSafeEqual provides post-length.
 */
function timingSafeStringEq(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * v2.1.7 Item 2 (Steph): CSRF token derivation.
 *
 * Stateless double-submit: token is an HMAC-SHA256 of the authenticated
 * dashboard secret under a per-process random salt. Properties that matter:
 *
 *   1. Unforgeable — any attacker without the dashboard secret cannot
 *      predict the token for a given operator session.
 *   2. Process-scoped — a daemon restart rotates the salt, invalidating
 *      previously-issued tokens. Operators re-authenticate; browsers
 *      re-seed the cookie on the next GET.
 *   3. Stateless — no server-side token store to maintain, no TTL state
 *      to reclaim. The `relay_csrf` cookie IS the token; the `X-Relay-CSRF`
 *      header must match it.
 *
 * This is intentionally simpler than session-bound CSRF libraries: the
 * relay is single-tenant + single-operator, so "did this caller present
 * the dashboard secret once" is the only session signal we need.
 */
const CSRF_SALT = randomBytes(32);
export function computeCsrfToken(secret: string): string {
  return createHmac("sha256", CSRF_SALT).update(secret, "utf8").digest("hex");
}

export function extractSourceIp(req: Request, trustedProxies: string[]): string {
  const peer = req.socket.remoteAddress || "unknown";
  if (trustedProxies.length === 0) return peer;

  // Only honor XFF when the DIRECT peer is in our trusted list
  if (!ipInAnyCidr(peer, trustedProxies)) return peer;

  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd !== "string" || fwd.length === 0) return peer;

  // Walk right-to-left, skipping trusted hops. First untrusted wins.
  const chain = fwd.split(",").map((s) => s.trim()).filter(Boolean);
  for (let i = chain.length - 1; i >= 0; i--) {
    const hop = chain[i];
    if (!ipInAnyCidr(hop, trustedProxies)) return hop;
  }
  // Every hop in the chain is trusted — fall back to the direct peer
  return peer;
}

/**
 * v2.1.7 Item 6 (Codex): dashboard paths that bypass the HTTP-secret gate so
 * their own `dashboardAuthCheck` middleware can layer an independent
 * `RELAY_DASHBOARD_SECRET`. Pre-v2.1.7 the authMiddleware rejected any
 * request lacking the HTTP secret before `dashboardAuthCheck` ever ran,
 * making the separate-dashboard-secret feature silently inert.
 *
 * Enumerated exact-match rather than prefix-match so unrelated future /api/*
 * routes that should be HTTP-secret-gated don't silently inherit the bypass.
 * Add new dashboard-auth routes here when they land.
 */
const DASHBOARD_ROUTES_BYPASSING_HTTP_SECRET: ReadonlySet<string> = new Set([
  "/",
  "/dashboard",
  "/api/snapshot",
  "/api/keyring",
]);

/**
 * Auth middleware — enforces http_secret if set in config.
 * Accepts Authorization: Bearer <secret> OR X-Relay-Secret: <secret>.
 * Always allows /health (so monitors can ping without credentials).
 *
 * v1.7: supports secret rotation. In addition to http_secret (the primary),
 * http_secrets_previous is a list of secrets accepted during a rotation
 * window. Which secret was used is tagged on the request (for audit).
 *
 * v2.1.7 Item 6: skips dashboard routes so `dashboardAuthCheck` can apply
 * its own `RELAY_DASHBOARD_SECRET` independently of the HTTP secret.
 */
function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const config = loadConfig();
  if (!config.http_secret) {
    return next();
  }
  if (req.path === "/health") {
    return next();
  }
  // v2.1.7 Item 6: dashboard paths handle auth downstream.
  if (DASHBOARD_ROUTES_BYPASSING_HTTP_SECRET.has(req.path)) {
    return next();
  }

  const authHeader = req.headers.authorization;
  const bearer = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const customHeader = req.headers["x-relay-secret"] as string | undefined;
  const presented = bearer || customHeader;

  if (!presented) {
    res.status(401).json({
      error: "Unauthorized",
      hint: "Set Authorization: Bearer <secret> or X-Relay-Secret: <secret> header. Configure the server with RELAY_HTTP_SECRET env var or http_secret in ~/.bot-relay/config.json.",
    });
    return;
  }

  // Check primary first, then previous (rotation grace).
  // v1.7.1: use crypto.timingSafeEqual to prevent byte-by-byte side-channel
  // leakage of the shared secret. Length mismatch short-circuits (secret-length
  // is operational metadata, not a secret itself). Content comparison is
  // constant-time.
  let secretIdUsed: string | null = null;
  if (timingSafeStringEq(presented, config.http_secret)) {
    secretIdUsed = "primary";
  } else {
    for (let i = 0; i < config.http_secrets_previous.length; i++) {
      if (timingSafeStringEq(presented, config.http_secrets_previous[i])) {
        secretIdUsed = `previous[${i}]`;
        // Attach a rotation hint to response headers so clients see they should
        // upgrade — but do not fail the request.
        res.setHeader("X-Relay-Secret-Deprecated", "true");
        break;
      }
    }
  }

  if (!secretIdUsed) {
    res.status(401).json({
      error: "Unauthorized",
      hint: "Set Authorization: Bearer <secret> or X-Relay-Secret: <secret> header.",
    });
    return;
  }

  // Tag the context so the audit log can record which secret was used.
  (req as any).__secret_id = secretIdUsed;
  next();
}

/**
 * Start an HTTP server that speaks MCP over Streamable HTTP.
 * Each POST to /mcp creates a new stateless transport.
 * Each client gets its own Server instance, all sharing the same SQLite DB.
 */
/**
 * v2.1 Phase 4n (F-3a.9): refuse to start on a non-loopback host without
 * RELAY_HTTP_SECRET set. Default bind is 127.0.0.1 so local-only is safe,
 * but RELAY_HTTP_HOST=0.0.0.0 (or Docker -p mappings) with no secret means
 * anyone reachable on the port can register_agent / register_webhook / etc.
 *
 * Conservative-by-default; explicit opt-in via RELAY_ALLOW_OPEN_PUBLIC=1.
 * Exported for testability.
 */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "::1",
  "localhost",
  "0:0:0:0:0:0:0:1",
  "[::1]",
]);

export function assertBindSafety(host: string, httpSecret: string | null): void {
  const normalized = host.trim().toLowerCase();
  if (LOOPBACK_HOSTS.has(normalized)) return;
  if (httpSecret && httpSecret.length > 0) return;
  if (process.env.RELAY_ALLOW_OPEN_PUBLIC === "1") {
    log.warn(
      `[http] DANGER: binding to "${host}" with NO RELAY_HTTP_SECRET set. Anonymous callers can register agents, create webhooks, and enumerate channels. Continuing only because RELAY_ALLOW_OPEN_PUBLIC=1 is explicitly set. Set RELAY_HTTP_SECRET=<strong-random-string> for production.`
    );
    return;
  }
  throw new Error(
    `Refusing to bind to non-loopback host "${host}" without RELAY_HTTP_SECRET set. ` +
    `Anonymous agent registration + webhook creation on a public port is almost certainly unintentional. ` +
    `Resolve by one of:\n` +
    `  (a) set RELAY_HTTP_SECRET=<strong-random-string> (recommended — full auth/audit pipeline activates), or\n` +
    `  (b) bind to 127.0.0.1 / ::1 (default — local-only), or\n` +
    `  (c) set RELAY_ALLOW_OPEN_PUBLIC=1 to acknowledge the risk and proceed (dev/test only).`
  );
}

export function startHttpServer(port: number, host: string): Server {
  // v2.1 Phase 4n: bind-safety check BEFORE any express setup so we fail
  // fast and never accidentally bind to a risky host.
  const preflightConfig = loadConfig();
  assertBindSafety(host, preflightConfig.http_secret ?? null);

  const app = express();
  // v2.0 final (#14): outer HTTP body limit. Tighter inner limits apply to
  // specific content fields via zod refines — RELAY_MAX_PAYLOAD_BYTES (default
  // 64KB) on message/task content. 1MB here guards against pathological
  // JSON wrappers while still comfortably accommodating bundled tool calls.

  // v2.1.7 Item 3 (Steph): per-IP rate + concurrent-request cap at the
  // transport layer. Existing per-tool-call rate limits (src/server.ts) bucket
  // by agent_name; a noisy anonymous source can still exhaust express
  // middleware + JSON-parse CPU before auth fires. This middleware sits
  // before body-parse so a flooding IP pays the cheapest possible rejection.
  //
  // /health is excluded: monitors should be able to poll the liveness probe
  // without hitting the rate cap (spec-pinned).
  //
  // Defaults:
  //   - 200 requests per rolling 60s per IP (env: RELAY_HTTP_RATE_LIMIT_PER_MINUTE)
  //   - 10 concurrent in-flight requests per IP (env: RELAY_HTTP_MAX_CONCURRENT_PER_IP)
  //
  // Implementation notes: fixed-window counter (cheaper than a sliding window
  // and sufficient for DoS-class flood rejection). Concurrent cap tracked via
  // per-IP active counter incremented on request, decremented on response
  // finish/close. Keyed on the extracted source IP so trusted-proxy XFF rules
  // apply (v1.6 semantics preserved).
  const rateLimitPerMinute = Math.max(
    1,
    parseInt(process.env.RELAY_HTTP_RATE_LIMIT_PER_MINUTE || "200", 10) || 200
  );
  const maxConcurrentPerIp = Math.max(
    1,
    parseInt(process.env.RELAY_HTTP_MAX_CONCURRENT_PER_IP || "10", 10) || 10
  );
  const rateLimitWindowMs = 60_000;
  interface RateBucket {
    count: number;
    windowStart: number;
  }
  const rateBuckets = new Map<string, RateBucket>();
  const activeByIp = new Map<string, number>();

  const configEarly = loadConfig();
  const rateLimitCheck = (req: Request, res: Response, next: NextFunction) => {
    if (req.path === "/health") return next();
    const ip = extractSourceIp(req, configEarly.trusted_proxies);
    const nowMs = Date.now();

    // 1. Fixed-window request-rate counter.
    const bucket = rateBuckets.get(ip);
    if (!bucket || nowMs - bucket.windowStart >= rateLimitWindowMs) {
      rateBuckets.set(ip, { count: 1, windowStart: nowMs });
    } else {
      bucket.count++;
      if (bucket.count > rateLimitPerMinute) {
        const retrySec = Math.max(
          1,
          Math.ceil((rateLimitWindowMs - (nowMs - bucket.windowStart)) / 1000)
        );
        res.setHeader("Retry-After", String(retrySec));
        res.status(429).json({
          error: "Too Many Requests",
          hint: `Rate limit ${rateLimitPerMinute} req/min per IP exceeded. Retry after ${retrySec}s. Raise via RELAY_HTTP_RATE_LIMIT_PER_MINUTE.`,
        });
        return;
      }
    }

    // 2. Concurrent-request cap.
    const active = activeByIp.get(ip) ?? 0;
    if (active >= maxConcurrentPerIp) {
      res.setHeader("Retry-After", "1");
      res.status(429).json({
        error: "Too Many Concurrent Requests",
        hint: `Concurrent cap ${maxConcurrentPerIp} per IP exceeded. Raise via RELAY_HTTP_MAX_CONCURRENT_PER_IP.`,
      });
      return;
    }
    activeByIp.set(ip, active + 1);
    // Decrement on response finish or client abort. Both events always fire
    // exactly once per request lifecycle.
    let decremented = false;
    const decrement = () => {
      if (decremented) return;
      decremented = true;
      const cur = activeByIp.get(ip) ?? 1;
      if (cur <= 1) activeByIp.delete(ip);
      else activeByIp.set(ip, cur - 1);
    };
    res.on("finish", decrement);
    res.on("close", decrement);

    // 3. Garbage-collect stale buckets opportunistically (every 1024 hits).
    if (rateBuckets.size > 1024) {
      for (const [k, v] of rateBuckets) {
        if (nowMs - v.windowStart >= rateLimitWindowMs * 2) rateBuckets.delete(k);
      }
    }

    next();
  };
  app.use(rateLimitCheck);

  app.use(express.json({ limit: process.env.RELAY_HTTP_BODY_LIMIT || "1mb" }));

  const config = loadConfig();

  // Health check (auth-free)
  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      version: VERSION,
      protocol_version: PROTOCOL_VERSION,
      transport: "http",
      auth_required: !!config.http_secret,
    });
  });

  // v1.7: CORS / Origin allow-list check for dashboard routes.
  // A request with an Origin header outside the allowlist is 403'd. Requests
  // without an Origin header (non-browser callers like curl) are allowed.
  const originCheck = (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (!origin) return next(); // non-browser caller
    const allowed = config.allowed_dashboard_origins.some((pattern) => matchesOrigin(origin, pattern));
    if (!allowed) {
      res.status(403).json({ error: "Origin not allowed", origin });
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    next();
  };

  // v2.1 Phase 4d (B) — DNS-rebinding defense, widened in v2.1.7 (Steph): Host
  // header must match an allowlist on EVERY HTTP route, not just the dashboard
  // surface. Pre-v2.1.7 this gate only fired on /, /dashboard, /api/snapshot,
  // /api/keyring — leaving /mcp open to browser-side DNS-rebinding attacks
  // that reach loopback via a malicious page. v2.1.7 applies the same check
  // to /mcp (both POST and GET). See SECURITY.md § DNS-rebinding defense.
  //
  // Default: hostname part of the Host header must be a loopback literal
  // (127.0.0.1, localhost, [::1]) regardless of port — correct for the
  // random-port test harness (bind on :0) and for the shipping default bind.
  //
  // Override precedence (both accepted; canonical is the v2.1.7 name):
  //   1. RELAY_HTTP_ALLOWED_HOSTS (v2.1.7+, canonical)
  //   2. RELAY_DASHBOARD_HOSTS    (v2.1 Phase 4d, backward-compat alias)
  //
  // Mismatch → 421 Misdirected Request (distinct from 401/403 so browsers/
  // curl don't retry auth handshakes).
  //
  // /health is excluded: monitors often probe with a plain IP:port Host and
  // rejecting them adds no security (endpoint is read-only + surfaces nothing
  // sensitive).
  const hostAllowlistOverride: Set<string> | null = (() => {
    // v2.1.7: canonical env var. Falls back to the pre-v2.1.7 name for
    // existing deployments — documented in SECURITY.md + HANDOFF.md.
    const raw =
      process.env.RELAY_HTTP_ALLOWED_HOSTS ?? process.env.RELAY_DASHBOARD_HOSTS;
    if (!raw || !raw.trim()) return null;
    return new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  })();
  const DEFAULT_LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  // Strip port from a Host header for hostname-only comparison.
  // Handles both `host:port` and bracketed IPv6 `[::1]:port`.
  const hostnameOnly = (hostHeader: string): string => {
    const bracket = hostHeader.match(/^\[([^\]]+)\](?::\d+)?$/);
    if (bracket) return `[${bracket[1]}]`;
    const idx = hostHeader.lastIndexOf(":");
    return idx === -1 ? hostHeader : hostHeader.slice(0, idx);
  };
  const httpHostCheck = (req: Request, res: Response, next: NextFunction) => {
    if (req.path === "/health") return next();
    const hostHeader = (req.headers.host || "").toLowerCase();
    let allowed = false;
    if (hostAllowlistOverride) {
      // v2.1.7 refinement: operators often write `RELAY_HTTP_ALLOWED_HOSTS=
      // dashboard.example.com` without a port (port is selected by the bind,
      // not by policy). Accept EITHER full `host:port` verbatim match OR a
      // hostname-only entry matching the stripped Host hostname. Strict
      // operators can still pin to exact host:port by including the port.
      if (hostAllowlistOverride.has(hostHeader)) {
        allowed = true;
      } else {
        const hname = hostnameOnly(hostHeader);
        if (hostAllowlistOverride.has(hname)) allowed = true;
      }
    } else {
      // Default: strip port, accept if hostname is a loopback literal.
      allowed = DEFAULT_LOOPBACK_HOSTNAMES.has(hostnameOnly(hostHeader));
    }
    if (!allowed) {
      res.status(421).json({
        error: "Misdirected Request",
        host: hostHeader,
        hint:
          "This relay does not serve this Host. Set RELAY_HTTP_ALLOWED_HOSTS=<comma-list> " +
          "(or the legacy alias RELAY_DASHBOARD_HOSTS) to allow it.",
      });
      return;
    }
    next();
  };
  // v2.1.7: apply globally so every HTTP route (including /mcp) is gated.
  // Pre-v2.1.7 this was only wired per-route on the dashboard paths.
  // Ordered BEFORE authMiddleware so DNS-rebinding attempts get a 421
  // regardless of HTTP secret state — 421 is distinct from 401/403 so
  // browsers/curl do not retry an auth handshake against a wrong Host.
  app.use(httpHostCheck);
  app.use(authMiddleware);

  // v2.1 Phase 4d (A): dashboard auth gate. Priority:
  //   1. RELAY_DASHBOARD_SECRET (dedicated)
  //   2. RELAY_HTTP_SECRET (fallback — operators with an HTTP secret get
  //      dashboard auth for free)
  //   3. No secret + loopback host → dev-friendly allow
  //   4. No secret + non-loopback host → 403 with hint
  // Secret presentation channels: Authorization: Bearer <s>, ?auth=<s>, or
  // cookie `relay_dashboard_auth=<s>`. All constant-time compared.
  const dashboardAuthCheck = (req: Request, res: Response, next: NextFunction) => {
    const dashboardSecret = process.env.RELAY_DASHBOARD_SECRET || config.http_secret || null;
    if (!dashboardSecret) {
      // No secret configured. Loopback → allow; non-loopback → refuse.
      // Treat the socket peer as authoritative over Host header (Host is
      // attacker-controllable; socket IP is not).
      const peerIp = (req.socket.remoteAddress || "").toLowerCase();
      const peerIsLoopback = peerIp === "127.0.0.1" || peerIp === "::1" || peerIp === "::ffff:127.0.0.1" || peerIp === "localhost";
      if (peerIsLoopback) return next();
      res.status(403).json({
        error: "Dashboard requires a secret",
        hint: "Set RELAY_DASHBOARD_SECRET=<strong-random-string> (or RELAY_HTTP_SECRET) to expose the dashboard on a non-loopback bind.",
      });
      return;
    }
    // A secret IS configured — require it.
    const headerAuth = req.headers.authorization;
    let presented: string | null = null;
    if (headerAuth && headerAuth.toLowerCase().startsWith("bearer ")) {
      presented = headerAuth.slice(7).trim();
    }
    if (!presented) {
      const q = req.query.auth;
      if (typeof q === "string" && q.length > 0) presented = q;
    }
    if (!presented) {
      const cookieHeader = req.headers.cookie;
      if (typeof cookieHeader === "string") {
        const match = cookieHeader.match(/(?:^|;\s*)relay_dashboard_auth=([^;]+)/);
        if (match) presented = decodeURIComponent(match[1]);
      }
    }
    if (!presented || !timingSafeStringEq(presented, dashboardSecret)) {
      res.status(401).json({
        error: "Dashboard secret required",
        hint: "Present via `Authorization: Bearer <secret>`, `?auth=<secret>`, or cookie `relay_dashboard_auth=<secret>`.",
      });
      return;
    }
    // v2.1.7 Item 2 (Steph): on successful auth, (re-)issue BOTH cookies with
    // hardened attributes:
    //   - relay_dashboard_auth: HttpOnly + SameSite=Strict + Path=/
    //     (+ Secure only when RELAY_TLS_ENABLED=1 so local http-only dev
    //      browsers still get the cookie; prod TLS deployments opt in).
    //   - relay_csrf: a random double-submit token, SameSite=Strict + Path=/
    //     but NOT HttpOnly (client JS must read it to set the
    //     X-Relay-CSRF header on state-changing requests).
    // These are refreshed on every successful auth so attributes are always
    // current even if the operator originally seeded the cookie manually.
    // No application-level state change beyond the cookie write — pure HTTP.
    const tlsOn = process.env.RELAY_TLS_ENABLED === "1";
    const secureFlag = tlsOn ? "; Secure" : "";
    const authCookie =
      `relay_dashboard_auth=${encodeURIComponent(presented)}` +
      `; Path=/; HttpOnly; SameSite=Strict${secureFlag}`;
    // Derive a deterministic CSRF token from the authenticated session
    // (HMAC over the presented secret + a rotating per-process salt). Keeps
    // the middleware stateless — no CSRF store to maintain — while still
    // meeting the double-submit contract: cookie + header must agree, and
    // neither side can be forged without knowing the dashboard secret.
    const csrfToken = computeCsrfToken(presented);
    const csrfCookie =
      `relay_csrf=${encodeURIComponent(csrfToken)}` +
      `; Path=/; SameSite=Strict${secureFlag}`;
    // res.setHeader overwrites; use res.append to preserve other Set-Cookies.
    const existing = res.getHeader("Set-Cookie");
    if (existing === undefined) {
      res.setHeader("Set-Cookie", [authCookie, csrfCookie]);
    } else if (Array.isArray(existing)) {
      res.setHeader("Set-Cookie", [...existing, authCookie, csrfCookie]);
    } else {
      res.setHeader("Set-Cookie", [String(existing), authCookie, csrfCookie]);
    }
    next();
  };

  // v2.1.7 Item 2 (Steph) — CSRF double-submit check. Applies to unsafe
  // methods (POST/PUT/DELETE/PATCH) on /api/* paths. Pre-v2.2 there are no
  // such endpoints; the middleware ships as infrastructure so every new
  // state-changing dashboard endpoint shipped in v2.2 is safe-by-construction.
  // Defensive no-op on safe methods (GET/HEAD/OPTIONS) and non-/api paths.
  //
  // Enforcement: both the cookie `relay_csrf` and the header `X-Relay-CSRF`
  // must be present AND match via constant-time compare. Cookie is set by
  // dashboardAuthCheck on successful auth; header is set by dashboard JS
  // before issuing the unsafe request. Attacker pages on a third-party
  // origin cannot forge the header (SameSite=Strict prevents the cookie
  // from being sent, and the header must be a custom value the attacker
  // cannot read).
  const UNSAFE_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "DELETE", "PATCH"]);
  const csrfCheck = (req: Request, res: Response, next: NextFunction) => {
    if (!UNSAFE_METHODS.has(req.method)) return next();
    if (!req.path.startsWith("/api/")) return next();
    const cookieHeader = req.headers.cookie;
    let cookieToken: string | null = null;
    if (typeof cookieHeader === "string") {
      const match = cookieHeader.match(/(?:^|;\s*)relay_csrf=([^;]+)/);
      if (match) cookieToken = decodeURIComponent(match[1]);
    }
    const headerToken = req.headers["x-relay-csrf"];
    const headerTokenStr = typeof headerToken === "string" ? headerToken : null;
    if (!cookieToken || !headerTokenStr || !timingSafeStringEq(cookieToken, headerTokenStr)) {
      res.status(403).json({
        error: "CSRF token missing or mismatched",
        hint:
          "State-changing dashboard endpoints require the `X-Relay-CSRF` header " +
          "to match the `relay_csrf` cookie (double-submit). Authenticate via /dashboard " +
          "first to receive the cookie, then mirror its value in the header.",
      });
      return;
    }
    next();
  };
  // Wire globally — middleware internally gates on method + path.
  app.use(csrfCheck);

  // v2.1.7 Item 1: httpHostCheck is now applied globally via app.use above,
  // so per-route wiring drops it. dashboardAuthCheck + originCheck stay.
  app.get("/", dashboardAuthCheck, originCheck, renderDashboard);
  app.get("/dashboard", dashboardAuthCheck, originCheck, renderDashboard);
  app.get("/api/snapshot", dashboardAuthCheck, originCheck, snapshotApi);
  // v2.1 Phase 4b.3: keyring info endpoint. Returns current + known key_ids
  // + per-column legacy-row counts. NEVER exposes raw keys.
  app.get("/api/keyring", dashboardAuthCheck, originCheck, keyringApi);

  // Stateless MCP endpoint — new transport + server per request
  app.post("/mcp", async (req: Request, res: Response) => {
    const sourceIp = extractSourceIp(req, config.trusted_proxies);
    const authenticated = !!config.http_secret; // authMiddleware already enforced if set
    const headerAgentToken = (req.headers["x-agent-token"] as string | undefined) || undefined;
    await requestContext.run(
      { sourceIp, authenticated, transport: "http", headerAgentToken },
      async () => {
        try {
          const server = createServer();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined, // stateless
          });

          res.on("close", () => {
            transport.close().catch(() => {});
          });

          await server.connect(transport);
          await transport.handleRequest(req, res, req.body);
        } catch (err) {
          log.error("[http] Error handling MCP request:", err);
          if (!res.headersSent) {
            res.status(500).json({
              jsonrpc: "2.0",
              error: {
                code: -32603,
                message: "Internal server error",
              },
              id: null,
            });
          }
        }
      }
    );
  });

  // GET /mcp is not supported in stateless mode (no SSE stream)
  app.get("/mcp", (_req: Request, res: Response) => {
    res.status(405).json({
      error: "Method not allowed. Stateless mode does not support server-initiated streams.",
    });
  });

  const server = app.listen(port, host, () => {
    log.info(`HTTP server listening on http://${host}:${port}`);
    log.info(`  MCP endpoint: POST http://${host}:${port}/mcp`);
    log.info(`  Health check: GET http://${host}:${port}/health`);
    log.info(`  Dashboard:    GET http://${host}:${port}/`);
    if (config.http_secret) log.info(`  Auth: required (Bearer token or X-Relay-Secret header)`);
    // v2.1.3 (I16): clarify the stdio/http process boundary so operators
    // don't misattribute post-restart symptoms. Restarting THIS daemon
    // never affects Claude Code stdio MCP clients — they each run their
    // own `node dist/index.js` process. Only `"type":"http"` MCP clients
    // pointed at this URL lose their connection across a restart.
    log.info(
      `  NOTE: stdio MCP clients (each Claude Code terminal with "type":"stdio" in ~/.claude.json spawns its own server process) are process-independent from this daemon. Restarting this daemon does NOT affect them; operator /mcp reconnect is only needed for "type":"http" MCP clients pointed at ${host}:${port}. See docs/transport-architecture.md.`
    );
  });

  return server;
}
