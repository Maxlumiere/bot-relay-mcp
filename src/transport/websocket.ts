// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.2.0 Phase 2 — dashboard WebSocket push layer.
 *
 * Mounted on the same http.Server that serves /mcp + /dashboard; takes over
 * the "upgrade" event for requests to /dashboard/ws and leaves every other
 * upgrade path alone.
 *
 * Auth: same semantics as dashboardAuthCheck.
 *   - `RELAY_DASHBOARD_SECRET` (or `RELAY_HTTP_SECRET` as fallback) required
 *     for remote clients.
 *   - Loopback peer (127.0.0.1 / ::1) permitted with no secret — matches the
 *     dev-friendly default on the HTTP surface.
 *   - Secret channels, in precedence order: cookie `relay_dashboard_auth`,
 *     `?auth=<secret>` query, `Sec-WebSocket-Protocol: bearer.<secret>`.
 *     Browsers don't let JS set arbitrary headers on new WebSocket() so
 *     cookie-based or query-based auth are the realistic paths; subprotocol
 *     `bearer.<secret>` is the programmatic escape hatch.
 *
 * Broadcast events:
 *   - `agent.state_changed`
 *   - `message.sent`
 *   - `task.transitioned` (umbrella for task.posted/accepted/completed/rejected/cancelled)
 *   - `channel.posted`
 *
 * Rate limit: max 1 broadcast per 500ms per (event_type, entity_id) tuple —
 * coalesces bursts (e.g. five channel.posted in 100ms → one). Trailing
 * broadcast is dropped, not queued, per spec §Phase 2 ("coalesce bursts").
 *
 * Stateless across daemon restart: no server-side session store. Clients
 * reconnect on their own (spec §Phase 2: exponential backoff on the client).
 */
import { WebSocketServer, type WebSocket } from "ws";
import { timingSafeEqual } from "crypto";
import type { IncomingMessage, Server as HttpServer } from "http";
import { loadConfig } from "../config.js";
import { log } from "../logger.js";
import {
  checkHostHeader,
  checkOrigin,
  parseHostAllowlist,
} from "./boundary-checks.js";

/**
 * v2.2.0 Codex audit H4: broadcasts are metadata-only.
 *
 * Pre-audit shape included `data: Record<string, unknown>` carrying raw
 * webhook payloads + plaintext message.sent content. The dashboard client
 * treats every push as a "something changed — refetch /api/snapshot"
 * signal and ignores the payload entirely; sending the full shape
 * needlessly expanded the blast radius (any log aggregator, any
 * unauthenticated network capture during the WebSocket handshake, or a
 * future WS-surface-broadening bug would have leaked message content).
 *
 * Trimmed to {event, entity_id, ts, kind?}. `kind` is an optional
 * one-word tag ("send_message", "task.accepted", etc.) for clients that
 * want to display "X happened" without looking up details — still free
 * of body content. If we ever need to ship payload-bound broadcasts,
 * introduce a new `DashboardPayloadEvent` shape alongside this one so
 * the metadata-only contract never regresses silently.
 */
export interface DashboardEvent {
  /** High-level event name broadcast to dashboard clients. Stable wire format. */
  event: "agent.state_changed" | "message.sent" | "task.transitioned" | "channel.posted";
  /** Primary entity id used for the rate-limit coalesce key. */
  entity_id: string;
  /** ISO timestamp of the event — always stamped server-side so clients can order. */
  ts: string;
  /** Optional one-word sub-tag (e.g. `"send_message"` or `"task.accepted"`). No body content. */
  kind?: string;
}

const LOOPBACK_PEERS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
  "localhost",
]);

/**
 * v2.2.0: singleton per process. The HTTP transport calls `attachDashboardWs`
 * once at startup; event sources call `broadcastDashboardEvent` on
 * state-change paths. Keeping a single module-scope server instance matches
 * the design of `webhooks.ts` (one fire path, module-scope state).
 */
let wss: WebSocketServer | null = null;
const clients: Set<WebSocket> = new Set();

/** Rate-limit map: (event:entity_id) → last-broadcast epoch ms. */
const lastBroadcastAt = new Map<string, number>();
const BROADCAST_MIN_INTERVAL_MS = 500;

