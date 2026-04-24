// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.4.0 Part F.2 — MCP resources.
 *
 * Pre-defined data endpoints the operator's MCP client can fetch via
 * `resources/list` + `resources/read`. Separate from tools (tool
 * count stays 30). Pure read-only.
 *
 * Each resource returns a single-text-block response with a JSON
 * snapshot of the current relay state. Useful for visualization
 * tools + operator dashboards that want structured data without
 * calling individual tools.
 *
 * Resources registered:
 *   relay://current-state    — agents + active tasks + queue summary
 *   relay://recent-activity  — last 50 audit log entries
 *   relay://agent-graph      — agent + message + task graph
 */
import { getDb, getAgents } from "./db.js";

export interface McpResourceDescriptor {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export const RESOURCE_DESCRIPTORS: readonly McpResourceDescriptor[] = [
  {
    uri: "relay://current-state",
    name: "Current relay state",
    description:
      "JSON snapshot: agents (with agent_status derived from last_seen), active tasks, pending-message counts per agent. Same shape family as the dashboard's /api/snapshot but surfaced via MCP.",
    mimeType: "application/json",
  },
  {
    uri: "relay://recent-activity",
    name: "Recent audit activity",
    description:
      "Last 50 audit_log entries (tool, source, success, timestamp, agent_name). Sensitive params_json field stripped. For incident review without hitting the SQLite file directly.",
    mimeType: "application/json",
  },
  {
    uri: "relay://agent-graph",
    name: "Agent graph",
    description:
      "Agents + edges (message-sent-between counts + active-task assignments). Structured object suited for visualization tools that render agent interaction graphs.",
    mimeType: "application/json",
  },
];

export function listResources(): McpResourceDescriptor[] {
  return [...RESOURCE_DESCRIPTORS];
}

/** Read-only resource content loader. Dispatches on the URI. */
export function readResource(uri: string): {
  uri: string;
  mimeType: string;
  text: string;
} {
  switch (uri) {
    case "relay://current-state":
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(buildCurrentState(), null, 2),
      };
    case "relay://recent-activity":
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(buildRecentActivity(), null, 2),
      };
    case "relay://agent-graph":
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(buildAgentGraph(), null, 2),
      };
    default:
      throw new Error(
        `MCP resource "${uri}" not found. Available: ${RESOURCE_DESCRIPTORS.map((r) => r.uri).join(", ")}`,
      );
  }
}

function buildCurrentState(): {
  agents: Array<{ name: string; role: string; agent_status: string; last_seen: string; pending_count: number }>;
  active_tasks_count: number;
  total_pending_messages: number;
  schema_version: number;
} {
  const db = getDb();
  const agents = getAgents();
  const pending = db
    .prepare(
      "SELECT to_agent, COUNT(*) AS c FROM messages WHERE status = 'pending' GROUP BY to_agent",
    )
    .all() as { to_agent: string; c: number }[];
  const pendingByAgent = new Map(pending.map((r) => [r.to_agent, r.c]));
  const activeTasks = (db
    .prepare("SELECT COUNT(*) AS c FROM tasks WHERE status IN ('queued','accepted','in_progress')")
    .get() as { c: number }).c;
  const totalPending = pending.reduce((sum, r) => sum + r.c, 0);
  const schemaVersion = (db
    .prepare("SELECT version FROM schema_info WHERE id = 1")
    .get() as { version: number } | undefined)?.version ?? -1;
  return {
    agents: agents.map((a) => ({
      name: a.name,
      role: a.role,
      agent_status: a.agent_status,
      last_seen: a.last_seen,
      pending_count: pendingByAgent.get(a.name) ?? 0,
    })),
    active_tasks_count: activeTasks,
    total_pending_messages: totalPending,
    schema_version: schemaVersion,
  };
}

function buildRecentActivity(): {
  entries: Array<{
    id: string;
    ts: string;
    tool: string;
    source: string;
    success: boolean;
    agent_name: string | null;
    error: string | null;
  }>;
} {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, created_at AS ts, tool, source, success, agent_name, error " +
        "FROM audit_log ORDER BY id DESC LIMIT 50",
    )
    .all() as Array<{
      id: string;
      ts: string;
      tool: string;
      source: string;
      success: number;
      agent_name: string | null;
      error: string | null;
    }>;
  return {
    entries: rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      tool: r.tool,
      source: r.source,
      success: r.success === 1,
      agent_name: r.agent_name,
      error: r.error,
    })),
  };
}

function buildAgentGraph(): {
  nodes: Array<{ id: string; role: string; agent_status: string }>;
  message_edges: Array<{ from: string; to: string; count: number }>;
  task_edges: Array<{ from: string; to: string; status: string; count: number }>;
} {
  const db = getDb();
  const agents = getAgents();
  // Message edges: count of messages per (from, to) pair, over all time.
  const msgEdges = db
    .prepare(
      "SELECT from_agent AS \"from\", to_agent AS \"to\", COUNT(*) AS count " +
        "FROM messages GROUP BY from_agent, to_agent",
    )
    .all() as Array<{ from: string; to: string; count: number }>;
  // Task edges: count by status per (from, to) — to_agent may be NULL
  // for queued-unrouted tasks; filter those out for graph edges.
  const taskEdges = db
    .prepare(
      "SELECT from_agent AS \"from\", to_agent AS \"to\", status, COUNT(*) AS count " +
        "FROM tasks WHERE to_agent IS NOT NULL GROUP BY from_agent, to_agent, status",
    )
    .all() as Array<{ from: string; to: string; status: string; count: number }>;
  return {
    nodes: agents.map((a) => ({
      id: a.name,
      role: a.role,
      agent_status: a.agent_status,
    })),
    message_edges: msgEdges,
    task_edges: taskEdges,
  };
}
