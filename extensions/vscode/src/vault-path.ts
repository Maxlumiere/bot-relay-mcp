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
// way the relay resolves it (src/instance.ts `resolveInstanceDbPath` +
// src/token-store.ts `resolveAgentVaultDir`), honoring `RELAY_DB_PATH`,
// `RELAY_HOME`, `RELAY_INSTANCE_ID`, and the `~/.bot-relay/active-instance`
// pointer (symlink OR file — a GUI-launched VSCode often lacks the env but CAN
// read that file), then `dirname(dbPath)/agents/<name>.token`. A NAIVE flat
// `~/.bot-relay/agents` hardcode would reopen the v2.4.5 split-brain and read
// the WRONG token. So:
//   - a genuinely single-instance setup (no env + no active-instance file) →
//     the flat DB, which is correct there;
//   - but an active-instance that is PRESENT-BUT-MALFORMED → FAIL CLOSED (miss
//     + a visible log), never a silent fall-through to the flat vault.
//
// The token is shape-validated and NEVER logged.
//
// VSCode-free: `env` + `homeDir` are injected so the unit tests drive the REAL
// resolver (extension.ts wires `process.env` + `os.homedir()`).
import fs from "fs";
import path from "path";

/** Mirrors src/token-store.ts TOKEN_SHAPE_RE. */
export const TOKEN_SHAPE_RE = /^[A-Za-z0-9_=.-]{8,128}$/;
/** Mirrors config.ts AGENT_NAME_RE / hooks/_vault-helpers.sh. */
export const AGENT_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
/** Mirrors src/instance.ts instanceDir() id sanitizer. */
export const INSTANCE_ID_RE = /^[A-Za-z0-9._-]+$/;

export type EnvRecord = Record<string, string | undefined>;

function botRelayRoot(env: EnvRecord, homeDir: string): string {
  if (env.RELAY_HOME) return env.RELAY_HOME;
  return path.join(homeDir, ".bot-relay");
}

type InstanceResult = { id: string } | { id: null } | { malformed: string };

/**
 * Mirror of src/instance.ts resolveActiveInstanceId, but with the D2
 * fail-closed distinction: a PRESENT-but-malformed active-instance is a
 * `malformed` (→ miss), NOT a silent null (→ flat).
 */
function resolveActiveInstanceId(env: EnvRecord, homeDir: string): InstanceResult {
  const envId = env.RELAY_INSTANCE_ID;
  if (envId && envId.length > 0) {
    if (!INSTANCE_ID_RE.test(envId)) return { malformed: `RELAY_INSTANCE_ID "${envId}" is invalid` };
    return { id: envId };
  }
  const activeLink = path.join(botRelayRoot(env, homeDir), "active-instance");
  let st: fs.Stats;
  try {
    st = fs.lstatSync(activeLink); // no-follow so a symlink to a bare id still "exists"
  } catch {
    return { id: null }; // no pointer at all → legitimately single-instance (flat)
  }
  let raw: string | null = null;
  try {
    if (st.isSymbolicLink()) raw = path.basename(fs.readlinkSync(activeLink));
    else if (st.isFile()) raw = fs.readFileSync(activeLink, "utf-8").trim();
    else return { malformed: "active-instance is neither a file nor a symlink" };
  } catch {
    return { malformed: "active-instance pointer is unreadable" };
  }
  if (!raw || raw.length === 0) return { malformed: "active-instance pointer is empty" };
  if (!INSTANCE_ID_RE.test(raw)) return { malformed: `active-instance id "${raw}" is invalid` };
  return { id: raw };
}

export type DbPathResult = { dbPath: string } | { miss: string };

/** Mirror of src/instance.ts resolveInstanceDbPath (fail-closed on malformed). */
export function resolveRelayDbPath(env: EnvRecord, homeDir: string): DbPathResult {
  if (env.RELAY_DB_PATH) return { dbPath: env.RELAY_DB_PATH };
  const active = resolveActiveInstanceId(env, homeDir);
  if ("malformed" in active) return { miss: active.malformed };
  if (active.id === null) return { dbPath: path.join(botRelayRoot(env, homeDir), "relay.db") };
  return { dbPath: path.join(botRelayRoot(env, homeDir), "instances", active.id, "relay.db") };
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
