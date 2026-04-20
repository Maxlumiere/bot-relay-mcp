// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { sendMessage, getMessages, broadcastMessage, runHealthMonitorTick } from "../db.js";
import { fireWebhooks } from "../webhooks.js";
import type { SendMessageInput, GetMessagesInput, BroadcastInput } from "../types.js";

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
}

export function handleGetMessages(input: GetMessagesInput) {
  runHealthMonitor("get_messages");
  const messages = getMessages(input.agent_name, input.status, input.limit);
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
