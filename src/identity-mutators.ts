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