/** Constant-time string compare for shared secrets. */
function timingSafeStringEq(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function extractSecretCandidate(req: IncomingMessage): string | null {
  // 1. Query string ?auth=<secret>
  const url = req.url ?? "";
  const qIdx = url.indexOf("?");
  if (qIdx >= 0) {
    const params = new URLSearchParams(url.slice(qIdx + 1));
    const q = params.get("auth");
    if (q) return q;
  }
  // 2. Cookie relay_dashboard_auth=<secret>
  const cookie = req.headers.cookie;
  if (typeof cookie === "string") {
    const m = cookie.match(/(?:^|;\s*)relay_dashboard_auth=([^;]+)/);
    if (m) return decodeURIComponent(m[1]);
  }
  // 3. Sec-WebSocket-Protocol: bearer.<secret> — programmatic clients that
  //    cannot set cookies (e.g. Node scripts).
  const proto = req.headers["sec-websocket-protocol"];
  if (typeof proto === "string") {
    const parts = proto.split(",").map((s) => s.trim());
    for (const p of parts) {
      if (p.startsWith("bearer.")) return p.slice("bearer.".length);
    }
  }
  return null;
}

/**
 * Gate: is this incoming upgrade allowed to open a dashboard WS session?
 * Exported for testability.
 */
export function dashboardWsAuthOk(req: IncomingMessage): { ok: boolean; reason?: string } {
  const dashboardSecret = process.env.RELAY_DASHBOARD_SECRET || loadConfig().http_secret || null;
  if (!dashboardSecret) {
    // No secret configured — fall back to the loopback-only rule that
    // dashboardAuthCheck applies. Socket-level peer IP is authoritative;
    // Host header is attacker-controllable.
    const peer = (req.socket.remoteAddress || "").toLowerCase();
    if (LOOPBACK_PEERS.has(peer)) return { ok: true };
    return {
      ok: false,
      reason: "dashboard requires a secret for non-loopback clients — set RELAY_DASHBOARD_SECRET or RELAY_HTTP_SECRET",
    };
  }
  const presented = extractSecretCandidate(req);
  if (!presented) {
    return {
      ok: false,
      reason: "dashboard secret required — present via cookie relay_dashboard_auth, ?auth=<secret>, or Sec-WebSocket-Protocol: bearer.<secret>",
    };
  }
  if (!timingSafeStringEq(presented, dashboardSecret)) {
    return { ok: false, reason: "invalid dashboard secret" };
  }
  return { ok: true };
}

/**
 * Attach a WebSocket server to the running http.Server. Hijacks only the
 * /dashboard/ws upgrade path; every other upgrade is left for future
 * transports to handle (currently none).
 */
export function attachDashboardWs(server: HttpServer): void {
  if (wss) {
    log.warn("[dashboard-ws] attachDashboardWs called twice — ignoring duplicate attach");
    return;
  }
  wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws: WebSocket) => {
    log.debug(`[dashboard-ws] client connected, total=${clients.size + 1}`);
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
    // Send a hello so clients can confirm auth + subscribe-loop handshake.
    // setImmediate defers the send one tick so the client's "open" handler
    // has registered its message listener before the frame lands — races
    // have been observed when the client doesn't attach "message" in the
    // same tick as the "open" event.
    setImmediate(() => {
      try {
        ws.send(JSON.stringify({ event: "dashboard.hello", ts: new Date().toISOString() }));
      } catch (err) {
        log.debug(`[dashboard-ws] hello send failed: ${err instanceof Error ? err.message : err}`);
      }
    });
  });

  // v2.2.0 Codex audit H3: Host + Origin allowlists are parsed once at
  // attach time so the per-upgrade check is a pure function call.
  const hostAllowlistOverride = parseHostAllowlist(process.env);
  const config = loadConfig();

  server.on("upgrade", (req, socket, head) => {
    // Only handle /dashboard/ws; ignore other paths to leave room for
    // future transports + to avoid interfering with Node-internal upgrades.
    const url = req.url ?? "";
    const pathOnly = url.split("?")[0];
    log.debug(`[dashboard-ws] upgrade request url="${url}" path="${pathOnly}"`);
    if (pathOnly !== "/dashboard/ws") return;

    // v2.2.0 Codex H3: Host-header check BEFORE auth. DNS-rebinding
    // attempts against /dashboard/ws now get the same 421 signal as the
    // HTTP routes — distinct from 401 so browsers don't retry auth
    // against a wrong Host.
    const hostRes = checkHostHeader(req.headers.host, hostAllowlistOverride);
    if (!hostRes.ok) {
      log.info(`[dashboard-ws] upgrade rejected (host): ${hostRes.reason}`);
      const body = JSON.stringify({ error: "Misdirected Request", host: hostRes.host, reason: hostRes.reason });
      socket.write(
        "HTTP/1.1 421 Misdirected Request\r\n" +
          "Content-Type: application/json\r\n" +
          "Content-Length: " +
          Buffer.byteLength(body) +
          "\r\n\r\n" +
          body
      );
      socket.destroy();
      return;
    }

    // v2.2.0 Codex H3: Origin check too. Browsers always send Origin on
    // cross-origin fetches; non-browser callers (curl, server-to-server)
    // omit it and pass through. The allowlist comes from config, same
    // as the HTTP middleware.
    const originRes = checkOrigin(
      typeof req.headers.origin === "string" ? req.headers.origin : undefined,
      config.allowed_dashboard_origins
    );
    if (!originRes.ok) {
      log.info(`[dashboard-ws] upgrade rejected (origin): ${originRes.reason}`);
      const body = JSON.stringify({ error: "Origin not allowed", origin: originRes.origin });
      socket.write(
        "HTTP/1.1 403 Forbidden\r\n" +
          "Content-Type: application/json\r\n" +
          "Content-Length: " +
          Buffer.byteLength(body) +
          "\r\n\r\n" +
          body
      );
      socket.destroy();
      return;
    }

    const authRes = dashboardWsAuthOk(req);
    if (!authRes.ok) {
      // 401 response + close. No upgrade.
      log.info(`[dashboard-ws] upgrade rejected: ${authRes.reason}`);
      socket.write(
        "HTTP/1.1 401 Unauthorized\r\n" +
          "Content-Type: application/json\r\n" +
          "Content-Length: " +
          Buffer.byteLength(JSON.stringify({ error: "Unauthorized", reason: authRes.reason })) +
          "\r\n\r\n" +
          JSON.stringify({ error: "Unauthorized", reason: authRes.reason })
      );
      socket.destroy();
      return;
    }

    // Accept. Handshake continues to WebSocketServer.handleUpgrade.
    wss!.handleUpgrade(req, socket, head, (ws) => {
      wss!.emit("connection", ws, req);
    });
  });
}

