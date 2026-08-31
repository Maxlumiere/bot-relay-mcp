// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.3.0 Part B — profile/bundle surface shaping, extracted to a LEAF module (#tools-list-visibility)
 * so both server.ts (which filters tools/list) and the health_check handler can read it without a
 * server↔status import cycle.
 *
 * #tools-list-visibility — tools/list is an MCP protocol response whose shape is not ours to extend,
 * so a hidden tool leaves NO signal in that response: an agent cannot tell "hidden by my profile"
 * from "not connected" from "does not exist", and a missing capability is never noticed because
 * nobody looks for a tool they do not know exists. resolveSurfaceSummary() puts that signal in the
 * always-visible health_check response instead — a place to LOOK. Honest bound: an agent that reads
 * ONLY tools/list and never calls health_check can still be fooled; that is inherent to the protocol.
 */
import { loadConfig } from "./config.js";

export const TOOL_BUNDLES: Record<string, string> = {
  // core
  register_agent: "core",
  unregister_agent: "core",
  abandon_registration: "core",
  discover_agents: "core",
  send_message: "core",
  get_messages: "core",
  get_messages_summary: "core",
  get_outstanding: "core",
  // v2.12.0 — pending-vs-history. Own-mailbox primitive (no extra capability;
  // recipient-scoped by token→agent_name binding, like get_messages).
  resolve_messages: "core",
  broadcast: "core",
  // v2.10 — capability-routed messaging (FYI/coordination lane). Core primitive.
  post_to_capability: "core",
  post_task: "core",
  post_task_auto: "core",
  update_task: "core",
  get_tasks: "core",
  get_task: "core",
  set_status: "core",
  report_liveness: "core",
  health_check: "core",
  // webhooks
  register_webhook: "webhooks",
  list_webhooks: "webhooks",
  delete_webhook: "webhooks",
  // channels
  create_channel: "channels",
  join_channel: "channels",
  leave_channel: "channels",
  post_to_channel: "channels",
  get_channel_messages: "channels",
  // admin
  rotate_token: "admin",
  rotate_token_admin: "admin",
  revoke_token: "admin",
  expand_capabilities: "admin",
  set_dashboard_theme: "admin",
  spawn_agent: "admin",
  // managed-agents
  get_standup: "managed-agents",
  // v2.3.0 Part C.3 — ambient-wake peek tool, a core mailbox primitive.
  peek_inbox_version: "core",
  // v2.10 — schema-gated task completion. register is admin-bundled + cap-gated
  // (manage_schemas); the schema read is a core primitive.
  register_task_schema: "admin",
  task_schema_get: "core",
  // federation — reserved (empty)
};

export function isToolVisible(
  toolName: string,
  bundles: string[],
  hiddenList: string[] = [],
): boolean {
  if (hiddenList.includes(toolName)) return false;
  const bundle = TOOL_BUNDLES[toolName] ?? "core"; // fail-open on drift
  // health_check + discover_agents are always visible — diagnostic/routing
  // primitives every profile needs (ops, debugging, first-run discovery).
  if (toolName === "health_check" || toolName === "discover_agents") return true;
  return bundles.includes(bundle);
}

/**
 * v2.3.0 Part B.2 — resolve the active feature bundles + hidden list from
 * config. Falls back to all-bundles-visible when the config is pre-v2.3.0
 * (no profile field → no shaping applied). Deliberately permissive to
 * avoid breaking existing installs on upgrade.
 */
export function resolveSurfaceShape(): { bundles: string[]; hidden: string[] } {
  try {
    const cfg = loadConfig() as unknown as {
      feature_bundles?: string[];
      tool_visibility?: { hidden?: string[] };
    };
    if (Array.isArray(cfg.feature_bundles) && cfg.feature_bundles.length > 0) {
      return {
        bundles: cfg.feature_bundles,
        hidden: cfg.tool_visibility?.hidden ?? [],
      };
    }
  } catch {
    /* fall through — no config or invalid shape */
  }
  // Default: everything visible (pre-v2.3.0 install or config-less run).
  return {
    bundles: ["core", "webhooks", "channels", "admin", "managed-agents"],
    hidden: [],
  };
}

/**
 * #tools-list-visibility — the surface an agent can see, made observable. Computed over the SAME
 * predicate tools/list applies (isToolVisible), so the counts cannot disagree with what tools/list
 * returns. `hidden_tools` names the filtered tools so an agent can tell "hidden by profile" (name in
 * this list) from "does not exist" (name absent from the full inventory). Reported by health_check.
 */
export function resolveSurfaceSummary(): {
  profile: string | null;
  feature_bundles: string[];
  tools_total: number;
  tools_visible: number;
  tools_hidden: number;
  hidden_tools: string[];
} {
  const { bundles, hidden } = resolveSurfaceShape();
  let profile: string | null = null;
  try {
    profile = (loadConfig() as unknown as { profile?: string }).profile ?? null;
  } catch {
    /* config-less run — profile unknown */
  }
  const allTools = Object.keys(TOOL_BUNDLES);
  const hiddenTools = allTools.filter((name) => !isToolVisible(name, bundles, hidden)).sort();
  return {
    profile,
    feature_bundles: bundles,
    tools_total: allTools.length,
    tools_visible: allTools.length - hiddenTools.length,
    tools_hidden: hiddenTools.length,
    hidden_tools: hiddenTools,
  };
}
