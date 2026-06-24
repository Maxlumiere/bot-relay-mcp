// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.5.0 Tether Phase 1 — Part S — MCP resource subscription registry.
 *
 * Per MCP spec, subscriptions are PER-SESSION: a `subscribe` request binds
 * the calling client's session to a specific resource URI; the server pushes
 * `notifications/resources/updated` for that URI; `unsubscribe` (or session
 * disconnect) drops the binding. We track those bindings here, keyed by URI
 * so the inbox-event consumer can fan out to exactly the Servers that asked.
 *
 * Why a Server-level set, not session-level:
 *   - Each MCP transport (stdio process, HTTP request stream) wraps a single
 *     `Server` instance from `@modelcontextprotocol/sdk`. The SDK already
 *     scopes its `sendResourceUpdated` to the transport bound to that Server.
 *     So holding a Server reference is the unit of "this subscriber".
 *   - Stdio: 1 Server per process, lifetime = process. unsubscribeAllForServer
 *     fires on process exit (transport.onclose).
 *   - HTTP / SSE: 1 Server per active request stream in the StreamableHTTP
 *     wrapper. unsubscribeAllForServer fires on stream close.
 *
 * Cleanup discipline:
 *   - Every server.connect() that wires our handlers MUST also wire onclose
 *     to call unsubscribeAllForServer(server). Failing to do so leaks a
 *     dead Server into the registry — sendResourceUpdated against a closed
 *     transport throws, which we swallow + log, so leaks aren't fatal but
 *     they're observable in the warn logs.
 */
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { log } from "./logger.js";
import { onInboxChanged, type InboxChangedEvent } from "./inbox-events.js";

/**
 * URI builder for a per-agent inbox. Centralized so the resource handler,
 * subscription handler, and emitter all use the exact same shape.
 *
 * Agent names are validated upstream against [A-Za-z0-9_.-]{1,64} (see Zod
 * schemas in src/types.ts), so URI escaping isn't strictly required, but
 * encodeURIComponent keeps us safe if a future regex relaxation slips in
 * without re-auditing this site.
 */
export function inboxUriFor(agentName: string): string {
  return `relay://inbox/${encodeURIComponent(agentName)}`;
}

/**
 * Inverse of inboxUriFor — extract the agent name from a relay://inbox/<x>
 * URI, or null if the URI doesn't match the inbox shape. Returns null on
 * malformed URIs so callers can surface "unknown resource" errors with the
 * standard not-found path instead of crashing.
 */
export function agentNameFromInboxUri(uri: string): string | null {
  if (!uri.startsWith("relay://inbox/")) return null;
  const tail = uri.slice("relay://inbox/".length);
  if (!tail) return null;
  try {
    return decodeURIComponent(tail);
  } catch {
    return null;
  }
}

const subscriptionsByUri = new Map<string, Set<Server>>();
let inboxBusUnbinder: (() => void) | null = null;

/**
 * v2.7 / Tether Phase 3b — per-URI highest event id that has already been
 * broadcast to subscribers. The in-process bus and the cross-process outbox
 * tail both route through {@link broadcastInboxChange}; an event whose id is
 * &le; the recorded high-water mark is dropped. This prevents double-
 * notification when sender and subscriber share a process (bus fires first,
 * then the tail catches up and would otherwise re-broadcast the same row).
 *
 * Why event id and not timestamp:
 *   - `inbox_events.id` is a monotonic SQLite AUTOINCREMENT PK, unique
 *     per DB. Timestamps tie on fast batched writes.
 *   - The tail SELECTs ORDER BY id, so its delivery order is also stable
 *     by id, which makes the &le; comparison correct under all interleavings.
 *
 * Memory growth is bounded by the number of distinct subscribed URIs, which
 * is bounded by the number of registered agents. Entries are dropped when
 * the last subscriber leaves the URI ({@link unsubscribe} +
 * {@link unsubscribeAllForServer}).
 */
const lastBroadcastIdByUri = new Map<string, number>();

// v2.6.x / Tether v0.1.1 Phase 2 — TEMPORARY broadcast-trace instrumentation.
// Goal: surface where the subscribe→emit→fan-out→sendResourceUpdated chain
// breaks during the Tether VS Code smoke (a completion report during dispatch
// surfaced that Phase 1 client-side onerror/onclose never fire — failure is
// below the SDK message-handling layer). Each Server gets a monotonic debug
// tag (S1, S2, …) so daemon stderr can correlate subscribe + per-iteration
// fan-out lines. Tag survives via WeakMap so we don't keep dead Servers
// alive. Remove (or downgrade to debug-level) after the structural fix lands.
let serverDebugCounter = 0;
const serverDebugTags = new WeakMap<Server, string>();
function tagFor(server: Server): string {
  let tag = serverDebugTags.get(server);
  if (!tag) {
    serverDebugCounter += 1;
    tag = `S${serverDebugCounter}`;
    serverDebugTags.set(server, tag);
  }
  return tag;
}