/**
 * Broadcast an event to every connected dashboard client. Rate-limited: at
 * most one broadcast per 500ms per (event, entity_id) tuple. Exceeding that
 * drops the broadcast silently — the next state transition will emit its
 * own fresh broadcast and clients poll-refresh via /api/snapshot if they
 * want canonical state.
 *
 * NEVER throws. Event sources are callbacks from hot paths (send_message,
 * update_task, etc.); a broadcast failure must not escape to the caller.
 */
export function broadcastDashboardEvent(evt: DashboardEvent): void {
  try {
    const key = `${evt.event}:${evt.entity_id}`;
    const now = Date.now();
    const last = lastBroadcastAt.get(key);
    if (last !== undefined && now - last < BROADCAST_MIN_INTERVAL_MS) {
      return;
    }
    lastBroadcastAt.set(key, now);

    // Opportunistic GC — mirrors the rateLimitCheck pattern in http.ts.
    if (lastBroadcastAt.size > 1024) {
      for (const [k, ts] of lastBroadcastAt) {
        if (now - ts > BROADCAST_MIN_INTERVAL_MS * 10) lastBroadcastAt.delete(k);
      }
    }

    if (clients.size === 0) return; // nothing to fan out to
    const line = JSON.stringify(evt);
    for (const ws of clients) {
      try {
        ws.send(line);
      } catch {
        // Per-client send failure removes the client; next upgrade reconnects.
        clients.delete(ws);
      }
    }
  } catch (err) {
    log.warn(
      `[dashboard-ws] broadcast error (swallowed): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Testing-only: clear module-scope state between runs. */
export function _resetDashboardWsForTests(): void {
  for (const ws of clients) {
    try {
      ws.terminate();
    } catch {
      /* ignore */
    }
  }
  clients.clear();
  lastBroadcastAt.clear();
  if (wss) {
    try {
      wss.close();
    } catch {
      /* ignore */
    }
    wss = null;
  }
}

/** Testing-only: read-only view of client + rate-limit counts. */
export function _dashboardWsStateForTests(): { clients: number; rateKeys: number } {
  return { clients: clients.size, rateKeys: lastBroadcastAt.size };
}
