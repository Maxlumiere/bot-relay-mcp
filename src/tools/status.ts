// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { setAgentStatus, getHealthSnapshot, getAgents, getAgentAuthData, setAgentLivenessAnchor } from "../db.js";
import type { SetStatusInput, HealthCheckInput, ReportLivenessInput } from "../types.js";
import { VERSION } from "../version.js";
import { PROTOCOL_VERSION } from "../protocol.js";
import { ERROR_CODES } from "../error-codes.js";
import { authenticateAgent, verifyToken } from "../auth.js";
import type { AuthStateInput } from "../auth.js";
import { currentContext } from "../request-context.js";
import { broadcastDashboardEvent } from "../transport/websocket.js";

/** Process-start wall clock — captured at module load so health_check can report uptime. */
const PROCESS_STARTED_AT = Date.now();

/**
 * v2.1.3 (I6): map legacy enum values to the widened v2_5 enum. Keeps
 * pre-v2.1.3 clients working without a protocol_version MAJOR bump.
 */
const LEGACY_SET_STATUS_MAP: Record<string, "idle" | "working" | "blocked" | "waiting_user" | "offline"> = {
  online: "idle",
  busy: "working",
  away: "blocked",
  idle: "idle",
  working: "working",
  blocked: "blocked",
  waiting_user: "waiting_user",
  offline: "offline",
};

const EXEMPT_FROM_REASSIGN = new Set(["working", "blocked", "waiting_user"]);

/**
 * v2.15.0 — report_liveness: narrow, metadata-only presence self-report.
 * Restamps ONLY the agent's liveness anchor (agent_pid + start-time, + fills
 * host_id when NULL) via setAgentLivenessAnchor — NO session_id rotation, NO
 * last_seen bump, NO read-cursor touch — so an old/existing session can become
 * probe-able without a re-register that would re-surface session-scoped mail.
 * Auth: own agent token only (agent_name is the caller field).
 */
export function handleReportLiveness(input: ReportLivenessInput) {
  const updated = setAgentLivenessAnchor(
    input.agent_name,
    input.agent_pid,
    input.agent_pid_start ?? null,
  );
  if (!updated) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { success: false, error: `Agent "${input.agent_name}" is not registered.`, error_code: ERROR_CODES.NOT_FOUND },
            null,
            2,
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
            agent_name: input.agent_name,
            agent_pid: input.agent_pid,
            note: "Liveness anchor restamped (metadata-only: agent_pid + start-time; no session rotation).",
          },
          null,
          2,
        ),
      },
    ],
  };
}

export function handleSetStatus(input: SetStatusInput) {
  // Normalize legacy → new. Zod has already restricted to the known set.
  const normalized = LEGACY_SET_STATUS_MAP[input.status];
  const updated = setAgentStatus(input.agent_name, normalized);
  if (updated) {
    // v2.2.0 Phase 2: agent state change → fan out to dashboard WebSocket
    // clients. set_status does NOT fire a webhook (internal state, not a
    // third-party-delivery event), so broadcast directly. Rate-limited +
    // never-throw inside the dashboard broadcast helper; safe here.
    // v2.2.0 Codex audit H4: metadata-only — no status body. Clients
    // refetch /api/snapshot to get the new agent_status; this push is
    // just the "something changed" signal.
    broadcastDashboardEvent({
      event: "agent.state_changed",
      entity_id: input.agent_name,
      ts: new Date().toISOString(),
      kind: "set_status",
    });
  }
  if (!updated) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { success: false, error: `Agent "${input.agent_name}" is not registered.`, error_code: ERROR_CODES.NOT_FOUND },
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
            agent: input.agent_name,
            status: normalized,
            ...(input.status !== normalized ? { status_normalized_from: input.status } : {}),
            note: EXEMPT_FROM_REASSIGN.has(normalized)
              ? `Status set to "${normalized}" — health monitor will not reassign your tasks.`
              : `Status set to "${normalized}".`,
          },
          null,
          2
        ),
      },
    ],
  };
}

/**
 * v2.1 Phase 4b.1 v2: token-aware extension for the SessionStart hook.
 * health_check remains a no-auth endpoint — it does NOT require a token.
 * But IF a token is presented, we validate it and surface auth_error +
 * agent_name + auth_state in the response so the hook can detect
 * stale/revoked tokens on terminal start.
 *
 * v2.6.1 R3: precedence chain mirrors `resolveToken` in `src/server.ts`.
 * Items 1-2 (args, header) are caller-presented and accepted on any
 * transport; item 3 (RELAY_AGENT_TOKEN env) is the daemon's own env and
 * is gated on `ctx.transport === "stdio"`. Without this gate an HTTP
 * caller could omit all credentials and the daemon would validate its
 * own env token, returning `agent_name` + `auth_state` for whichever
 * agent owns that env token — same auth-oracle / info-disclosure bug
 * class as resolveToken pre-R3 (Codex audit). Stdio is safe
 * because the process identity IS the agent.
 */
