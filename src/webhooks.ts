// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import {
  getWebhooksForEvent,
  logWebhookDelivery,
  scheduleWebhookRetry,
  claimDueWebhookRetries,
  recordWebhookRetryOutcome,
  terminateWebhookRetry,
} from "./db.js";
import { loadConfig } from "./config.js";
import { log } from "./logger.js";
import type { WebhookEvent } from "./types.js";
import { VERSION } from "./version.js";
import { validateWebhookUrl } from "./url-safety.js";
import { broadcastDashboardEvent, type DashboardEvent } from "./transport/websocket.js";
import { deliverPinnedPost } from "./webhook-delivery.js";

export interface WebhookPayload {
  event: WebhookEvent;
  timestamp: string;
  /** v2.1 Phase 4e: uuidv4 assigned at initial fire; stable across retries (payload is stored verbatim). Recipients dedupe on this. */
  delivery_id: string;
  /**
   * v2.1 Phase 4e: stable per-underlying-event identifier. Derived as
   * `<event>:<from>:<to>:<resource_id>` where resource_id is the most
   * specific ID present (message_id / task_id / channel_name / timestamp).
   * Recipients dedupe AND correlate related retries on this.
   */
  idempotency_key: string;
  from_agent?: string;
  to_agent?: string;
  content?: string;
  task?: {
    id: string;
    title: string;
    status: string;
    priority: string;
    result?: string | null;
  };
  message_id?: string;
  task_id?: string;
  // v2.0 — channel + routing + health fields
  channel_name?: string;
  previous_agent?: string;
  reason?: string | null;
  required_capabilities?: string[] | null;
  chosen_agent?: string;
  queue_depth?: number;
  tasks_reassigned_count?: number;
  // v2.0 beta — auto-routing + cancellation metadata
  routed?: boolean;
  assigned_to?: string | null;
  candidate_count?: number;
  auto_routed?: boolean;
  auto_assigned_from_queue?: boolean;
  cancelled_by?: string;
  triggered_by?: string;
}

