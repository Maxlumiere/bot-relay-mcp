// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * THE VERDICT CARRIES ITS EVIDENCE; AUTHORITY IS RE-DERIVED SYNCHRONOUSLY AT THE POINT OF USE (PR-B; architect
 * b11ef8ad / cbc2e1c5, after Codex R2 on #308).
 *
 * Auth is async (bcrypt runs in a worker pool), so between a verify and the handler's write a rotation, a
 * revocation, a recovery or simply the CLOCK can change what the verdict was based on. Guarding each await
 * separately missed one (the cache-put's second verify). So every allowed call records ONE verdict, and the
 * dispatcher calls `revalidate(verdict, now)` ONCE, synchronously, after the LAST await and with no await before
 * the handler starts (tests/pr-b-auth-invariants.test.ts pins that by AST). A cached verdict goes through it too:
 * a cache is never the last word.
 *
 * revalidate re-reads the row (sync) and requires, for a credential verdict:
 *   (a) the row still exists, is not revoked, and its auth_state still admits a caller (active, rotation_grace);
 *   (b) the EVIDENCE: the hash of the row the verify ran against is still that column's hash (no evidence = refused);
 *   (c) EVERY time predicate the verdict depends on, against `now`: a verdict on the PREVIOUS credential needs
 *       the row still in rotation_grace and its window still open;
 *   (d) the tool's required capability, from the FRESH row.
 * A verdict with no credential (a new name, a legacy migration, a recovery or abandon handle, a tool that needs
 * no auth) names WHY; those writes are guarded where they happen (CAS on the verified hash in the db layer).
 */
import type { CompatDatabase } from "./sqlite-compat.js";
import type { AgentRecord } from "./types.js";

export type AuthVerdict =
  | {
      kind: "credential";
      agent: string;
      /** Which stored credential the presented token matched. */
      basis: "current" | "previous";
      /** The bcrypt hash it matched (the row's token_hash or previous_token_hash at the read). */
      hash: string | null;
      /** The auth generation read WITH the row (kept for diagnostics; revalidate does NOT consult it). */
      gen: number;
    }
  | {
      kind: "none";
      why:
        | "validation"
        | "new-name"
        | "legacy-migration"
        | "recovery-cas"
        | "abandon-precondition"
        | "abandon-cas"
        | "no-auth-tool"
        | "legacy-grace";
    };

/**
 * SEC-20: is this row revoked (terminal) or awaiting recovery? ONE predicate for every consumer that must report
 * a revoke instead of acting (mint-token, mint-reuse, relay send / resolve), whatever the vault or the hash says.
 */
export function revokedStateOf(row: Pick<AgentRecord, "auth_state" | "revoked_at"> | null | undefined): "revoked" | "recovery_pending" | null {
  if (!row) return null;
  if (row.auth_state === "recovery_pending") return "recovery_pending";
  if (row.revoked_at || row.auth_state === "revoked") return "revoked";
  return null;
}

export type Revalidation = { ok: true } | { ok: false; reason: string; code: "AUTH_FAILED" | "CAP_DENIED" };

/**
 * PURE and SYNC: everything it reads comes through `db`, so a transaction can call it with no rewrite (the ADR-0050
 * seam). The dispatcher calls it and starts the handler in ONE synchronous block (authorizedDispatch, pinned by AST).
 *
 * Authority is derived from the FRESH row, never from the verdict (architect 6f35008c): the verdict contributes only
 * WHO (agent), WHICH credential (basis) and its EVIDENCE (the hash of the row its verify ran against). The global auth
 * generation is NOT consulted: it is only the verdict cache's invalidation key, so unrelated auth mutations cannot
 * refuse or churn this call.
 *
 * RESIDUAL (stated here, in SECURITY.md "Known residual behavior" and in the PR, architect ea8db5d9): authorization
 * and effect are atomic WITHIN the daemon process. A concurrent write from ANOTHER process (a CLI verb such as
 * `relay recover`, or a stdio connector, on the same SQLite file) can still commit between this check and the
 * handler's write, exactly as before PR-B. Closed by ADR-0050 (transactional authorization: this predicate and the
 * effect in ONE BEGIN IMMEDIATE transaction).
 */
export function revalidate(db: CompatDatabase, v: AuthVerdict, now: number, requiredCap?: string): Revalidation {
  if (v.kind === "none") {
    // No credential means no capabilities: a capability-gated tool on a "none" verdict is refused (fail closed).
    return requiredCap ? { ok: false, code: "CAP_DENIED", reason: `Tool requires the "${requiredCap}" capability; this call has no authenticated agent.` } : { ok: true };
  }
  const row = db.prepare("SELECT * FROM agents WHERE name = ?").get(v.agent) as AgentRecord | undefined;
  if (!row) return { ok: false, code: "AUTH_FAILED", reason: `Agent "${v.agent}" is no longer registered.` };
  // The state still admits a caller.
  const state = row.auth_state ?? "active";
  if (row.revoked_at || (state !== "active" && state !== "rotation_grace")) {
    return { ok: false, code: "AUTH_FAILED", reason: `Agent "${v.agent}" can no longer authenticate (${row.revoked_at ? "revoked" : state}).` };
  }
  // The EVIDENCE: the credential the verify matched must still be the row's, for that column. A credential verdict
  // without evidence is refused (fail closed): a verdict can never be trusted on its say-so.
  const stored = v.basis === "current" ? row.token_hash : row.previous_token_hash;
  if (!v.hash || stored !== v.hash) {
    return { ok: false, code: "AUTH_FAILED", reason: `The credential for agent "${v.agent}" changed since it was verified: re-authenticate.` };
  }
  // Time predicates, against `now` (read once by the caller). A PREVIOUS-credential verdict holds only inside the
  // rotation-grace window. (A row with no recorded expiry keeps authenticateAgent's semantics: no expiry.)
  if (v.basis === "previous") {
    const expiry = row.rotation_grace_expires_at ? new Date(row.rotation_grace_expires_at).getTime() : 0;
    if (state !== "rotation_grace" || (expiry > 0 && now >= expiry)) {
      return { ok: false, code: "AUTH_FAILED", reason: `Invalid token for agent "${v.agent}" (rotation grace window expired — use the new token).` };
    }
  }
  // SEAM (ADR-0049 S2): a lease's expiry joins HERE, as one more time predicate on the verdict.
  // Capabilities from the FRESH row (never the verdict's): a capability change needs no generation either.
  if (requiredCap) {
    let caps: string[] = [];
    try {
      caps = JSON.parse(row.capabilities ?? "[]") as string[];
    } catch {
      caps = [];
    }
    if (!caps.includes(requiredCap)) {
      return { ok: false, code: "CAP_DENIED", reason: `Agent "${v.agent}" lacks required capability "${requiredCap}".` };
    }
  }
  return { ok: true };
}
