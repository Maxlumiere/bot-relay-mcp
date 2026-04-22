// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import {
  registerAgent,
  getAgents,
  unregisterAgent,
  rotateAgentToken,
  rotateAgentTokenAdmin,
  revokeAgentToken,
  getAgentAuthData,
  sendMessage,
  logAudit,
  ConcurrentUpdateError,
  expandAgentCapabilities,
  NameCollisionActiveError,
} from "../db.js";
import { fireWebhooks } from "../webhooks.js";
import { log } from "../logger.js";
import { currentContext } from "../request-context.js";
import { updateCapturedSessionId } from "../transport/stdio.js";
import { PROTOCOL_VERSION } from "../protocol.js";
import { ERROR_CODES } from "../error-codes.js";
import type {
  RegisterAgentInput,
  DiscoverAgentsInput,
  UnregisterAgentInput,
  RotateTokenInput,
  RotateTokenAdminInput,
  RevokeTokenInput,
  ExpandCapabilitiesInput,
} from "../types.js";

export function handleRegisterAgent(input: RegisterAgentInput) {
  // v2.1 Phase 4b.1 v2: capture the pre-transition auth_state so we can
  // surface `recovery_completed: true` in the response. The source of truth
  // is the atomic transition inside registerAgent (CAS-gated) — this read is
  // informational for the caller's hook flow, not load-bearing.
  const preRow = getAgentAuthData(input.name);
  const preState = (preRow?.auth_state ?? null) as
    | "active"
    | "legacy_bootstrap"
    | "revoked"
    | "recovery_pending"
    | null;

  // v2.2.1 B2: hard-reject re-registration against an actively-held name.
  // Pre-v2.2.1 this silently rotated session_id and dropped mail on the
  // losing terminal (shared-token race). The check is handler-layer, not
  // DB-layer, so internal callers (tests, relay recover, migrations) still
  // call db.registerAgent directly without collision protection. Operators
  // who need to take over a stuck session can either:
  //   (a) wait for the row to go stale (5min at last_seen),
  //   (b) run `relay recover <name>` to force-release, or
  //   (c) pass `force: true` to register_agent (undocumented escape hatch).
  // See memory/feedback_scoped_victra_names.md for the bug's history.
  //
  // Exemptions:
  //   - auth_state recovery_pending: admin-approved re-take-over via
  //     recovery_token, not a concurrent-session race.
  //   - auth_state legacy_bootstrap: pre-v1.7 rows being migrated; no token
  //     exists yet, by definition no concurrent session.
  //   - force=true: explicit operator opt-in.
  const ACTIVE_STATES = new Set(["idle", "working", "blocked", "waiting_user", "online", "busy"]);
  const SESSION_TIMEOUT_SEC = 120; // matches the legacy warn window's tight lower bound
  const EXEMPT_AUTH_STATES = new Set(["recovery_pending", "legacy_bootstrap"]);
  if (!input.force && preRow && !EXEMPT_AUTH_STATES.has(preRow.auth_state ?? "active")) {
    const ageSec = (Date.now() - new Date(preRow.last_seen).getTime()) / 1000;
    const isActivelyHeld =
      preRow.session_id != null &&
      ageSec < SESSION_TIMEOUT_SEC &&
      ACTIVE_STATES.has(preRow.agent_status ?? "idle");
    if (isActivelyHeld) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: false,
                error:
                  `Agent "${input.name}" is already registered and online on another session ` +
                  `(session_id=${preRow.session_id}, last_seen=${preRow.last_seen}). ` +
                  `Two terminals running under the same name will race on get_messages and silently drop mail. ` +
                  `Resolution: (a) scope your name (e.g. "${input.name}-mcp", "${input.name}-outreach") so each terminal has a distinct identity; ` +
                  `(b) close the holding terminal and let it mark the row offline on exit; or ` +
                  `(c) run "relay recover ${input.name} --yes" to force-release + re-register fresh.`,
                error_code: ERROR_CODES.NAME_COLLISION_ACTIVE,
                existing_session_id: preRow.session_id,
                existing_last_seen: preRow.last_seen,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }

  // v2.1 Phase 7p HIGH #2: plumb the dispatcher-verified recovery hash through
  // to the db layer so the CAS anchors on the hash the CALLER's ticket was
  // verified against — not on a fresh SELECT, which could miss an admin reissue
  // landing between verify and UPDATE. Undefined when not a recovery flow.
  const expectedRecoveryHash = currentContext().verifiedRecoveryHash;

  const { agent, plaintext_token, auto_assigned } = registerAgent(
    input.name,
    input.role,
    input.capabilities,
    {
      description: input.description,
      managed: input.managed,
      terminal_title_ref: input.terminal_title_ref,
      expectedRecoveryHash,
      // v2.2.1 B2: when force=true the db-layer warn is also suppressed to
      // keep the escape-hatch path quiet. `force` never reaches the DB
      // beyond this.
      force: input.force === true,
    }
  );

  const recoveryCompleted = preState === "recovery_pending";
  if (recoveryCompleted) {
    // Structured audit entry for incident replay (spec §6).
    logAudit(
      input.name,
      "register_agent",
      `recovery_completed target=${input.name}`,
      true,
      null,
      currentContext().transport,
      {
        tool: "register_agent",
        auth_state_before: "recovery_pending",
        auth_state_after: "active",
        recovery_completed: true,
      }
    );
    log.warn(
      `[auth] Recovery completed for "${input.name}". Previous recovery_token is now invalid; state=active.`
    );
  }

  // Surface the one-time token to stderr so the operator can capture it from
  // their terminal session. The raw token is also in the tool response body,
  // but the stderr line is a belt-and-suspenders backup for the hook flow.
  if (plaintext_token) {
    log.info(`[auth] New agent_token issued for "${agent.name}". Save it: RELAY_AGENT_TOKEN=${plaintext_token} (shown ONCE).`);
  }

  // v2.1 Phase 4f.1: when a stdio process registers itself mid-lifetime, the
  // SIGTERM auto-unregister needs the fresh session_id to clean up its row
  // on exit. captureSessionId() in stdio.ts only runs ONCE at startup and
  // sees null if the agent wasn't pre-registered — Phase 2a's null-guard then
  // correctly refuses to unregister-by-name. Refresh the captured sid here,
  // gated on (a) stdio transport, (b) the registered name matching our
  // RELAY_AGENT_NAME env. Any other combination (HTTP caller, different-name
  // admin register) is a no-op to preserve process ownership semantics.
  try {
    const ctx = currentContext();
    const ownName = process.env.RELAY_AGENT_NAME;
    if (ctx.transport === "stdio" && ownName && ownName === agent.name) {
      updateCapturedSessionId(agent.session_id ?? null);
    }
  } catch {
    // Never block register on a re-capture failure — SIGTERM will fall back to
    // the null-guard path, which is safe.
  }

  // v2.0 beta.1 (Codex HIGH 4): auto_assigned is produced inside registerAgent
  // so every caller of that function gets the sweep. We stay responsible for
  // firing webhooks off the returned list to avoid a circular import.
  for (const a of auto_assigned) {
    fireWebhooks("task.posted", a.from_agent, agent.name, {
      task_id: a.task_id,
      task: {
        id: a.task_id,
        title: a.title,
        status: "posted",
        priority: a.priority,
        result: null,
      },
      auto_assigned_from_queue: true,
    });
  }

  // v1.7.1: capabilities are immutable on re-register. If the caller asked
  // for different caps than what is now stored, surface a clear note so the
  // operator understands why their request payload is not reflected.
  const capsMismatch =
    JSON.stringify(input.capabilities.slice().sort()) !==
    JSON.stringify(agent.capabilities.slice().sort());
  const capsNote = capsMismatch
    ? `Capabilities are immutable after first registration (v1.7.1). Requested ${JSON.stringify(input.capabilities)} ignored; stored capabilities preserved. To change capabilities, call unregister_agent first, then register_agent with the new set.`
    : undefined;

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            success: true,
            agent,
            protocol_version: PROTOCOL_VERSION,
            ...(plaintext_token
              ? {
                  agent_token: plaintext_token,
                  auth_note: `Save this agent_token in the RELAY_AGENT_TOKEN env var. It is shown only on this response; the server stores a bcrypt hash.`,
                }
              : {}),
            ...(capsNote ? { capabilities_note: capsNote } : {}),
            ...(auto_assigned.length > 0 ? { auto_assigned_tasks: auto_assigned.map((a) => ({ task_id: a.task_id, title: a.title, priority: a.priority })) } : {}),
            ...(recoveryCompleted ? { recovery_completed: true } : {}),
            message: `Agent "${agent.name}" registered as ${agent.role}`,
          },
          null,
          2
        ),
      },
    ],
  };
}

