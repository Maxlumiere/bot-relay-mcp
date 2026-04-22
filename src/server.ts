// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
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
import { VERSION } from "./version.js";

export function createServer(): Server {
  const server = new Server(
    {
      name: "bot-relay",
      version: VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "register_agent",
        description:
          "Register this terminal as a named agent. Call this first to announce your identity, role, and capabilities to other agents. Uses upsert — safe to call multiple times.",
        inputSchema: zodToJsonSchema(RegisterAgentSchema),
      },
      {
        name: "discover_agents",
        description:
          "List all registered agents with their current status (online/stale/offline). Optionally filter by role.",
        inputSchema: zodToJsonSchema(DiscoverAgentsSchema),
      },
      {
        name: "unregister_agent",
        description:
          "Remove an agent from the relay. Use when a terminal is closing to let the relay reflect true presence. Idempotent — returns removed:false if the agent was not registered.",
        inputSchema: zodToJsonSchema(UnregisterAgentSchema),
      },
      {
        name: "spawn_agent",
        description:
          "Spawn a new Claude Code terminal pre-configured as a relay agent. Opens a new iTerm2/Terminal.app window with RELAY_AGENT_NAME/ROLE/CAPABILITIES set. The SessionStart hook auto-registers the agent on startup. Optionally queue an initial_message that the new agent sees on arrival. v2.1.4: optional brief_file_path threads a durable task-brief file path into the KICKSTART prompt so respawned agents read canonical scope from disk (not inbox messages that can read as injection). macOS only.",
        inputSchema: zodToJsonSchema(SpawnAgentSchema),
      },
      {
        name: "send_message",
        description:
          "Send a text message to a specific agent. The message is stored and the recipient will see it when they call get_messages.",
        inputSchema: zodToJsonSchema(SendMessageSchema),
      },
      {
        name: "get_messages",
        description:
          "Check your mailbox for messages. Returns messages addressed to you, newest first. Pending messages are automatically marked as read. v2.1.6: optional `since` trims stale backlog (default '24h'; pass 'all' or null for the pre-v2.1.6 unlimited behavior). v2.2.1: when status='pending' AND count=0 AND since<24h, response includes a `hint` field nudging toward since='all' — the `since` filter trims both pending AND read mail, so a narrow window can hide older pending work.",
        inputSchema: zodToJsonSchema(GetMessagesSchema),
      },
      {
        name: "get_messages_summary",
        description:
          "v2.1.6: lightweight inbox preview. Same filter surface as get_messages (status + since) but returns only message headers + a 100-char content_preview. Does NOT mark messages read — pure observation. Use to scan an inbox cheaply then expand chosen IDs via get_messages.",
        inputSchema: zodToJsonSchema(GetMessagesSummarySchema),
      },
      {
        name: "broadcast",
        description:
          "Send a message to all registered agents (or all agents with a specific role). Excludes the sender.",
        inputSchema: zodToJsonSchema(BroadcastSchema),
      },
      {
        name: "post_task",
        description:
          "Assign a task to another agent. Creates a task with status 'posted'. The assigned agent can accept, complete, or reject it.",
        inputSchema: zodToJsonSchema(PostTaskSchema),
      },
      {
        name: "post_task_auto",
        description:
          "Auto-route a task to the least-loaded agent whose capabilities match ALL `required_capabilities`. Tie-break: freshest last_seen. If no agent matches, the task is queued and auto-assigned when a capable agent registers. v2.0.",
        inputSchema: zodToJsonSchema(PostTaskAutoSchema),
      },
      {
        name: "update_task",
        description:
          "Update a task's status. Actions: accept/complete/reject (assignee), cancel (requester), heartbeat (assignee, renews task lease). Heartbeat does not change status; it refreshes lease_renewed_at so the health monitor does not requeue the task.",
        inputSchema: zodToJsonSchema(UpdateTaskSchema),
      },
      {
        name: "get_tasks",
        description:
          "Query your task queue. Use role 'assigned' to see tasks given to you, or 'posted' to see tasks you created. Filter by status.",
        inputSchema: zodToJsonSchema(GetTasksSchema),
      },
      {
        name: "get_task",
        description:
          "Get a single task by ID. Returns full task details including status, result, and timestamps.",
        inputSchema: zodToJsonSchema(GetTaskSchema),
      },
      {
        name: "register_webhook",
        description:
          "Register a webhook to receive HTTP POST notifications for relay events (message.sent, task.posted, etc., or '*' for all). Optional agent filter and HMAC secret.",
        inputSchema: zodToJsonSchema(RegisterWebhookSchema),
      },
      {
        name: "list_webhooks",
        description: "List all registered webhook subscriptions.",
        inputSchema: zodToJsonSchema(ListWebhooksSchema),
      },
      {
        name: "delete_webhook",
        description: "Delete a webhook subscription by ID.",
        inputSchema: zodToJsonSchema(DeleteWebhookSchema),
      },
      // v2.0 — Channel tools
      {
        name: "create_channel",
        description: "Create a named channel for multi-agent coordination. Requires 'channels' capability.",
        inputSchema: zodToJsonSchema(CreateChannelSchema),
      },
      {
        name: "join_channel",
        description: "Join an existing channel. Any authenticated agent can join any channel.",
        inputSchema: zodToJsonSchema(JoinChannelSchema),
      },
      {
        name: "leave_channel",
        description: "Leave a channel you are a member of.",
        inputSchema: zodToJsonSchema(LeaveChannelSchema),
      },
      {
        name: "post_to_channel",
        description: "Post a message to a channel. Requires membership and 'channels' capability.",
        inputSchema: zodToJsonSchema(PostToChannelSchema),
      },
      {
        name: "get_channel_messages",
        description: "Read messages from a channel you are a member of. Returns messages since your join time, newest first, in priority order.",
        inputSchema: zodToJsonSchema(GetChannelMessagesSchema),
      },
      // v2.0 final — status + health
      {
        name: "set_status",
        description: "Set your operational status: online (default), busy (exempts you from health-monitor task reassignment), away (same treatment as busy), or offline (graceful shutdown). Distinct from presence (last_seen) — this is your declared working state.",
        inputSchema: zodToJsonSchema(SetStatusSchema),
      },
      {
        name: "health_check",
        description: "Report relay health: status, version, uptime, and live counts (agents, pending messages, active/queued tasks, channels). Works on both stdio and HTTP transports. No capability required.",
        inputSchema: zodToJsonSchema(HealthCheckSchema),
      },
      {
        name: "rotate_token",
        description: "v2.1: rotate your own agent_token. Prove identity with the current token; get a fresh one back. Managed agents (registered with managed:true) enter a grace window during which both the old and new token auth; a priority=high push-message is sent to the agent with the new token. Unmanaged agents (default) get restart_required:true in the response — the old token is invalid immediately.",
        inputSchema: zodToJsonSchema(RotateTokenSchema),
      },
      {
        name: "rotate_token_admin",
        description: "v2.1 Phase 4b.2: admin-initiated rotation of ANOTHER agent's token. Requires 'rotate_others' capability on the rotator. Managed targets enter a grace window + receive the new token via push-message; unmanaged targets return the new token to the rotator for out-of-band delivery + restart_required:true.",
        inputSchema: zodToJsonSchema(RotateTokenAdminSchema),
      },
      {
        name: "revoke_token",
        description: "v2.1 Phase 4b.1 v2: revoke another agent's token (admin capability required). Transitions the target row to auth_state='recovery_pending' (if issue_recovery=true, returns a one-time recovery_token the operator hands off out-of-band; re-register via register_agent with recovery_token transitions back to active) or 'revoked' (terminal — only unregister_agent + register_agent can reuse the name). The original token_hash is preserved for forensic correlation; the state gate — not the hash — enforces rejection.",
        inputSchema: zodToJsonSchema(RevokeTokenSchema),
      },
      // v2.1.4 — observation + lifecycle
      {
        name: "get_standup",
        description: "v2.1.4 (I12): one-shot team-status synthesis for orchestrators. Pure read-only. Given a window (`since: '15m' | '1h' | '3h' | '1d' | ISO`), returns active_agents + message_activity + task_state + rule-based observation bullets — all computed server-side so the caller burns near-zero tokens. No LLM on the relay side; observations are hand-rolled heuristics. Use instead of polling discover_agents + get_messages + get_tasks and synthesizing in-LLM.",
        inputSchema: zodToJsonSchema(GetStandupSchema),
      },
      {
        name: "expand_capabilities",
        description: "v2.1.4 (I11): self-managed ADDITIVE capability expansion. Closes the v1.7.1 immutability gap for agents that hook-registered with a narrow cap set and later need more. Caller presents their token; request MUST be a superset of current caps (reductions rejected with REDUCTION_NOT_ALLOWED — those still need unregister + re-register). Requesting already-held caps with no new additions rejects with NO_OP_EXPANSION.",
        inputSchema: zodToJsonSchema(ExpandCapabilitiesSchema),
      },
      {
        name: "set_dashboard_theme",
        description:
          "v2.2.1: set the server-side default dashboard theme. Modes: 'catppuccin' (default Mocha palette) | 'dark' (tool-neutral) | 'light' (tool-neutral) | 'custom' (requires custom_json with all 13 CSS tokens). Newly-connecting dashboard clients read this on first visit only — each client's localStorage preference beats the server default locally (path-1 client-only design). No WebSocket push; already-connected dashboards surface the change on full reload.",
        inputSchema: zodToJsonSchema(SetDashboardThemeSchema),
      },
    ],
  }));

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
