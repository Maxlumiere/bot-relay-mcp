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
 * Register an inbox-bus listener once, lazily, the first time anything
 * subscribes. Doing it lazily keeps test fixtures clean — tests that never
 * touch subscriptions don't need to tear down a global handler.
 */
function ensureBusListener(): void {
  if (inboxBusUnbinder) return;
  inboxBusUnbinder = onInboxChanged((event: InboxChangedEvent) => {
    const uri = inboxUriFor(event.agent_name);
    const subs = subscriptionsByUri.get(uri);
    if (!subs || subs.size === 0) return;
    for (const server of subs) {
      // Each Server.sendResourceUpdated() returns a Promise; we don't
      // await — fan-out is best-effort, and one slow client must not
      // block the writer that fired the event. Errors here usually mean
      // the transport closed between subscribe + emit; log + drop the
      // dead subscriber to avoid further noise.
      server.sendResourceUpdated({ uri }).catch((err: unknown) => {
        log.warn(
          `[mcp-subscriptions] sendResourceUpdated(${uri}) failed; dropping dead subscriber: ${err instanceof Error ? err.message : String(err)}`,
        );
        subs.delete(server);
        if (subs.size === 0) subscriptionsByUri.delete(uri);
      });
    }
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
  if (inboxBusUnbinder) {
    inboxBusUnbinder();
    inboxBusUnbinder = null;
  }
}
