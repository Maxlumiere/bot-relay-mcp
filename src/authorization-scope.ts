// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * SEC-20 (Codex #315 R1 P1): the dispatcher's authorization, re-derivable INSIDE an async handler.
 *
 * The dispatcher revalidates a call's verdict synchronously right before the handler starts (PR-B). A handler
 * that AWAITS before it writes (register_webhook validates the URL with DNS; spawn_agent writes the token vault
 * before it launches the child) opened a window the dispatcher's check does not cover: a revoke landing during
 * that await, and the write still happened. Such a handler calls recheckAuthorization() after its LAST await,
 * synchronously, immediately before the write: the same revalidate on the same verdict and capability, against
 * the fresh row and the current clock.
 *
 * tests/sec-20-async-handlers.test.ts pins that every async dispatched handler is classified here (it does no
 * write after an await, or it calls recheckAuthorization first). ADR-0051's activation boundary supersedes this.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { revalidate, type AuthVerdict, type Revalidation } from "./auth-verdict.js";
import { getDb } from "./db.js";

interface AuthorizationScope {
  verdict: AuthVerdict;
  requiredCap?: string;
}

const scope = new AsyncLocalStorage<AuthorizationScope>();

/** Run a dispatched handler under its call's verdict (the dispatcher's only use). */
export function runAuthorized<T>(verdict: AuthVerdict, requiredCap: string | undefined, fn: () => T): T {
  return scope.run({ verdict, requiredCap }, fn);
}

/**
 * Is the caller of the current dispatched call STILL authorized, right now? SYNC: call it after the handler's last
 * await and write with no await in between. Outside a dispatched call (a handler invoked directly by a test) there
 * is no verdict to re-derive, so it reports ok with `unscoped: true`: in production every handler runs under the
 * dispatcher (src/server.ts dispatch is their only caller, pinned by the same test).
 */
export function recheckAuthorization(): Revalidation & { unscoped?: true } {
  const s = scope.getStore();
  if (!s) return { ok: true, unscoped: true };
  return revalidate(getDb(), s.verdict, Date.now(), s.requiredCap);
}
