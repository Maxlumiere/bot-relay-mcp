// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.7 / Tether Phase 3b — durable outbox tail.
 *
 * Problem this solves:
 *   - Each stdio MCP terminal (`node dist/index.js`) is its own OS process.
 *   - The HTTP daemon (`node dist/index.js`, RELAY_TRANSPORT=http) is yet
 *     another process.
 *   - The in-process EventEmitter in src/inbox-events.ts (the "bus") only
 *     reaches listeners inside the SAME process. A message written by a
 *     stdio terminal NEVER fires the HTTP daemon's bus, so MCP subscribers
 *     that connected to the HTTP transport silently miss every cross-
 *     process update.
 *
 * Solution (Codex Option E — durable outbox):
 *   - Producers INSERT into `inbox_events` inside the same SQLite tx as
 *     the underlying message/broadcast row (src/db.ts).
 *   - This tail runs ONLY in the HTTP daemon. It polls `inbox_events`
 *     for rows past its in-memory cursor and dispatches each one to the
 *     same `broadcastInboxChange` function that the in-process bus uses
 *     (src/mcp-subscriptions.ts).
 *   - `broadcastInboxChange` dedups by event id so when sender + subscriber
 *     happen to share the daemon process (bus + tail both observe the
 *     same row), the subscriber receives exactly one notification.
 *
 * Why polling, not LISTEN/NOTIFY:
 *   - SQLite has no NOTIFY. WAL + `PRAGMA data_version` gives us a cheap
 *     change-detector (single uint64 read, no I/O) that we use as a skip
 *     check before the actual SELECT.
 *
 * Cursor lifetime:
 *   - In-memory only. On daemon start, initialized to `MAX(id)` so we
 *     don't replay historical rows. This is intentional: a cold daemon
 *     wakeup should not flood every subscriber with a backlog of
 *     long-since-read events. The producer-side outbox is for
 *     "wake live subscribers", not durable per-subscriber delivery.
 *
 * Per-tick limit + drain loop:
 *   - Each tick SELECTs at most BATCH_LIMIT rows. If we hit the limit,
 *     we immediately re-tick (no setTimeout delay) so a sudden burst
 *     drains within tens of ms instead of one batch per poll interval.
 *
 * Configurable env:
 *   - RELAY_OUTBOX_POLL_MS — polling interval in ms (default 100).
 *   - Setting to 0 disables polling entirely (start() becomes a no-op).
 */

import { getDb } from "./db.js";
import { log } from "./logger.js";
import { broadcastInboxChange } from "./mcp-subscriptions.js";
import { touchMarker } from "./filesystem-marker.js";
import type { InboxChangedEvent } from "./inbox-events.js";

/**
 * SENTINEL MARKER OWNERSHIP — the tail is the SOLE writer of wake markers.
 *
 * Previously `sendMessage` (src/db.ts) touched the marker in-process. That was
 * wrong, and the failure was invisible: `touchMarker` gates on
 * `RELAY_FILESYSTEM_MARKERS` read from *whichever process executes the write*.
 * The daemon sets it; a stdio MCP server does not. Same call site, same
 * mailbox, same instance DB — but a message sent from an MCP peer silently
 * skipped the marker while a `relay send` through the daemon wrote it. Watchers
 * then fell back to polling and looked merely "slow" (measured: 12ms on the
 * event path vs a 3s poll fingerprint).
 *
 * A per-process env check is not a bug you fix once — it returns every time
 * someone adds an execution context. The tail is the only component that
 * observes every commit cross-process, so it is the only place that can
 * honestly claim to see all mail. It also removes the `from === 'system'`
 * blind spot BY CONSTRUCTION: that branch never called `touchMarker` at all,
 * and now it does not need to, because it writes `inbox_events` like every
 * other producer.
 *
 * CONSEQUENCE, stated rather than buried: markers are now a DAEMON-PROVIDED
 * service. A stdio-only deployment with no daemon has no marker writer, so
 * watchers there poll. That is correct and honest — and the end-to-end marker
 * assertion (the companion change) makes it *visible* instead of silent, which
 * is the property that was actually missing.
 *
 * Kept as a single narrow seam so relocating the owner is a move, not a
 * rewrite, if the ADR-0005 review prefers a different one.
 */
function writeWakeMarker(row: OutboxRow): void {
  // `message_read` is the agent draining its OWN mailbox — waking on it would
  // be a self-inflicted wake. Only genuine new-mail reasons signal.
  if (row.reason !== "message_received" && row.reason !== "broadcast_received") return;
  touchMarker(row.agent_name);
}

interface OutboxRow {
  id: number;
  agent_name: string;
  reason: InboxChangedEvent["reason"];
}

const BATCH_LIMIT = 500;

let cursorId = 0;
let timer: NodeJS.Timeout | null = null;
let running = false;
let stopping = false;
let lastDataVersion: number | null = null;

function pollIntervalMs(): number {
  const raw = process.env.RELAY_OUTBOX_POLL_MS;
  if (raw === undefined || raw === "") return 100;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 100;
  return n;
}

function readDataVersion(): number | null {
  try {
    const db = getDb();
    const v = db.pragma("data_version", { simple: true });
    if (typeof v === "number") return v;
    if (typeof v === "bigint") return Number(v);
    return null;
  } catch {
    return null;
  }
}