function hmac(payload: string, secret: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * v2.1 Phase 4e: derive a stable idempotency key from the event + participants +
 * most-specific resource ID in the payload data. Recipients dedupe on this.
 * Exported for tests.
 */
export function deriveIdempotencyKey(
  event: WebhookEvent,
  fromAgent: string,
  toAgent: string,
  data: Partial<WebhookPayload>
): string {
  const resource =
    data.message_id ??
    data.task_id ??
    data.task?.id ??
    data.channel_name ??
    data.timestamp ??
    new Date().toISOString();
  return `${event}:${fromAgent}:${toAgent}:${resource}`;
}

/**
 * v2.2.0 Phase 2: map a webhook event onto the coarser dashboard event
 * taxonomy + broadcast. Mapping:
 *   - message.sent / message.broadcast   → message.sent
 *   - task.* (all lifecycle transitions) → task.transitioned
 *   - channel.message_posted              → channel.posted
 *   - agent.* (state-impacting)           → agent.state_changed
 *   - webhook.delivery_failed             → NOT broadcast (operator concern,
 *                                            not something a dashboard user
 *                                            watches for)
 *
 * v2.2.0 Codex audit H4: broadcasts are METADATA-ONLY. No body content,
 * no raw webhook payload — the client treats pushes as "refetch" signals
 * and ignores the body anyway. The `kind` field carries the
 * underlying webhook event name for clients that want to render a
 * one-word activity tag without looking up details.
 *
 * Fire-and-forget. broadcastDashboardEvent rate-limits + swallows errors.
 */
function emitDashboardBroadcast(
  event: WebhookEvent,
  fromAgent: string,
  toAgent: string,
  data: Partial<WebhookPayload>
): void {
  let dashEvent: DashboardEvent["event"] | null = null;
  let entityId = "";

  if (event === "message.sent" || event === "message.broadcast") {
    dashEvent = "message.sent";
    entityId = (data.message_id as string | undefined) ?? `${fromAgent}->${toAgent}`;
  } else if (event.startsWith("task.")) {
    dashEvent = "task.transitioned";
    entityId =
      (data.task_id as string | undefined) ??
      (data.task?.id as string | undefined) ??
      `${fromAgent}->${toAgent}`;
  } else if (event === "channel.message_posted") {
    dashEvent = "channel.posted";
    entityId = (data.channel_name as string | undefined) ?? `${fromAgent}->${toAgent}`;
  } else if (event === "agent.unregistered" || event === "agent.spawned" || event === "agent.health_timeout") {
    dashEvent = "agent.state_changed";
    entityId = fromAgent || toAgent || "unknown";
  } else {
    // webhook.delivery_failed + '*' never broadcast.
    return;
  }

  broadcastDashboardEvent({
    event: dashEvent,
    entity_id: entityId,
    ts: new Date().toISOString(),
    kind: event,
  });
}

/**
 * Fire webhooks matching the event. Fire-and-forget with timeout.
 * Never throws — errors are logged to webhook_delivery_log.
 */
export function fireWebhooks(
  event: WebhookEvent,
  fromAgent: string,
  toAgent: string,
  data: Partial<WebhookPayload>
): void {
  // v2.2.0 Phase 2: every fireWebhooks call ALSO fans out to connected
  // dashboard WebSocket clients (if any). Mapped to the coarser dashboard
  // event taxonomy — five task.* webhook events collapse to one
  // task.transitioned dashboard event so the frontend renders a single
  // lifecycle stream per task. Broadcast is rate-limited + never-throw
  // inside broadcastDashboardEvent; safe to call unconditionally.
  emitDashboardBroadcast(event, fromAgent, toAgent, data);

  const webhooks = getWebhooksForEvent(event, fromAgent, toAgent);
  if (webhooks.length === 0) return;

  const config = loadConfig();
  const deliveryId = uuidv4();
  const idempotencyKey = deriveIdempotencyKey(event, fromAgent, toAgent, data);
  const payload: WebhookPayload = {
    event,
    timestamp: new Date().toISOString(),
    delivery_id: deliveryId,
    idempotency_key: idempotencyKey,
    from_agent: fromAgent,
    to_agent: toAgent,
    ...data,
  };
  const payloadStr = JSON.stringify(payload);

  for (const hook of webhooks) {
    log.debug(`[webhook] fire event=${event} → ${hook.url} delivery_id=${deliveryId}`);
    deliverWebhook(hook.id, hook.url, hook.secret, event, payloadStr, deliveryId, config.webhook_timeout_ms);
  }
  // v2.0 final: piggyback retry scan. CAS in claimDueWebhookRetries keeps
  // concurrent callers from double-dispatching the same job.
  processDueWebhookRetries();
}

async function deliverWebhook(
  webhookId: string,
  url: string,
  secret: string | null,
  event: string,
  payloadStr: string,
  deliveryId: string,
  timeoutMs: number
): Promise<void> {
  // v2.1 Phase 4e (A): DNS-rebinding defense at fire time. Re-resolve the
  // hostname and re-run the all-IPs SSRF check. Register-time validation is
  // not enough — an attacker controlling DNS can flip the record between
  // register and fire.
  //
  // v2.2.0 Phase 4 (bundled v2.1.7 Item 7 from Codex): the validate call
  // below returns the resolved IPs AS OF THIS MOMENT. `deliverPinnedPost`
  // connects DIRECTLY to one of those IPs without a second DNS lookup,
  // closing the TOCTOU window a fast-flip authoritative nameserver could
  // previously exploit between validation and socket open. TLS SNI +
  // certificate validation still anchor on the URL hostname via the
  // `servername` option on https.request (see src/webhook-delivery.ts).
  const safety = await validateWebhookUrl(url);
  if (!safety.ok) {
    const reason = `DNS rebinding refusal at fire time: ${safety.reason}`;
    log.warn(`[webhook] ${reason} url=${url}`); // stderr keeps the full detail
    // Terminal log entry — no retry, attacker controls DNS so retrying feeds them.
    logWebhookDelivery(webhookId, event, payloadStr, null, reason);
    return;
  }
  const pinnedIp = safety.resolvedIps && safety.resolvedIps.length > 0 ? safety.resolvedIps[0] : null;
  if (!pinnedIp) {
    // Shouldn't happen — validateWebhookUrl returns ok only if it resolved
    // at least one IP. Defensive belt-and-suspenders.
    const reason = "no validated IP to pin for delivery (internal error)";
    log.warn(`[webhook] ${reason} url=${url}`);
    logWebhookDelivery(webhookId, event, payloadStr, null, reason);
    return;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": `bot-relay-mcp/${VERSION}`,
    "X-Relay-Event": event,
    "X-Relay-Webhook-Id": webhookId,
    // v2.1 Phase 4e (B): replay-defense infrastructure — recipients dedupe
    // on delivery_id + reject payloads with an old Date per their policy.
    "X-Relay-Delivery-Id": deliveryId,
    "Date": new Date().toUTCString(),
  };
  if (secret) {
    headers["X-Relay-Signature"] = hmac(payloadStr, secret);
  }

  // Pre-log: record the attempt BEFORE the delivery fires so a process crash
  // mid-delivery still leaves a trail. Status starts as "in-flight" (-1).
  logWebhookDelivery(webhookId, event, payloadStr, -1, "in-flight (process exited?)");

  const res = await deliverPinnedPost({
    url,
    pinnedIp,
    headers,
    body: payloadStr,
    timeoutMs,
  });
  if (res.error) {
    log.warn(`[webhook] delivery error url=${url} pinned=${pinnedIp}: ${res.error}`);
    scheduleWebhookRetry(webhookId, event, payloadStr, res.error);
    return;
  }
  const status = res.statusCode ?? 0;
  if (status < 200 || status >= 300) {
    scheduleWebhookRetry(webhookId, event, payloadStr, `HTTP ${status}`);
  } else {
    logWebhookDelivery(webhookId, event, payloadStr, status, null);
  }
}

/**
 * v2.0 final: process any due webhook retries. Piggybacked on tool calls
 * that fire webhooks (send_message, broadcast, post_task, post_task_auto,
 * update_task, register_webhook). Bounded — each piggyback processes up to
 * RELAY_WEBHOOK_RETRY_BATCH_SIZE (default 10) jobs.
 *
 * Fire-and-forget. Any error inside is swallowed (logged only) — the main
 * tool call must not fail because a retry failed.
 */
export function processDueWebhookRetries(): void {
  try {
    const config = loadConfig();
    const jobs = claimDueWebhookRetries();
    if (jobs.length === 0) return;
    log.debug(`[webhook-retry] claimed ${jobs.length} due job(s)`);
    for (const job of jobs) {
      retryOne(job.log_id, job.url, job.secret, job.event, job.payload, job.webhook_id, config.webhook_timeout_ms);
    }
  } catch (err) {
    log.warn("[webhook-retry] piggyback failed:", err);
  }
}

async function retryOne(
  logId: string,
  url: string,
  secret: string | null,
  event: string,
  payloadStr: string,
  webhookId: string,
  timeoutMs: number
): Promise<void> {
  // v2.1 Phase 4e (A) + v2.2.0 Phase 4: re-validate DNS on every retry
  // (attacker-controlled nameserver could flip between attempts) AND pin
  // the TCP connection to the re-validated IP so native fetch can't
  // silently re-resolve at socket open.
  const safety = await validateWebhookUrl(url);
  if (!safety.ok) {
    const reason = `DNS rebinding refusal on retry: ${safety.reason}`;
    log.warn(`[webhook-retry] ${reason} url=${url}`); // stderr keeps the full detail
    terminateWebhookRetry(logId, reason);
    return;
  }
  const pinnedIp = safety.resolvedIps && safety.resolvedIps.length > 0 ? safety.resolvedIps[0] : null;
  if (!pinnedIp) {
    const reason = "no validated IP to pin for retry (internal error)";
    log.warn(`[webhook-retry] ${reason} url=${url}`);
    terminateWebhookRetry(logId, reason);
    return;
  }

  // Extract the stored delivery_id from the payload body so the retry header
  // matches what recipients already know (dedup stability across retries).
  let deliveryId = "";
  try {
    const parsed = JSON.parse(payloadStr);
    if (typeof parsed.delivery_id === "string") deliveryId = parsed.delivery_id;
  } catch {
    // Payload unparseable — shouldn't happen since we wrote it, but don't
    // block the retry.
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": `bot-relay-mcp/${VERSION}`,
    "X-Relay-Event": event,
    "X-Relay-Webhook-Id": webhookId,
    "X-Relay-Retry": "1",
    "Date": new Date().toUTCString(),
  };
  if (deliveryId) headers["X-Relay-Delivery-Id"] = deliveryId;
  if (secret) headers["X-Relay-Signature"] = hmac(payloadStr, secret);

  const res = await deliverPinnedPost({
    url,
    pinnedIp,
    headers,
    body: payloadStr,
    timeoutMs,
  });
  if (res.error) {
    recordWebhookRetryOutcome(logId, false, null, res.error);
    log.debug(`[webhook-retry] log=${logId} url=${url} pinned=${pinnedIp} → error: ${res.error}`);
    return;
  }
  const status = res.statusCode ?? 0;
  const ok = status >= 200 && status < 300;
  recordWebhookRetryOutcome(logId, ok, status, ok ? null : `HTTP ${status}`);
  log.debug(`[webhook-retry] log=${logId} url=${url} pinned=${pinnedIp} → ${status} ${ok ? "(delivered)" : "(will retry or terminal)"}`);
}
