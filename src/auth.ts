// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Per-agent authentication (v1.7).
 *
 * Each agent, on register, receives a freshly-generated auth token returned
 * ONCE in the registration response. The relay stores only a bcrypt hash of
 * the token in agents.token_hash. Subsequent tool calls must present the
 * raw token (via tool input field or X-Agent-Token HTTP header); the server
 * bcrypt-verifies it against the stored hash.
 *
 * Legacy agents (registered before v1.7) have NULL token_hash. They are
 * rejected by default unless RELAY_ALLOW_LEGACY=1 is set during migration.
 */

import bcrypt from "bcryptjs";
import crypto from "crypto";

const BCRYPT_ROUNDS = 10;
const TOKEN_BYTE_LEN = 32;

/** Generate a cryptographically random agent token (base64url). */
export function generateToken(): string {
  return crypto.randomBytes(TOKEN_BYTE_LEN).toString("base64url");
}

/** Hash a token for storage. Returns bcrypt hash (includes salt). */
export function hashToken(token: string): string {
  return bcrypt.hashSync(token, BCRYPT_ROUNDS);
}

/** Verify a token against a stored hash. */
export function verifyToken(token: string, hash: string): boolean {
  try {
    return bcrypt.compareSync(token, hash);
  } catch {
    return false;
  }
}

/** Whether the legacy grace period is active (env-driven). */
export function isLegacyGraceActive(): boolean {
  return process.env.RELAY_ALLOW_LEGACY === "1";
}

export interface AuthResult {
  ok: boolean;
  reason?: string;
  /** The legacy-acceptance path was used (no token check). */
  legacy?: boolean;
  /**
   * v2.1 Phase 4b.1 v2: auth was rejected specifically because the target
   * row is in `revoked` state. Distinct from a generic token-mismatch so
   * callers + audit readers can distinguish "bad credential" from
   * "administratively terminated."
   */
  revoked?: boolean;
  /**
   * v2.1 Phase 4b.1 v2: auth was rejected because the target row is in
   * `recovery_pending` state. The caller must re-register with a valid
   * recovery_token obtained out-of-band from the revoker.
   */
  recoveryRequired?: boolean;
  /** The resolved caller agent name (if identified). */
  callerName?: string;
  /** The resolved caller's capabilities (JSON-parsed). */
  callerCapabilities?: string[];
}

/** v2.1 Phase 4b.1 v2: minimal shape of the row needed for auth state checks. */
export type AuthStateInput =
  | "active"
  | "legacy_bootstrap"
  | "revoked"
  | "recovery_pending"
  /** v2.1 Phase 4b.2: managed agent in grace window; old + new token both valid until rotation_grace_expires_at. */
  | "rotation_grace";

/**
 * v2.1 Phase 4b.2: auxiliary inputs for rotation_grace auth. Ignored for
 * every other state; required when `authState === "rotation_grace"`.
 */
export interface RotationGraceInputs {
  /** bcrypt hash of the PRE-rotation token. Auth succeeds if presented token matches this AND grace hasn't expired. */
  previousTokenHash?: string | null;
  /** ISO8601 timestamp of grace-window expiry. Auth using previousTokenHash rejected once now() >= this. */
  rotationGraceExpiresAt?: string | null;
}

/** Capability requirements per tool. Missing = always allowed. */
export const TOOL_CAPABILITY: Record<string, string> = {
  spawn_agent: "spawn",
  post_task: "tasks",
  post_task_auto: "tasks",
  update_task: "tasks",
  broadcast: "broadcast",
  register_webhook: "webhooks",
  list_webhooks: "webhooks",
  delete_webhook: "webhooks",
  // v2.0: channel tools
  create_channel: "channels",
  post_to_channel: "channels",
  // v2.1 Phase 4b.1: admin-capability-gated token revocation.
  // rotate_token is NOT listed — every authenticated agent can rotate its own
  // token. revoke_token is for cross-agent nullification; requires admin cap.
  revoke_token: "admin",
  // v2.1 Phase 4b.2: admin-initiated cross-agent token rotation. Separate
  // from rotate_token (which remains no-cap for self-rotation). Holder of
  // `rotate_others` can force a rotation on any agent — managed agents
  // enter rotation_grace + receive a push-message; unmanaged agents return
  // the new token to the rotator for out-of-band delivery.
  rotate_token_admin: "rotate_others",
};

