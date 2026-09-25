// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1.4 (I12) — `get_standup`: server-side team-status synthesis.
 *
 * Pure read-only. No LLM call. No mutations. Rule-based heuristics produce
 * the observation bullets so the output is deterministic + cheap. Intended
 * audience: orchestrators that would otherwise poll discover_agents +
 * get_messages + get_tasks and synthesize in-LLM.
 */

import type { GetStandupInput } from "../types.js";
import { ERROR_CODES } from "../error-codes.js";
import {
  getAgents,
  getMessagesInWindow,
  getTasksInWindow,
  getAuditLog,
} from "../db.js";

interface RecentAction {
  tool: string;
  at: string;
  success: boolean;
}

interface ActiveAgentRow {
  name: string;
  role: string;
  last_seen: string;
  current_status: string;
  recent_actions: RecentAction[];
}

interface TopN {
  name: string;
  count: number;
}

interface FlaggedMessage {
  id: string;
  from: string;
  to: string;
  created_at: string;
}

interface StandupResult {
  window: { since: string; now: string; duration_ms: number };
  active_agents: ActiveAgentRow[];
  message_activity: {
    total: number;
    top_senders: TopN[];
    top_receivers: TopN[];
    flagged_priority: FlaggedMessage[];
  };
  task_state: {
    completed_in_window: number;
    queued: number;
    blocked: number;
    assigned_by_agent: Record<string, number>;
  };
  observations: string[];
}

/**
 * Parse `since` as either a duration shorthand or an ISO timestamp. Returns
 * milliseconds-since-epoch of the window start. Throws on invalid input.
 */
export function parseSince(since: string, nowMs: number = Date.now()): number {
  const durMatch = /^(\d+)(m|h|d)$/.exec(since.trim());
  if (durMatch) {
    const n = parseInt(durMatch[1], 10);
    const unit = durMatch[2];
    const multipliers: Record<string, number> = {
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
    };
    if (n <= 0 || !Number.isFinite(n)) {
      throw new Error(`since duration must be positive: "${since}"`);
    }
    return nowMs - n * multipliers[unit];
  }
  // Fallback: ISO timestamp parse.
  const t = Date.parse(since);
  if (Number.isNaN(t)) {
    throw new Error(
      `since must be a duration ('15m' | '1h' | '3h' | '1d') or ISO8601 timestamp; got "${since}"`
    );
  }
  return t;
}

function topN<T>(
  items: T[],
  key: (item: T) => string,
  n: number = 3
): TopN[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, count]) => ({ name, count }));
}

function minutesSince(iso: string, nowMs: number): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Infinity;
  return (nowMs - t) / 60_000;
}

function formatRelative(minutes: number): string {
  if (!Number.isFinite(minutes)) return "never";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  const h = minutes / 60;
  if (h < 24) return `${h.toFixed(1)}h ago`;
  return `${(h / 24).toFixed(1)}d ago`;
}

