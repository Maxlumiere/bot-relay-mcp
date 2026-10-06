// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ONE decision for "is this token the one stored here?" (PR-B; architect rulings e26359ac, 16343dc1,
 * 7ab8ea86). FAILURES NEVER HASH where the stored digest can decide:
 *
 *   digest says   | what runs                                   | a failure
 *   --------------+---------------------------------------------+--------------------------------
 *   mismatch      | nothing: DEFINITIVELY wrong                 | free (zero bcrypt)
 *   match         | one pooled bcrypt CONFIRM (a true positive) | (a digest collision only)
 *   unknown       | throttle RESERVED, then one pooled bcrypt    | spends it (a success refunds it)
 *
 * "unknown" = no digest, a pre-PR-B digest of unknown provenance that no derivable key reproduces, or a
 * digest under a key that is no longer derivable (token-lookup.ts digestVerdict). bcrypt always runs
 * in the worker pool, never on the event loop; a full pool refuses at once ("busy"), never waits. A
 * worker failure is "not verified" (fail closed).
 */
import { BcryptBusyError, compareOffLoop } from "./bcrypt-pool.js";
import { throttleRefund, throttleTake } from "./auth-throttle.js";
import { digestVerdict } from "./token-lookup.js";
import { currentContext } from "./request-context.js";

export type CredentialVerdict = "ok" | "wrong" | "throttled" | "busy";

/** One stored credential: a bcrypt hash and the lookup digest written beside it (or none). */
export interface StoredCredential {
  hash: string | null | undefined;
  lookup?: string | null;
}

/** The throttle's source for the current request: the HTTP source IP, else the transport ("stdio"). */
export function authSource(): string {
  const ctx = currentContext();
  return ctx.sourceIp ?? ctx.transport;
}

/** Verify `token` against ONE stored credential of agent `name`. */
export async function verifyCredential(
  name: string,
  stored: StoredCredential,
  token: string,
  source: string = authSource(),
): Promise<{ verdict: CredentialVerdict; digest: "match" | "mismatch" | "unknown" }> {
  if (!stored.hash) return { verdict: "wrong", digest: "unknown" };
  const digest = digestVerdict(stored.lookup, token);
  if (digest === "mismatch") return { verdict: "wrong", digest };
  const reserved = digest === "unknown";
  if (reserved && !throttleTake(source, name)) return { verdict: "throttled", digest };
  let ok: boolean;
  try {
    ok = await compareOffLoop(token, stored.hash);
  } catch (err) {
    if (reserved) throttleRefund(source, name); // never compared: nothing failed
    return { verdict: err instanceof BcryptBusyError ? "busy" : "wrong", digest };
  }
  if (ok && reserved) throttleRefund(source, name); // only a FAILED compare spends an attempt
  return { verdict: ok ? "ok" : "wrong", digest };
}

/**
 * Verify a secret that has NO lookup digest (a recovery token, a registration-recovery handle):
 * always the "unknown" row of the table above, throttled per (source, name).
 */
export async function verifySecretHash(
  name: string,
  hash: string | null | undefined,
  presented: string,
  source: string = authSource(),
): Promise<CredentialVerdict> {
  return (await verifyCredential(name, { hash, lookup: null }, presented, source)).verdict;
}
