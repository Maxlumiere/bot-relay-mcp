// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import { AsyncLocalStorage } from "async_hooks";

/**
 * Request-scoped context for the HTTP transport.
 *
 * The HTTP transport sets this per request (source IP, auth state). The
 * tool dispatcher reads it to decide how to rate-limit: authenticated or
 * stdio callers are rate-limited by agent_name; unauthenticated HTTP
 * callers are also rate-limited by their source IP so they cannot bypass
 * quotas by rotating agent names.
 */
export interface RequestContext {
  /** Remote IP address of the HTTP caller, if any. */
  sourceIp?: string;
  /** Whether the HTTP request presented a valid shared secret. */
  authenticated?: boolean;
  /** Transport origin: 'stdio' or 'http'. */
  transport: "stdio" | "http";
  /** v1.7: HTTP caller's X-Agent-Token header value (if any). */
  headerAgentToken?: string;
  /**
   * PR-D: the secret the HTTP caller presented (X-Relay-Secret, else Authorization: Bearer), if any. The
   * registration-secret gate compares it when a NEW name registers (src/mint-gate.ts). Never logged.
   */
  presentedSecret?: string;
  /**
   * v2.1 (Phase 4k): the authenticated agent name for this tool call. Set by
   * `enforceAuth` in `server.ts` on successful resolution (both explicit-caller
   * and token-resolved paths). Handlers that need caller identity for authz —
   * e.g. `handleGetTask` verifying the caller is a party to the task — read
   * from here. `undefined` means unauth or a tool that skipped auth entirely.
   */
  callerName?: string;
  /**
   * v2.1 (Phase 7p HIGH #2): the exact `recovery_token_hash` value the
   * dispatcher verified for a recovery_pending → active transition. Passed
   * through to `registerAgent` so the CAS UPDATE pins to the HASH the caller
   * actually presented against, not to a fresh SELECT (which would miss an
   * admin reissue landing between verify and UPDATE). Closes the verify-then-
   * reissue race in Phase 4b.1 v2.
   */
  verifiedRecoveryHash?: string | null;
  /**
   * PR-B (architect 64131354): the registration-recovery hash the dispatcher VERIFIED an
   * abandon_registration handle against (an async, pooled compare under the auth-generation
   * re-check), so the SYNC handler deletes only while the row still carries it. Unset: not verified.
   */
  verifiedAbandonHash?: string | null;
  /**
   * PR-B (architect b11ef8ad): the verdict enforceAuth allowed this call on, with its evidence. The dispatcher
   * revalidates it synchronously after the last await (src/auth-verdict.ts); a call without one is refused.
   */
  authVerdict?: import("./auth-verdict.js").AuthVerdict;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/** Returns the current request context, or a stdio default if none is set. */
export function currentContext(): RequestContext {
  return requestContext.getStore() ?? { transport: "stdio" };
}
