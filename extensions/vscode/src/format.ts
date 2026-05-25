// bot-relay-mcp — Tether for VSCode
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT

/**
 * Pure-function formatters extracted so vitest can exercise them without
 * booting a VSCode test host (vscode-test is heavyweight + CI-only). The
 * actual extension wires these into a `StatusBarItem` and a webview body
 * via the vscode API surface.
 */

export interface InboxSnapshot {
  agent_name: string;
  agent_known: boolean;
  pending_count: number;
  total_count: number;
  last_message_at: string | null;
  last_message_from: string | null;
  last_message_priority: string | null;
  last_message_preview: string | null;
  last_message_truncated: boolean;
}

/**
 * Status-bar text. The trailing relative-time hint helps an operator see
 * "is this stale?" at a glance without expanding the panel.
 */
export function formatStatusBar(snapshot: InboxSnapshot, nowMs: number = Date.now()): string {
  const count = snapshot.pending_count;
  const last = snapshot.last_message_at
    ? formatRelativeTime(snapshot.last_message_at, nowMs)
    : "no mail yet";
  return `Tether: ${count} | last ${last}`;
}

/**
 * Color hint for the status-bar item. The extension maps these to the
 * built-in VSCode theme colors (statusBarItem.warningBackground etc.).
 */
export function statusBarSeverity(snapshot: InboxSnapshot): "ok" | "warn" | "alert" {
  const c = snapshot.pending_count;
  if (c <= 0) return "ok";
  if (c <= 3) return "warn";
  return "alert";
}

/** Compact "Xm ago" / "Xh ago" / "Xd ago" formatter. */
export function formatRelativeTime(iso: string, nowMs: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "unknown";
  const deltaMs = nowMs - t;
  if (deltaMs < 0) return "just now";
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/** Toast text for a fresh inbox event. */
export function formatToast(snapshot: InboxSnapshot): string {
  const sender = snapshot.last_message_from ?? "system";
  return `Tether: New message from ${sender} in ${snapshot.agent_name} inbox`;
}

/**
 * v0.2 — executor-mode status bar. When Tether is managing an agent
 * process (Spawn Agent has fired), the status bar shows the managed
 * agent's name + lifecycle status alongside the pending-mail count.
 *
 * Format (locked in v0.2 brief):
 *   `Tether: <agentName> | <pendingCount> pending | <status>`
 * where status ∈ {connecting, connected, disconnected, error, restarting}
 *
 * Maps the AgentManager's internal status to the brief's terminology:
 *   idle       → disconnected
 *   spawning   → connecting
 *   connected  → connected
 *   crashed    → restarting   (a crashed status only exists for the
 *                              single tick between close + schedule;
 *                              callers should see "restarting" by the
 *                              time the status bar redraws)
 *   restarting → restarting
 *   error      → error
 *
 * The mapping is deliberate: the brief's vocabulary is operator-
 * facing; AgentManager's internal vocabulary distinguishes pre-spawn
 * idle from disconnected-after-kill, which the status bar doesn't
 * care about.
 */
export type ExecutorStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "restarting"
  | "error";

export type AgentLifecycleStatus =
  | "idle"
  | "spawning"
  | "connected"
  | "crashed"
  | "restarting"
  | "error";

export function mapExecutorStatus(s: AgentLifecycleStatus): ExecutorStatus {
  switch (s) {
    case "idle":
      return "disconnected";
    case "spawning":
      return "connecting";
    case "connected":
      return "connected";
    case "crashed":
      return "restarting";
    case "restarting":
      return "restarting";
    case "error":
      return "error";
  }
}

export function formatExecutorStatusBar(args: {
  agentName: string;
  pendingCount: number;
  status: AgentLifecycleStatus;
}): string {
  const { agentName, pendingCount } = args;
  const status = mapExecutorStatus(args.status);
  return `Tether: ${agentName} | ${pendingCount} pending | ${status}`;
}
