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

/**
 * v2.2.0: terminal_title_ref captures the window title the agent's terminal
 * was spawned with (typically the same as `--name` on the claude launcher).
 * The dashboard's click-to-focus driver uses this to look up the target
 * window across macOS iTerm2 / Linux wmctrl / Windows AppActivate. Allowlist
 * matches the rest of the spawn-identity surface (no shell metachars, no
 * control characters) so the title can be safely interpolated into
 * osascript / wmctrl / PowerShell commands without quote gymnastics.
 */
const TERMINAL_TITLE_REF_PATTERN = /^[A-Za-z0-9_.\- ]+$/;
const TerminalTitleRefField = z
  .string()
  .min(1)
  .max(100)
  .regex(TERMINAL_TITLE_REF_PATTERN, "terminal_title_ref must match [A-Za-z0-9_.- ] (letters, digits, dot, dash, underscore, space)")
  .optional()
  .describe(
    "v2.2.0: window title the agent's terminal was spawned with. Used by the " +
      "dashboard's click-to-focus driver. Typically equals the agent's `--name`. " +
      "Mutable on re-register (updates to reflect the current session's title)."
  );

export const RegisterAgentSchema = z.object({
  name: z.string().min(1).max(64).describe("Human-readable agent name"),
  role: z.string().min(1).max(64).describe("Agent role (e.g. orchestrator, builder, ops)"),
  capabilities: z.array(z.string()).describe("List of capabilities"),
  description: z.string().max(512).optional().describe("v2.0: optional human-readable description (max 512 chars). Shown in discover_agents + dashboard. Mutable on re-register — if omitted, previous value preserved."),
  terminal_title_ref: TerminalTitleRefField,
  agent_token: AgentTokenField,
  recovery_token: z.string().min(1).optional().describe("v2.1 Phase 4b.1 v2: required when re-registering an agent whose auth_state is 'recovery_pending'. Obtained from the revoker's revoke_token response (shown ONCE) and handed off to the operator out-of-band."),
  managed: z.boolean().default(false).describe("v2.1 Phase 4b.2: true = agent is a Managed Agent wrapper that can parse push-token messages + self-update its local config on rotation. false (default) = Claude Code terminal or equivalent (restart-required on rotation). Immutable after first registration — change requires unregister + fresh register."),
  /**
   * v2.2.1 B2: bypass the duplicate-name active-session collision check.
   * Default false → re-register on an actively-held name returns
   * NAME_COLLISION_ACTIVE (forces operators to scope names distinctly, which
   * kills the get_messages mailbox-drain race when two terminals share a
   * RELAY_AGENT_NAME + token). Operators who genuinely need to force a
   * takeover (e.g. previous session crashed + they can't wait for
   * staleness or run `relay recover`) can pass force=true explicitly.
   * Undocumented on the public tool description — it's an escape hatch,
   * not a feature.
   */
  force: z.boolean().default(false).optional().describe("Escape hatch — bypass the duplicate-name active-session collision check. Default false rejects re-registration on an actively-held name with NAME_COLLISION_ACTIVE so concurrent terminals don't race the get_messages mailbox-drain. Set true only when the prior session is unreachable (crashed terminal, stale-but-not-yet-aged-out session) and you cannot wait for the staleness window or run `relay recover`."),
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

// v2.1.4 (I10): brief_file_path allowlist mirrors SPAWN_CWD_PATTERN. Absolute
// POSIX path, no shell metacharacters, no control chars. Zod boundary is the
// primary defense; the shell script + handler also validate existence / size.
const SPAWN_BRIEF_PATH_PATTERN = /^\/[A-Za-z0-9_./ -]+$/;
const SPAWN_BRIEF_PATH_FORBIDDEN = SPAWN_CWD_FORBIDDEN;

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
  brief_file_path: z.string()
    .max(1024)
    .regex(SPAWN_BRIEF_PATH_PATTERN, "brief_file_path must be an absolute POSIX path matching [A-Za-z0-9_./ -] (no shell metachars)")
    .refine((v) => !SPAWN_BRIEF_PATH_FORBIDDEN.test(v), "brief_file_path contains a forbidden character (shell metachar or control char)")
    .optional()
    .describe("v2.1.4 (I10): absolute path to a task-brief file the spawned agent should read FIRST. The relay validates that the file exists at spawn time, is readable, and is <=10KB. When set, the default KICKSTART prompt appends a sentence telling the agent to read this file as the canonical source for its task scope — trust-anchored fix for respawned-agent context loss (inbox messages are not durable). macOS only for v2.1.4; Linux/Windows drivers ignore (no KICKSTART on those platforms yet)."),
  agent_token: AgentTokenField,
});

