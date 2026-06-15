// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import {
  sendMessage,
  getMessages,
  getMessagesSummary,
  broadcastMessage,
  postToCapability,
  runHealthMonitorTick,
  SenderNotRegisteredError,
  getAgentSessionStart,
} from "../db.js";
import { fireWebhooks } from "../webhooks.js";
import { ERROR_CODES } from "../error-codes.js";
import { parseSince } from "./standup.js";
import { sampleGetMessagesConsistency } from "../transport/consistency-probe.js";
import type {
  SendMessageInput,
  GetMessagesInput,
  GetMessagesSummaryInput,
  BroadcastInput,
  PostToCapabilityInput,
} from "../types.js";

/** v2.0 beta: lazy health piggyback on get_messages. See tools/tasks.ts for rationale. */
function runHealthMonitor(triggeredBy: string): void {
  const requeued = runHealthMonitorTick(triggeredBy);
  for (const r of requeued) {
    fireWebhooks("task.health_reassigned", r.from_agent, r.previous_agent, {
      task_id: r.task_id,
      previous_agent: r.previous_agent,
      reason: "agent_offline_grace_lease_expired",
      triggered_by: r.triggered_by,
      required_capabilities: r.required_capabilities,
    });
  }
}

export function handleSendMessage(input: SendMessageInput) {
  try {
    const message = sendMessage(input.from, input.to, input.content, input.priority);
    fireWebhooks("message.sent", input.from, input.to, {
      content: input.content,
      message_id: message.id,
    });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              success: true,
              message_id: message.id,
              from: message.from_agent,
              to: message.to_agent,
              priority: message.priority,
              note: `Message sent to "${message.to_agent}"`,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (err: any) {
    // v2.1.3 (I9 bonus): surface SENDER_NOT_REGISTERED so callers can
    // re-register + retry instead of silently succeeding with a frozen
    // last_seen on a ghost row.
    if (err instanceof SenderNotRegisteredError) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: false,
                error: err.message,
                error_code: ERROR_CODES.SENDER_NOT_REGISTERED,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
    throw err;
  }
}

/**
 * v2.1.6: resolve the `since` arg to an ISO lower bound for SQL filtering, or
 * null when the caller explicitly opts out ("all" / null) and no bound should
 * be applied. Throws a caller-facing error for malformed inputs so the caller
 * gets a VALIDATION error code instead of a 500.
 *
 * Accepts (per spec):
 *   - duration shorthand: "15m" | "1h" | "24h" | "3d" (via parseSince)
 *   - ISO8601 timestamp (via parseSince)
 *   - "session_start" — agent's last register_agent timestamp (session_started_at)
 *   - "all" | null — disable filter (preserves pre-v2.1.6 behavior)
 */
function resolveSinceBound(
  since: string | null | undefined,
  agentName: string
): string | null {
  if (since === null || since === undefined) return null;
  if (since === "all") return null;
  if (since === "session_start") {
    const started = getAgentSessionStart(agentName);
    // Unknown agent OR legacy row (never re-registered post-v2.1.6) → no
    // session anchor exists, so treat as an unfiltered read instead of
    // inventing a bound. Callers wanting a time floor can pass a duration.
    return started ?? null;
  }
  const ms = parseSince(since);
  return new Date(ms).toISOString();
}

export function handleGetMessages(input: GetMessagesInput) {
  runHealthMonitor("get_messages");
  // v2.7.0 Hermes P1 fix: `sinceIso` is now passed into the SQL layer and
  // applied as `AND created_at >= ?` BEFORE the mark-as-read mutation in
  // src/db.ts getMessages. Pre-v2.7.0 the filter ran here in JS AFTER
  // getMessages had already marked rows as read for this session — a
  // message older than the bound got consumed silently and never
  // resurfaced. See docs/v2.7.0-get-messages-filter-after-mark.md for
  // the full investigation + regression test.
  let sinceIso: string | null;
  try {
    sinceIso = resolveSinceBound(input.since, input.agent_name);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { success: false, error: msg, error_code: ERROR_CODES.VALIDATION },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
  const raw = getMessages(input.agent_name, input.status, input.limit, input.peek ?? false, sinceIso, input.lane);
  const messages = raw;
  // v2.3.0 Part A.2 — live consistency probe. Off by default; when
  // enabled via RELAY_CONSISTENCY_PROBE=1, samples every Nth call and
  // logs a stderr warning if a raw SQL superset query sees pending
  // messages that the MCP path dropped (v2.2.1-style bug class).
  // Never throws, never blocks — pure observation.
  try {
    // v2.10 — the probe compares against a raw superset query that is NOT
    // lane-aware, so only sample when lane='all' (default). A lane filter is
    // an intentional subset, not a consistency bug.
    if ((input.lane ?? "all") === "all") {
      sampleGetMessagesConsistency({
        agentName: input.agent_name,
        status: input.status,
        limit: input.limit,
        peek: input.peek ?? false,
        mcpResult: raw,
        sinceIso,
      });
    }
  } catch {
    /* probe guarantees no-throw but defensive */
  }

  // v2.2.1 B4: if the caller asked for `pending` + got zero results + the
  // `since` window is narrow (parsed + < 24h), emit a `hint` nudging them
  // to widen the window. Common operator confusion pre-v2.2.1: "my
  // pending message from 25min ago doesn't show up with since='15m'" →
  // false-ghost-session diagnosis. The hint makes the bounded-filter
  // semantic visible instead of silently hiding mail.
  //
  // Fires ONLY when all three conditions hold:
  //   - status === "pending"
  //   - returned count === 0
  //   - sinceIso != null (a bound was applied) AND bound is < 24h ago
  // When since="all" or since=null the bound is absent → no hint.
  let hint: string | undefined;
  if (input.status === "pending" && messages.length === 0 && sinceIso) {
    const boundAgeMs = Date.now() - new Date(sinceIso).getTime();
    const twentyFourHoursMs = 24 * 60 * 60 * 1000;
    if (boundAgeMs >= 0 && boundAgeMs < twentyFourHoursMs) {
      hint =
        "Narrow `since` window may hide older pending messages. " +
        "Try since='24h' or since='all' to check for stale-but-pending work " +
        "(the `since` filter trims both pending AND read mail).";
    }
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            messages,
            count: messages.length,
            agent: input.agent_name,
            filter: input.status,
            since: input.since ?? null,
            since_bound: sinceIso,
            ...(hint ? { hint } : {}),
          },
          null,
          2
        ),
      },
    ],
  };
}

