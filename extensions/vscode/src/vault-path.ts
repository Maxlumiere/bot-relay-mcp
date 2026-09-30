// Tether for bot-relay-mcp (VSCode)
// SPDX-License-Identifier: MIT
//
// v0.5.0 — per-instance vault-path resolver + token reader.
//
// THE DURABLE AUTOWAKE-TOKEN FIX. Tether used to read only a MANUALLY-set
// SecretStorage token, so when a launcher's `mint-token --force` rotated the
// agent's DB token on relaunch — while the SessionStart hook rewrote the fresh
// token to the per-instance VAULT — Tether kept presenting its stale copy and
// 401'd (autowake died until the operator re-ran "Set Agent Token"). This
// module lets Tether read the vault the hook keeps current, so identity
// auto-syncs across a rotation with ZERO manual steps.
//
// D2 (the load-bearing constraint): the vault path MUST be resolved EXACTLY the
// way the relay resolves it, then `dirname(dbPath)/agents/<name>.token`. Since
// ADR-0048 PR D that is not a mirror any more: Tether BUNDLES the relay's ONE
// resolver (src/resolve-instance.ts, a pure module) and calls it. So every rule
// the relay applies applies here, by construction: the flat DB only on a
// positive absence of any instance, a present-but-malformed or ambiguous
// selection is a MISS (never a silent fall-through to the flat vault), ids "."
// and ".." are refused, and containment (approved roots, real paths, the
// shared-root ownership rule; labeled "roots-only" on Windows) is the relay's
// own. A shared fixture (tests/fixtures/instance-resolution-table.json) runs the
// same rows through the relay and through this module.
//
// The token is shape-validated and NEVER logged.
//
// VSCode-free: `env` + `homeDir` are injected so the unit tests drive the REAL
// resolver (extension.ts wires `process.env` + `os.homedir()`); the resolver
// takes the env as a PARAMETER and never reads or mutates process.env for it.
import fs from "node:fs";
import path from "node:path";
import { resolveInstance, INSTANCE_ID_RE as RESOLVER_INSTANCE_ID_RE, RESOLVER_REVISION } from "../../../src/resolve-instance.js";

/** The resolver revision this bundle carries (compared with the relay's /health). */
export const BUNDLED_RESOLVER_REVISION = RESOLVER_REVISION;

/** Mirrors src/token-store.ts TOKEN_SHAPE_RE. */
export const TOKEN_SHAPE_RE = /^[A-Za-z0-9_=.-]{8,128}$/;
/** Mirrors config.ts AGENT_NAME_RE / hooks/_vault-helpers.sh. */
export const AGENT_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
/** The relay's own instance-id rule (re-exported; not a copy). */
export const INSTANCE_ID_RE = RESOLVER_INSTANCE_ID_RE;

export type EnvRecord = Record<string, string | undefined>;

export type DbPathResult = { dbPath: string } | { miss: string };

/**
 * The relay DB for `env`, from the relay's ONE resolver. The injected `homeDir`
 * is authoritative for the home directory (HOME / USERPROFILE), exactly as the
 * callers pass it; the resolver's error kind is a MISS with its reason.
 */
export function resolveRelayDbPath(env: EnvRecord, homeDir: string): DbPathResult {
  const r = resolveInstance({ env: { ...env, HOME: homeDir, USERPROFILE: homeDir } });
  if (r.kind === "error") return { miss: r.reason };
  return { dbPath: r.dbPath };
}

export type VaultPathResult = { tokenPath: string } | { miss: string };

/** Resolve the per-agent vault token file: dirname(dbPath)/agents/<name>.token. */
export function resolveVaultTokenPath(
  agentName: string,
  env: EnvRecord,
  homeDir: string,
): VaultPathResult {
  if (!AGENT_NAME_RE.test(agentName)) return { miss: `invalid agent name "${agentName}"` };
  const db = resolveRelayDbPath(env, homeDir);
  if ("miss" in db) return { miss: db.miss };
  return { tokenPath: path.join(path.dirname(db.dbPath), "agents", `${agentName}.token`) };
}

/**
 * Read + shape-validate the per-instance vault token for `agentName`, or null.
 *
 * Distinguishes:
 *   - malformed active-instance → FAIL CLOSED: null + a visible `log` (never a
 *     flat-vault fallback that could read the wrong token);
 *   - absent vault file → null silently (the caller falls back to SecretStorage
 *     / env / config — back-compat + cross-machine);
 *   - present but wrong shape → null + a log (NEVER logging the value).
 *
 * The token itself is NEVER passed to `log`.
 */
export function readVaultToken(
  agentName: string,
  env: EnvRecord,
  homeDir: string,
  log: (line: string) => void,
): string | null {
  const resolved = resolveVaultTokenPath(agentName, env, homeDir);
  if ("miss" in resolved) {
    log(`vault: ${resolved.miss} — NOT falling back to a flat vault (fail-closed to avoid reading the wrong instance's token)`);
    return null;
  }
  let raw: string;
  try {
    raw = fs.readFileSync(resolved.tokenPath, "utf-8").trim();
  } catch {
    return null; // absent / unreadable → miss, caller falls back
  }
  if (!TOKEN_SHAPE_RE.test(raw)) {
    log(`vault: token at ${resolved.tokenPath} failed shape validation — ignoring (value not logged)`);
    return null;
  }
  return raw;
}
