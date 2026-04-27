// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  RegisterAgentSchema,
  DiscoverAgentsSchema,
  UnregisterAgentSchema,
  SpawnAgentSchema,
  SendMessageSchema,
  GetMessagesSchema,
  GetMessagesSummarySchema,
  BroadcastSchema,
  PostTaskSchema,
  PostTaskAutoSchema,
  UpdateTaskSchema,
  GetTasksSchema,
  GetTaskSchema,
  RegisterWebhookSchema,
  ListWebhooksSchema,
  DeleteWebhookSchema,
  CreateChannelSchema,
  JoinChannelSchema,
  LeaveChannelSchema,
  PostToChannelSchema,
  GetChannelMessagesSchema,
  SetStatusSchema,
  HealthCheckSchema,
  RotateTokenSchema,
  RotateTokenAdminSchema,
  RevokeTokenSchema,
  GetStandupSchema,
  ExpandCapabilitiesSchema,
  SetDashboardThemeSchema,
  PeekInboxVersionSchema,
} from "./types.js";
import {
  handleRegisterAgent,
  handleDiscoverAgents,
  handleUnregisterAgent,
  handleRotateToken,
  handleRotateTokenAdmin,
  handleRevokeToken,
  handleExpandCapabilities,
} from "./tools/identity.js";
import { handleSpawnAgent } from "./tools/spawn.js";
import { logAudit, checkAndRecordRateLimit, getAgentAuthData, getAgents } from "./db.js";
import { loadConfig } from "./config.js";
import { log } from "./logger.js";
import { currentContext, requestContext } from "./request-context.js";
import { ERROR_CODES, type ErrorCode } from "./error-codes.js";
import { ZodError } from "zod";
import { authenticateAgent, verifyToken, TOOL_CAPABILITY, TOOLS_NO_AUTH, isLegacyGraceActive } from "./auth.js";
import { handleSendMessage, handleGetMessages, handleGetMessagesSummary, handleBroadcast } from "./tools/messaging.js";
import { handlePostTask, handlePostTaskAuto, handleUpdateTask, handleGetTasks, handleGetTask } from "./tools/tasks.js";
import { handleRegisterWebhook, handleListWebhooks, handleDeleteWebhook } from "./tools/webhooks.js";
import { processDueWebhookRetries } from "./webhooks.js";
import { sweepExpiredRotationGrace } from "./db.js";

/**
 * v2.1 Phase 4q MED #4: webhook retry piggyback counter. Lives at module
 * scope rather than inside createServer() because the HTTP transport
 * instantiates a fresh server factory per /mcp request (stateless MCP).
 * A closure-scoped counter would reset to 0 on every call → the piggyback
 * threshold would never be crossed. Module scope keeps the counter
 * persistent across the daemon's lifetime.
 */
const WEBHOOK_RETRY_PIGGYBACK_EVERY = 5;
let webhookRetryCallCounter = 0;
function piggybackTick(): void {
  webhookRetryCallCounter++;
  if (webhookRetryCallCounter % WEBHOOK_RETRY_PIGGYBACK_EVERY !== 0) return;
  try {
    processDueWebhookRetries();
    // v2.1 Phase 4b.2: shared piggyback tick — one counter, two sweeps.
    // Expired rotation_grace rows auto-transition back to `active` +
    // clear previous_token_hash / rotation_grace_expires_at. Idempotent;
    // rows already cleaned up match no WHERE clause.
    sweepExpiredRotationGrace();
  } catch {
    // processDueWebhookRetries is fire-and-forget + swallows its own errors.
    // Belt-and-suspenders: never let a piggyback failure block a tool call.
  }
}

/** Testing-only: reset the piggyback counter between test runs. */
export function _resetPiggybackCounterForTests(): void {
  webhookRetryCallCounter = 0;
}
import {
  handleCreateChannel,
  handleJoinChannel,
  handleLeaveChannel,
  handlePostToChannel,
  handleGetChannelMessages,
  handleListChannels,
} from "./tools/channels.js";
import { handleSetStatus, handleHealthCheck } from "./tools/status.js";
import { handleGetStandup } from "./tools/standup.js";
import { handleSetDashboardTheme } from "./tools/dashboard.js";
import { handlePeekInboxVersion } from "./tools/peek-inbox-version.js";
import { recordCall } from "./transport/traffic-recorder.js";
import { listPrompts, getPrompt } from "./mcp-prompts.js";
import { listResources, readResource } from "./mcp-resources.js";
import { VERSION } from "./version.js";

/**
 * v2.3.0 Part B.2 — surface-shaping.
 *
 * Every MCP tool declares a feature bundle. Profiles (written into
 * config.json by `relay init --profile`) list the bundles they expose;
 * tools outside those bundles are filtered out of `tools/list` and
 * rejected at call time with TOOL_NOT_AVAILABLE + a hint pointing at
 * the profile that would expose them.
 *
 * Bundle list (authoritative; mirrors memory/project_federation_design.md):
 *   core           — identity + messaging + tasks + status + health + peek
 *   webhooks       — webhook registration/list/delete
 *   channels       — channel primitives
 *   admin          — token rotate/revoke, dashboard theme, spawn, cap expand
 *   managed-agents — managed-agent standup synthesis
 *   federation     — reserved for v2.3.x hub/edge (empty in v2.3.0)
 *
 * A tool that doesn't appear here is a hard bug (new tool forgot to
 * claim a bundle). The surface-shaping filter treats unknown tools as
 * "core" by default so we fail open on a drift rather than silently
 * hiding functional tools — the CI surface-shape test asserts every
 * tool IS in this map.
 */
