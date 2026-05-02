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
 * Static resources:
 *   relay://current-state    — agents + active tasks + queue summary
 *   relay://recent-activity  — last 50 audit log entries
 *   relay://agent-graph      — agent + message + task graph
 *
 * v2.5.0 Tether Phase 1 — Part S — dynamic per-agent inbox resources:
 *   relay://inbox/<agent_name> — one resource per registered agent.
 *   Subscribable; emits notifications/resources/updated on every
 *   inbox write (send_message / broadcast / get_messages drain).
 */
import { getDb, getAgents } from "./db.js";
import { decryptContent } from "./encryption.js";
import { agentNameFromInboxUri, inboxUriFor } from "./mcp-subscriptions.js";

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

/**
 * v2.5.0 Tether Phase 1 — Part S — preview cap on the last-message field
 * surfaced via relay://inbox/<agent_name>. Matches the
 * get_messages_summary 100-char preview cap so an MCP client subscribing
 * to inbox events sees the same first-glance shape as one polling the
 * summary tool. Long messages get a trailing ellipsis-style flag so
 * clients can render "(truncated)" without re-counting bytes.
 */
const INBOX_PREVIEW_MAX = 200;

export function listResources(): McpResourceDescriptor[] {
  // v2.5.0 Tether Phase 1 — Part S — dynamic per-agent inbox descriptors.
  // We list one resource per CURRENTLY-REGISTERED agent rather than a single
  // template entry: MCP clients walk this list to populate their resource
  // pickers, and a flat list of concrete URIs renders better than a single
  // "<agent_name>" placeholder. New agents that register after listResources
  // ran are still subscribable — clients can subscribe to a URI without it
  // having appeared in the most recent list (the spec doesn't gate subscribe
  // on prior listing).
  const dynamic: McpResourceDescriptor[] = getAgents().map((a) => ({
    uri: inboxUriFor(a.name),
    name: `Inbox: ${a.name}`,
    description:
      `JSON snapshot of the per-agent inbox for "${a.name}": pending count, ` +
      `total count, last-message timestamp, and a ${INBOX_PREVIEW_MAX}-char ` +
      `preview. Subscribable — receive notifications/resources/updated when ` +
      `new mail arrives or a pending message gets drained.`,
    mimeType: "application/json",
  }));
  return [...RESOURCE_DESCRIPTORS, ...dynamic];
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
  }
  // v2.5.0 Tether Phase 1 — Part S — dynamic relay://inbox/<agent> resources.
  const agentName = agentNameFromInboxUri(uri);
  if (agentName !== null) {
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(buildInboxSnapshot(agentName), null, 2),
    };
  }
  throw new Error(
    `MCP resource "${uri}" not found. Available static: ${RESOURCE_DESCRIPTORS.map((r) => r.uri).join(", ")}; per-agent inbox URIs: relay://inbox/<agent_name>.`,
  );
}

/**
 * v2.5.0 Tether Phase 1 — Part S — build a per-agent inbox snapshot.
 *
 * Field shape:
 *   - agent_name              — exact name the URI was scoped to
 *   - pending_count           — messages still status='pending' (un-drained)
 *   - total_count             — every message ever sent to this agent
 *   - last_message_at         — ISO timestamp of the most-recent message;
 *                               null if the inbox is empty
 *   - last_message_from       — sender of the most-recent message
 *   - last_message_priority   — 'normal' | 'high'
 *   - last_message_preview    — first INBOX_PREVIEW_MAX chars of body
 *   - last_message_truncated  — true when content overflowed the preview cap
 *
 * Returning a stable snapshot for an unknown agent (rather than throwing)
 * lets MCP clients subscribe BEFORE the agent registers — same idiom as
 * `get_messages` returning an empty array for a fresh agent's first poll.
 * `agent_known` flags whether the row exists so the client can render
 * "agent not yet registered" instead of "0 pending" if it cares.
 */
function buildInboxSnapshot(agentName: string): {
  agent_name: string;
  agent_known: boolean;
  pending_count: number;
  total_count: number;
  last_message_at: string | null;
  last_message_from: string | null;
  last_message_priority: string | null;
  last_message_preview: string | null;
  last_message_truncated: boolean;
} {
  const db = getDb();
  const known = !!(db
    .prepare("SELECT 1 AS x FROM agents WHERE name = ? LIMIT 1")
    .get(agentName) as { x: number } | undefined);
  const total = (db
    .prepare("SELECT COUNT(*) AS c FROM messages WHERE to_agent = ?")
    .get(agentName) as { c: number }).c;
  const pending = (db
    .prepare("SELECT COUNT(*) AS c FROM messages WHERE to_agent = ? AND status = 'pending'")
    .get(agentName) as { c: number }).c;
  const last = db
    .prepare(
      "SELECT from_agent, priority, content, created_at FROM messages " +
        "WHERE to_agent = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(agentName) as
    | { from_agent: string; priority: string; content: string; created_at: string }
    | undefined;
  if (!last) {
    return {
      agent_name: agentName,
      agent_known: known,
      pending_count: pending,
      total_count: total,
      last_message_at: null,
      last_message_from: null,
      last_message_priority: null,
      last_message_preview: null,
      last_message_truncated: false,
    };
  }
  // R1 #4 — decrypt-on-read contract. v1.7 messages are stored as
  // `enc1:<ciphertext>` when RELAY_ENCRYPTION_KEY is set; the standard read
  // paths (getMessages line 2714, getMessagesSummary line 2772, getTask line
  // 2320) all run content through decryptContent. R0 buildInboxSnapshot
  // skipped the helper and surfaced the raw column — when encryption was
  // active, MCP subscribers + the VSCode webview saw `enc1:...` ciphertext
  // in last_message_preview. Safe-no-op for plaintext rows by decryptContent
  // contract (returns null on non-enc1 input → fallback to original).
  const plaintext = decryptContent(last.content) ?? last.content;
  const truncated = plaintext.length > INBOX_PREVIEW_MAX;
  return {
    agent_name: agentName,
    agent_known: known,
    pending_count: pending,
    total_count: total,
    last_message_at: last.created_at,
    last_message_from: last.from_agent,
    last_message_priority: last.priority,
    last_message_preview: truncated ? plaintext.slice(0, INBOX_PREVIEW_MAX) : plaintext,
    last_message_truncated: truncated,
  };
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