/** Tools that do NOT require any authentication (bootstrap + always-allowed-readonly). */
export const TOOLS_NO_AUTH: ReadonlySet<string> = new Set([
  "register_agent",
  // v2.0 final: health_check is a monitoring/diagnostic endpoint. No auth so
  // operators can probe from scripts without wiring a token. Returns only
  // aggregate counts — no per-agent content.
  "health_check",
]);

/**
 * Check if the caller's presented token authenticates them as `claimedName`.
 *
 * v2.1 Phase 4b.1 v2: auth now gates on `authState` FIRST, replacing the
 * v1 `token_hash IS NULL` overload. See types.AgentAuthState for semantics.
 *
 * @param claimedName  The agent name the caller claims to be.
 * @param tokenOrNull  The raw token presented, or null if none was sent.
 * @param storedHash   The stored bcrypt hash (null iff state=legacy_bootstrap).
 * @param authState    v2.1: explicit auth-state of the target row. Defaults to
 *                     `"active"` when not supplied (backward-compat during
 *                     pre-migration startup; once migrateSchemaToV2_1 runs,
 *                     every row carries an explicit value).
 */
export function authenticateAgent(
  claimedName: string,
  tokenOrNull: string | null,
  storedHash: string | null,
  authState: AuthStateInput = "active",
  graceInputs: RotationGraceInputs = {}
): AuthResult {
  // Terminal state. No recovery path from here without unregister_agent.
  if (authState === "revoked") {
    return {
      ok: false,
      revoked: true,
      reason: `Agent "${claimedName}" has been revoked. Contact an administrator for a recovery token or use unregister_agent + register_agent to re-create the row.`,
    };
  }
  // Recovery pending: caller must re-register via register_agent with a valid
  // recovery_token — no other operation is permitted on the row.
  if (authState === "recovery_pending") {
    return {
      ok: false,
      recoveryRequired: true,
      reason: `Agent "${claimedName}" is in recovery. Re-register via register_agent with a valid recovery_token obtained from the revoker.`,
    };
  }
  // v2.1 Phase 4b.2: rotation_grace — both the NEW (token_hash) and PREVIOUS
  // (previous_token_hash) tokens are valid until the grace window expires.
  // Auto-expiry cleanup is handled by the piggyback tick in server.ts; this
  // path is read-only (pure function contract preserved).
  if (authState === "rotation_grace") {
    const expiry = graceInputs.rotationGraceExpiresAt
      ? new Date(graceInputs.rotationGraceExpiresAt).getTime()
      : 0;
    const expired = expiry > 0 && Date.now() >= expiry;
    if (!tokenOrNull) {
      return {
        ok: false,
        reason: `Agent "${claimedName}" requires an agent_token. Pass it as the agent_token tool input field or via the X-Agent-Token HTTP header.`,
      };
    }
    // New token always works during rotation_grace.
    if (storedHash && verifyToken(tokenOrNull, storedHash)) {
      return { ok: true };
    }
    // Old token works ONLY while grace hasn't expired.
    if (
      !expired &&
      graceInputs.previousTokenHash &&
      verifyToken(tokenOrNull, graceInputs.previousTokenHash)
    ) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: `Invalid token for agent "${claimedName}"${
        expired ? " (rotation grace window expired — use the new token)." : "."
      }`,
    };
  }
  // Pre-v1.7 legacy row — one-shot migration path.
  if (authState === "legacy_bootstrap") {
    if (isLegacyGraceActive()) {
      return { ok: true, legacy: true };
    }
    return {
      ok: false,
      reason: `Agent "${claimedName}" has no token (registered before v1.7). Re-register with register_agent to get a token, or set RELAY_ALLOW_LEGACY=1 on the server during migration.`,
    };
  }

  // authState === "active"
  if (!storedHash) {
    // Defensive: cannot happen in the new model post-migration (active rows
    // always have a hash). Fail closed if data integrity is broken.
    return {
      ok: false,
      reason: `Agent "${claimedName}" is active but has no stored token hash. Data integrity error — investigate and re-register.`,
    };
  }
  if (!tokenOrNull) {
    return {
      ok: false,
      reason: `Agent "${claimedName}" requires an agent_token. Pass it as the agent_token tool input field or via the X-Agent-Token HTTP header.`,
    };
  }
  if (!verifyToken(tokenOrNull, storedHash)) {
    return {
      ok: false,
      reason: `Invalid token for agent "${claimedName}".`,
    };
  }
  return { ok: true };
}
