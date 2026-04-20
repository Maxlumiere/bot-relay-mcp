// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { z } from "zod";

// --- Zod Schemas for tool inputs ---

/**
 * v2.0 final (#7): guard every agent-supplied payload against OOM. The byte
 * limit is UTF-8-aware (counts bytes, not characters) because an attacker
 * could send a short character string that expands to many bytes via emoji
 * surrogates or combining marks.
 *
 * Configurable via RELAY_MAX_PAYLOAD_BYTES env var (default 65536 = 64KB).
 * The HTTP body-parser limit (1MB) is the outer bound; this is the inner
 * per-field limit.
 */
function payloadMaxBytes(): number {
  const env = parseInt(process.env.RELAY_MAX_PAYLOAD_BYTES || "65536", 10);
  if (!Number.isFinite(env) || env < 1) return 65536;
  return env;
}
const payloadField = (fieldName: string) =>
  z.string().min(1).refine((s) => Buffer.byteLength(s, "utf8") <= payloadMaxBytes(), {
    message: `${fieldName} exceeds RELAY_MAX_PAYLOAD_BYTES (${payloadMaxBytes()} bytes). Reduce size or raise the env var.`,
  });

/**
 * v1.7: the agent_token field is optional on every tool schema, because stdio
 * clients pull it from RELAY_AGENT_TOKEN env and HTTP clients can send it via
 * X-Agent-Token header. The dispatcher resolves it from whichever source and
 * validates at the auth layer.
 */
const AgentTokenField = z.string().optional().describe("Your agent token (from register_agent response). Optional here — also resolvable from RELAY_AGENT_TOKEN env or X-Agent-Token header.");

export const RegisterAgentSchema = z.object({
  name: z.string().min(1).max(64).describe("Human-readable agent name"),
  role: z.string().min(1).max(64).describe("Agent role (e.g. orchestrator, builder, ops)"),
  capabilities: z.array(z.string()).describe("List of capabilities"),
  description: z.string().max(512).optional().describe("v2.0: optional human-readable description (max 512 chars). Shown in discover_agents + dashboard. Mutable on re-register — if omitted, previous value preserved."),
  agent_token: AgentTokenField,
  recovery_token: z.string().min(1).optional().describe("v2.1 Phase 4b.1 v2: required when re-registering an agent whose auth_state is 'recovery_pending'. Obtained from the revoker's revoke_token response (shown ONCE) and handed off to the operator out-of-band."),
  managed: z.boolean().default(false).describe("v2.1 Phase 4b.2: true = agent is a Managed Agent wrapper that can parse push-token messages + self-update its local config on rotation. false (default) = Claude Code terminal or equivalent (restart-required on rotation). Immutable after first registration — change requires unregister + fresh register."),
});

export const DiscoverAgentsSchema = z.object({
  role: z.string().optional().describe("Filter by role"),
  agent_token: AgentTokenField,
});

export const UnregisterAgentSchema = z.object({
  name: z.string().min(1).max(64).describe("Agent name to unregister"),
  agent_token: AgentTokenField,
});