export const SendMessageSchema = z.object({
  from: z.string().min(1).describe("Sender agent name"),
  to: z.string().min(1).describe("Recipient agent name"),
  content: payloadField("content").describe("Message content (max 64KB by default; see RELAY_MAX_PAYLOAD_BYTES)"),
  priority: z.enum(["normal", "high"]).default("normal").describe("Message priority"),
  agent_token: AgentTokenField,
});

/**
 * v2.1.6: optional `since` filter. Same grammar as `/standup`'s since arg —
 * duration shorthand ("15m" | "1h" | "24h" | "3d"), an ISO8601 timestamp, the
 * literal "session_start" sentinel (messages since the agent's current
 * session registered), OR "all" / null to preserve pre-v2.1.6 unlimited
 * behavior. Default is "24h" — keeps reused agent names from inheriting the
 * full inbox backlog while leaving an escape hatch for cross-session handoff.
 */
const GetMessagesSinceField = z
  .union([z.string().min(1), z.null()])
  .optional()
  .default("24h")
  .describe(
    "v2.1.6: time-window filter. Accepts duration ('15m'|'1h'|'24h'|'3d'), " +
      "ISO8601 timestamp, 'session_start' sentinel, or 'all'/null to disable. " +
      "Default '24h' trims stale backlog when an agent name is reused."
  );

/**
 * v2.3.0 Part C.3 — peek_inbox_version. Cheap non-mutating observation
 * of the agent's mailbox. Pair with get_messages(since_seq=...) in a
 * later release for efficient cursor-based drain.
 */
export const PeekInboxVersionSchema = z.object({
  agent_name: z.string().min(1).max(64).describe("The agent whose mailbox to observe"),
  agent_token: AgentTokenField,
});
export type PeekInboxVersionInput = z.infer<typeof PeekInboxVersionSchema>;

export const GetMessagesSchema = z.object({
  agent_name: z.string().min(1).describe("Your agent name"),
  status: z.enum(["pending", "read", "all"]).default("pending").describe("Filter by status"),
  limit: z.number().int().min(1).max(100).default(20).describe("Max messages to return"),
  since: GetMessagesSinceField,
  /**
   * v2.2.2 BUG1 — when true, do NOT mark returned messages as read-by-
   * this-session. Repeated calls with `status='pending'` continue to
   * return the same rows until the caller either requests without
   * peek OR another session marks them read. Default false preserves
   * v2.0 consume-once semantics for single-shot workers. Intended for
   * orchestrators that survey their own inbox on a polling interval
   * without consuming it (Victra's get_messages pattern).
   */
  peek: z.boolean().optional().default(false).describe(
    "When true, skip the mark-as-read side effect so repeated status='pending' polls return the same messages. Default false (consume-once)."
  ),
  agent_token: AgentTokenField,
});

/**
 * v2.1.6: lightweight inbox preview. Same filter surface as GetMessages but
 * returns only message headers + a 100-char content_preview. Does NOT mark
 * messages read (pure observation). Intended for orchestrators or dashboards
 * that want to scan an inbox cheaply + call get_messages only for IDs they
 * want to expand.
 */
