// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.16.1 — stable mint-once-reuse (the launcher side of the durable
 * autowake-token fix).
 *
 * The recurring desync came from a launcher running `mint-token --force` on
 * EVERY relaunch: that rotated the DB token_hash, and any holder of the old
 * token (Tether's stale SecretStorage copy) 401'd. The Tether-side fix makes
 * Tether read the hook-maintained vault; THIS is the complementary launcher
 * fix — a default (non-force) mint that REUSES the existing credential instead
 * of churning it:
 *
 *   - no agent row            → mint a fresh token AND write it to the vault
 *                               (closing the pre-v2.16.1 "minted but never
 *                               wrote the vault" strand);
 *   - row + vault authenticates → REUSE (return the vault token, token_hash
 *                               UNCHANGED — no rotation, no churn);
 *   - row + vault does NOT authenticate (missing / stale / mismatched) →
 *                               MISMATCH: do NOT silently rotate as a "fix"
 *                               (that recreates the desync AND hides a possibly
 *                               stale/compromised credential). The caller
 *                               surfaces the state and requires an explicit
 *                               operator action (`--force` rotate, or
 *                               `relay recover`).
 *
 * Explicit rotation stays available via `mint-token --force` for the genuine
 * "I want a new token" case (it writes the vault too).
 */
import bcrypt from "bcryptjs";
import { mintAgentToken, getAgentAuthData } from "./db.js";
import { defaultTokenStore } from "./token-store.js";

export type MintReuseResult =
  | { status: "created"; token: string }
  | { status: "reused"; token: string }
  | { status: "mismatch" };

/**
 * Default (non-force) mint: create-and-vault, reuse-if-authenticating, or
 * report a mismatch. NEVER rotates an existing token silently. The plaintext
 * token in the result is for the operator/env only — callers must not log it.
 */
export async function stableMintOrReuse(
  name: string,
  role: string,
  capabilities: string[],
  opts: { description?: string | null } = {},
): Promise<MintReuseResult> {
  const existing = getAgentAuthData(name);
  if (!existing || !existing.token_hash) {
    // Genuinely absent identity → mint + write the vault atomically-enough
    // (DB row first, then the vault so a live agent's next hook run + Tether
    // both see the same current token).
    const minted = mintAgentToken(name, role, capabilities, { description: opts.description });
    await defaultTokenStore().write(name, minted.plaintext_token);
    return { status: "created", token: minted.plaintext_token };
  }
  // Row exists — reuse ONLY if the on-disk vault token authenticates against
  // the stored bcrypt hash.
  const vaultToken = await defaultTokenStore().read(name);
  if (vaultToken && bcrypt.compareSync(vaultToken, existing.token_hash)) {
    return { status: "reused", token: vaultToken };
  }
  // Row present but the vault can't prove it — refuse to silently rotate.
  return { status: "mismatch" };
}

/**
 * Explicit rotation (the `--force` path): rotate the DB token AND write the new
 * plaintext to the vault so the two halves stay in sync (pre-v2.16.1 the CLI
 * rotated the DB but never wrote the vault → the classic strand). Invalidates
 * the previous token by design.
 */
export async function forceRotateAndVault(
  name: string,
  role: string,
  capabilities: string[],
  opts: { description?: string | null } = {},
): Promise<{ token: string; created: boolean }> {
  const minted = mintAgentToken(name, role, capabilities, { description: opts.description, force: true });
  await defaultTokenStore().write(name, minted.plaintext_token);
  return { token: minted.plaintext_token, created: minted.created };
}
