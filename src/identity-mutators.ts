// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * THE REGISTRY of tools whose handler WRITES identity or token state (PR-B; architect ruling 64131354).
 *
 * The invariant, by construction: NO await between the FINAL authorization check and the state write it
 * authorizes. Auth is async (bcrypt runs in a worker pool), so the dispatcher re-verifies whenever the
 * auth generation moved during verification (server.ts), and from that last check to the handler's write
 * everything must be synchronous. So every handler listed here is a SYNC function, with one declared
 * shape: "sync-prefix", an async handler whose authorized write happens before its FIRST await.
 *
 * tests/pr-b-auth-invariants.test.ts enforces it: each handler's kind; the dispatcher's route to it; and
 * that any handler in src/tools that calls an identity/token mutator is listed here (so a new mutating
 * handler cannot be added silently). PR-D's create branch joins this registry.
 */
export interface IdentityMutatingTool {
  /** The handler's exported name, in `module`. */
  handler: string;
  module: string;
  /** "sync": the handler is not async. "sync-prefix": async, but its authorized write precedes its first await. */
  shape: "sync" | "sync-prefix";
  /** For "sync-prefix": the identifier of the write that must come before the first `await` in the handler. */
  writeBeforeFirstAwait?: string;
}

export const IDENTITY_MUTATING_TOOLS: Readonly<Record<string, IdentityMutatingTool>> = Object.freeze({
  register_agent: { handler: "handleRegisterAgent", module: "tools/identity", shape: "sync" },
  unregister_agent: { handler: "handleUnregisterAgent", module: "tools/identity", shape: "sync" },
  abandon_registration: { handler: "handleAbandonRegistration", module: "tools/identity", shape: "sync" },
  rotate_token: { handler: "handleRotateToken", module: "tools/identity", shape: "sync" },
  rotate_token_admin: { handler: "handleRotateTokenAdmin", module: "tools/identity", shape: "sync" },
  revoke_token: { handler: "handleRevokeToken", module: "tools/identity", shape: "sync" },
  expand_capabilities: { handler: "handleExpandCapabilities", module: "tools/identity", shape: "sync" },
  // Spawning a terminal is inherently async; the CHILD's identity is created before the first await.
  // Its later rollback (unregisterAgent after a failed vault write) is a compensating write of the row
  // it just created, after an await: a stated limit, outside this invariant.
  spawn_agent: { handler: "handleSpawnAgent", module: "tools/spawn", shape: "sync-prefix", writeBeforeFirstAwait: "registerAgent" },
});

/** The db functions that write identity or token state. A handler in src/tools calling one must be registered above. */
export const IDENTITY_MUTATOR_FUNCTIONS: readonly string[] = Object.freeze([
  "registerAgent",
  "unregisterAgent",
  "revokeAgentToken",
  "rotateAgentToken",
  "rotateAgentTokenAdmin",
  "expandAgentCapabilities",
  "abandonVerifiedRegistration",
  "abandonRegistration",
  "mintAgentToken",
]);

/**
 * EVERY site that AWAITS a credential verify, and what it writes after the verdict (PR-B; architect
 * 07fe7cfc: the no-await invariant widened to ANY write derived from an awaited verify). While a compare
 * runs in the pool, a rotate, revoke or recovery can land, so a write made from the verdict must stay
 * right when the credential changed during the verify. Each site says how:
 *   - "none"        it writes nothing derived from the verdict (it returns it, or sends the token on to
 *                   a daemon that verifies it again);
 *   - "dispatcher"  the writes are the tool handlers', made after the dispatcher's FINAL auth-generation
 *                   re-check with no await between (IDENTITY_MUTATING_TOOLS above);
 *   - "guarded"     each write is named with its guard: a CAS on the verified credential, a cache bound
 *                   to the generation read BEFORE the verify, a generation re-check, or a monotonic fact.
 * Keyed by `<file>:<enclosing top-level function>`, with the awaited primitives in source order.
 * tests/pr-b-auth-invariants.test.ts parses src (TypeScript AST) and requires this table to match EXACTLY,
 * so a new awaited verify cannot appear without being classified here. The behaviour is tested in
 * tests/pr-b-verify-derived-writes.test.ts (each race lands a mutation during the compare).
 */
export interface VerifySite {
  awaits: readonly string[];
  kind: "none" | "dispatcher" | "guarded";
  writes: string;
}

export const VERIFY_SITES: Readonly<Record<string, VerifySite>> = Object.freeze({
  "src/token-verify.ts:verifyCredential": { awaits: ["compareOffLoop"], kind: "none", writes: "the primitive: returns the verdict (its in-memory throttle refund is not credential state)" },
  "src/token-verify.ts:verifySecretHash": { awaits: ["verifyCredential"], kind: "none", writes: "returns the verdict" },
  "src/auth.ts:authenticateAgent": { awaits: ["verifyCredential", "verifyCredential", "verifyCredential"], kind: "none", writes: "returns the verdict" },
  "src/db.ts:findAgentRowByToken": { awaits: ["verifyCredential", "verifyCredential"], kind: "none", writes: "returns the matched row" },
  "src/db.ts:resolveAgentByToken": {
    awaits: ["findAgentRowByToken"],
    kind: "guarded",
    writes: "the verified-token cache (bound to the generation read BEFORE the await); the digest heal (a CAS on the verified credential); first_authed_at + established_at (monotonic: the token was valid when its compare started)",
  },
  "src/db.ts:explicitCallerCachePut": {
    awaits: ["verifyCredential"],
    kind: "guarded",
    writes: "the verified-token cache (bound to the generation the CALLER read with the row, before its verify); the digest heal (a CAS); first_authed_at + established_at (monotonic)",
  },
  "src/db.ts:abandonRegistration": { awaits: ["verifySecretHash"], kind: "guarded", writes: "the abandon delete: a CAS on the verified registration-recovery hash" },
  "src/server.ts:createServer": {
    awaits: ["verifySecretHash", "authenticateAgent", "verifySecretHash", "authenticateAgent", "explicitCallerCachePut", "resolveCallerByToken"],
    kind: "dispatcher",
    writes: "the tool handlers' writes, after the final auth-generation re-check; the explicit-caller cache via explicitCallerCachePut (generation read with the row)",
  },
  "src/tools/status.ts:checkToken": { awaits: ["findAgentRowByToken", "authenticateAgent"], kind: "guarded", writes: "first_authed_at + established_at (monotonic)" },
  "src/transport/http.ts:startHttpServer": { awaits: ["verifyCredential"], kind: "guarded", writes: "the dashboard send_message as `from`: refused with retry when the auth generation moved during the verify" },
  "src/mint-reuse.ts:stableMintOrReuse": { awaits: ["verifyCredential"], kind: "none", writes: "returns the vault token for reuse" },
  "src/cli/resolve.ts:run": { awaits: ["verifyCredential"], kind: "none", writes: "nothing in the DB: the token is sent on, and the daemon verifies it again" },
  "src/cli/send.ts:run": { awaits: ["verifyCredential"], kind: "none", writes: "nothing in the DB: the token is sent on, and the daemon verifies it again" },
});

/** The verify primitives an await of which makes a VERIFY_SITES entry. */
export const VERIFY_PRIMITIVES: readonly string[] = Object.freeze([
  "verifyCredential",
  "verifySecretHash",
  "compareOffLoop",
  "authenticateAgent",
  "findAgentRowByToken",
  "resolveAgentByToken",
  "explicitCallerCachePut",
  "resolveCallerByToken",
  "abandonRegistration",
]);