export const GetMessagesSummarySchema = z.object({
  agent_name: z.string().min(1).describe("Your agent name"),
  status: z.enum(["pending", "read", "all"]).default("pending").describe("Filter by status"),
  limit: z.number().int().min(1).max(100).default(20).describe("Max message summaries to return"),
  since: GetMessagesSinceField,
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
  // v2.2.2 B3: relay-computed terminal state for agents that have been
  // offline for RELAY_AGENT_ABANDON_DAYS (default 7) without
  // re-registering. Distinct from `offline` so dashboards can hide
  // retired terminals by default while keeping the row around for the
  // operator's `relay purge-agents` sweep.
  "abandoned",
  // v2.2.2 BUG2: intentional-terminal-close state. Written by the
  // SIGINT/SIGTERM stdio handler (closeAgentSession helper) when the
  // operator deliberately shuts a terminal. Distinct from `offline`
  // (which can be network drop / sleep / transient) so dashboards can
  // show retired-by-intent sessions differently. Auto-promotes to
  // `abandoned` via the existing RELAY_AGENT_ABANDON_DAYS chain.
  "closed",
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

/**
 * v2.1.4 (I12): server-side team-status synthesis for orchestrators.
 *
 * `since` accepts either a duration string (`"15m"`, `"1h"`, `"3h"`, `"1d"`) or
 * an ISO8601 timestamp. Duration shorthand mirrors common standup intervals;
 * ISO is the escape hatch for finer control.
 *
 * `filter` narrows the synthesis window. `include_offline` defaults false so
 * the default view is "who's currently active." Set true for post-mortems.
 *
 * This is a READ-ONLY tool. No mutations. No LLM. Observation bullets are
 * hand-rolled heuristics in the handler.
 */
export const GetStandupSchema = z.object({
  since: z.string().min(1).describe(
    "Window start: either a duration string ('15m' | '1h' | '3h' | '1d') or an ISO8601 timestamp. Duration shorthands: m=minutes, h=hours, d=days."
  ),
  filter: z
    .object({
      agents: z.array(z.string().min(1)).optional().describe("Restrict to these agent names."),
      roles: z.array(z.string().min(1)).optional().describe("Restrict to these roles."),
      include_offline: z.boolean().default(false).describe("Include agents with agent_status='offline' in active_agents."),
    })
    .optional()
    .describe("Optional narrowing filter for the standup snapshot. Combine `agents` (restrict to names) and `roles` (restrict to roles); both filters AND together. `include_offline` flips the default that drops offline agents from active_agents."),
  agent_token: AgentTokenField,
});

export type GetStandupInput = z.infer<typeof GetStandupSchema>;

/**
 * v2.1.4 (I11): self-managed additive capability expansion. Closes the v1.7.1
 * cap-immutability gap for agents that hook-registered with a narrow set and
 * later need more caps, without forcing full unregister + re-register.
 *
 * Semantics: caller presents their token (resolved from any of arg / header /
 * env as usual). `new_capabilities` MUST be a superset of the agent's current
 * caps. Reductions are rejected (REDUCTION_NOT_ALLOWED) — operator ceremony
 * preserved for the destructive path. No-ops are rejected explicitly
 * (NO_OP_EXPANSION) so callers don't accidentally double-submit.
 */
export const ExpandCapabilitiesSchema = z.object({
  agent_name: z.string().min(1).max(64).describe("Your agent name. Must match the row your token authenticates to."),
  new_capabilities: z.array(
    z.string().min(1).max(64)
  ).min(1).describe("The full new capability set. Must be a superset of the agent's current caps — additive only."),
  agent_token: AgentTokenField,
});

export type ExpandCapabilitiesInput = z.infer<typeof ExpandCapabilitiesSchema>;

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

/**
 * v2.2.0: dashboard click-to-focus request body. Sent by the dashboard JS to
 * POST /api/focus-terminal. Validated at the HTTP layer before dispatching
 * to the platform focus driver.
 */
export const FocusTerminalSchema = z.object({
  agent_name: z.string().min(1).max(64).describe("Name of the agent whose terminal window should come to the front"),
});
export type FocusTerminalInput = z.infer<typeof FocusTerminalSchema>;

/**
 * v2.2.1 P2: dashboard inline-action request bodies. Each proxies to the
 * matching MCP tool (send_message / unregister_agent / set_status) but
 * is gated by the dashboard auth surface (dashboardAuthCheck + origin +
 * CSRF) instead of agent-level tokens. Rationale: the dashboard operator
 * is by definition trusted once they've authenticated with the dashboard
 * secret — they're running the relay. We don't layer additional
 * agent-token auth on top; that would require every dashboard user to
 * also have an admin-cap agent token, which defeats the "operator
 * dashboard" semantic.
 */
export const ApiSendMessageSchema = z.object({
  from: z.string().min(1).max(64).describe("Sender agent name (must be a registered agent)"),
  to: z.string().min(1).max(64).describe("Recipient agent name"),
  content: payloadField("content"),
  priority: z.enum(["normal", "high"]).default("normal"),
  /**
   * v2.2.2 A1 — Option (b) defense-in-depth. Optional: when present, the
   * server verifies against the from-agent's stored token_hash + the
   * audit-log entry records `from_authenticated: true`. When absent, the
   * v2.2.1 Option (a) audit-only model applies: dashboard-secret gate is
   * the only check + `from_authenticated: false` is recorded so incident
   * review can distinguish operator-impersonation from token-verified
   * sends. Also acceptable via `X-From-Agent-Token` header.
   */
  from_agent_token: z.string().min(8).max(128).optional(),
});
export type ApiSendMessageInput = z.infer<typeof ApiSendMessageSchema>;

export const ApiKillAgentSchema = z.object({
  name: z.string().min(1).max(64).describe("Agent name to unregister"),
});
export type ApiKillAgentInput = z.infer<typeof ApiKillAgentSchema>;

/**
 * v2.3.0 Part C.5 — dashboard wake-agent inline-action endpoint.
 * POST /api/wake-agent {agent_name}. Touches the filesystem marker
 * (when RELAY_FILESYSTEM_MARKERS=1) so a client watching that path
 * receives a low-latency wake signal.
 */
export const ApiWakeAgentSchema = z.object({
  agent_name: z.string().min(1).max(64).describe("Target agent to wake"),
});
export type ApiWakeAgentInput = z.infer<typeof ApiWakeAgentSchema>;

export const ApiSetStatusSchema = z.object({
  agent_name: z.string().min(1).max(64).describe("Target agent"),
  agent_status: z.enum(["idle", "working", "blocked", "waiting_user", "offline"]).describe("New status"),
});
export type ApiSetStatusInput = z.infer<typeof ApiSetStatusSchema>;

/**
 * v2.2.1 P1 — theme shape for the dashboard's `custom` mode + the
 * set_dashboard_theme MCP tool.
 *
 * The 13 tokens below mirror the CSS custom properties declared in
 * `src/dashboard-styles.ts` :root selector. A theme object MUST set every
 * token; partial themes are rejected at the Zod boundary so the dashboard
 * never ends up with a mix-of-themes visual (e.g. dark backgrounds + light
 * tag colors). Each token is a CSS color string — no format validation
 * beyond "non-empty string" because CSS accepts many forms (#hex,
 * rgb(), hsl(), color()).
 */
const THEME_TOKEN_FIELD = z.string().min(1).max(64);
export const CustomThemeSchema = z.object({
  bg: THEME_TOKEN_FIELD,
  panel: THEME_TOKEN_FIELD,
  "panel-2": THEME_TOKEN_FIELD,
  border: THEME_TOKEN_FIELD,
  text: THEME_TOKEN_FIELD,
  muted: THEME_TOKEN_FIELD,
  accent: THEME_TOKEN_FIELD,
  online: THEME_TOKEN_FIELD,
  stale: THEME_TOKEN_FIELD,
  offline: THEME_TOKEN_FIELD,
  critical: THEME_TOKEN_FIELD,
  high: THEME_TOKEN_FIELD,
  normal: THEME_TOKEN_FIELD,
  low: THEME_TOKEN_FIELD,
});
export type CustomTheme = z.infer<typeof CustomThemeSchema>;

export const SetDashboardThemeSchema = z
  .object({
    mode: z.enum(["catppuccin", "dark", "light", "custom"]).describe(
      "Theme mode. catppuccin is the default; dark/light are tool-neutral; custom requires custom_json."
    ),
    custom_json: CustomThemeSchema.optional().describe(
      "Required when mode='custom'. JSON object with all 13 CSS-token fields (bg, panel, panel-2, border, text, muted, accent, online, stale, offline, critical, high, normal, low)."
    ),
    agent_token: AgentTokenField,
  })
  .refine(
    (v) => v.mode !== "custom" || v.custom_json !== undefined,
    { message: "mode='custom' requires custom_json with all 13 token fields" }
  );
export type SetDashboardThemeInput = z.infer<typeof SetDashboardThemeSchema>;

/**
 * v2.2.2 B1 — same shape as SetDashboardThemeSchema but without the MCP
 * agent_token field (the dashboard POST endpoint is gated by
 * dashboardAuthCheck + originCheck + csrfCheck, not by agent auth).
 */
export const ApiDashboardThemeSchema = z
  .object({
    mode: z.enum(["catppuccin", "dark", "light", "custom"]),
    custom_json: CustomThemeSchema.optional(),
  })
  .refine(
    (v) => v.mode !== "custom" || v.custom_json !== undefined,
    { message: "mode='custom' requires custom_json with all 14 token fields" }
  );
export type ApiDashboardThemeInput = z.infer<typeof ApiDashboardThemeSchema>;

// --- TypeScript types ---

export type RegisterAgentInput = z.infer<typeof RegisterAgentSchema>;
export type DiscoverAgentsInput = z.infer<typeof DiscoverAgentsSchema>;
export type UnregisterAgentInput = z.infer<typeof UnregisterAgentSchema>;
export type SpawnAgentInput = z.infer<typeof SpawnAgentSchema>;
export type SendMessageInput = z.infer<typeof SendMessageSchema>;
export type GetMessagesInput = z.infer<typeof GetMessagesSchema>;
export type GetMessagesSummaryInput = z.infer<typeof GetMessagesSummarySchema>;
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
  /** v2.1.6: ISO timestamp of the agent's current session start (last register_agent). NULL on rows registered before v2.1.6. */
  session_started_at?: string | null;
  /** v2.2.0: window title the agent's terminal was spawned with. Used by the dashboard's click-to-focus driver. NULL on rows spawned before v2.2.0 or rows that did not thread the value through the register call. */
  terminal_title_ref?: string | null;
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
  agent_status: "idle" | "working" | "blocked" | "waiting_user" | "stale" | "offline" | "abandoned" | "closed";
  /** v2.0 final: optional description. */
  description: string | null;
  /** v2.0 final: current session_id (UUID, rotates on re-register). */
  session_id: string | null;
  /** v2.2.0: window title the agent's terminal was spawned with (NULL if legacy). */
  terminal_title_ref: string | null;
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
  /**
   * v2.3.0 Part C — per-recipient monotonic sequence assigned at first
   * observation. Null until the recipient reads the message for the
   * first time. Stable across later reads.
   */
  seq?: number | null;
  /**
   * v2.3.0 Part C — mailbox epoch snapshotted at delivery time. Lets
   * the recipient detect a backup/restore vs. a genuine new message.
   */
  epoch?: string | null;
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
