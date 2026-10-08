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
import { authSource, verifyCredential, type CredentialVerdict, type StoredCredential } from "./token-verify.js";

// v2.6.0: exported so the CLI mint-token regression test can pin the cost
// factor without duplicating the constant. Any future bump (e.g. 10 → 12)
// then has a single source of truth.
export const BCRYPT_ROUNDS = 10;
const TOKEN_BYTE_LEN = 32;

/**
 * Generate a cryptographically random agent token (base64url). Pure — the
 * redact-by-value registry is fed at the IDENTITY-association sites in db.ts
 * (registerAgent / rotate / revoke / mintAgentToken), which key each token to its
 * owning principal so a live token is never aged out by mint volume (secret-registry).
 */
export function generateToken(): string {
  return crypto.randomBytes(TOKEN_BYTE_LEN).toString("base64url");
}

/**
 * Hash a token for storage. Returns bcrypt hash (includes salt).
 *
 * PR-B (architect 8c8ef8ea): this is the ONLY sync bcrypt left in src, and it is called only at the
 * inventoried write sites inside SQLite transactions (where an awaited worker call is impossible),
 * each a NAMED exception in tests/pr-b-auth-invariants.test.ts. Every bcrypt COMPARE runs in the
 * worker pool (bcrypt-pool.ts) through token-verify.ts; there is no sync verify any more.
 */
export function hashToken(token: string): string {
  return bcrypt.hashSync(token, BCRYPT_ROUNDS);
}

/** Whether the legacy grace period is active (env-driven). */
export function isLegacyGraceActive(): boolean {
  return process.env.RELAY_ALLOW_LEGACY === "1";
}

export interface AuthResult {
  ok: boolean;
  reason?: string;
  /**
   * PR-B (architect b11ef8ad): on success, WHICH stored credential the token matched. The dispatcher records
   * it in the call's verdict, and revalidate (src/auth-verdict.ts) re-checks it, and any time predicate on it
   * (a previous credential's grace window), synchronously at the point of use.
   */
  matched?: "current" | "previous";
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
  /** PR-B: refused WITHOUT a compare: this (source, name) spent its failed-auth throttle. */
  throttled?: boolean;
  /** PR-B: refused at once: the bcrypt pool is full ("busy, retry"). */
  busy?: boolean;
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
  /** The PRE-rotation token's credential (bcrypt hash + lookup digest). Auth succeeds if the presented token matches it AND grace hasn't expired. */
  previous?: StoredCredential | null;
  /** ISO8601 timestamp of grace-window expiry. Auth using previousTokenHash rejected once now() >= this. */
  rotationGraceExpiresAt?: string | null;
}

/** Capability requirements per tool. Missing = always allowed. */
export const TOOL_CAPABILITY: Record<string, string> = {
  spawn_agent: "spawn",
  // v2.10 — a registered task schema is COMPILED by ajv, so registration is
  // restricted to agents holding the dedicated `manage_schemas` capability
  // (least-privilege; Q9). Built-in seed schemas bypass the tool (direct DB at
  // init). task_schema_get is an open read (TOOLS_NO_AUTH).
  register_task_schema: "manage_schemas",
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
  // v2.7.1 [CRITICAL FIX] — an external security review surfaced that
  // pre-v2.7.1 this map omitted
  // expand_capabilities entirely. The dispatcher at src/server.ts:1034
  // falls back to "no capability required" for unmapped tools, so any
  // authenticated agent — even one with the default `{user}` cap set —
  // could call expand_capabilities on themselves to add `admin`,
  // `manage_others`, `rotate_others`, then in ~3 calls revoke any peer
  // via revoke_token or rotate_token_admin. Gate on `admin` to match
  // the existing revoke_token surface — the two tools form the
  // privilege-escalation pair.
  expand_capabilities: "admin",
  // v2.7.1 R1 [P2 FIX] — codex audit caught that set_dashboard_theme
  // documents itself as "Auth: dashboard-secret-equivalent capability
  // (treated as an admin operation)" at src/server.ts:633 but was NOT
  // in TOOL_CAPABILITY. The fixed-list spec-pin in v2.7.1 R0's
  // tests/v2-7-1-expand-capabilities-gate.test.ts missed this current
  // counterexample (a fixed list would NOT have failed if another admin
  // tool stayed unmapped).
  // R1 adds the cap entry AND replaces the spec-pin with a contract
  // test that scans tool descriptions for admin-equivalent phrasing.
  set_dashboard_theme: "admin",
};

