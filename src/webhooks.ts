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
 * Fire webhooks matching the event. Fire-and-forget with timeout.
 * Never throws — errors are logged to webhook_delivery_log.
 */
export function fireWebhooks(
  event: WebhookEvent,
  fromAgent: string,
  toAgent: string,
  data: Partial<WebhookPayload>
): void {
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
  const safety = await validateWebhookUrl(url);
  if (!safety.ok) {
    const reason = `DNS rebinding refusal at fire time: ${safety.reason}`;
    log.warn(`[webhook] ${reason} url=${url}`); // stderr keeps the full detail
    // Terminal log entry — no retry, attacker controls DNS so retrying feeds them.
    logWebhookDelivery(webhookId, event, payloadStr, null, reason);
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

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

  // Pre-log: record the attempt BEFORE the fetch fires so a process crash
  // mid-delivery still leaves a trail. Status starts as "in-flight" (-1).
  logWebhookDelivery(webhookId, event, payloadStr, -1, "in-flight (process exited?)");

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: payloadStr,
      signal: controller.signal,
    });
    clearTimeout(timer);
    // v2.0 final: non-2xx is a failure → schedule retry. 2xx → log success
    // with a terminal row so /dashboard can distinguish delivered vs pending.
    if (res.status < 200 || res.status >= 300) {
      scheduleWebhookRetry(webhookId, event, payloadStr, `HTTP ${res.status}`);
    } else {
      logWebhookDelivery(webhookId, event, payloadStr, res.status, null);
    }
  } catch (err) {
    clearTimeout(timer);
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.warn(`[webhook] delivery error url=${url}: ${errorMsg}`); // stderr keeps full
    scheduleWebhookRetry(webhookId, event, payloadStr, errorMsg);
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
  // v2.1 Phase 4e (A): same DNS re-check on retry. Terminal refusal — no
  // further retries; attacker controls DNS, we stop feeding them.
  const safety = await validateWebhookUrl(url);
  if (!safety.ok) {
    const reason = `DNS rebinding refusal on retry: ${safety.reason}`;
    log.warn(`[webhook-retry] ${reason} url=${url}`); // stderr keeps the full detail
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: payloadStr,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const ok = res.status >= 200 && res.status < 300;
    recordWebhookRetryOutcome(logId, ok, res.status, ok ? null : `HTTP ${res.status}`);
    log.debug(`[webhook-retry] log=${logId} url=${url} → ${res.status} ${ok ? "(delivered)" : "(will retry or terminal)"}`);
  } catch (err) {
    clearTimeout(timer);
    const errorMsg = err instanceof Error ? err.message : String(err);
    recordWebhookRetryOutcome(logId, false, null, errorMsg);
    log.debug(`[webhook-retry] log=${logId} url=${url} → error: ${errorMsg}`);
  }
}