function resolveTokenForHealthCheck(input: HealthCheckInput): string | null {
  // Item 1 — args.agent_token (caller-presented per call).
  if (typeof input?.agent_token === "string" && input.agent_token.length > 0) {
    return input.agent_token;
  }
  let ctxTransport: "stdio" | "http" = "stdio";
  try {
    const ctx = currentContext();
    // Item 2 — X-Agent-Token header (caller-presented per request).
    if (ctx.headerAgentToken) return ctx.headerAgentToken;
    ctxTransport = ctx.transport;
  } catch {
    /* outside request context — defaults to stdio, which is safe */
  }
  // Item 3 — RELAY_AGENT_TOKEN env (daemon-side, STDIO-ONLY per R3).
  if (ctxTransport !== "stdio") return null;
  const envTok = process.env.RELAY_AGENT_TOKEN;
  if (envTok && envTok.length > 0) return envTok;
  return null;
}

interface TokenCheckResult {
  auth_error: boolean;
  auth_error_reason?: string;
  agent_name?: string;
  auth_state?: AuthStateInput;
}

/**
 * v2.1 Phase 7p MED #1: delegate the final decision to `authenticateAgent`
 * instead of maintaining a second, parallel token-checker. Pre-fix, this
 * function only consulted `auth.token_hash` — it had no awareness of the
 * `rotation_grace` state (v2.1 Phase 4b.2) where BOTH the new token AND
 * `previous_token_hash` are valid until grace expiry. An operator probing
 * with their pre-rotation token during a valid grace window got a false
 * auth_error, which would wrongly trigger the hook's stale-token recovery
 * path.
 *
 * Resolution: linear-scan agents to find the one whose current OR previous
 * hash matches the token (identification), then let `authenticateAgent` —
 * the canonical gate also used by the dispatcher — make the state-aware
 * yes/no call.
 */
function checkToken(token: string): TokenCheckResult {
  const agents = getAgents();
  for (const a of agents) {
    const auth = getAgentAuthData(a.name);
    if (!auth) continue;
    // Identification: does the token match EITHER the current token_hash OR
    // (for rotation_grace rows) the previous_token_hash? If not, keep looking.
    const matchesCurrent = !!auth.token_hash && verifyToken(token, auth.token_hash);
    const matchesPrevious =
      !!auth.previous_token_hash && verifyToken(token, auth.previous_token_hash);
    if (!matchesCurrent && !matchesPrevious) continue;

    const state = (auth.auth_state ?? "active") as AuthStateInput;
    const result = authenticateAgent(a.name, token, auth.token_hash ?? null, state, {
      previousTokenHash: auth.previous_token_hash ?? null,
      rotationGraceExpiresAt: auth.rotation_grace_expires_at ?? null,
    });
    if (result.ok) {
      return { auth_error: false, agent_name: a.name, auth_state: state };
    }
    return {
      auth_error: true,
      auth_error_reason: result.reason,
      agent_name: a.name,
      auth_state: state,
    };
  }
  return {
    auth_error: true,
    auth_error_reason:
      "agent_token did not match any registered agent (stale or never issued). Ensure RELAY_AGENT_TOKEN matches the token from your most recent register_agent response.",
  };
}

export function handleHealthCheck(input: HealthCheckInput) {
  const snapshot = getHealthSnapshot();
  const uptime_seconds = Math.floor((Date.now() - PROCESS_STARTED_AT) / 1000);

  const presentedToken = resolveTokenForHealthCheck(input);
  const tokenCheck: TokenCheckResult | null = presentedToken ? checkToken(presentedToken) : null;

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            ...snapshot,
            version: VERSION,
            protocol_version: PROTOCOL_VERSION,
            transport: process.env.RELAY_TRANSPORT || "stdio",
            uptime_seconds,
            legacy_grace_active: process.env.RELAY_ALLOW_LEGACY === "1",
            ...(tokenCheck
              ? {
                  token_validated: true,
                  auth_error: tokenCheck.auth_error,
                  ...(tokenCheck.auth_error_reason ? { auth_error_reason: tokenCheck.auth_error_reason } : {}),
                  ...(tokenCheck.agent_name ? { agent_name: tokenCheck.agent_name } : {}),
                  ...(tokenCheck.auth_state ? { auth_state: tokenCheck.auth_state } : {}),
                }
              : {}),
          },
          null,
          2
        ),
      },
    ],
  };
}