export function handleGetStandup(input: GetStandupInput) {
  // --- 1. Parse window ---
  const nowMs = Date.now();
  let sinceMs: number;
  try {
    sinceMs = parseSince(input.since, nowMs);
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
  const sinceIso = new Date(sinceMs).toISOString();
  const nowIso = new Date(nowMs).toISOString();

  // --- 2. Gather raw data ---
  const allAgents = getAgents();
  const allMessages = getMessagesInWindow(sinceIso);
  const allTasks = getTasksInWindow(sinceIso);
  // Pull audit log broadly; filter in memory by window.
  const auditAll = getAuditLog(undefined, undefined, 500);
  const auditInWindow = auditAll.filter((a) => a.created_at >= sinceIso);

  // --- 3. Apply filter ---
  const filter = input.filter;
  const nameAllow = filter?.agents ? new Set(filter.agents) : null;
  const roleAllow = filter?.roles ? new Set(filter.roles) : null;
  const includeOffline = filter?.include_offline ?? false;

  const agents = allAgents.filter((a) => {
    if (nameAllow && !nameAllow.has(a.name)) return false;
    if (roleAllow && !roleAllow.has(a.role)) return false;
    if (!includeOffline && a.agent_status === "offline") return false;
    return true;
  });
  const agentNameSet = new Set(agents.map((a) => a.name));

  // --- 4. active_agents section ---
  const auditByAgent = new Map<string, RecentAction[]>();
  for (const entry of auditInWindow) {
    if (!entry.agent_name) continue;
    if (!auditByAgent.has(entry.agent_name)) auditByAgent.set(entry.agent_name, []);
    const list = auditByAgent.get(entry.agent_name)!;
    if (list.length < 3) {
      list.push({ tool: entry.tool, at: entry.created_at, success: entry.success === 1 });
    }
  }
  const active_agents: ActiveAgentRow[] = agents.map((a) => ({
    name: a.name,
    role: a.role,
    last_seen: a.last_seen,
    current_status: a.agent_status,
    recent_actions: auditByAgent.get(a.name) ?? [],
  }));

  // --- 5. message_activity section ---
  const messagesFiltered = allMessages.filter(
    (m) =>
      (!nameAllow || agentNameSet.has(m.from_agent) || agentNameSet.has(m.to_agent)) &&
      (!roleAllow || agentNameSet.has(m.from_agent) || agentNameSet.has(m.to_agent))
  );
  const oneHourAgoIso = new Date(nowMs - 60 * 60 * 1000).toISOString();
  const flagged_priority: FlaggedMessage[] = messagesFiltered
    .filter((m) => (m.priority === "high" || m.priority === "critical") && m.created_at >= oneHourAgoIso)
    .slice(0, 20)
    .map((m) => ({ id: m.id, from: m.from_agent, to: m.to_agent, created_at: m.created_at }));

  const message_activity = {
    total: messagesFiltered.length,
    top_senders: topN(messagesFiltered, (m) => m.from_agent),
    top_receivers: topN(messagesFiltered, (m) => m.to_agent),
    flagged_priority,
  };

  // --- 6. task_state section ---
  const tasksFiltered = allTasks.filter((t) => {
    const touches =
      agentNameSet.has(t.from_agent) || (t.to_agent && agentNameSet.has(t.to_agent));
    if (nameAllow || roleAllow) return touches;
    return true;
  });
  const completed_in_window = tasksFiltered.filter(
    (t) => t.status === "completed" && t.updated_at >= sinceIso
  ).length;
  const queued = tasksFiltered.filter((t) => t.status === "queued").length;
  // "Blocked" in the task sense: accepted with no recent heartbeat (>30 min)
  // OR status='posted' with no movement since window start.
  const thirtyAgoIso = new Date(nowMs - 30 * 60 * 1000).toISOString();
  const blocked = tasksFiltered.filter((t) => {
    if (t.status === "accepted") {
      const hb = t.lease_renewed_at ?? t.updated_at;
      return hb < thirtyAgoIso;
    }
    return false;
  }).length;
  const assigned_by_agent: Record<string, number> = {};
  for (const t of tasksFiltered) {
    if (t.to_agent) {
      assigned_by_agent[t.to_agent] = (assigned_by_agent[t.to_agent] ?? 0) + 1;
    }
  }

  // --- 7. Observations (rule-based) ---
  const observations: string[] = [];

  // 7a. Agents currently declared blocked. Note: the HYBRID status returned
  // by getAgents() overrides any stored 'blocked' with 'stale' after 5min of
  // last_seen silence and 'offline' after 30min, so an agent only shows as
  // 'blocked' here if it's actively declared blocked AND still within the
  // 5min-active window — which is exactly the high-signal case.
  for (const a of active_agents) {
    if (a.current_status === "blocked") {
      observations.push(
        `${a.name} blocked (last_seen ${a.last_seen}) — may need operator attention.`
      );
    }
  }

  // 7b. Agents appearing stale but status isn't offline
  for (const a of active_agents) {
    if (a.current_status !== "offline" && a.current_status !== "stale") {
      const mins = minutesSince(a.last_seen, nowMs);
      const windowMins = (nowMs - sinceMs) / 60_000;
      if (mins > Math.max(windowMins, 5) && mins > 15) {
        observations.push(
          `${a.name} appears stale (last_seen ${formatRelative(mins)}) but agent_status='${a.current_status}'.`
        );
      }
    }
  }

  // 7c. Load imbalance — agent with >= 10 active tasks
  for (const [agent, count] of Object.entries(assigned_by_agent)) {
    if (count >= 10) {
      observations.push(`${agent} has ${count} active tasks — may need rebalance.`);
    }
  }

  // 7d. Sender dominates (>= 3x median count + at least 5 messages)
  if (message_activity.top_senders.length > 0) {
    const counts = message_activity.top_senders.map((t) => t.count);
    const median = counts[Math.floor(counts.length / 2)] ?? 0;
    const top = message_activity.top_senders[0];
    if (top.count >= 5 && median > 0 && top.count >= 3 * median) {
      observations.push(
        `${top.name} dominating message traffic (${top.count} messages, ${Math.round(
          top.count / Math.max(median, 1)
        )}x median).`
      );
    }
  }

  // 7e. Queued task pileup
  if (queued > 3) {
    observations.push(
      `${queued} tasks queued — no capable agent registered, or auto-routing unmatched.`
    );
  }

  // 7f. Stale leases
  if (blocked > 0) {
    observations.push(
      `${blocked} task(s) accepted but no heartbeat in >30min — health monitor may requeue.`
    );
  }

  const result: StandupResult = {
    window: { since: sinceIso, now: nowIso, duration_ms: nowMs - sinceMs },
    active_agents,
    message_activity,
    task_state: {
      completed_in_window,
      queued,
      blocked,
      assigned_by_agent,
    },
    observations,
  };

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ success: true, ...result }, null, 2),
      },
    ],
  };
}