/**
 * v2.7 / Tether Phase 3b — single fan-out path used by BOTH the in-process
 * bus listener (same-process sender + subscriber) and the cross-process
 * outbox tail (the polling loop in src/outbox-tail.ts that drains
 * inbox_events rows produced by stdio writers in a different process).
 *
 * Dedup contract: callers MUST pass `eventId` = the row id from
 * `inbox_events` that produced this change. An event whose id is &le;
 * the per-URI high-water mark is dropped silently. This guarantees that
 * if both the bus and the tail observe the same row (which is the
 * expected case when sender + subscriber share a process), the subscriber
 * receives exactly one `sendResourceUpdated`.
 *
 * Exported so `outbox-tail.ts` can call it directly; tests can call it
 * too if they want to bypass the bus + DB layer.
 */
export function broadcastInboxChange(
  agentName: string,
  reason: InboxChangedEvent["reason"],
  eventId: number,
  source: "bus" | "tail",
): void {
  const uri = inboxUriFor(agentName);
  const last = lastBroadcastIdByUri.get(uri) ?? 0;
  if (eventId <= last) {
    // [broadcast-trace] dedup — second observer of the same row. Common
    // path: bus fires first (same-process), then tail catches up; or
    // tail fires first (cross-process), then bus fires in the daemon for
    // a subscriber that happened to also be local. Either way: drop.
    // v2.7.0 — debug-level (fires on every duplicate; only useful when
    // chasing a specific dedup edge case under RELAY_LOG_LEVEL=debug).
    log.debug(
      `[broadcast-trace] dedup-skip source=${source} agent=${agentName} reason=${reason} ` +
      `event_id=${eventId} last_broadcast_id=${last} uri=${uri}`,
    );
    return;
  }
  lastBroadcastIdByUri.set(uri, eventId);

  // [broadcast-trace] fanout enter — KEPT at info as the load-bearing
  // production observability line for per-event broadcast. Surfaces the
  // (agent, reason, uri, sub count) summary on every fanout — useful
  // for operators verifying their subscriber is receiving notifications
  // without needing debug-level logs.
  const subs = subscriptionsByUri.get(uri);
  log.info(
    `[broadcast-trace] fanout enter source=${source} agent=${agentName} reason=${reason} uri=${uri} ` +
    `event_id=${eventId} total_uris=${subscriptionsByUri.size} subs_for_uri=${subs?.size ?? 0}`,
  );
  if (!subs || subs.size === 0) return;
  for (const server of subs) {
    const tag = tagFor(server);
    // v2.7.0 — debug-level per-subscriber trace.
    log.debug(`[broadcast-trace] notifying server=${tag} uri=${uri}`);
    server.sendResourceUpdated({ uri })
      .then(() => {
        log.debug(`[broadcast-trace] notify accepted server=${tag} uri=${uri}`);
      })
      .catch((err: unknown) => {
        log.warn(
          `[mcp-subscriptions] sendResourceUpdated(${uri}) failed; dropping dead subscriber=${tag}: ${err instanceof Error ? err.message : String(err)}`,
        );
        subs.delete(server);
        if (subs.size === 0) subscriptionsByUri.delete(uri);
      });
  }
}

/**
 * Register an inbox-bus listener once, lazily, the first time anything
 * subscribes. Doing it lazily keeps test fixtures clean — tests that never
 * touch subscriptions don't need to tear down a global handler.
 */
function ensureBusListener(): void {
  if (inboxBusUnbinder) return;
  inboxBusUnbinder = onInboxChanged((event: InboxChangedEvent) => {
    broadcastInboxChange(event.agent_name, event.reason, event.id, "bus");
  });
}

export function subscribe(uri: string, server: Server): void {
  ensureBusListener();
  let set = subscriptionsByUri.get(uri);
  if (!set) {
    set = new Set();
    subscriptionsByUri.set(uri, set);
  }
  set.add(server);
  // v2.7.1 — downgraded to debug per an audit finding: only `fanout
  // enter` stays at info as the
  // load-bearing per-event observability line. `subscribe added`
  // fires once per subscriber lifetime; surface under
  // RELAY_LOG_LEVEL=debug when chasing a specific session.
  log.debug(
    `[broadcast-trace] subscribe added server=${tagFor(server)} uri=${uri} subs_for_uri=${set.size} total_uris=${subscriptionsByUri.size}`,
  );
}

export function unsubscribe(uri: string, server: Server): void {
  const set = subscriptionsByUri.get(uri);
  if (!set) return;
  set.delete(server);
  if (set.size === 0) subscriptionsByUri.delete(uri);
}

/**
 * Drop every subscription for a Server. Call from the transport's onclose
 * handler so a dead session doesn't leak into the registry.
 */
export function unsubscribeAllForServer(server: Server): void {
  for (const [uri, set] of subscriptionsByUri.entries()) {
    if (set.delete(server) && set.size === 0) {
      subscriptionsByUri.delete(uri);
    }
  }
}

/** Test-only: subscriber count for a URI. Used by the Part S test harness. */
export function _subscriberCountForTests(uri: string): number {
  return subscriptionsByUri.get(uri)?.size ?? 0;
}

/** Test-only: drop every subscription + unbind the bus listener. */
export function _resetSubscriptionsForTests(): void {
  subscriptionsByUri.clear();
  lastBroadcastIdByUri.clear();
  if (inboxBusUnbinder) {
    inboxBusUnbinder();
    inboxBusUnbinder = null;
  }
}
