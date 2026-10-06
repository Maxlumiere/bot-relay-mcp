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
 *   (a) the auth GENERATION read with the row before the verify is still current (every token/auth mutation
 *       bumps it, by construction: scripts/auth-gen-guard.mjs). A moved generation is RETRYABLE: re-verify.
 *   (b) the row still exists, is not revoked, and its auth_state still admits a caller (active, rotation_grace);
 *       independent of (a), cheap.
 *   (c) EVERY time predicate the verdict depends on, against `now`: a verdict on the PREVIOUS credential needs
 *       the row still in rotation_grace and its window still open.
 *   The matched credential's fingerprint (its bcrypt hash) still on the row: free from the same read.
 * A verdict with no credential (bootstrap, a legacy migration, a recovery or abandon handle, a tool that needs
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
      /** The auth generation read WITH the row, BEFORE the awaited verify. */
      gen: number;
    }
  | {
      kind: "none";
      why:
        | "validation"
        | "bootstrap"
        | "legacy-migration"
        | "recovery-cas"
        | "abandon-precondition"
        | "abandon-cas"
        | "no-auth-tool"
        | "legacy-grace";
    };

export type Revalidation = { ok: true } | { ok: false; retryable: boolean; reason: string };

/**
 * PURE and SYNC: everything it reads comes through `db`, so a transaction can call it with no rewrite (the ADR-0050
 * seam). No await may sit between this and the handler (pinned by AST).
 *
 * RESIDUAL (stated here, in SECURITY.md "Known residual behavior" and in the PR, architect ea8db5d9): authorization
 * and effect are atomic WITHIN the daemon process. A concurrent write from ANOTHER process (a CLI verb such as
 * `relay recover`, or a stdio connector, on the same SQLite file) can still commit between this check and the
 * handler's write, exactly as before PR-B. Closed by ADR-0050 (transactional authorization: this predicate and the
 * effect in ONE BEGIN IMMEDIATE transaction).
 */
export function revalidate(db: CompatDatabase, v: AuthVerdict, now: number): Revalidation {
  if (v.kind === "none") return { ok: true };
  // (a) the generation: any token/auth mutation since the read means the verdict may be stale. Re-verify.
  const gen = (db.prepare("SELECT generation FROM auth_meta WHERE id = 1").get() as { generation?: number } | undefined)?.generation ?? 0;
  if (gen !== v.gen) {
    return { ok: false, retryable: true, reason: "Auth state changed while this call was being verified: retry." };
  }
  const row = db.prepare("SELECT * FROM agents WHERE name = ?").get(v.agent) as AgentRecord | undefined;
  if (!row) return { ok: false, retryable: false, reason: `Agent "${v.agent}" is no longer registered.` };
  // (b) the state still admits a caller.
  const state = row.auth_state ?? "active";
  if (row.revoked_at || (state !== "active" && state !== "rotation_grace")) {
    return { ok: false, retryable: false, reason: `Agent "${v.agent}" can no longer authenticate (${row.revoked_at ? "revoked" : state}).` };
  }
  // The matched credential is still the row's (free from the same read).
  const stored = v.basis === "current" ? row.token_hash : row.previous_token_hash;
  if (v.hash !== null && stored !== v.hash) {
    return { ok: false, retryable: true, reason: "The credential changed while this call was being verified: retry." };
  }
  // (c) time predicates. A PREVIOUS-credential verdict holds only inside the rotation-grace window, now.
  if (v.basis === "previous") {
    const expiry = row.rotation_grace_expires_at ? new Date(row.rotation_grace_expires_at).getTime() : 0;
    if (state !== "rotation_grace" || (expiry > 0 && now >= expiry)) {
      return { ok: false, retryable: false, reason: `Invalid token for agent "${v.agent}" (rotation grace window expired — use the new token).` };
    }
  }
  // SEAM (ADR-0049 S2): a lease's expiry joins HERE, as one more time predicate on the verdict.
  return { ok: true };
}