// Defense-in-depth (v1.6.2): these patterns MUST match the validation in
// bin/spawn-agent.sh. If you change one, change the other. The TS layer is
// the primary defense; the shell layer is the belt-and-suspenders.
// Deliberately NO shell metacharacters, NO whitespace, NO null bytes, NO
// control characters, NO unicode codepoints outside the printable ASCII
// allowlist. This makes unicode-normalization attacks structurally impossible.
const SPAWN_IDENT_PATTERN = /^[A-Za-z0-9_.-]+$/;
const SPAWN_CAPABILITY_PATTERN = /^[A-Za-z0-9_.-]+$/;
const SPAWN_CWD_PATTERN = /^\/[A-Za-z0-9_./ -]+$/;
// Disallow any of these anywhere in cwd — even if the base pattern lets them through
const SPAWN_CWD_FORBIDDEN = /[`;$&|<>"'*?\n\r\t\0]/;

export const SpawnAgentSchema = z.object({
  name: z.string()
    .min(1).max(64)
    .regex(SPAWN_IDENT_PATTERN, "name must match [A-Za-z0-9_.-]+ (no spaces, no shell metachars)")
    .describe("Name for the new agent — [A-Za-z0-9_.-]+, max 64 chars"),
  role: z.string()
    .min(1).max(64)
    .regex(SPAWN_IDENT_PATTERN, "role must match [A-Za-z0-9_.-]+ (no spaces, no shell metachars)")
    .describe("Role of the new agent — [A-Za-z0-9_.-]+, max 64 chars"),
  capabilities: z.array(
    z.string()
      .min(1).max(64)
      .regex(SPAWN_CAPABILITY_PATTERN, "each capability must match [A-Za-z0-9_.-]+")
  ).default([]).describe("Capabilities of the new agent"),
  cwd: z.string()
    .max(1024)
    .regex(SPAWN_CWD_PATTERN, "cwd must be an absolute path (starts with /) containing only [A-Za-z0-9_./ -]")
    .refine((v) => !SPAWN_CWD_FORBIDDEN.test(v), "cwd contains a forbidden character (shell metachar or control char)")
    .optional()
    .describe("Absolute path working directory for the new terminal. Defaults to user's home."),
  initial_message: z.string().max(10000).optional().describe("Optional message to queue for the new agent before it spawns. It will see this on session start."),
  agent_token: AgentTokenField,
});

export const SendMessageSchema = z.object({
  from: z.string().min(1).describe("Sender agent name"),
  to: z.string().min(1).describe("Recipient agent name"),
  content: payloadField("content").describe("Message content (max 64KB by default; see RELAY_MAX_PAYLOAD_BYTES)"),
  priority: z.enum(["normal", "high"]).default("normal").describe("Message priority"),
  agent_token: AgentTokenField,
});

export const GetMessagesSchema = z.object({
  agent_name: z.string().min(1).describe("Your agent name"),
  status: z.enum(["pending", "read", "all"]).default("pending").describe("Filter by status"),
  limit: z.number().int().min(1).max(100).default(20).describe("Max messages to return"),
  agent_token: AgentTokenField,
});

export const BroadcastSchema = z.object({
  from: z.string().min(1).describe("Sender agent name"),
  content: payloadField("content").describe("Broadcast content (max 64KB by default; see RELAY_MAX_PAYLOAD_BYTES)"),
  role: z.string().optional().describe("Only send to agents with this role"),
  agent_token: AgentTokenField,
});

export const PostTaskSchema = z.object({
  from: z.string().min(1).describe("Requester agent name"),
  to: z.string().min(1).describe("Assigned agent name"),
  title: z.string().min(1).max(256).describe("Short task title"),
  description: payloadField("description").describe("Full task description (max 64KB by default; see RELAY_MAX_PAYLOAD_BYTES)"),
  priority: z.enum(["low", "normal", "high", "critical"]).default("normal").describe("Task priority"),
  agent_token: AgentTokenField,
});

/**
 * v2.1.3 (I6) — agent_status enum widened from (online | busy | away | offline)
 * to (idle | working | blocked | waiting_user | stale | offline). Legacy values
 * stay accepted on input and map to the new enum:
 *   online → idle
 *   busy   → working
 *   away   → blocked
 *   offline → offline (unchanged)
 *
 * `stale` is RESERVED for relay auto-transitions only (agents shouldn't
 * self-declare stale — it's an observation-layer signal). The Zod schema
 * accepts it in `AgentStatusEnum` for completeness of the read-side type,
 * but `SetStatusInputEnum` excludes it for writes.
 */
export const AgentStatusEnum = z.enum([
  "idle",
  "working",
  "blocked",
  "waiting_user",
  "stale",
  "offline",
]);

/** v2.1.3 — union accepted by set_status: new values + legacy aliases. */
export const SetStatusInputEnum = z.enum([
  // new
  "idle",
  "working",
  "blocked",
  "waiting_user",
  "offline",
  // legacy (back-compat, normalized in handler)
  "online",
  "busy",
  "away",
]);

export const SetStatusSchema = z.object({
  agent_name: z.string().min(1).describe("Your agent name"),
  status: SetStatusInputEnum.describe(
    "Operational status — v2.1.3 widened enum: " +
    "idle (default active state), working (actively executing a task; exempts from health-monitor reassignment), " +
    "blocked (cannot proceed; also exempt), waiting_user (paused pending operator input), " +
    "offline (graceful shutdown). Legacy aliases still accepted: online→idle, busy→working, away→blocked. " +
    "`stale` is relay-computed, not agent-settable."
  ),
  agent_token: AgentTokenField,
});

export const HealthCheckSchema = z.object({
  agent_token: AgentTokenField,
});

export const UpdateTaskSchema = z.object({
  task_id: z.string().min(1).describe("Task ID to update"),
  agent_name: z.string().min(1).describe("Your agent name"),
  action: z.enum(["accept", "complete", "reject", "cancel", "heartbeat"]).describe("Action to take. accept/complete/reject/heartbeat are assignee actions; cancel is requester-only."),
  result: z.string().optional().refine(
    (s) => s === undefined || Buffer.byteLength(s, "utf8") <= payloadMaxBytes(),
    { message: "result exceeds RELAY_MAX_PAYLOAD_BYTES" }
  ).describe("Completion notes, rejection reason, or cancellation reason (max 64KB by default)"),
  agent_token: AgentTokenField,
});

export const GetTasksSchema = z.object({
  agent_name: z.string().min(1).describe("Your agent name"),
  role: z.enum(["assigned", "posted"]).default("assigned").describe("'assigned' = tasks for you, 'posted' = tasks you created"),
  status: z.enum(["queued", "posted", "accepted", "completed", "rejected", "cancelled", "all"]).default("all").describe("Filter by task status"),
  limit: z.number().int().min(1).max(100).default(20).describe("Max tasks to return"),
  agent_token: AgentTokenField,
});

export const PostTaskAutoSchema = z.object({
  from: z.string().min(1).describe("Requester agent name"),
  title: z.string().min(1).max(256).describe("Short task title"),
  description: payloadField("description").describe("Full task description (max 64KB by default)"),
  required_capabilities: z.array(z.string().min(1).max(64)).min(1).describe("Capabilities the assigned agent must have (ALL must match). Also used to auto-assign from the queue when a capable agent registers later."),
  priority: z.enum(["low", "normal", "high", "critical"]).default("normal").describe("Task priority"),
  allow_self_assign: z.boolean().default(false).describe("v2.1: opt-in flag to let the sender self-assign the task when they match the required capabilities. Default false — sender is excluded from routing so auto-routed work reaches peers."),
  agent_token: AgentTokenField,
});

export const GetTaskSchema = z.object({
  task_id: z.string().min(1).describe("Task ID to look up"),
  agent_token: AgentTokenField,
});

// v2.1 Phase 4b.1 — token lifecycle. agent_token stays OPTIONAL on the schema
// (matches the rest of the tool suite); the dispatcher resolves it from
// args / X-Agent-Token header / RELAY_AGENT_TOKEN env and authenticates
// before the handler runs.
export const RotateTokenSchema = z.object({
  agent_name: z.string().min(1).describe("Agent name — must match the token's owner"),
  agent_token: AgentTokenField,
  grace_seconds: z.number().int().min(0).max(3600).optional().describe("v2.1 Phase 4b.2: override the grace window length for managed agents. Clamped to [0, 3600]. 0 forces hard-cut (immediate invalidation) even for managed agents. Unmanaged agents ignore this field (no grace applicable). Default: RELAY_ROTATION_GRACE_SECONDS env var (fallback 900)."),
});

export const RotateTokenAdminSchema = z.object({
  target_agent_name: z.string().min(1).describe("Name of the agent whose token to rotate. Must differ from rotator_name — self-rotation uses rotate_token."),
  rotator_name: z.string().min(1).describe("Name of the admin-capable agent performing the rotation. Must hold 'rotate_others' capability."),
  grace_seconds: z.number().int().min(0).max(3600).optional().describe("v2.1 Phase 4b.2: override the grace window length for managed targets. Clamped to [0, 3600]. 0 forces hard-cut. Unmanaged targets ignore this field. Default: RELAY_ROTATION_GRACE_SECONDS env var (fallback 900)."),
  agent_token: AgentTokenField,
});

export const RevokeTokenSchema = z.object({
  target_agent_name: z.string().min(1).describe("Name of the agent whose token to revoke."),
  revoker_name: z.string().min(1).describe("Name of the agent performing the revoke — must hold the 'admin' capability."),
  issue_recovery: z.boolean().default(true).describe("v2.1 Phase 4b.1 v2: if true (default), issue a one-time recovery_token returned on this response (shown ONCE). Target can re-register with that token to resume as 'active'. If false, revocation is terminal — operator must unregister_agent + register_agent to recreate the row."),
  agent_token: AgentTokenField,
});

// --- Channel schemas (v2.0) ---

const CHANNEL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]?$/;

export const CreateChannelSchema = z.object({
  name: z.string().min(1).max(64).regex(CHANNEL_NAME_PATTERN, "Channel name must be lowercase alphanumeric + hyphens, 1-64 chars").describe("Channel name (lowercase, alphanumeric + hyphens)"),
  description: z.string().max(256).optional().describe("Channel description"),
  creator: z.string().min(1).describe("Agent creating the channel"),
  agent_token: AgentTokenField,
});

export const JoinChannelSchema = z.object({
  channel_name: z.string().min(1).describe("Channel to join"),
  agent_name: z.string().min(1).describe("Agent joining"),
  agent_token: AgentTokenField,
});

export const LeaveChannelSchema = z.object({
  channel_name: z.string().min(1).describe("Channel to leave"),
  agent_name: z.string().min(1).describe("Agent leaving"),
  agent_token: AgentTokenField,
});

export const PostToChannelSchema = z.object({
  channel_name: z.string().min(1).describe("Channel to post to"),
  from: z.string().min(1).describe("Sender agent name"),
  content: payloadField("content").describe("Channel message content (max 64KB by default)"),
  priority: z.enum(["normal", "high"]).default("normal").describe("Message priority"),
  agent_token: AgentTokenField,
});

export const GetChannelMessagesSchema = z.object({
  channel_name: z.string().min(1).describe("Channel to read from"),
  agent_name: z.string().min(1).describe("Agent reading (must be a member)"),
  limit: z.number().int().min(1).max(100).default(20).describe("Max messages to return"),
  since: z.string().optional().describe("ISO timestamp — only return messages after this time"),
  agent_token: AgentTokenField,
});

export const WebhookEventEnum = z.enum([
  "message.sent",
  "message.broadcast",
  "task.posted",
  "task.accepted",
  "task.completed",
  "task.rejected",
  "task.cancelled",
  "task.auto_routed",
  "task.health_reassigned",
  "agent.unregistered",
  "agent.spawned",
  "agent.health_timeout",
  "channel.message_posted",
  "webhook.delivery_failed",
  "*",
]);

export const RegisterWebhookSchema = z.object({
  url: z.string().url().describe("HTTP(S) URL to POST events to"),
  event: WebhookEventEnum.describe("Event to subscribe to, or '*' for all events"),
  filter: z.string().optional().describe("Optional agent name filter (only fire if from_agent or to_agent matches)"),
  secret: z.string().optional().describe("Optional secret for HMAC signature (sent in X-Relay-Signature header)"),
  agent_token: AgentTokenField,
});

export const ListWebhooksSchema = z.object({
  agent_token: AgentTokenField,
});

export const DeleteWebhookSchema = z.object({
  webhook_id: z.string().min(1).describe("Webhook subscription ID to delete"),
  agent_token: AgentTokenField,
});

// --- TypeScript types ---

export type RegisterAgentInput = z.infer<typeof RegisterAgentSchema>;
export type DiscoverAgentsInput = z.infer<typeof DiscoverAgentsSchema>;
export type UnregisterAgentInput = z.infer<typeof UnregisterAgentSchema>;
export type SpawnAgentInput = z.infer<typeof SpawnAgentSchema>;
export type SendMessageInput = z.infer<typeof SendMessageSchema>;
export type GetMessagesInput = z.infer<typeof GetMessagesSchema>;
export type BroadcastInput = z.infer<typeof BroadcastSchema>;
export type PostTaskInput = z.infer<typeof PostTaskSchema>;
export type PostTaskAutoInput = z.infer<typeof PostTaskAutoSchema>;
export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;
export type GetTasksInput = z.infer<typeof GetTasksSchema>;
export type GetTaskInput = z.infer<typeof GetTaskSchema>;
export type RegisterWebhookInput = z.infer<typeof RegisterWebhookSchema>;
export type ListWebhooksInput = z.infer<typeof ListWebhooksSchema>;
export type DeleteWebhookInput = z.infer<typeof DeleteWebhookSchema>;
export type WebhookEvent = z.infer<typeof WebhookEventEnum>;
export type SetStatusInput = z.infer<typeof SetStatusSchema>;
export type HealthCheckInput = z.infer<typeof HealthCheckSchema>;
export type CreateChannelInput = z.infer<typeof CreateChannelSchema>;
export type JoinChannelInput = z.infer<typeof JoinChannelSchema>;
export type LeaveChannelInput = z.infer<typeof LeaveChannelSchema>;
export type PostToChannelInput = z.infer<typeof PostToChannelSchema>;
export type GetChannelMessagesInput = z.infer<typeof GetChannelMessagesSchema>;
export type RotateTokenInput = z.infer<typeof RotateTokenSchema>;
export type RotateTokenAdminInput = z.infer<typeof RotateTokenAdminSchema>;
export type RevokeTokenInput = z.infer<typeof RevokeTokenSchema>;

/**
 * v2.1 Phase 4b.1 v2: explicit auth-state machine. Replaces the v1
 * `token_hash IS NULL` overload (which conflated "pre-v1.7 legacy migration"
 * with "admin-revoked"). Transitions are CAS-gated at each write site.
 *
 *  - active            normal agent, token_hash set, auth via token verify
 *  - legacy_bootstrap  pre-v1.7 row (token_hash IS NULL), one-shot migration
 *                      via plain register_agent mint
 *  - revoked           terminal; admin must unregister_agent + fresh register
 *                      to re-use the name. token_hash preserved for forensics.
 *  - recovery_pending  admin issued a one-time recovery_token; target
 *                      re-registers with it to transition back to active
 */
export type AgentAuthState =
  | "active"
  | "legacy_bootstrap"
  | "revoked"
  | "recovery_pending"
  /** v2.1 Phase 4b.2: managed agent is mid-rotation. Old token_hash lives in `previous_token_hash`, new in `token_hash`, both valid until `rotation_grace_expires_at`. */
  | "rotation_grace";

export interface AgentRecord {
  id: string;
  name: string;
  role: string;
  capabilities: string;
  last_seen: string;
  created_at: string;
  token_hash: string | null;
  /** v2.0 final: session_id rotates on every register_agent call (session-aware read receipts). */
  session_id?: string | null;
  /** v2.0 final: agent-set status (online/busy/away/offline). Default "online". Controlled by set_status + heartbeat. */
  agent_status?: string | null;
  /** v2.0 final: optional human-readable description. Shown in discover_agents + dashboard. */
  description?: string | null;
  /** v2.1 Phase 4b.1 v2: auth-state machine (see AgentAuthState). */
  auth_state?: AgentAuthState;
  /** v2.1 Phase 4b.1 v2: ISO timestamp of the most recent revoke_token call against this row. */
  revoked_at?: string | null;
  /** v2.1 Phase 4b.1 v2: bcrypt hash of admin-issued recovery secret. Populated iff state=recovery_pending. */
  recovery_token_hash?: string | null;
  /** v2.1 Phase 4b.2: true = Managed Agent wrapper (can self-update from push-token messages). Immutable after first register (same as capabilities). */
  managed?: number;
  /** v2.1 Phase 4b.2: ISO timestamp of rotation grace window expiry. Populated iff state=rotation_grace. */
  rotation_grace_expires_at?: string | null;
  /** v2.1 Phase 4b.2: bcrypt hash of pre-rotation token. Populated iff state=rotation_grace; allows the old token to auth alongside the new token during the grace window. */
  previous_token_hash?: string | null;
}

export interface AgentWithStatus extends Omit<AgentRecord, "capabilities" | "token_hash" | "session_id" | "agent_status" | "description"> {
  capabilities: string[];
  /** v1.3 presence: computed from last_seen. Distinct from agent_status. */
  status: "online" | "stale" | "offline";
  /** v1.7: whether the agent has a token (false = legacy pre-v1.7 agent) */
  has_token: boolean;
  /**
   * v2.0 final: agent-controlled operational status (different from presence).
   * v2.1.3 (I6): enum widened — idle (default active), working, blocked,
   * waiting_user, stale (relay-computed from last_seen), offline. The value
   * surfaced here is the HYBRID: relay overrides a stored active-state
   * (idle/working/blocked/waiting_user) with 'stale' at 5 min + 'offline' at
   * 30 min of last_seen silence.
   */
  agent_status: "idle" | "working" | "blocked" | "waiting_user" | "stale" | "offline";
  /** v2.0 final: optional description. */
  description: string | null;
  /** v2.0 final: current session_id (UUID, rotates on re-register). */
  session_id: string | null;
}

export interface MessageRecord {
  id: string;
  from_agent: string;
  to_agent: string;
  content: string;
  priority: string;
  status: string;
  created_at: string;
  /** v2.0 final: session that read this message. Null = unread. Used for session-aware read receipts (#6). */
  read_by_session?: string | null;
}

export interface TaskRecord {
  id: string;
  from_agent: string;
  /** May be null for queued (not-yet-routed) tasks. */
  to_agent: string | null;
  title: string;
  description: string;
  priority: string;
  status: string;
  result: string | null;
  created_at: string;
  updated_at: string;
  /** v2.0 beta: ISO timestamp of last lease renewal by the assigned agent. Null when status != 'accepted' or on legacy tasks. */
  lease_renewed_at?: string | null;
  /** v2.0 beta: JSON-array string of capabilities required for auto-routing. Null for tasks posted via legacy post_task. */
  required_capabilities?: string | null;
}

export interface WebhookRecord {
  id: string;
  url: string;
  event: string;
  filter: string | null;
  secret: string | null;
  created_at: string;
}

export interface WebhookDeliveryRecord {
  id: string;
  webhook_id: string;
  event: string;
  payload: string;
  status_code: number | null;
  error: string | null;
  attempted_at: string;
}

export type TaskStatus = "queued" | "posted" | "accepted" | "completed" | "rejected" | "cancelled";
export type TaskAction = "accept" | "complete" | "reject" | "cancel" | "heartbeat";

// Valid state transitions. heartbeat is a no-state-change action (validated separately).
export const VALID_TRANSITIONS: Record<TaskAction, TaskStatus[]> = {
  accept: ["posted"],
  complete: ["accepted"],
  reject: ["posted", "accepted"],
  cancel: ["queued", "posted", "accepted"],
  heartbeat: ["accepted"],
};

// Only non-heartbeat actions map to a new status. heartbeat keeps current status.
export const ACTION_TO_STATUS: Partial<Record<TaskAction, TaskStatus>> = {
  accept: "accepted",
  complete: "completed",
  reject: "rejected",
  cancel: "cancelled",
};