function tickOnce(): { rowsProcessed: number; hitLimit: boolean } {
  const db = getDb();

  // Cheap skip: if data_version hasn't changed since our last successful
  // poll, no writes have committed and there's nothing to do. data_version
  // bumps on every COMMIT to the underlying DB file, regardless of which
  // process did the writing — so a stdio writer's commit will be visible
  // here as a version bump.
  const dv = readDataVersion();
  if (dv !== null && lastDataVersion !== null && dv === lastDataVersion) {
    return { rowsProcessed: 0, hitLimit: false };
  }

  const rows = db
    .prepare(
      "SELECT id, agent_name, reason FROM inbox_events WHERE id > ? ORDER BY id LIMIT ?",
    )
    .all(cursorId, BATCH_LIMIT) as OutboxRow[];

  if (rows.length === 0) {
    // No rows — but the DB DID change (some other table got written). Record
    // the new data_version so we don't re-SELECT for that same change.
    if (dv !== null) lastDataVersion = dv;
    return { rowsProcessed: 0, hitLimit: false };
  }

  for (const row of rows) {
    // Marker FIRST, and in its own try/catch: it is a best-effort hint, so a
    // marker failure must never cost the row its authoritative subscriber
    // dispatch below. `touchMarker` already swallows its own IO errors; this
    // guard is defence-in-depth against the tail halting on an unexpected throw.
    try {
      writeWakeMarker(row);
    } catch (err: unknown) {
      log.debug(
        `[outbox-tail] marker write threw for row id=${row.id} ` +
        `agent=${row.agent_name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      broadcastInboxChange(row.agent_name, row.reason, row.id, "tail");
    } catch (err: unknown) {
      // broadcastInboxChange's per-subscriber send is async + already catches
      // its own errors. A synchronous throw here would mean the dedup map
      // or log layer blew up; record and continue so one bad row doesn't
      // halt the tail entirely.
      log.warn(
        `[outbox-tail] broadcastInboxChange threw for row id=${row.id} ` +
        `agent=${row.agent_name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    cursorId = row.id;
  }
  if (dv !== null) lastDataVersion = dv;
  return { rowsProcessed: rows.length, hitLimit: rows.length >= BATCH_LIMIT };
}

function scheduleNext(): void {
  if (stopping) return;
  const ms = pollIntervalMs();
  timer = setTimeout(runTick, ms);
  // Don't keep the event loop alive solely on the poll timer — daemon
  // shutdown should be able to exit even if no other handles remain.
  if (timer && typeof timer.unref === "function") timer.unref();
}

function runTick(): void {
  if (stopping) return;
  try {
    const result = tickOnce();
    if (result.hitLimit && !stopping) {
      // Drain immediately on backlog instead of waiting one poll interval.
      // setImmediate yields to other I/O so a sustained backlog doesn't
      // starve the event loop.
      setImmediate(runTick);
      return;
    }
  } catch (err: unknown) {
    log.warn(
      `[outbox-tail] tick failed: ${err instanceof Error ? err.message : String(err)} — will retry next interval`,
    );
  }
  scheduleNext();
}

/**
 * Start the outbox tail. Idempotent — second call no-ops. Initializes the
 * in-memory cursor to MAX(id) so a fresh daemon start does NOT replay every
 * historical row to current subscribers.
 *
 * Call ONLY from the HTTP daemon entry point (src/index.ts). Stdio sessions
 * don't need the tail — they have direct access to the in-process bus for
 * any subscriber that happens to live in the same process, and stdio
 * subscribers from a different process are not a supported topology.
 */
export function startOutboxTail(): void {
  if (running) return;
  if (pollIntervalMs() === 0) {
    log.info("[outbox-tail] disabled (RELAY_OUTBOX_POLL_MS=0)");
    return;
  }
  running = true;
  stopping = false;
  try {
    const db = getDb();
    const row = db
      .prepare("SELECT COALESCE(MAX(id), 0) AS max_id FROM inbox_events")
      .get() as { max_id: number | bigint };
    cursorId = Number(row.max_id);
    lastDataVersion = readDataVersion();
    log.info(
      `[outbox-tail] started; initial cursor=${cursorId}, poll_ms=${pollIntervalMs()}, ` +
      `data_version=${lastDataVersion ?? "n/a"}`,
    );
  } catch (err: unknown) {
    log.warn(
      `[outbox-tail] failed to initialize cursor; starting from 0: ${err instanceof Error ? err.message : String(err)}`,
    );
    cursorId = 0;
  }
  scheduleNext();
}

/**
 * Stop the outbox tail. Cancels any pending timer + flips the stopping flag
 * so an in-flight tick won't reschedule itself. Safe to call multiple times.
 */
export function stopOutboxTail(): void {
  stopping = true;
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/** Test-only: current in-memory cursor. Used by Phase 3d cross-process test. */
export function _currentCursorForTests(): number {
  return cursorId;
}

/** Test-only: reset internal state between cases. */
export function _resetOutboxTailForTests(): void {
  stopOutboxTail();
  cursorId = 0;
  lastDataVersion = null;
}