/**
 * v2.1.6 — lightweight inbox preview. Pure read (no read_by_session mutation,
 * no touchAgent). Returns only {id, from_agent, priority, status, created_at,
 * content_preview} with content truncated at 100 chars. Supports the same
 * `since` + `status` filters as get_messages.
 *
 * Use case: orchestrators + dashboards that want to scan an inbox cheaply
 * without burning tokens on full bodies. Caller expands chosen IDs via
 * get_messages.
 */
const SUMMARY_PREVIEW_MAX = 100;

export function handleGetMessagesSummary(input: GetMessagesSummaryInput) {
  let sinceIso: string | null;
  try {
    sinceIso = resolveSinceBound(input.since, input.agent_name);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { success: false, error: msg, error_code: ERROR_CODES.VALIDATION },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
  const rows = getMessagesSummary(input.agent_name, input.status, input.limit, sinceIso);
  const summaries = rows.map((r) => ({
    id: r.id,
    from_agent: r.from_agent,
    priority: r.priority,
    status: r.status,
    created_at: r.created_at,
    content_preview:
      r.content.length > SUMMARY_PREVIEW_MAX
        ? r.content.slice(0, SUMMARY_PREVIEW_MAX)
        : r.content,
    content_truncated: r.content.length > SUMMARY_PREVIEW_MAX,
  }));
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            summaries,
            count: summaries.length,
            agent: input.agent_name,
            filter: input.status,
            since: input.since ?? null,
            since_bound: sinceIso,
          },
          null,
          2
        ),
      },
    ],
  };
}

export function handleBroadcast(input: BroadcastInput) {
  const result = broadcastMessage(input.from, input.content, input.role);
  for (const recipient of result.sent_to) {
    fireWebhooks("message.broadcast", input.from, recipient, {
      content: input.content,
    });
  }
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            success: true,
            sent_to: result.sent_to,
            message_ids: result.message_ids,
            count: result.sent_to.length,
            note: result.sent_to.length === 0
              ? "No other agents found to broadcast to"
              : `Broadcast sent to ${result.sent_to.length} agent(s)`,
          },
          null,
          2
        ),
      },
    ],
  };
}

/**
 * v2.10 — capability-routed messaging (principle #1). Fans an FYI/coordination
 * message out to the CURRENT owner(s) of a capability. FYI/coordination lane
 * ONLY — action-required completions stay point-to-point ship-pongs via
 * send_message. Fires ONE `message.capability_routed` webhook for the whole
 * fan-out (not per-recipient) carrying the capability + recipients, so
 * integrations (Tether) can render the FYI lane distinctly.
 */
export function handlePostToCapability(input: PostToCapabilityInput) {
  try {
    const result = postToCapability(
      input.from,
      input.capability,
      input.content,
      input.priority,
      input.exclude_self ?? true,
    );
    fireWebhooks("message.capability_routed", input.from, input.capability, {
      capability: input.capability,
      routed_to: result.routed_to,
      message_count: result.message_ids.length,
    });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              success: true,
              capability: input.capability,
              routed_to: result.routed_to,
              message_ids: result.message_ids,
              count: result.routed_to.length,
              note:
                result.routed_to.length === 0
                  ? `No registered owner for capability "${input.capability}" — nothing routed (FYI is fire-and-forget to current owners).`
                  : `Capability-routed to ${result.routed_to.length} owner(s) of "${input.capability}".`,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (err: any) {
    if (err instanceof SenderNotRegisteredError) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: false,
                error: err.message,
                error_code: ERROR_CODES.SENDER_NOT_REGISTERED,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
    throw err;
  }
}
