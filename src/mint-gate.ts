// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * THE REGISTRATION-SECRET GATE (PR-D; architect rulings f885e674, dfa29648, efb48600, 64131354).
 *
 * Decides whether a register_agent that CREATES a name may proceed. Only that branch is gated (Q1): an
 * existing identity is authenticated by its own token, and stdio is out of scope (Q6: a local process that
 * can spawn the server can already open the DB). Over HTTP the caller must present this instance's
 * registration secret (src/mint-secret.ts) as X-Relay-Secret or Authorization: Bearer.
 *
 * SYNCHRONOUS BY CONSTRUCTION (64131354 point 2): the read is readFileSync and the compare timingSafeEqual,
 * so the gate adds no await between the dispatcher's final authorization check and the write it authorizes.
 * tests/pr-d-mint-gate.test.ts asserts checkMintGate is not an AsyncFunction.
 *
 * The secret is read AT USE TIME, never cached: a rotation needs no restart, and a deleted or broken file
 * FAILS CLOSED (a refusal, never an open mint).
 */
import path from "path";
import { getDbPath } from "./db.js";
import { MintSecretError, ensureMintSecret, mintSecretMatches, readMintSecret } from "./mint-secret.js";

/** The development escape hatch (Q5): open minting, announced loudly, refused on a non-loopback bind. */
export const OPEN_MINT_ENV = "RELAY_ALLOW_OPEN_MINT";

export function openMintAllowed(): boolean {
  return process.env[OPEN_MINT_ENV] === "1";
}

/**
 * Where the secret lives: `<dir of the DB>/secrets/mint.secret`. In instance mode that is the instance
 * directory (ruling Q3); in the flat layout it is the relay root. The secret belongs to the DB it guards.
 */
export function mintSecretHome(): string {
  return path.dirname(getDbPath());
}

export type MintGateVerdict =
  | { ok: true; mode: "stdio" | "secret" | "open-dev" }
  | { ok: false; reason: "missing" | "wrong" | "unavailable"; detail: string };

export function checkMintGate(transport: "stdio" | "http", presented: string | undefined): MintGateVerdict {
  if (transport === "stdio") return { ok: true, mode: "stdio" };
  if (openMintAllowed()) return { ok: true, mode: "open-dev" };
  let secret: string | null;
  try {
    secret = readMintSecret(mintSecretHome());
  } catch (err) {
    const detail = err instanceof MintSecretError ? err.message : `the registration secret could not be read (${(err as Error).message})`;
    return { ok: false, reason: "unavailable", detail };
  }
  if (secret === null) return { ok: false, reason: "unavailable", detail: "this relay has no registration secret (restart the daemon, or run `relay init`)" };
  if (presented === undefined) return { ok: false, reason: "missing", detail: "no registration secret was presented" };
  if (!mintSecretMatches(presented, secret)) return { ok: false, reason: "wrong", detail: "the presented registration secret does not match" };
  return { ok: true, mode: "secret" };
}

/** What /health reports (Q1): "secret" (gated), "open-dev" (RELAY_ALLOW_OPEN_MINT=1), or "unavailable" (gated, but no usable secret: every new-name register is refused). */
export function mintMode(): "secret" | "open-dev" | "unavailable" {
  if (openMintAllowed()) return "open-dev";
  try {
    return readMintSecret(mintSecretHome()) !== null ? "secret" : "unavailable";
  } catch {
    return "unavailable";
  }
}

/** Why the secret is unusable (absent, malformed, or its chain not private: the path and uid, mode or SID), or null when it is usable or minting is open. Never the secret itself. */
export function mintFault(): string | null {
  if (openMintAllowed()) return null;
  try {
    return readMintSecret(mintSecretHome()) !== null ? null : `no registration secret at ${mintSecretHome()} (restart the daemon, or run \`relay init\`)`;
  } catch (err) {
    return (err as Error).message;
  }
}

/**
 * At HTTP daemon start (Q4, Q5, Q8). `loopback`: whether the bind host is a loopback literal.
 *   - RELAY_ALLOW_OPEN_MINT=1 on a NON-loopback bind: THROWS (the daemon refuses to start). On loopback it
 *     is announced loudly, and /health says open-dev.
 *   - Otherwise the secret is created when absent, SEEDED from a legacy http_secret when one is set (so a
 *     remote client that already sends it keeps working), and announced once. An existing secret is never
 *     replaced; a legacy http_secret that DIFFERS from it is a loud warning (two secrets, one meaning).
 *   - A secret that cannot be created or read does NOT stop the daemon (existing agents keep working); it is
 *     a loud error, /health reports "unavailable", and the gate refuses every new-name register (fail closed).
 * `say` receives the announcements (the daemon's logger); nothing printed ever contains the secret.
 */
export function prepareMintSecret(
  loopback: boolean,
  legacyHttpSecret: string | null,
  say: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void },
): "secret" | "open-dev" | "unavailable" {
  if (openMintAllowed()) {
    if (!loopback) {
      throw new Error(
        `Refusing to start: ${OPEN_MINT_ENV}=1 lets ANY caller register a new agent name without the registration secret, ` +
        `and this daemon binds a non-loopback host. Unset ${OPEN_MINT_ENV} (it is for local development only).`,
      );
    }
    say.warn(`[mint] OPEN MINT (${OPEN_MINT_ENV}=1): any local process can register a NEW agent name without the registration secret. Development only; /health reports mint: open-dev.`);
    return "open-dev";
  }
  const home = mintSecretHome();
  try {
    const seed = legacyHttpSecret && legacyHttpSecret.length > 0 ? legacyHttpSecret : undefined;
    const r = ensureMintSecret(home, seed);
    if (r.created) {
      say.info(
        seed
          ? `[mint] created the registration secret at ${r.path}, SEEDED from the legacy http_secret so existing remote clients keep working. New writes and rotations go to this file only.`
          : `[mint] created the registration secret at ${r.path}. Registering a NEW agent name over HTTP now requires it (X-Relay-Secret); the relay hooks read it at use time.`,
      );
    } else if (seed !== undefined) {
      const current = readMintSecret(home);
      if (current !== null && !mintSecretMatches(seed, current)) {
        say.warn(`[mint] the legacy http_secret DIFFERS from the registration secret at ${r.path}: remote clients that send only http_secret cannot register new names. Make them one secret.`);
      }
    }
    return "secret";
  } catch (err) {
    say.error(`[mint] the registration secret is UNAVAILABLE (${(err as Error).message}): every NEW-name registration over HTTP will be refused until it is fixed (run \`relay init\`). Existing agents are unaffected.`);
    return "unavailable";
  }
}