/** Tools that do NOT require any authentication (bootstrap + always-allowed-readonly). */
export const TOOLS_NO_AUTH: ReadonlySet<string> = new Set([
  "register_agent",
  // ADR-0005: abandon_registration authenticates via the one-time
  // registration-recovery HANDLE (the caller lost the agent_token — that's the
  // whole point), verified inside the handler; the keystone (only-never-authed
  // rows) makes it safe. No agent_token gate.
  "abandon_registration",
  // v2.0 final: health_check is a monitoring/diagnostic endpoint. No auth so
  // operators can probe from scripts without wiring a token. Returns only
  // aggregate counts — no per-agent content.
  "health_check",
  // v2.10: task_schema_get is a pure read of a public structural contract.
  "task_schema_get",
]);

/**
 * Check if the caller's presented token authenticates them as `claimedName`.
 *
 * v2.1 Phase 4b.1 v2: auth now gates on `authState` FIRST, replacing the
 * v1 `token_hash IS NULL` overload. See types.AgentAuthState for semantics.
 *
 * @param claimedName  The agent name the caller claims to be.
 * @param tokenOrNull  The raw token presented, or null if none was sent.
 * @param stored       The stored credential: bcrypt hash + lookup digest (no hash iff state=legacy_bootstrap).
 *                     PR-B: decided by token-verify.ts (failures never hash on a known digest; bcrypt
 *                     only in the worker pool).
 * @param authState    v2.1: explicit auth-state of the target row. Defaults to
 *                     `"active"` when not supplied (backward-compat during
 *                     pre-migration startup; once migrateSchemaToV2_1 runs,
 *                     every row carries an explicit value).
 */
export async function authenticateAgent(
  claimedName: string,
  tokenOrNull: string | null,
  stored: StoredCredential | null,
  authState: AuthStateInput = "active",
  graceInputs: RotationGraceInputs = {},
  /** The throttle's source (SEC-20: an HTTP route passes its trusted-proxy-aware source IP). */
  source: string = authSource()
): Promise<AuthResult> {
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
  // PR-B: a refusal that did NOT decide the token (the throttle, or a full pool) says so.
  const undecided = (v: CredentialVerdict): AuthResult | null =>
    v === "throttled"
      ? { ok: false, throttled: true, reason: `Too many failed token attempts for agent "${claimedName}" from this source: wait and retry.` }
      : v === "busy"
        ? { ok: false, busy: true, reason: "The relay is busy verifying credentials: retry." }
        : null;
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
    if (stored?.hash) {
      const v = (await verifyCredential(claimedName, stored, tokenOrNull, source)).verdict;
      if (v === "ok") return { ok: true, matched: "current" };
      const u = undecided(v);
      if (u) return u;
    }
    // Old token works ONLY while grace hasn't expired.
    if (!expired && graceInputs.previous?.hash) {
      const v = (await verifyCredential(claimedName, graceInputs.previous, tokenOrNull, source)).verdict;
      // The compare is AWAITED (the pool), so the window can close while it runs: the verdict says it rests on
      // the PREVIOUS credential, and revalidate re-checks the window against the clock at the point of use
      // (one site for every await, architect b11ef8ad), never here.
      if (v === "ok") return { ok: true, matched: "previous" };
      const u = undecided(v);
      if (u) return u;
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
  if (!stored?.hash) {
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
  const v = (await verifyCredential(claimedName, stored, tokenOrNull, source)).verdict;
  if (v === "ok") return { ok: true, matched: "current" };
  return undecided(v) ?? { ok: false, reason: `Invalid token for agent "${claimedName}".` };
}