export const TOOL_BUNDLES: Record<string, string> = {
  // core
  register_agent: "core",
  unregister_agent: "core",
  discover_agents: "core",
  send_message: "core",
  get_messages: "core",
  get_messages_summary: "core",
  broadcast: "core",
  post_task: "core",
  post_task_auto: "core",
  update_task: "core",
  get_tasks: "core",
  get_task: "core",
  set_status: "core",
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

export function createServer(): Server {
  const server = new Server(
    {
      name: "bot-relay",
      version: VERSION,
    },
    {
      capabilities: {
        tools: {},
        // v2.4.0 Part F — MCP prompts + resources split. Separate from
        // tools: prompts are pre-baked instruction templates the client
        // surfaces in a prompts menu; resources are pre-defined data
        // endpoints clients can fetch. Neither increments the tool
        // count (stays 30).
        prompts: {},
        resources: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { bundles, hidden } = resolveSurfaceShape();
    const all = ALL_TOOLS_DEFINITION;
    return {
      tools: all.filter((t) => isToolVisible(t.name, bundles, hidden)),
    };
  });

  // v2.4.0 Part F.1 — MCP prompts. Pre-baked instruction templates
  // the client surfaces in a prompts menu. See src/mcp-prompts.ts.
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return { prompts: listPrompts() };
  });
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return getPrompt(name, args as Record<string, string> | undefined);
  });

  // v2.4.0 Part F.2 — MCP resources. Read-only JSON data endpoints
  // the client can fetch via resources/read. See src/mcp-resources.ts.
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return { resources: listResources() };
  });
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    const content = readResource(uri);
    return {
      contents: [
        {
          uri: content.uri,
          mimeType: content.mimeType,
          text: content.text,
        },
      ],
    };
  });

  // v2.3.0 Part B.2 — frozen tool definition list. Pulled out of the
  // setRequestHandler closure so isToolVisible can filter it; same data
  // shape as before, no runtime semantic change.
  // v2.4.4 — Glama A-tier description push.
  //
  // Each tool below uses the same structured shape:
  //   Purpose. When to use vs alternatives. Behavior + auth + side effects.
  //   Returns shape. Errors (error_code → cause).
  // Markdown-style line breaks (\n\n) are preserved by the MCP SDK and
  // render in clients that surface tool descriptions to humans (Glama,
  // mcp-inspector). Length is uniform across the 30 tools so the Glama
  // TDQS MIN-weighted (40%) score isn't dragged by a one-liner.
  const ALL_TOOLS_DEFINITION = [
      {
        name: "register_agent",
        description:
          "Register this terminal as a named agent so other agents can address it.\n\n" +
          "When to use: call this first thing in any session that needs to send/receive messages, post tasks, or join channels. Idempotent upsert, safe to call again on reconnect. The SessionStart hook (`hooks/check-relay.sh`) typically calls it for you.\n\n" +
          "Behavior: creates or updates the agent row keyed by `name`. First registration mints a fresh agent_token (returned ONCE, store it in `RELAY_AGENT_TOKEN`). Re-registering preserves the existing token unless `recovery_token` is presented (v2.1 Phase 4b.1 v2 recovery flow). Capabilities are immutable on re-register (v1.7.1), use `expand_capabilities` for additive changes.\n\n" +
          "Returns: `{ agent: { name, role, capabilities, status, has_token, agent_status, ... }, plaintext_token: string | null, auto_assigned: QueuedAssignment[] }`.\n\n" +
          "Errors: `AUTH_FAILED` (recovery_pending row presented without recovery_token), `RECOVERY_REQUIRED` (token rejected, present recovery_token), `INVALID_INPUT` (name/role/capabilities malformed), `RATE_LIMITED`.",
        inputSchema: zodToJsonSchema(RegisterAgentSchema),
      },
      {
        name: "discover_agents",
        description:
          "List every registered agent with computed presence + operator-controlled status.\n\n" +
          "When to use: pick a routing target by role (e.g., 'any builder'), confirm an expected agent is online before sending it work, or surface the agent fleet to a dashboard. For periodic team rollups use `get_standup` instead, it bundles agents + recent activity in one call.\n\n" +
          "Behavior: pure read; never mutates `last_seen` (v1.3 presence-integrity fix). Optionally filters by `role`. The returned `status` (online | stale | offline) is computed from `last_seen` deltas; the returned `agent_status` (idle | working | blocked | waiting_user | stale | offline | abandoned | closed) is operator-controlled via `set_status`. Token hashes are stripped, `has_token: boolean` only.\n\n" +
          "Returns: `{ agents: AgentWithStatus[] }` ordered by `last_seen DESC`.\n\n" +
          "Errors: `RATE_LIMITED`. (No auth required, this surface is intentionally observable for orchestration.)",
        inputSchema: zodToJsonSchema(DiscoverAgentsSchema),
      },
      {
        name: "unregister_agent",
        description:
          "Remove an agent row so the relay reflects true presence after a clean shutdown.\n\n" +
          "When to use: terminal exit, role rotation, or one half of the recovery flow when reusing a name after `revoke_token` set the row to `revoked`. For graceful working-state announcements without removing the row, use `set_status` with `offline` instead.\n\n" +
          "Behavior: deletes the agent row + all messages and tasks the agent was the from/to of (cascade). Idempotent, unregistering a name that does not exist returns `removed:false` instead of an error. Auth: requires the agent's own token, OR for admin removals an authenticated agent with `manage_others` capability.\n\n" +
          "Returns: `{ removed: boolean }`.\n\n" +
          "Errors: `AUTH_FAILED` (token missing or wrong owner), `INVALID_INPUT`.",
        inputSchema: zodToJsonSchema(UnregisterAgentSchema),
      },
      {
        name: "spawn_agent",
        description:
          "Open a new Claude Code terminal pre-configured as a relay agent (macOS only).\n\n" +
          "When to use: orchestrators delegating work to a fresh sub-agent. The new terminal arrives in a known role + capability set with `RELAY_AGENT_NAME`/`ROLE`/`CAPABILITIES` already in env, and the SessionStart hook auto-registers it before the LLM's first turn. Linux/Windows drivers exist for headless smoke tests but do not open a UI window.\n\n" +
          "Behavior: pre-registers the new agent server-side (so its token is minted before the child process starts and reaches it via env), opens an iTerm2 or Terminal.app window via AppleScript, and runs the configured shell command in that window. Optional `initial_message` is queued in the new agent's mailbox and surfaces on its first `get_messages`. `brief_file_path` (v2.1.4) threads a durable on-disk task brief into the KICKSTART prompt, preferred over `initial_message` for non-trivial scopes because file-on-disk does not read as prompt-injection the way an inbox message can.\n\n" +
          "Returns: `{ agent_name, agent_token, terminal_title_ref?, ... }`.\n\n" +
          "Errors: `SPAWN_NOT_SUPPORTED` (non-macOS host without an explicit driver), `AUTH_FAILED`, `INVALID_INPUT`, `RATE_LIMITED`.",
        inputSchema: zodToJsonSchema(SpawnAgentSchema),
      },
      {
        name: "send_message",
        description:
          "Send a text message addressed to a single agent.\n\n" +
          "When to use: 1:1 communication, dispatching work, relaying a status update, asking a peer a question. Prefer `broadcast` for fan-out to many agents, `post_to_channel` for topical group coordination, and `post_task` (or `post_task_auto`) when the recipient should track state-machine progress (accept/complete/reject) rather than a free-text message.\n\n" +
          "Behavior: stores the message with `status='pending'` and notifies any matching webhook subscribers (`message.sent` event). The recipient sees it on its next `get_messages` call (which auto-marks read unless `peek=true`). Content is encrypted at rest if `RELAY_ENCRYPTION_KEY` is set. Caps at `RELAY_MAX_PAYLOAD_BYTES` (default 64 KB). Auth: sender must present a valid token whose row matches `from`.\n\n" +
          "Returns: `{ message_id, status: 'pending', created_at }`.\n\n" +
          "Errors: `AUTH_FAILED` (token missing/mismatched), `PAYLOAD_TOO_LARGE`, `UNKNOWN_RECIPIENT`, `RATE_LIMITED`.",
        inputSchema: zodToJsonSchema(SendMessageSchema),
      },
      {
        name: "get_messages",
        description:
          "Drain or peek your own mailbox.\n\n" +
          "When to use: each turn that should observe new mail; orchestrators that batch-poll many agents may prefer `get_messages_summary` (cheaper preview) or `peek_inbox_version` (counts only). For surveys that must NOT consume mail, set `peek=true`.\n\n" +
          "Behavior: returns messages addressed to you, ordered by priority then `created_at` newest-first. By default `status='pending'` returns un-read messages and atomically marks them read for THIS session (sessions are per-`session_id`; a fresh terminal re-sees previously-read messages, v2.0 final fix). Optional `since` (`'1h' | '24h' | '7d' | ISO | 'all'`) trims old mail (v2.1.6 default `'24h'`). When `status='pending'` returns 0 with `since<24h`, the response includes a `hint` field nudging toward `since='all'`. `peek=true` (v2.2.2) suppresses the read-side-effect entirely.\n\n" +
          "Returns: `{ messages: MessageRecord[], hint?: string }`.\n\n" +
          "Errors: `AUTH_FAILED`, `INVALID_INPUT` (bad `since` format), `RATE_LIMITED`.",
        inputSchema: zodToJsonSchema(GetMessagesSchema),
      },
      {
        name: "get_messages_summary",
        description:
          "Cheap, non-mutating mailbox preview (v2.1.6).\n\n" +
          "When to use: orchestrators scanning many inboxes per cycle, dashboards rendering a per-agent backlog count, or any flow where you want to see what is there without consuming it. After picking interesting IDs, expand them with `get_messages` (which CAN mutate) or read them by ID.\n\n" +
          "Behavior: same `status` + `since` filter surface as `get_messages`. Returns headers + a 100-char `content_preview` (decrypted on the fly when `RELAY_ENCRYPTION_KEY` is set). Never marks messages read. Auth: agent token (own mailbox only).\n\n" +
          "Returns: `{ messages: { id, from_agent, to_agent, priority, status, created_at, content_preview }[] }`.\n\n" +
          "Errors: `AUTH_FAILED`, `INVALID_INPUT`, `RATE_LIMITED`.",
        inputSchema: zodToJsonSchema(GetMessagesSummarySchema),
      },
      {
        name: "broadcast",
        description:
          "Fan out a single message to every registered agent (or every agent of a given role).\n\n" +
          "When to use: announcements, fleet-wide pings, role-targeted prompts ('all builders, refresh your dependencies'). For 1:1 use `send_message`. For topical group coordination prefer `post_to_channel`, channels persist membership and avoid spamming agents who have explicitly opted out by leaving.\n\n" +
          "Behavior: stores one row per recipient with `status='pending'`; the sender is excluded from the recipient set. Fires one `message.broadcast` webhook event for the whole batch (delivery_id + idempotency_key in the envelope). Optional `role` narrows the recipient set. Same payload size cap as `send_message` (`RELAY_MAX_PAYLOAD_BYTES`).\n\n" +
          "Returns: `{ delivered_count: number, recipients: string[] }`.\n\n" +
          "Errors: `AUTH_FAILED`, `PAYLOAD_TOO_LARGE`, `RATE_LIMITED`.",
        inputSchema: zodToJsonSchema(BroadcastSchema),
      },
      {
        name: "post_task",
        description:
          "Assign a tracked task to a specific agent.\n\n" +
          "When to use: work that should move through accept then complete/reject and report a result, with a single named owner. Prefer `post_task_auto` when you do not care which capable agent picks it up. Prefer `send_message` for free-text comms that do not need a state machine.\n\n" +
          "Behavior: creates a row with `status='posted'` and notifies `task.posted` webhook subscribers. The assignee accepts/completes/rejects via `update_task`; the assigner can `cancel` via the same call. Tasks have a heartbeat lease, if the assignee does not `update_task action='heartbeat'` within `RELAY_TASK_LEASE_SECONDS`, the health monitor surfaces the task as stuck. Auth: requester token; `to` must be a registered agent.\n\n" +
          "Returns: `{ task_id, status: 'posted', created_at }`.\n\n" +
          "Errors: `AUTH_FAILED`, `UNKNOWN_RECIPIENT`, `PAYLOAD_TOO_LARGE`, `RATE_LIMITED`.",
        inputSchema: zodToJsonSchema(PostTaskSchema),
      },
      {
        name: "post_task_auto",
        description:
          "Auto-route a task to the least-loaded capable agent (v2.0).\n\n" +
          "When to use: when you know the required capabilities but do not want to hard-code a specific assignee, load balances across the fleet. Prefer `post_task` when the assignee is intentional. Prefer `broadcast` for non-tracked notifications.\n\n" +
          "Behavior: picks the agent with the smallest accepted-task backlog whose capability set is a superset of `required_capabilities`. Tie-break: freshest `last_seen`. If no live agent qualifies, the task enters `status='queued'` and is auto-assigned the first time a capable agent calls `register_agent` (the assignment is included in that response's `auto_assigned`). By default the sender is excluded from routing, set `allow_self_assign=true` to opt in (v2.1).\n\n" +
          "Returns: `{ task_id, status: 'posted' | 'queued', assigned_to: string | null, created_at }`.\n\n" +
          "Errors: `AUTH_FAILED`, `PAYLOAD_TOO_LARGE`, `RATE_LIMITED`.",
        inputSchema: zodToJsonSchema(PostTaskAutoSchema),
      },
      {
        name: "update_task",
        description:
          "Drive a task through its state machine, or extend its lease.\n\n" +
          "When to use: assignees acknowledge work (`accept`), report outcome (`complete` / `reject`), or keep the lease alive on long-running tasks (`heartbeat`). Requesters cancel work they no longer need (`cancel`). Read-only progress checks belong in `get_task` / `get_tasks`.\n\n" +
          "Behavior: enforces role-by-action, accept/complete/reject/heartbeat are assignee-only; cancel is requester-only. Heartbeat refreshes `lease_renewed_at` without changing status, so the health monitor does not requeue a long task. `result` is required on complete/reject and surfaces in `get_task`. Fires `task.accepted` / `task.completed` / `task.rejected` webhooks. Auth: agent token (matching the action's required role).\n\n" +
          "Returns: `{ task_id, status, updated_at, result?: string }`.\n\n" +
          "Errors: `AUTH_FAILED`, `INVALID_STATE` (action not allowed in current status), `NOT_FOUND` (unknown task_id), `PAYLOAD_TOO_LARGE`.",
        inputSchema: zodToJsonSchema(UpdateTaskSchema),
      },
      {
        name: "get_tasks",
        description:
          "Query the tasks you are involved with.\n\n" +
          "When to use: assignees triaging their queue (`role='assigned'`), requesters checking on dispatched work (`role='posted'`). For a single task by id use `get_task`. For team-wide rollup use `get_standup`.\n\n" +
          "Behavior: pure read. Filters by `role` + `status`; default `status='all'`. Ordered by priority then `created_at` newest-first. Auth: agent token (only your own tasks are visible).\n\n" +
          "Returns: `{ tasks: TaskRecord[] }` (each row carries id, status, priority, title, description, result, requester, assignee, created_at, updated_at, lease_renewed_at).\n\n" +
          "Errors: `AUTH_FAILED`, `RATE_LIMITED`.",
        inputSchema: zodToJsonSchema(GetTasksSchema),
      },
      {
        name: "get_task",
        description:
          "Look up a single task by id.\n\n" +
          "When to use: any flow that needs the canonical state of one specific task, e.g., the assignee just heartbeat'd and wants to confirm the row, or the requester is checking on a known task_id from an earlier `post_task` response. For browsing many tasks use `get_tasks`.\n\n" +
          "Behavior: pure read. Returns the full task record including encrypted-at-rest description + result fields decrypted on the fly. Auth: agent token whose row is either the requester or assignee on this task, the relay refuses to leak third-party tasks.\n\n" +
          "Returns: `{ task: TaskRecord }`.\n\n" +
          "Errors: `AUTH_FAILED` (not your task), `NOT_FOUND`, `RATE_LIMITED`.",
        inputSchema: zodToJsonSchema(GetTaskSchema),
      },
      {
        name: "register_webhook",
        description:
          "Subscribe an HTTP endpoint to relay events.\n\n" +
          "When to use: reactive integrations, Slack notifier, audit pipeline, dashboard refresher. For polling-style observation prefer `get_standup` or `peek_inbox_version`. For local UIs the bundled `/dashboard` already consumes the live event stream.\n\n" +
          "Behavior: stores the subscription + optional HMAC `secret` (encrypted at rest with the same keyring the message body uses, v2.1 Phase 4p). Each delivery POSTs the event JSON with `X-Relay-Delivery-ID` + `X-Relay-Idempotency-Key` headers and an `X-Relay-Signature` HMAC-SHA256 if a secret was registered. Outbound URLs are SSRF-validated against the cloud-metadata + private-IP blocklist (v1.10). Events: `message.sent` | `message.broadcast` | `task.posted` | `task.accepted` | `task.completed` | `task.rejected` | `channel.message_posted` | `agent.unregistered` | `agent.spawned` | `'*'`. Optional `agent_filter` narrows by sender/recipient.\n\n" +
          "Returns: `{ webhook_id, url, event, has_secret: boolean }`.\n\n" +
          "Errors: `AUTH_FAILED` (caller needs `webhooks` capability), `URL_BLOCKED` (SSRF target), `INVALID_INPUT`, `RATE_LIMITED`.",
        inputSchema: zodToJsonSchema(RegisterWebhookSchema),
      },
      {
        name: "list_webhooks",
        description:
          "List every webhook subscription registered on the relay.\n\n" +
          "When to use: sanity-checking integrations ('is the Slack notifier still wired up?'), pre-cleanup audits, or building an admin UI. To narrow by event you currently filter client-side from this list.\n\n" +
          "Behavior: pure read. The raw HMAC `secret` is NEVER returned, each row exposes `has_secret: boolean` only. Auth: any registered agent (subscriptions are observable so admins can audit them, but secrets stay write-only).\n\n" +
          "Returns: `{ webhooks: { id, url, event, agent_filter, has_secret, created_at }[] }`.\n\n" +
          "Errors: `AUTH_FAILED`, `RATE_LIMITED`.",
        inputSchema: zodToJsonSchema(ListWebhooksSchema),
      },
      {
        name: "delete_webhook",
        description:
          "Tear down a webhook subscription by id.\n\n" +
          "When to use: cleanup when an integration is being retired, when the receiver URL is dead and you do not want delivery-log noise, or when rotating a webhook secret (delete + register fresh).\n\n" +
          "Behavior: removes the subscription row and any pending entries in `webhook_delivery_log`. Idempotent, deleting a non-existent id returns `deleted:false` instead of an error. Auth: the registrant's token, OR an authenticated agent with `webhooks` capability for cross-owner cleanup.\n\n" +
          "Returns: `{ deleted: boolean, webhook_id }`.\n\n" +
          "Errors: `AUTH_FAILED`, `INVALID_INPUT`.",
        inputSchema: zodToJsonSchema(DeleteWebhookSchema),
      },
      // v2.0 — Channel tools
      {
        name: "create_channel",
        description:
          "Create a named channel for many-to-many topical coordination.\n\n" +
          "When to use: ongoing conversations that more than two agents care about and that should persist beyond the lifetime of any one agent (e.g., `#deploys`, `#triage`). For 1:1 use `send_message`. For one-shot fleet-wide announcements use `broadcast`.\n\n" +
          "Behavior: creates the channel row and adds the creator as a member. Channels are flat (no hierarchy) and globally addressable by name. Auth: caller must hold the `channels` capability.\n\n" +
          "Returns: `{ channel_id, channel_name, created_by, created_at }`.\n\n" +
          "Errors: `AUTH_FAILED` (missing `channels` capability), `CHANNEL_EXISTS` (name collision), `INVALID_INPUT`, `RATE_LIMITED`.",
        inputSchema: zodToJsonSchema(CreateChannelSchema),
      },
      {
        name: "join_channel",
        description:
          "Subscribe to a channel so you receive its messages from your join time forward.\n\n" +
          "When to use: any agent that wants to follow a channel's traffic, joining is open to any authenticated caller (no invite gate; channels are intentionally low-friction). Pair with `post_to_channel` for posting and `get_channel_messages` for reading.\n\n" +
          "Behavior: inserts the membership row with `joined_at = now`. `get_channel_messages` and the `channel.message_posted` webhook event scope to messages with `created_at >= joined_at` for this member, so historical traffic is NOT replayed (a deliberate design choice, channels are streams, not archives). Idempotent: rejoining is a no-op. Auth: any agent token.\n\n" +
          "Returns: `{ joined: boolean, channel_id, joined_at }`.\n\n" +
          "Errors: `AUTH_FAILED`, `NOT_FOUND` (unknown channel_name), `RATE_LIMITED`.",
        inputSchema: zodToJsonSchema(JoinChannelSchema),
      },
      {
        name: "leave_channel",
        description:
          "Cancel your membership so you stop receiving a channel's messages.\n\n" +
          "When to use: channel is no longer relevant to your role, or you are shutting down and want to be a clean citizen (the dashboard surfaces ghost members otherwise). Idempotent, calling it on a channel you never joined is fine.\n\n" +
          "Behavior: removes the membership row. Past messages stay in the channel (other members still see them); your `joined_at` cursor is forgotten so a future `join_channel` starts a fresh observation window. Auth: agent token (you can only leave on your own behalf).\n\n" +
          "Returns: `{ left: boolean, channel_id }`.\n\n" +
          "Errors: `AUTH_FAILED`, `NOT_FOUND`, `RATE_LIMITED`.",
        inputSchema: zodToJsonSchema(LeaveChannelSchema),
      },
      {
        name: "post_to_channel",
        description:
          "Send a message into a channel you have joined.\n\n" +
          "When to use: ongoing topical coordination among multiple agents ('deploy started', 'triage thread for incident-12'). For 1:1 use `send_message`; for fleet-wide one-shots use `broadcast`. The audience is exactly the current channel membership at post time.\n\n" +
          "Behavior: stores a `channel_messages` row, fires the `channel.message_posted` webhook event, and surfaces in every member's `get_channel_messages` whose `joined_at <= post.created_at`. Same `RELAY_MAX_PAYLOAD_BYTES` cap as direct messages. Encrypted at rest when keyring is configured. Auth: caller must be a current member AND hold the `channels` capability.\n\n" +
          "Returns: `{ message_id, channel_id, created_at }`.\n\n" +
          "Errors: `AUTH_FAILED` (not a member, or missing `channels` cap), `PAYLOAD_TOO_LARGE`, `NOT_FOUND`, `RATE_LIMITED`.",
        inputSchema: zodToJsonSchema(PostToChannelSchema),
      },
      {
        name: "get_channel_messages",
        description:
          "Read the messages you are entitled to see in a channel.\n\n" +
          "When to use: any flow that observes channel traffic, dashboard refresh, post-incident review thread, role onboarding ('catch up on `#deploys`'). For 1:1 mailbox use `get_messages`; for whole-fleet activity use `get_standup`.\n\n" +
          "Behavior: scoped to messages with `created_at >= your join_time`. Ordered by priority then `created_at` newest-first. Pure read, channel posts have no per-recipient read state, so this call is fully idempotent. Auth: caller must be a current member.\n\n" +
          "Returns: `{ messages: ChannelMessage[] }` (id, channel_id, from_agent, content, priority, created_at).\n\n" +
          "Errors: `AUTH_FAILED` (not a member), `NOT_FOUND`, `RATE_LIMITED`.",
        inputSchema: zodToJsonSchema(GetChannelMessagesSchema),
      },
      // v2.0 final — status + health
      {
        name: "set_status",
        description:
          "Declare your operational state independently of presence.\n\n" +
          "When to use: tell the relay what kind of work you are in, so the health monitor and orchestrators can route or skip accordingly. Distinct from `last_seen`-derived presence (online/stale/offline), that one is computed; this one is your declared intent. For one-call team rollup use `get_standup`.\n\n" +
          "Behavior: updates the agent row's `agent_status` (idle | working | blocked | waiting_user | offline). v2.1.3 (I6) widened the enum from the original online/busy/away/offline. `busy` and `away` map to `working` for backward compatibility. The health monitor exempts `working`/`blocked`/`waiting_user` rows from automatic task reassignment. Auth: own agent token only.\n\n" +
          "Returns: `{ agent_name, agent_status, updated_at }`.\n\n" +
          "Errors: `AUTH_FAILED`, `INVALID_INPUT`, `RATE_LIMITED`.",
        inputSchema: zodToJsonSchema(SetStatusSchema),
      },
      {
        name: "health_check",
        description:
          "Report relay process health + live counts.\n\n" +
          "When to use: liveness probes (`/health` HTTP endpoint mirrors this surface), version-pinning checks during upgrades, dashboard footers. Cheaper than `get_standup` for binary up/down questions.\n\n" +
          "Behavior: pure read. Counts agents by presence, pending messages, active and queued tasks, channels, and webhook subscriptions. Reports `version` (from `package.json` via the v2.1 Phase 4a single source of truth) + `protocol_version` (the client-compat surface, distinct from package version). Works on stdio AND HTTP transports. No capability required, intentionally observable.\n\n" +
          "Returns: `{ status: 'ok', version, protocol_version, transport, uptime_seconds, agents: {...counts}, messages: {...counts}, tasks: {...counts}, channels, webhooks }`.\n\n" +
          "Errors: none expected (`status='ok'` is the only success shape).",
        inputSchema: zodToJsonSchema(HealthCheckSchema),
      },
      {
        name: "rotate_token",
        description:
          "Self-rotate your own agent_token (v2.1).\n\n" +
          "When to use: scheduled rotation, suspected token leak, or any time you want a fresh secret without losing identity. For admin-driven rotation of someone else's token use `rotate_token_admin`. To wipe the token entirely use `revoke_token`.\n\n" +
          "Behavior: requires the current valid token. For Managed agents (registered with `managed:true`) the relay enters a grace window during which BOTH old and new tokens authenticate, and a `priority='high'` push-message carries the new token to the agent so it can self-update. For unmanaged agents (default, Claude Code terminals), the response carries `restart_required:true` and the old token is invalid immediately.\n\n" +
          "Returns: `{ new_token, restart_required: boolean, grace_until?: ISO, push_sent?: boolean }`.\n\n" +
          "Errors: `AUTH_FAILED`, `RECOVERY_REQUIRED` (row in `recovery_pending`), `RATE_LIMITED`.",
        inputSchema: zodToJsonSchema(RotateTokenSchema),
      },
      {
        name: "rotate_token_admin",
        description:
          "Admin-initiated rotation of another agent's token (v2.1 Phase 4b.2).\n\n" +
          "When to use: operator-driven incident response, scheduled rotation across the fleet, or onboarding a Managed agent into a new key generation. Requires `rotate_others` capability on the rotator. For self-service use `rotate_token`. For revocation without re-issuance use `revoke_token`.\n\n" +
          "Behavior: same Managed-vs-unmanaged split as `rotate_token`. Managed targets get the new token via push-message + a grace window. Unmanaged targets return the new token in the rotator's response (the rotator delivers it out-of-band) and the response carries `restart_required:true`. The audit log records BOTH the rotator and the target so attribution survives.\n\n" +
          "Returns: `{ target_agent_name, new_token?, push_sent: boolean, restart_required: boolean, grace_until?: ISO }`.\n\n" +
          "Errors: `AUTH_FAILED` (rotator not authenticated, or missing `rotate_others`), `NOT_FOUND` (unknown target), `RATE_LIMITED`.",
        inputSchema: zodToJsonSchema(RotateTokenAdminSchema),
      },
      {
        name: "revoke_token",
        description:
          "Invalidate another agent's token (v2.1 Phase 4b.1 v2).\n\n" +
          "When to use: confirmed compromise, lost device, or graceful retirement of an agent name. For routine key-hygiene rotation prefer `rotate_token` / `rotate_token_admin` (those keep identity). For removing the agent entirely use `unregister_agent`.\n\n" +
          "Behavior: transitions the target row to `auth_state='recovery_pending'` (when `issue_recovery=true`, also returns a one-time `recovery_token` the operator hands off out-of-band; the agent re-registers via `register_agent` with that token to mint a fresh agent_token) or `auth_state='revoked'` (terminal, only `unregister_agent` + `register_agent` can reuse the name). Original `token_hash` is preserved for forensic correlation; the state column, not the hash, enforces rejection. Requires `revoke_others` capability.\n\n" +
          "Returns: `{ target_agent_name, new_state: 'recovery_pending' | 'revoked', recovery_token?: string }`.\n\n" +
          "Errors: `AUTH_FAILED`, `NOT_FOUND`, `INVALID_STATE` (already revoked), `RATE_LIMITED`.",
        inputSchema: zodToJsonSchema(RevokeTokenSchema),
      },
      // v2.1.4 — observation + lifecycle
      {
        name: "get_standup",
        description:
          "One-shot team-status synthesis for orchestrators (v2.1.4).\n\n" +
          "When to use: every observation cycle that would otherwise call `discover_agents` + `get_messages` + `get_tasks` and synthesize in-LLM. The relay does the rollup server-side so the caller burns near-zero tokens. For specific drill-downs after the rollup, fall through to the underlying tools.\n\n" +
          "Behavior: pure read. Given a window (`since: '15m' | '1h' | '3h' | '1d' | ISO`), returns active_agents (filtered to non-offline by default, set `include_offline=true` to include them), message_activity counts, task_state breakdown, and rule-based observation bullets ('agent X has been blocked >30min', etc.). Observations are hand-rolled heuristics, NO LLM on the relay side. Optional `agents` / `roles` arrays narrow the snapshot. Auth: any agent token.\n\n" +
          "Returns: `{ window, active_agents: Agent[], message_activity: {...}, task_state: {...}, observations: string[] }`.\n\n" +
          "Errors: `AUTH_FAILED`, `INVALID_INPUT` (bad `since`), `RATE_LIMITED`.",
        inputSchema: zodToJsonSchema(GetStandupSchema),
      },
      {
        name: "expand_capabilities",
        description:
          "Self-managed additive capability expansion (v2.1.4).\n\n" +
          "When to use: an agent registered (often via the SessionStart hook) with a narrow capability set and now needs more, e.g., a builder later picks up a `webhooks` integration. Reductions are NOT supported (`unregister_agent` + fresh `register_agent` for those). For privileged cross-agent edits, no equivalent admin tool exists by design, capability changes are caller-attested.\n\n" +
          "Behavior: caller presents their token; the requested set MUST be a SUPERSET of current caps (additive only, closes the v1.7.1 immutability gap without re-opening the capability-escalation CVE). Reductions reject with `REDUCTION_NOT_ALLOWED`. Requesting only already-held caps rejects with `NO_OP_EXPANSION`. The expansion is recorded in the audit log with the verified caller name.\n\n" +
          "Returns: `{ agent_name, capabilities: string[], added: string[] }`.\n\n" +
          "Errors: `AUTH_FAILED`, `REDUCTION_NOT_ALLOWED`, `NO_OP_EXPANSION`, `INVALID_INPUT`.",
        inputSchema: zodToJsonSchema(ExpandCapabilitiesSchema),
      },
      {
        name: "set_dashboard_theme",
        description:
          "Set the server-side default dashboard theme (v2.2.1).\n\n" +
          "When to use: org-level theme defaults ('every new operator should land on dark'), or programmatically applying a brand palette via `mode='custom'`. Each individual operator's `localStorage` preference still beats this default for repeat visits, this only affects first-visit theming for newly-connecting clients.\n\n" +
          "Behavior: stores the chosen theme + optional `custom_json` in `dashboard_prefs`. Modes: `'catppuccin'` (default Mocha palette), `'dark'` (tool-neutral), `'light'` (tool-neutral), `'custom'` (requires `custom_json` with all 13 CSS color tokens). No WebSocket push, already-open dashboards adopt on full reload. Auth: dashboard-secret-equivalent capability (treated as an admin operation).\n\n" +
          "Returns: `{ theme, custom_json: object | null, updated_at }`.\n\n" +
          "Errors: `AUTH_FAILED`, `INVALID_INPUT` (custom mode missing required tokens), `RATE_LIMITED`.",
        inputSchema: zodToJsonSchema(SetDashboardThemeSchema),
      },
      {
        name: "peek_inbox_version",
        description:
          "Cheap non-mutating mailbox version probe (v2.3.0 Phase 4s, ambient wake support).\n\n" +
          "When to use: low-rate polling that wants to know 'do I have new mail?' without paying a `get_messages` round-trip, clients diff `total_unread_count` against their cached value and only call `get_messages` on a change. Pair with the optional filesystem-marker wake (when `RELAY_FILESYSTEM_MARKERS=1`) for low-latency idle wake. For full mailbox content use `get_messages` (mutating) or `get_messages_summary` (preview).\n\n" +
          "Behavior: pure read. Returns `{ mailbox_id, epoch, last_seq, total_messages_count, total_unread_count }`. WATCH `total_unread_count` for new-mail detection, it advances on every `send_message`/`broadcast` to this agent. `last_seq` only advances when the recipient calls `get_messages` (read-cursor). `epoch` rotates on backup/restore, a client whose cached epoch no longer matches MUST reset its local `last_seen_seq` to 0 and re-drain. Auth: any agent token.\n\n" +
          "Returns: `{ mailbox_id, epoch, last_seq, total_messages_count, total_unread_count }`.\n\n" +
          "Errors: `AUTH_FAILED`, `NOT_FOUND` (unknown agent_name), `RATE_LIMITED`.",
        inputSchema: zodToJsonSchema(PeekInboxVersionSchema),
      },
    ];

  // Map of tool name -> which rate-limit bucket it lives in
  const RATE_BUCKETS: Record<string, "messages" | "tasks" | "spawns" | null> = {
    send_message: "messages",
    broadcast: "messages",
    post_task: "tasks",
    post_task_auto: "tasks",
    spawn_agent: "spawns",
  };

  function paramsSummary(tool: string, args: any): string {
    if (!args || typeof args !== "object") return "";
    // v2.1 Phase 4q LOW #6: extend keys so audit entries for channel tools,
    // revoke_token, webhook tools, and send_message carry the subject
    // identifier in params_summary (grep-able for incident review).
    const keys = [
      "name", "from", "to", "title", "event", "url", "action",
      "task_id", "agent_name", "role", "channel_name",
      "target_agent_name", "revoker_name", "webhook_id", "event_type",
    ];
    const picked: Record<string, any> = {};
    for (const k of keys) {
      if (k in args) picked[k] = typeof args[k] === "string" ? args[k].slice(0, 80) : args[k];
    }
    // v2.1 Phase 4q LOW #6: content gets special handling — 40-char preview
    // + original length. NEVER full body: privacy + log-size discipline
    // (encrypted params_json still carries the full structured record for
    // authorized review under RELAY_ENCRYPTION_KEY).
    if (typeof args.content === "string") {
      picked.content_preview = args.content.slice(0, 40);
      picked.content_len = args.content.length;
    }
    return JSON.stringify(picked);
  }

  // v2.1 Phase 4q MED #4: thin wrapper over the module-scope piggybackTick.
  // Kept as a named factory-scoped helper so future per-request gating can
  // layer in without rewiring call sites.
  function maybePiggybackWebhookRetries(): void {
    piggybackTick();
  }

  /**
   * Resolve the caller's agent name from tool args, tool-aware.
   * `name` is only a caller-identity for unregister_agent (self-delete) and
   * register_agent (bootstrap). For spawn_agent, `name` is the CHILD agent
   * being spawned — the caller must be identified by the token instead.
   */
  function agentFromArgs(toolName: string, args: any): string | null {
    if (!args || typeof args !== "object") return null;
    if (typeof args.from === "string") return args.from;
    if (typeof args.agent_name === "string") return args.agent_name;
    if (typeof args.creator === "string") return args.creator;
    // v2.1 Phase 4b.1 v2 (HIGH A fix): revoke_token's caller is revoker_name,
    // not target_agent_name. The dispatcher needs this to capability-check the
    // REVOKER, not the victim row being rewritten.
    if (toolName === "revoke_token" && typeof args.revoker_name === "string") {
      return args.revoker_name;
    }
    // v2.1 Phase 4b.2: same pattern for admin-initiated rotation. Caller is
    // `rotator_name`, not target_agent_name; dispatcher cap-checks `rotate_others`
    // on the rotator before the handler runs.
    if (toolName === "rotate_token_admin" && typeof args.rotator_name === "string") {
      return args.rotator_name;
    }
    if ((toolName === "unregister_agent" || toolName === "register_agent") && typeof args.name === "string") {
      return args.name;
    }
    return null;
  }

  async function dispatch(name: string, args: any): Promise<any> {
    switch (name) {
      case "register_agent":
        return handleRegisterAgent(RegisterAgentSchema.parse(args));
      case "discover_agents":
        return handleDiscoverAgents(DiscoverAgentsSchema.parse(args));
      case "unregister_agent":
        return handleUnregisterAgent(UnregisterAgentSchema.parse(args));
      case "spawn_agent":
        return handleSpawnAgent(SpawnAgentSchema.parse(args));
      case "send_message":
        return handleSendMessage(SendMessageSchema.parse(args));
      case "get_messages":
        return handleGetMessages(GetMessagesSchema.parse(args));
      case "get_messages_summary":
        return handleGetMessagesSummary(GetMessagesSummarySchema.parse(args));
      case "broadcast":
        return handleBroadcast(BroadcastSchema.parse(args));
      case "post_task":
        return handlePostTask(PostTaskSchema.parse(args));
      case "post_task_auto":
        return handlePostTaskAuto(PostTaskAutoSchema.parse(args));
      case "update_task":
        return handleUpdateTask(UpdateTaskSchema.parse(args));
      case "get_tasks":
        return handleGetTasks(GetTasksSchema.parse(args));
      case "get_task":
        return handleGetTask(GetTaskSchema.parse(args));
      case "register_webhook":
        return handleRegisterWebhook(RegisterWebhookSchema.parse(args));
      case "list_webhooks":
        return handleListWebhooks();
      case "delete_webhook":
        return handleDeleteWebhook(DeleteWebhookSchema.parse(args));
      // v2.0 — Channel tools
      case "create_channel":
        return handleCreateChannel(CreateChannelSchema.parse(args));
      case "join_channel":
        return handleJoinChannel(JoinChannelSchema.parse(args));
      case "leave_channel":
        return handleLeaveChannel(LeaveChannelSchema.parse(args));
      case "post_to_channel":
        return handlePostToChannel(PostToChannelSchema.parse(args));
      case "get_channel_messages":
        return handleGetChannelMessages(GetChannelMessagesSchema.parse(args));
      case "set_status":
        return handleSetStatus(SetStatusSchema.parse(args));
      case "health_check":
        return handleHealthCheck(HealthCheckSchema.parse(args));
      case "rotate_token":
        return handleRotateToken(RotateTokenSchema.parse(args));
      case "rotate_token_admin":
        return handleRotateTokenAdmin(RotateTokenAdminSchema.parse(args));
      case "revoke_token":
        return handleRevokeToken(RevokeTokenSchema.parse(args));
      case "get_standup":
        return handleGetStandup(GetStandupSchema.parse(args));
      case "expand_capabilities":
        return handleExpandCapabilities(ExpandCapabilitiesSchema.parse(args));
      case "set_dashboard_theme":
        return handleSetDashboardTheme(SetDashboardThemeSchema.parse(args));
      case "peek_inbox_version":
        return handlePeekInboxVersion(PeekInboxVersionSchema.parse(args));
      default:
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: `Unknown tool: ${name}` }),
            },
          ],
          isError: true,
        };
    }
  }

  /**
   * Resolve the raw token a caller presented, in order of precedence:
   *   1. args.agent_token (explicit tool input — MCP stdio + HTTP both work)
   *   2. HTTP X-Agent-Token header (captured in request context)
   *   3. RELAY_AGENT_TOKEN env var (for stdio flows)
   */
  function resolveToken(args: any): string | null {
    if (args && typeof args === "object" && typeof args.agent_token === "string" && args.agent_token.length > 0) {
      return args.agent_token;
    }
    const ctx = currentContext();
    if (ctx.headerAgentToken) return ctx.headerAgentToken;
    const envTok = process.env.RELAY_AGENT_TOKEN;
    if (envTok && envTok.length > 0) return envTok;
    return null;
  }

  /**
   * For tools that don't have an explicit caller-name field (spawn_agent,
   * register_webhook, list_webhooks, delete_webhook, discover_agents,
   * get_task), identify the caller by matching the presented token against
   * all registered agents. O(N) bcrypt, fine for small deployments. Defer
   * O(1) token-index lookup to v1.7.x if N grows.
   */
  function resolveCallerByToken(token: string): { name: string; capabilities: string[] } | null {
    const agents = getAgents();
    for (const a of agents) {
      const auth = getAgentAuthData(a.name);
      if (!auth) continue;
      // v2.1 Phase 4b.1 v2: token_hash is preserved post-revoke (forensic
      // integrity + CAS contract), so a hash-match alone is insufficient —
      // state must be 'active' (or rotation_grace, v2.1 Phase 4b.2) for the
      // token to authenticate.
      const state = (auth.auth_state ?? "active") as
        | "active"
        | "legacy_bootstrap"
        | "revoked"
        | "recovery_pending"
        | "rotation_grace";
      if (state === "active" && auth.token_hash && verifyToken(token, auth.token_hash)) {
        return { name: a.name, capabilities: a.capabilities };
      }
      // v2.1 Phase 4b.2: during rotation_grace, both the NEW token
      // (token_hash) and the PREVIOUS token (previous_token_hash) validate
      // the caller — until rotation_grace_expires_at. Piggyback cleanup
      // elsewhere will auto-expire the state.
      if (state === "rotation_grace") {
        const expiry = auth.rotation_grace_expires_at
          ? new Date(auth.rotation_grace_expires_at).getTime()
          : 0;
        const expired = expiry > 0 && Date.now() >= expiry;
        if (auth.token_hash && verifyToken(token, auth.token_hash)) {
          return { name: a.name, capabilities: a.capabilities };
        }
        if (!expired && auth.previous_token_hash && verifyToken(token, auth.previous_token_hash)) {
          return { name: a.name, capabilities: a.capabilities };
        }
      }
    }
    return null;
  }

  /**
   * Enforce auth + capability. Returns null if allowed, or an error result
   * to propagate to the caller.
   */
  function enforceAuth(toolName: string, args: any): any | null {
    // v1.7.1 + v2.1 (Phase 2b): register_agent has a trifurcated auth rule.
    //   - If the claimed name does NOT exist → bootstrap, no auth required.
    //   - If the existing row is a legacy pre-v1.7 agent (token_hash IS NULL)
    //     → plug-and-play migration path: bypass auth on this single call and
    //       let registerAgent issue a fresh token. Narrow, intentional: the
    //       row had no hash to verify against anyway, so any presented token
    //       is meaningless here. RELAY_ALLOW_LEGACY is NOT required for this
    //       path (it remains the escape hatch for non-register tool calls
    //       against unmigrated legacy rows).
    //   - Otherwise (existing row WITH token_hash) → re-register, caller
    //     must present a valid token. Closes the capability-escalation CVE
    //     where an unauthenticated caller could alter an existing agent's
    //     caps. Caps are ALSO preserved at the DB layer as defense-in-depth.
    // v2.1 Phase 4b.1 v2: register_agent is now quadrifurcated by auth_state.
    //   bootstrap          → no existing row, no auth required
    //   legacy_bootstrap   → Phase 2b migration path, no token required
    //   revoked            → hard-reject; operator must unregister_agent first
    //   recovery_pending   → require a valid recovery_token in args
    //   active             → standard re-register, valid token required
    if (toolName === "register_agent") {
      const claimedName = typeof args?.name === "string" ? args.name : null;
      if (!claimedName) return null; // let zod produce the validation error
      const existing = getAgentAuthData(claimedName);
      if (!existing) return null; // first registration — bootstrap path
      const state = (existing.auth_state ?? "active") as
        | "active"
        | "legacy_bootstrap"
        | "revoked"
        | "recovery_pending";
      if (state === "legacy_bootstrap") return null; // Phase 2b migration path
      if (state === "revoked") {
        return authError(
          `Agent "${claimedName}" is revoked. Use unregister_agent to free the name, or contact an administrator for a recovery token.`,
          ERROR_CODES.AUTH_FAILED
        );
      }
      if (state === "recovery_pending") {
        const recoveryTok = typeof args?.recovery_token === "string" ? args.recovery_token : null;
        if (
          !recoveryTok ||
          !existing.recovery_token_hash ||
          !verifyToken(recoveryTok, existing.recovery_token_hash)
        ) {
          return authError(
            `Agent "${claimedName}" is in recovery; a valid recovery_token is required to re-register.`,
            ERROR_CODES.AUTH_FAILED
          );
        }
        // v2.1 Phase 7p HIGH #2: pin the verified hash into the request context.
        // registerAgent will include it in the CAS predicate so an admin
        // reissue landing between this verify and the UPDATE fails the CAS —
        // the old ticket cannot win the race. Without this, the CAS would
        // anchor on registerAgent's own fresh SELECT (which could have already
        // moved to the new hash), silently completing a stale-ticket register.
        const ctx = requestContext.getStore();
        if (ctx) {
          ctx.verifiedRecoveryHash = existing.recovery_token_hash;
        }
        // Recovery token verified — let the handler proceed. registerAgent
        // (db layer) will transition state back to active + clear the
        // recovery_token_hash under state+hash+verified-hash CAS.
        return null;
      }
      // state === "active"
      const token = resolveToken(args);
      const result = authenticateAgent(claimedName, token, existing.token_hash, state);
      if (!result.ok) {
        // v2.1.3 I5: when the active row has a live session_id, a different
        // caller presenting a wrong (or missing) token is almost certainly
        // a name-collision attempt (two concurrent terminals claiming the
        // same RELAY_AGENT_NAME), not an honest token mismatch. Surface a
        // distinct error code so operators get the right remediation hint
        // (stop the holding terminal OR run `relay recover`) instead of a
        // generic AUTH_FAILED they might attribute to a token drift.
        //
        // When session_id IS NULL (row is offline, e.g. after a prior
        // terminal's SIGINT marked it offline per v2.1.3 I9 fix), the
        // generic AUTH_FAILED is correct — the name is re-claimable, but
        // only by someone presenting the existing token_hash's valid token.
        if (existing.session_id) {
          return authError(
            `Agent "${claimedName}" is currently held by a live session (session_id=${existing.session_id}). ` +
            `Another terminal appears to be registered under this name. Resolution paths: ` +
            `(a) close the holding terminal and let it mark the row offline on exit (v2.1.3+ preserves token_hash), then re-register; or ` +
            `(b) run "bin/relay recover ${claimedName} --yes" to force-release the name (destroys the row + audit_log entry), then re-register fresh.`,
            ERROR_CODES.NAME_COLLISION_ACTIVE
          );
        }
        return authError(result.reason!);
      }
      return null;
    }

    if (TOOLS_NO_AUTH.has(toolName)) return null;

    const explicitCaller = agentFromArgs(toolName, args);
    const token = resolveToken(args);
    const requiredCap = TOOL_CAPABILITY[toolName];

    let callerName: string | null = null;
    let callerCaps: string[] = [];

    if (explicitCaller) {
      // Tools that declare their caller (send_message from, get_messages agent_name, etc.)
      const auth = getAgentAuthData(explicitCaller);
      if (!auth) {
        return authError(`Agent "${explicitCaller}" is not registered. Call register_agent first.`);
      }
      const explicitState = (auth.auth_state ?? "active") as
        | "active"
        | "legacy_bootstrap"
        | "revoked"
        | "recovery_pending"
        | "rotation_grace";
      // v2.1 Phase 4b.2: pass grace inputs so rotation_grace rows can
      // verify the old token via previous_token_hash until expiry.
      const result = authenticateAgent(explicitCaller, token, auth.token_hash, explicitState, {
        previousTokenHash: auth.previous_token_hash ?? null,
        rotationGraceExpiresAt: auth.rotation_grace_expires_at ?? null,
      });
      if (!result.ok) return authError(result.reason!);
      callerName = explicitCaller;
      callerCaps = JSON.parse(auth.capabilities) as string[];
    } else {
      // Tools without an explicit caller field — identify by token.
      if (!token) {
        if (isLegacyGraceActive()) {
          // v2.1 Phase 4b.1 v2 (HIGH A fix): legacy grace allows identity-less
          // auth for bootstrap traffic ONLY. Capability-gated tools still
          // require explicit identification — grace does not mean privilege
          // escalation. Without this check, any no-token caller during grace
          // could invoke revoke_token (admin cap) and terminate any agent.
          if (requiredCap) {
            return authError(
              `Tool "${toolName}" requires "${requiredCap}" capability; legacy grace cannot be used to bypass capability checks. Register an agent with the capability and present its token.`,
              ERROR_CODES.CAP_DENIED
            );
          }
          return null;
        }
        return authError(`Tool "${toolName}" requires an agent_token. Pass it as agent_token arg, X-Agent-Token header, or RELAY_AGENT_TOKEN env.`);
      }
      const resolved = resolveCallerByToken(token);
      if (!resolved) {
        return authError(`agent_token did not match any registered agent.`);
      }
      callerName = resolved.name;
      callerCaps = resolved.capabilities;
    }

    // Special rule: unregister_agent — caller's token must match the target name.
    // (The token check above already verified the caller IS that agent.)

    // Capability check
    if (requiredCap && !callerCaps.includes(requiredCap)) {
      return authError(`Agent "${callerName}" lacks required capability "${requiredCap}" for tool "${toolName}". Capabilities must be set at register time.`, "CAP_DENIED");
    }

    // v2.1 Phase 4k: expose resolved caller name via request-context so handlers
    // that need authz beyond the dispatcher's capability check (e.g. get_task's
    // party-membership check) can read it without re-running auth.
    if (callerName) {
      const store = requestContext.getStore();
      if (store) store.callerName = callerName;
    }

    return null;
  }

  function authError(message: string, errorCode: ErrorCode = ERROR_CODES.AUTH_FAILED): any {
    // v2.1 Phase 4g: `error_code` is the stable machine-readable token;
    // `error` string stays byte-for-byte for back-compat. `auth_error: true`
    // kept for existing callers that check that flag.
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ success: false, error: message, error_code: errorCode, auth_error: true }, null, 2),
        },
      ],
      isError: true,
    };
  }

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    // v2.1 Phase 4k: guarantee a per-call request-context store exists so
    // enforceAuth can record the resolved caller name and handlers that need
    // it for authz (e.g. handleGetTask's party-membership check) can read
    // from a single source regardless of transport. HTTP already wraps each
    // request in requestContext.run(...); stdio does not — this makes both
    // paths equivalent for handler-layer consumers.
    const existingStore = requestContext.getStore();
    const callStore = existingStore ?? { transport: "stdio" as const };
    return requestContext.run(callStore, () => runCall(request));
  });

  async function runCall(request: { params: { name: string; arguments?: any } }): Promise<any> {
    const { name, arguments: args } = request.params;
    const claimedAgent = agentFromArgs(name, args);
    const summary = paramsSummary(name, args);
    const config = loadConfig();
    // v2.0 final (#34): debug breadcrumb on every tool call. Silent unless
    // RELAY_LOG_LEVEL=debug. Cheap — just a formatted string builder guarded
    // by the level check inside the logger.
    log.debug(`[dispatch] tool=${name} claimed_agent=${claimedAgent ?? "<unknown>"}`);

    // v2.3.0 Part B.2 — surface-shaping guard. A tool hidden by the active
    // profile's feature_bundles / tool_visibility is rejected with a
    // stable error_code + a hint naming the profile that would expose it.
    // Runs BEFORE auth so the caller learns "not available in this
    // profile" instead of "bad token" — clearer operator UX. Hidden tools
    // are also already omitted from tools/list so this path fires only
    // when a client crafted a call by name directly.
    {
      const { bundles, hidden } = resolveSurfaceShape();
      if (!isToolVisible(name, bundles, hidden)) {
        const requiredBundle = TOOL_BUNDLES[name] ?? "core";
        const profileHint =
          requiredBundle === "admin" || requiredBundle === "webhooks" || requiredBundle === "channels"
            ? "team"
            : requiredBundle === "managed-agents"
              ? "team"
              : "solo";
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: false,
                  error: `Tool "${name}" is not available under the active profile.`,
                  error_code: ERROR_CODES.TOOL_NOT_AVAILABLE,
                  hint:
                    `Tool requires feature bundle "${requiredBundle}". ` +
                    `Re-run \`relay init --profile=${profileHint} --force\` ` +
                    `or edit ~/.bot-relay/config.json to add "${requiredBundle}" ` +
                    `to feature_bundles.`,
                  tool: name,
                  required_bundle: requiredBundle,
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
    }

    // v1.7: auth + capability gate, before rate limit (fail early on bad creds)
    // v2.1 Phase 4q MED #3: auth MUST run before any operation that keys on
    // a claimed identity (rate limit, audit attribution). The pre-auth
    // claimed name is attacker-controlled; using it for rate-limit buckets
    // lets an unauthenticated caller rotate `from`/`agent_name` values to
    // evade quotas, and using it for audit corrupts forensics by attributing
    // arbitrary actions to other agents.
    const authBlock = enforceAuth(name, args);
    if (authBlock) {
      const ctx = currentContext();
      const structured = {
        tool: name,
        // v2.1 Phase 4q MED #3: auth rejected → agent_name is NULL. We
        // deliberately do NOT record the claimed name here; that would let
        // an unauthenticated caller forge audit attribution to any agent.
        agent_name: null,
        claimed_name: claimedAgent,
        auth_method: ctx.authenticated ? "http_secret" : "stdio_or_unauth",
        source_ip: ctx.sourceIp ?? null,
        result: "auth_rejected",
      };
      logAudit(null, name, summary, false, "auth_error", ctx.transport, structured);
      return authBlock;
    }

    // v2.1 Phase 4q MED #3: auth passed — `verifiedAgent` is the identity
    // vouched for by enforceAuth's token check (exposed via request-context
    // per Phase 4k). Falls back to args.name for register_agent bootstrap
    // (callerName is unset during first-registration — that's the name the
    // caller is claiming AS, but it's safe because bootstrap is gated on
    // row non-existence not identity).
    const ctx = currentContext();
    const verifiedAgent: string | null =
      ctx.callerName ??
      (name === "register_agent" && typeof args?.name === "string" ? args.name : null);

    // Rate limit check (only for the buckets we care about).
    // Key strategy (v1.6.1 + v2.1 Phase 4q MED #3):
    //  - stdio authed OR HTTP authed: key on verified caller name
    //  - unauth HTTP with source IP: key on IP (existing protection preserved)
    //  - anonymous stdio (legacy grace + no-cap tool): skip rate limit
    //    (no identity to bucket on — this matches existing behavior where
    //    `if (bucket && agent)` skipped when agent was null)
    const bucket = RATE_BUCKETS[name];
    if (bucket) {
      const limitKey = `rate_limit_${bucket}_per_hour` as const;
      const limit = config[limitKey];
      if (limit > 0) {
        const rateLimitKey =
          ctx.transport === "http" && !ctx.authenticated && ctx.sourceIp
            ? `ip:${ctx.sourceIp}`
            : verifiedAgent
              ? `agent:${verifiedAgent}`
              : null;
        if (rateLimitKey) {
          const result = checkAndRecordRateLimit(rateLimitKey, bucket, limit);
          if (!result.allowed) {
            const errMsg = `Rate limit exceeded on bucket "${bucket}": ${result.count}/${result.limit} per hour (key: ${rateLimitKey}). Wait for the window to reset.`;
            logAudit(verifiedAgent, name, summary, false, errMsg);
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({ success: false, error: errMsg, error_code: ERROR_CODES.RATE_LIMITED, rate_limit: result }, null, 2),
                },
              ],
              isError: true,
            };
          }
        }
      }
    }

    // v2.1 Phase 4q MED #4: webhook-retry piggyback. Runs every N-th tool
    // call regardless of whether the tool itself fires webhooks. Prevents
    // due retries from stalling when subsequent traffic lands on tools with
    // no matching subscriptions (e.g. discover_agents, get_messages).
    maybePiggybackWebhookRetries();

    const baseStructured = {
      tool: name,
      agent_name: verifiedAgent,
      auth_method: ctx.authenticated ? "http_secret" : (ctx.transport === "stdio" ? "stdio" : "unauth_http"),
      source_ip: ctx.sourceIp ?? null,
    };

    try {
      const result = await dispatch(name, args);
      const isError = (result as any).isError === true;
      logAudit(verifiedAgent, name, summary, !isError, null, ctx.transport, { ...baseStructured, result: isError ? "error" : "success" });
      // v2.4.0 Part D.1 — traffic capture. Off by default; enabled by
      // RELAY_RECORD_TRAFFIC=<path>. Never throws; swallow failures so
      // capture can't break a tool call.
      try {
        recordCall({
          tool: name,
          args,
          response: result,
          transport: ctx.transport,
          source_ip: ctx.sourceIp ?? null,
        });
      } catch {
        /* already swallowed inside recordCall; belt-and-suspenders */
      }
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // v2.1 Phase 4g: convert zod validation errors (typically from
      // <X>Schema.parse(args) inside dispatch) into structured success:false
      // responses with error_code. Distinguish PAYLOAD_TOO_LARGE (our
      // refine predicate's signature message) from generic VALIDATION so
      // clients can handle payload-oversize separately.
      if (err instanceof ZodError) {
        const isPayload = err.issues.some((i) => /RELAY_MAX_PAYLOAD_BYTES/.test(i.message));
        const code = isPayload ? ERROR_CODES.PAYLOAD_TOO_LARGE : ERROR_CODES.VALIDATION;
        const flat = err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
        logAudit(verifiedAgent, name, summary, false, flat, ctx.transport, { ...baseStructured, result: "validation", error_code: code });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: false, error: flat, error_code: code, issues: err.issues }, null, 2),
            },
          ],
          isError: true,
        };
      }
      logAudit(verifiedAgent, name, summary, false, msg, ctx.transport, { ...baseStructured, result: "exception", error_message: msg });
      throw err;
    }
  }

  return server;
}
