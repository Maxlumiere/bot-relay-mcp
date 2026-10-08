// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * SEC-20: ONE authorizer for "does this token act as agent `name`?", for every consumer outside the MCP
 * dispatcher (which runs the same two steps inline: authenticateAgent, then revalidate at the point of use).
 *
 * A revoke KEEPS the agent's token hash (for forensics), so the token still MATCHES: only the row's
 * auth_state makes it invalid. A consumer that checked the hash alone (verifyCredential) let a revoked
 * agent act: /api/send-message delivered its messages, and `relay mint-token` handed its vault token back
 * as "reused". So a consumer never calls verifyCredential directly (tests/sec-20-verify-sites.test.ts):
 *
 *   1. authenticateAgent: the state decides first (revoked, recovery_pending: refused; rotation_grace: the
 *      new token, or the previous one inside its window; legacy_bootstrap: no actor); then the hash;
 *   2. revalidate: the same predicate the dispatcher applies at the point of use, on a FRESH read of the row
 *      (the verify is awaited, so a revoke can land during it).
 *
 * A caller that WRITES on the result (the send route) calls revalidate AGAIN, synchronously, immediately
 * before its write: an await separates this function's check from the caller's code (PR-B, 64131354).
 */
import { authenticateAgent, type AuthStateInput } from "./auth.js";
import { revalidate, type AuthVerdict } from "./auth-verdict.js";
import { authSource } from "./token-verify.js";
import { getAgentAuthData, getAuthGeneration, getDb } from "./db.js";

export type CredentialVerdict = Extract<AuthVerdict, { kind: "credential" }>;

export type TokenAuthorization =
  | { ok: true; verdict: CredentialVerdict; capabilities: string[] }
  | {
      ok: false;
      /** Why, as a fact a caller can act on: revoked / recovery_pending are the row's state, not the token's. */
      refusal: "unknown_agent" | "revoked" | "recovery_pending" | "legacy" | "invalid" | "throttled" | "busy";
      reason: string;
    };

/** Is `token` a credential that may act as agent `name` right now? See the module comment. */
export async function authorizeAgentToken(name: string, token: string | null, source: string = authSource()): Promise<TokenAuthorization> {
  const gen = getAuthGeneration(); // read WITH the row: diagnostics only, revalidate does not consult it
  const row = getAgentAuthData(name);
  if (!row) return { ok: false, refusal: "unknown_agent", reason: `Agent "${name}" is not registered.` };
  const state = (row.auth_state ?? "active") as AuthStateInput;
  const result = await authenticateAgent(
    name,
    token,
    { hash: row.token_hash, lookup: row.token_lookup },
    state,
    { previous: { hash: row.previous_token_hash ?? null, lookup: row.previous_token_lookup ?? null }, rotationGraceExpiresAt: row.rotation_grace_expires_at ?? null },
    source,
  );
  if (!result.ok) {
    const refusal = result.revoked ? "revoked" : result.recoveryRequired ? "recovery_pending" : result.throttled ? "throttled" : result.busy ? "busy" : "invalid";
    return { ok: false, refusal, reason: result.reason ?? `Invalid token for agent "${name}".` };
  }
  // Legacy grace authenticates a token-less pre-v1.7 row WITHOUT proving identity: never an actor.
  if (result.legacy) return { ok: false, refusal: "legacy", reason: `Agent "${name}" has no token (legacy pre-v1.7 row): mint one before acting as it.` };
  const basis = result.matched ?? "current";
  const verdict: CredentialVerdict = { kind: "credential", agent: name, basis, hash: basis === "current" ? (row.token_hash ?? null) : (row.previous_token_hash ?? null), gen };
  const still = revalidate(getDb(), verdict, Date.now());
  if (!still.ok) return { ok: false, refusal: /revoked/.test(still.reason) ? "revoked" : /recovery_pending/.test(still.reason) ? "recovery_pending" : "invalid", reason: still.reason };
  let capabilities: string[] = [];
  try {
    capabilities = JSON.parse(row.capabilities ?? "[]") as string[];
  } catch {
    capabilities = [];
  }
  return { ok: true, verdict, capabilities };
}