export function handleUnregisterAgent(input: UnregisterAgentInput) {
  const removed = unregisterAgent(input.name);
  if (removed) {
    fireWebhooks("agent.unregistered", input.name, input.name, {});
  }
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            success: true,
            name: input.name,
            removed,
            note: removed
              ? `Agent "${input.name}" unregistered`
              : `Agent "${input.name}" was not registered`,
          },
          null,
          2
        ),
      },
    ],
  };
}

/**
 * v2.1 Phase 4b.1 — rotate the caller's own token. Dispatcher auth already
 * verified `agent_token` matches `agent_name`'s current bcrypt hash; so we
 * can safely read the hash, CAS-swap it, and return the fresh plaintext.
 * CAS protects against concurrent rotate / revoke races.
 */
export function handleRotateToken(input: RotateTokenInput) {
  const existing = getAgentAuthData(input.agent_name);
  if (!existing) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              success: false,
              error: `Agent "${input.agent_name}" is not registered.`,
              error_code: ERROR_CODES.NOT_FOUND,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
  // v2.1 Phase 4b.1 v2 + 4b.2: rotate only works on auth_state='active'.
  // Legacy, revoked, recovery_pending, and rotation_grace rows all fall
  // through to explicit errors so the caller knows which path to use.
  const rotateState = (existing.auth_state ?? "active") as
    | "active"
    | "legacy_bootstrap"
    | "revoked"
    | "recovery_pending"
    | "rotation_grace";
  if (rotateState !== "active" || !existing.token_hash) {
    const hint =
      rotateState === "legacy_bootstrap"
        ? "Call register_agent to bootstrap a fresh token first (Phase 2b migration path)."
        : rotateState === "revoked"
        ? "Target is revoked; contact an administrator for a recovery token or use unregister_agent + register_agent to recreate."
        : rotateState === "recovery_pending"
        ? "Target is in recovery; use register_agent with the admin-issued recovery_token instead of rotating."
        : rotateState === "rotation_grace"
        ? "Target is already in a rotation grace window. Wait for it to expire (or use the new token to re-auth) before rotating again."
        : "Token_hash missing on an active row — data integrity error.";
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              success: false,
              error: `Cannot rotate token for "${input.agent_name}" (auth_state="${rotateState}"). ${hint}`,
              error_code: ERROR_CODES.INVALID_STATE,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
  try {
    // v2.1 Phase 4b.2: rotateAgentToken branches internally on `managed` and
    // returns the agent class + grace expiry so this handler can shape the
    // response accordingly.
    const outcome = rotateAgentToken(input.agent_name, existing.token_hash, {
      graceSeconds: input.grace_seconds,
    });
    const rotatedAt = new Date().toISOString();
    let pushSent = false;

    if (outcome.agentClass === "managed" && outcome.graceExpiresAt) {
      // Deliver the new token to the target agent via a priority=high
      // push-message. Best-effort — rotation succeeds at the CAS layer
      // regardless of send outcome. Format is frozen per
      // docs/managed-agent-protocol.md (version=1 envelope).
      const payload = {
        protocol: "bot-relay-token-rotation",
        version: 1,
        event: "token_rotated",
        agent_name: input.agent_name,
        new_token: outcome.newPlaintextToken,
        rotated_at: rotatedAt,
        grace_expires_at: outcome.graceExpiresAt,
        grace_seconds: Math.max(
          0,
          Math.floor((new Date(outcome.graceExpiresAt).getTime() - Date.now()) / 1000)
        ),
        rotator: "self",
      };
      const body =
        `[RELAY SECURITY] Token rotated for "${input.agent_name}". Old token valid until ${outcome.graceExpiresAt}.\n` +
        "```json\n" +
        JSON.stringify(payload, null, 2) +
        "\n```\n";
      try {
        sendMessage(input.agent_name, input.agent_name, body, "high");
        pushSent = true;
      } catch (err) {
        log.warn(
          `[rotate_token] push-message delivery failed for "${input.agent_name}": ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }

    log.info(
      outcome.agentClass === "managed"
        ? `[auth] Managed token rotated for "${input.agent_name}" (grace until ${outcome.graceExpiresAt ?? "immediate"}). Push sent: ${pushSent}.`
        : `[auth] Unmanaged token rotated for "${input.agent_name}". Operator must update env + restart.`
    );

    const commonResponse = {
      success: true,
      agent_name: input.agent_name,
      new_token: outcome.newPlaintextToken,
      rotated_at: rotatedAt,
      agent_class: outcome.agentClass,
    };
    const response =
      outcome.agentClass === "managed" && outcome.graceExpiresAt
        ? {
            ...commonResponse,
            grace_expires_at: outcome.graceExpiresAt,
            push_sent: pushSent,
            auth_note:
              "Managed agent: the new token was delivered via push-message. The old token remains valid until grace_expires_at. Update the managed agent's local config before the grace window closes.",
          }
        : outcome.agentClass === "managed"
          ? {
              ...commonResponse,
              grace_expires_at: null,
              push_sent: false,
              auth_note:
                "Managed agent with grace_seconds=0 — hard cut. Old token invalid immediately; operator must deliver the new token out-of-band.",
            }
          : {
              ...commonResponse,
              restart_required: true,
              operator_note: `Agent "${input.agent_name}" is not a Managed Agent. The new token must be placed in the agent's shell env manually + the terminal restarted. If the terminal is live, it will start failing with AUTH_FAILED on next MCP call. Use 'relay recover ${input.agent_name}' if the operator loses the new token before restarting.`,
            };

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  } catch (err) {
    if (err instanceof ConcurrentUpdateError) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: false,
                error: err.message,
                error_code: ERROR_CODES.CONCURRENT_UPDATE,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { success: false, error: message, error_code: ERROR_CODES.INTERNAL },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
}

/**
 * v2.1 Phase 4b.2 — admin-initiated cross-agent token rotation. Dispatcher
 * has already cap-checked `rotate_others` on the rotator. This handler
 * rejects self-rotation (use `rotate_token` instead), looks up the target's
 * `managed` flag, and dispatches to db.ts's `rotateAgentTokenAdmin`. Response
 * shape mirrors `handleRotateToken`: managed → grace + push-message to
 * target; unmanaged → new token returned to ROTATOR + restart_required.
 */
export function handleRotateTokenAdmin(input: RotateTokenAdminInput) {
  if (input.target_agent_name === input.rotator_name) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              success: false,
              error: `rotate_token_admin cannot target self; use rotate_token for self-rotation.`,
              error_code: ERROR_CODES.VALIDATION,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }

  const target = getAgentAuthData(input.target_agent_name);
  if (!target) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              success: false,
              error: `Target agent "${input.target_agent_name}" is not registered.`,
              error_code: ERROR_CODES.NOT_FOUND,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }

  const targetState = (target.auth_state ?? "active") as
    | "active"
    | "legacy_bootstrap"
    | "revoked"
    | "recovery_pending"
    | "rotation_grace";
  if (targetState !== "active") {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              success: false,
              error: `Cannot rotate token for "${input.target_agent_name}" (auth_state="${targetState}"). Target must be 'active' — wait for grace expiry / recover / unregister first as applicable.`,
              error_code: ERROR_CODES.INVALID_STATE,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }

  try {
    const outcome = rotateAgentTokenAdmin(input.target_agent_name, {
      graceSeconds: input.grace_seconds,
    });
    const rotatedAt = new Date().toISOString();
    let pushSent = false;

    if (outcome.agentClass === "managed" && outcome.graceExpiresAt) {
      const payload = {
        protocol: "bot-relay-token-rotation",
        version: 1,
        event: "token_rotated",
        agent_name: input.target_agent_name,
        new_token: outcome.newPlaintextToken,
        rotated_at: rotatedAt,
        grace_expires_at: outcome.graceExpiresAt,
        grace_seconds: Math.max(
          0,
          Math.floor((new Date(outcome.graceExpiresAt).getTime() - Date.now()) / 1000)
        ),
        rotator: input.rotator_name,
      };
      const body =
        `[RELAY SECURITY] Token rotated for "${input.target_agent_name}" by admin "${input.rotator_name}". Old token valid until ${outcome.graceExpiresAt}.\n` +
        "```json\n" +
        JSON.stringify(payload, null, 2) +
        "\n```\n";
      try {
        sendMessage(input.rotator_name, input.target_agent_name, body, "high");
        pushSent = true;
      } catch (err) {
        log.warn(
          `[rotate_token_admin] push-message delivery failed for "${input.target_agent_name}": ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }

    // Audit log entry names BOTH admin + target per spec §4.3 test 5.
    logAudit(
      input.rotator_name,
      "rotate_token_admin",
      `target=${input.target_agent_name}`,
      true,
      null,
      currentContext().transport,
      {
        tool: "rotate_token_admin",
        target_agent_name: input.target_agent_name,
        rotator_name: input.rotator_name,
        agent_class: outcome.agentClass,
        grace_expires_at: outcome.graceExpiresAt,
        push_sent: pushSent,
        result: "success",
      }
    );
    log.warn(
      `[auth] Admin "${input.rotator_name}" rotated token for "${input.target_agent_name}" (class=${outcome.agentClass}, push=${pushSent}).`
    );

    const commonResponse = {
      success: true,
      target_agent_name: input.target_agent_name,
      rotator: input.rotator_name,
      rotated_at: rotatedAt,
      agent_class: outcome.agentClass,
    };
    const response =
      outcome.agentClass === "managed" && outcome.graceExpiresAt
        ? {
            ...commonResponse,
            grace_expires_at: outcome.graceExpiresAt,
            push_sent: pushSent,
            note:
              "Managed target: new token delivered via push-message to the target. Old token remains valid until grace_expires_at. Admin does NOT need to deliver the token out-of-band.",
          }
        : outcome.agentClass === "managed"
          ? {
              ...commonResponse,
              new_token: outcome.newPlaintextToken,
              grace_expires_at: null,
              push_sent: false,
              note:
                "Managed target with grace_seconds=0 — hard cut, no push-message sent. Deliver the new_token to the target operator out-of-band.",
            }
          : {
              ...commonResponse,
              new_token: outcome.newPlaintextToken,
              restart_required: true,
              operator_note: `Target "${input.target_agent_name}" is NOT a Managed Agent. Deliver the new_token to the target's operator out-of-band; they must update the shell env + restart the terminal. Use 'relay recover' if the token is lost before restart.`,
            };

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  } catch (err) {
    if (err instanceof ConcurrentUpdateError) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: false,
                error: err.message,
                error_code: ERROR_CODES.CONCURRENT_UPDATE,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { success: false, error: message, error_code: ERROR_CODES.INTERNAL },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
}

/**
 * v2.1 Phase 4b.1 — nullify another agent's token_hash. Dispatcher has
 * already verified revoker holds the `admin` capability. Target falls into
 * the legacy-null-hash state; plain `register_agent` re-bootstraps via
 * Phase 2b's migration path.
 */
export function handleRevokeToken(input: RevokeTokenInput) {
  const target = getAgentAuthData(input.target_agent_name);
  if (!target) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              success: false,
              error: `Target agent "${input.target_agent_name}" is not registered.`,
              error_code: ERROR_CODES.NOT_FOUND,
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
  const stateBefore = (target.auth_state ?? "active") as
    | "active"
    | "legacy_bootstrap"
    | "revoked"
    | "recovery_pending";

  const { revoked, recoveryToken, wasReissue } = revokeAgentToken(
    input.target_agent_name,
    { issueRecovery: input.issue_recovery }
  );
  const revokedAt = new Date().toISOString();
  const stateAfter: "revoked" | "recovery_pending" = input.issue_recovery
    ? "recovery_pending"
    : "revoked";

  // v2.1 Phase 4b.1 v2: structured audit entry records the full state
  // transition (spec §6) so incident review can replay auth_state events.
  // `recovery_reissued: true` distinguishes a first-time revoke from a
  // lost-ticket reissue on a recovery_pending row.
  logAudit(
    input.revoker_name,
    "revoke_token",
    `target=${input.target_agent_name}`,
    true,
    null,
    currentContext().transport,
    {
      tool: "revoke_token",
      target_agent_name: input.target_agent_name,
      revoker_name: input.revoker_name,
      issue_recovery: input.issue_recovery,
      recovery_issued: revoked && input.issue_recovery,
      recovery_reissued: wasReissue,
      auth_state_before: stateBefore,
      auth_state_after: revoked ? stateAfter : stateBefore,
      result: revoked ? "success" : "noop_already_revoked",
    }
  );

  if (revoked) {
    log.warn(
      `[auth] Token REVOKED for "${input.target_agent_name}" by "${input.revoker_name}" ` +
      `(state ${stateBefore} → ${stateAfter}, issue_recovery=${input.issue_recovery}${wasReissue ? ", recovery_reissued" : ""}).`
    );
    if (recoveryToken) {
      log.info(
        `[auth] Recovery token issued for "${input.target_agent_name}". ` +
        `Shown ONCE in the response — hand it to the operator out-of-band.`
      );
    }
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            success: true,
            revoked: input.target_agent_name,
            revoked_by: input.revoker_name,
            revoked_at: revokedAt,
            changed: revoked,
            auth_state_before: stateBefore,
            auth_state_after: revoked ? stateAfter : stateBefore,
            ...(recoveryToken
              ? {
                  recovery_token: recoveryToken,
                  recovery_note:
                    "This recovery_token is shown ONCE. Hand it to the operator of " +
                    `"${input.target_agent_name}" out-of-band. They call ` +
                    "register_agent(name, role, capabilities, recovery_token=...) to resume.",
                  recovery_reissued: wasReissue,
                }
              : {}),
            note: revoked
              ? input.issue_recovery
                ? `Target agent "${input.target_agent_name}" is now in recovery_pending. A one-time recovery_token has been issued (see recovery_token field).`
                : `Target agent "${input.target_agent_name}" is now revoked (terminal). To reuse the name, call unregister_agent first.`
              : `Target agent "${input.target_agent_name}" was already revoked — this call was an idempotent no-op.`,
          },
          null,
          2
        ),
      },
    ],
  };
}

export function handleDiscoverAgents(input: DiscoverAgentsInput) {
  const agents = getAgents(input.role);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            agents,
            count: agents.length,
            filter: input.role ? { role: input.role } : "none",
          },
          null,
          2
        ),
      },
    ],
  };
}

