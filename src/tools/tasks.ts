// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { postTask, updateTask, getTasks, getTask, postTaskAuto, runHealthMonitorTick, ConcurrentUpdateError } from "../db.js";
import { fireWebhooks } from "../webhooks.js";
import type { PostTaskInput, PostTaskAutoInput, UpdateTaskInput, GetTasksInput, GetTaskInput, WebhookEvent } from "../types.js";
import { currentContext } from "../request-context.js";
import { ERROR_CODES, type ErrorCode } from "../error-codes.js";

/**
 * v2.1 Phase 4g: classify a thrown Error into a stable error_code. Default
 * to INTERNAL — only widen this classifier by adding well-known thrown-error
 * fingerprints above the fallback.
 */
function classifyTaskError(err: unknown): ErrorCode {
  if (err instanceof ConcurrentUpdateError) return ERROR_CODES.CONCURRENT_UPDATE;
  if (err instanceof Error) {
    const m = err.message;
    if (/not found/i.test(m)) return ERROR_CODES.NOT_FOUND;
    // "Cannot <action> a task with status ..." — state-transition violation.
    // Also: "Internal: no status mapping" / "unhandled action" (defensive
    // paths that shouldn't trigger on valid input, but if they do it's a
    // state problem, not INTERNAL noise).
    if (/^cannot\b|no status mapping|unhandled action/i.test(m)) return ERROR_CODES.INVALID_STATE;
    // Authorization rejection from updateTask: "Agent X is not authorized to Y ..."
    if (/not authorized|only the .* can/i.test(m)) return ERROR_CODES.NOT_PARTY;
  }
  return ERROR_CODES.INTERNAL;
}

/**
 * v2.0 beta: lazy health monitor. Called from task tools that already iterate
 * tasks, to amortize the stale-lease scan. Fires task.health_reassigned
 * webhooks for each requeue. Returns nothing — the caller's main result
 * stands on its own; health is a side-effect of the call.
 */
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

export function handlePostTask(input: PostTaskInput) {
  const task = postTask(input.from, input.to, input.title, input.description, input.priority);
  fireWebhooks("task.posted", input.from, input.to, {
    task_id: task.id,
    task: {
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      result: null,
    },
  });
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            success: true,
            task_id: task.id,
            from: task.from_agent,
            to: task.to_agent,
            title: task.title,
            priority: task.priority,
            status: task.status,
            note: `Task "${task.title}" posted for "${task.to_agent}"`,
          },
          null,
          2
        ),
      },
    ],
  };
}

export function handlePostTaskAuto(input: PostTaskAutoInput) {
  // Run the health tick first so any freshly-requeued tasks are eligible
  // candidates in this same routing pass.
  runHealthMonitor("post_task_auto");
  const result = postTaskAuto(
    input.from,
    input.title,
    input.description,
    input.required_capabilities,
    input.priority,
    { allowSelfAssign: input.allow_self_assign === true }
  );

  // Fire webhooks: always task.auto_routed; task.posted only when actually routed.
  fireWebhooks("task.auto_routed", input.from, result.assigned_to ?? "", {
    task_id: result.task.id,
    from_agent: input.from,
    routed: result.routed,
    assigned_to: result.assigned_to,
    required_capabilities: input.required_capabilities,
    candidate_count: result.candidate_count,
  });
  if (result.routed && result.assigned_to) {
    fireWebhooks("task.posted", input.from, result.assigned_to, {
      task_id: result.task.id,
      task: {
        id: result.task.id,
        title: result.task.title,
        status: result.task.status,
        priority: result.task.priority,
        result: null,
      },
      auto_routed: true,
    });
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            success: true,
            task_id: result.task.id,
            status: result.task.status,
            assigned_to: result.assigned_to,
            routed: result.routed,
            candidate_count: result.candidate_count,
            required_capabilities: input.required_capabilities,
            note: result.routed
              ? `Task auto-routed to "${result.assigned_to}" (${result.candidate_count} candidate(s))`
              : `No agent currently has the required capabilities — task queued. It will be auto-assigned when a capable agent registers.`,
          },
          null,
          2
        ),
      },
    ],
  };
}

export function handleGetTasks(input: GetTasksInput) {
  runHealthMonitor("get_tasks");
  const tasks = getTasks(input.agent_name, input.role, input.status, input.limit);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            tasks,
            count: tasks.length,
            agent: input.agent_name,
            role: input.role,
            filter: input.status,
          },
          null,
          2
        ),
      },
    ],
  };
}

export function handleGetTask(input: GetTaskInput) {
  const task = getTask(input.task_id);
  if (!task) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ success: false, error: `Task not found: ${input.task_id}`, error_code: ERROR_CODES.NOT_FOUND }, null, 2),
        },
      ],
      isError: true,
    };
  }
  // v2.1 Phase 4k (F-3a.2): authz — caller must be a party to the task
  // (from_agent or to_agent). Previously any authenticated agent could read
  // any task, bypassing v1.7 at-rest encryption in the response payload.
  const caller = currentContext().callerName;
  if (!caller || (caller !== task.from_agent && caller !== task.to_agent)) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              success: false,
              error: `Agent "${caller ?? "<unknown>"}" is not a party to this task. Only from_agent or to_agent can read it.`,
              error_code: ERROR_CODES.NOT_PARTY,
              auth_error: true,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            success: true,
            task,
          },
          null,
          2
        ),
      },
    ],
  };
}

export function handleUpdateTask(input: UpdateTaskInput) {
  try {
    const task = updateTask(input.task_id, input.agent_name, input.action, input.result);
    // Heartbeat is intentionally silent — no webhook (would be too noisy).
    if (input.action !== "heartbeat") {
      const eventMap: Record<string, WebhookEvent> = {
        accept: "task.accepted",
        complete: "task.completed",
        reject: "task.rejected",
        cancel: "task.cancelled",
      };
      const event = eventMap[input.action];
      if (event) {
        fireWebhooks(event, task.from_agent, task.to_agent ?? "", {
          task_id: task.id,
          task: {
            id: task.id,
            title: task.title,
            status: task.status,
            priority: task.priority,
            result: task.result,
          },
          ...(input.action === "cancel" ? { cancelled_by: input.agent_name, reason: input.result ?? null } : {}),
        });
      }
    }
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              success: true,
              task_id: task.id,
              status: task.status,
              result: task.result,
              ...(input.action === "heartbeat" ? { lease_renewed_at: task.lease_renewed_at } : {}),
              note: input.action === "heartbeat"
                ? `Task "${task.title}" lease renewed`
                : `Task "${task.title}" is now ${task.status}`,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ success: false, error: message, error_code: classifyTaskError(err) }, null, 2),
        },
      ],
      isError: true,
    };
  }
}
