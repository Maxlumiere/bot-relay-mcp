// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.5.0 Tether Phase 1 — Part S — central in-process event bus for inbox
 * mutations. The DB write paths (sendMessage, broadcastMessage, getMessages
 * draining pending → read) emit changed-inbox events; the MCP subscription
 * registry consumes them and fans out `notifications/resources/updated` to
 * every subscribed Server instance for `relay://inbox/<agent_name>`.
 *
 * Design notes:
 *   - Module-singleton EventEmitter so db.ts, mcp-subscriptions.ts, and any
 *     future consumer all observe the same stream without explicit wiring.
 *   - String topic 'inbox.changed' carries `{ agent_name }`. Single field is
 *     sufficient — subscribers re-fetch the resource to read fresh state.
 *   - Synchronous emit semantics — listeners see the event during the same
 *     tick the writer fired it. Notification dispatch (over the MCP transport)
 *     is async, but the event-bus hop is not.
 *   - Listeners MUST not throw — uncaught throws would propagate up to the
 *     write path that fired the event. The MCP subscription handler swallows
 *     and logs.
 *   - No back-pressure / queueing — high-volume writes fire one event each.
 *     A future Phase 2 batch-coalescer can subscribe here and re-emit at a
 *     throttled rate without changing producers.
 */
import { EventEmitter } from "node:events";

const bus = new EventEmitter();
// Default of 10 trips on the hot path (HTTP daemon + dashboard ws + several
// stdio sessions). Bump to a sensible ceiling so we don't get
// MaxListenersExceededWarning during normal multi-agent operation.
bus.setMaxListeners(100);

export interface InboxChangedEvent {
  agent_name: string;
  /**
   * Why the inbox changed. Subscribers don't need this for state — they
   * re-fetch the resource — but it's useful for debug logging and for the
   * Tether VSCode extension to choose toast wording.
   */
  reason: "message_received" | "message_read" | "broadcast_received";
}

export function emitInboxChanged(event: InboxChangedEvent): void {
  bus.emit("inbox.changed", event);
}

export function onInboxChanged(handler: (event: InboxChangedEvent) => void): () => void {
  bus.on("inbox.changed", handler);
  // Return an unbinder so callers (per-server subscription registries) can
  // detach cleanly when their owning Server tears down.
  return () => bus.off("inbox.changed", handler);
}

/**
 * Test seam: drop every listener. NEVER call this from production code —
 * only test fixtures invoke it between test cases to avoid cross-test bleed.
 */
export function _resetInboxEventBusForTests(): void {
  bus.removeAllListeners("inbox.changed");
}