/**
 * v2.1.4 (I11) — self-managed additive cap expansion.
 *
 * Dispatcher has already authenticated the caller by token (no explicit caller
 * field → token-resolution path) AND verified `agent_name` matches the authed
 * row (the explicit `agent_name` field routes through enforceAuth's
 * explicit-caller branch). That means by the time we're in the handler, the
 * caller proved they own the row. All that remains is the additive-only +
 * no-op policy, which lives in `expandAgentCapabilities`.
 */
export function handleExpandCapabilities(input: ExpandCapabilitiesInput) {
  try {
    const { added, current } = expandAgentCapabilities(input.agent_name, input.new_capabilities);
    logAudit(
      input.agent_name,
      "expand_capabilities",
      `added=${added.join(",")}`,
      true,
      null,
      currentContext().transport,
      { agent: input.agent_name, added, new_current: current }
    );
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              success: true,
              agent: input.agent_name,
              added,
              capabilities: current,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    let code: string = ERROR_CODES.INTERNAL;
    let friendly = msg;
    if (msg === "NOT_FOUND") {
      code = ERROR_CODES.NOT_FOUND;
      friendly = `Agent "${input.agent_name}" not found.`;
    } else if (msg === "REDUCTION_NOT_ALLOWED") {
      code = ERROR_CODES.REDUCTION_NOT_ALLOWED;
      friendly =
        `new_capabilities must be a SUPERSET of the agent's current caps — additive only. ` +
        `To reduce caps, operator must unregister_agent + register_agent.`;
    } else if (msg === "NO_OP_EXPANSION") {
      code = ERROR_CODES.NO_OP_EXPANSION;
      friendly =
        `new_capabilities is already a subset of current caps — nothing to add. ` +
        `Include at least one NEW cap.`;
    }
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { success: false, error: friendly, error_code: code },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
}
