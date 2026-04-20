// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import express, { type Request, type Response, type NextFunction } from "express";
import { randomUUID, timingSafeEqual } from "crypto";
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
 * Auth middleware — enforces http_secret if set in config.
 * Accepts Authorization: Bearer <secret> OR X-Relay-Secret: <secret>.
 * Always allows /health (so monitors can ping without credentials).
 *
 * v1.7: supports secret rotation. In addition to http_secret (the primary),
 * http_secrets_previous is a list of secrets accepted during a rotation
 * window. Which secret was used is tagged on the request (for audit).
 */
function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const config = loadConfig();
  if (!config.http_secret) {
    return next();
  }
  if (req.path === "/health") {
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
  app.use(express.json({ limit: process.env.RELAY_HTTP_BODY_LIMIT || "1mb" }));
  app.use(authMiddleware);

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

  // v2.1 Phase 4d (B): DNS-rebinding defense — Host header must match an
  // allowlist. Default: hostname part of the Host header must be a loopback
  // literal (127.0.0.1, localhost, [::1]) regardless of port — this is the
  // right default because we may have been asked to bind on port 0 (random-
  // port test harness) and still need to accept the actual bound port. If
  // RELAY_DASHBOARD_HOSTS is set (comma-separated), match the full
  // `host[:port]` string verbatim against that allowlist instead.
  // Mismatch → 421 Misdirected Request (distinct from 401/403 so browsers/
  // curl don't retry auth handshakes).
  const dashboardHostOverride: Set<string> | null = (() => {
    const raw = process.env.RELAY_DASHBOARD_HOSTS;
    if (!raw || !raw.trim()) return null;
    return new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  })();
  const DEFAULT_LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  const dashboardHostCheck = (req: Request, res: Response, next: NextFunction) => {
    const hostHeader = (req.headers.host || "").toLowerCase();
    let allowed = false;
    if (dashboardHostOverride) {
      allowed = dashboardHostOverride.has(hostHeader);
    } else {
      // Default: strip port, accept if hostname is a loopback literal.
      // Host may be either `host:port` or a bracketed IPv6 `[::1]:port`.
      let hostname = hostHeader;
      const bracket = hostHeader.match(/^\[([^\]]+)\](?::\d+)?$/);
      if (bracket) {
        hostname = `[${bracket[1]}]`;
      } else {
        const idx = hostHeader.lastIndexOf(":");
        if (idx !== -1) hostname = hostHeader.slice(0, idx);
      }
      allowed = DEFAULT_LOOPBACK_HOSTNAMES.has(hostname);
    }
    if (!allowed) {
      res.status(421).json({
        error: "Misdirected Request",
        host: hostHeader,
        hint: "The dashboard does not serve this Host. Set RELAY_DASHBOARD_HOSTS=<comma-list> to allow it.",
      });
      return;
    }
    next();
  };

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
    next();
  };

  app.get("/", dashboardHostCheck, dashboardAuthCheck, originCheck, renderDashboard);
  app.get("/dashboard", dashboardHostCheck, dashboardAuthCheck, originCheck, renderDashboard);
  app.get("/api/snapshot", dashboardHostCheck, dashboardAuthCheck, originCheck, snapshotApi);
  // v2.1 Phase 4b.3: keyring info endpoint. Returns current + known key_ids
  // + per-column legacy-row counts. NEVER exposes raw keys.
  app.get("/api/keyring", dashboardHostCheck, dashboardAuthCheck, originCheck, keyringApi);

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
  });

  return server;
}
