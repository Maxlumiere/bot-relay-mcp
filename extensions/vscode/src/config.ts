// bot-relay-mcp — Tether for VSCode
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT

/**
 * v2.5.0 R1 #3 — pure-function config resolution extracted so vitest can
 * exercise the precedence rule (VSCode setting > env > default) without
 * booting a VSCode instance.
 *
 * R0 had `(cfg.get(...) || "").trim() || env.X ? <env-using-string> : <fallback>`
 * which binds as `((<vscode>) || env.X) ? <env-thing> : <fallback>` — the
 * VSCode-configured endpoint was ignored when env was set, and undefined
 * env produced "http://undefined:3777". This module rebuilds the rule
 * with explicit branches and a dedicated test surface.
 */

export type ConfigGetter = (key: string) => string | boolean | undefined;
export type EnvRecord = Record<string, string | undefined>;

export interface TetherConfig {
  endpoint: string;
  agentName: string;
  agentToken: string;
  autoInjectInbox: boolean;
  notificationLevel: "event" | "summary" | "none";
}

const DEFAULT_ENDPOINT = "http://127.0.0.1:3777";

/**
 * Resolve a string setting with the canonical precedence:
 *   VSCode setting (non-empty after trim) > env var (non-empty) > default.
 *
 * Empty-string from VSCode means "user didn't set" (the JSON manifest's
 * `default: ""` shows up as `""`, not `undefined`). So we trim + check
 * length rather than truthiness to avoid surprising the operator who
 * deliberately set an empty value.
 */
function resolveString(
  fromConfig: string | undefined,
  fromEnv: string | undefined,
  fallback: string,
): string {
  const cfg = (fromConfig ?? "").trim();
  if (cfg.length > 0) return cfg;
  const env = (fromEnv ?? "").trim();
  if (env.length > 0) return env;
  return fallback;
}

/**
 * Resolve the relay HTTP endpoint with VSCode > env > default precedence.
 * Env composition: `http://${RELAY_HTTP_HOST}:${RELAY_HTTP_PORT ?? 3777}`.
 * Default: http://127.0.0.1:3777.
 *
 * Note: an env-derived endpoint requires RELAY_HTTP_HOST to be set. Just
 * RELAY_HTTP_PORT alone falls through to the default — partial env is
 * "the operator didn't fully specify," not "compose with default host."
 */
function resolveEndpoint(
  fromConfig: string | undefined,
  env: EnvRecord,
): string {
  const cfg = (fromConfig ?? "").trim();
  if (cfg.length > 0) return cfg;
  const host = (env.RELAY_HTTP_HOST ?? "").trim();
  if (host.length > 0) {
    const port = (env.RELAY_HTTP_PORT ?? "").trim() || "3777";
    return `http://${host}:${port}`;
  }
  return DEFAULT_ENDPOINT;
}

/**
 * v0.1.3 — agent_token now resolves from VSCode SecretStorage as the
 * highest-priority source. The legacy `bot-relay.tether.agentToken`
 * setting in `settings.json` is removed from the contributes schema in
 * v0.1.3 (an external security review flagged plaintext storage; migration is
 * auto-run in `extension.ts:activate` on first launch).
 *
 * Precedence: SecretStorage > env (RELAY_AGENT_TOKEN) > legacy config.
 *
 * v0.1.3 R1 [P2 codex audit fix] — `secretsAvailable` parameter
 * distinguishes two empty-secret scenarios:
 *   - `secretsAvailable = true` AND secret empty: SecretStorage is
 *     reachable, the value just isn't set. Migration window legacy
 *     fallback is OK (the operator opted into v0.1.2 plaintext at
 *     install time and we're servicing them while they upgrade).
 *   - `secretsAvailable = false`: SecretStorage backend is
 *     UNREACHABLE (Linux without libsecret, or a transient failure).
 *     We DO NOT consult the legacy plaintext config in this case —
 *     doing so re-promotes the exact leak surface v0.1.3 was built
 *     to close. Operator falls back to env-only; if env is also
 *     empty, returns "" and the extension goes idle until the
 *     operator fixes their SecretStorage backend or sets
 *     RELAY_AGENT_TOKEN env.
 *
 * Codex P2 finding: "If SecretStorage access fails,
 * do not read/use legacy `cfg(\"agentToken\")`; allow env-only
 * (`RELAY_AGENT_TOKEN`) with a log and preferably visible
 * warning/error. Keep the normal migration-window legacy fallback
 * only when SecretStorage access succeeds and there is no
 * secret/env."
 *
 * Exported (was module-private pre-R1) so the regression test calls
 * the actual shipped helper rather than re-implementing the
 * precedence rule, per `feedback_test_path_must_match_shipped_path`.
 */
export function resolveAgentToken(
  fromSecret: string | undefined,
  fromEnv: string | undefined,
  fromLegacyConfig: string | undefined,
  secretsAvailable: boolean,
  fromVault?: string | undefined,
): string {
  // v0.5.0 — precedence: explicit env > VAULT (hook-maintained, auto-syncs
  // across a token rotation) > SecretStorage > legacy config. The explicit env
  // override moves ABOVE SecretStorage so an operator can force a token, and
  // the vault sits above the (previously stale) SecretStorage copy.
  const e = (fromEnv ?? "").trim();
  if (e.length > 0) return e;
  const v = (fromVault ?? "").trim();
  if (v.length > 0) return v;
  const s = (fromSecret ?? "").trim();
  if (s.length > 0) return s;
  // v0.1.3 R1 — refuse to read legacy plaintext when SecretStorage backend is
  // unreachable; settings.json is no longer trusted for tokens.
  if (!secretsAvailable) return "";
  const c = (fromLegacyConfig ?? "").trim();
  if (c.length > 0) return c;
  return "";
}

/**
 * v0.1.3 — pure decision helper for the SecretStorage migration.
 * Extracted so the unit tests can exercise the branch matrix without
 * mocking the full VSCode SecretStorage/Configuration surface. The
 * extension.ts side effects (context.secrets.store, cfg.update,
 * showWarningMessage) are wired against whatever this returns.
 *
 *  - hasSecret = true → noop (already migrated OR set via "Set Token").
 *  - hasSecret = false + legacy config empty → noop (nothing to migrate).
 *  - hasSecret = false + legacy config has value → migrate it.
 */
export function decideMigrationAction(
  hasSecret: boolean,
  legacyConfigValue: string | undefined,
): { action: "noop" | "migrate"; tokenToStore: string | null } {
  if (hasSecret) return { action: "noop", tokenToStore: null };
  const trimmed = (legacyConfigValue ?? "").trim();
  if (trimmed.length === 0) return { action: "noop", tokenToStore: null };
  return { action: "migrate", tokenToStore: trimmed };
}

/**
 * v0.2 — per-agent SecretStorage key for the executor pattern.
 * Mirrors the immutable-caps discipline by keying
 * tokens by agent name so spawn/kill/restart cycles don't collide.
 *
 * Shape: `botRelayTether.token.<name>` where `<name>` matches the
 * relay's agent-name allowlist (`^[A-Za-z0-9_.-]{1,64}$`, mirrored
 * from `hooks/_vault-helpers.sh` + `src/token-store.ts`).
 *
 * Pre-v0.2 the extension used a singleton key (`botRelay.agentToken`
 * — see `SECRET_KEY_AGENT_TOKEN` in extension.ts). The singleton
 * stays for backward compat with v0.1.3 installs: the v0.2
 * extension migrates the singleton to the per-agent key when the
 * operator runs `Tether: Spawn Agent` for the first time on the
 * configured `bot-relay.tether.agentName`.
 *
 * Throws on malformed names so the caller can surface a clean
 * error to the operator instead of writing a token to a key that
 * the SessionStart hook would refuse to read.
 */
export const AGENT_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
export const PER_AGENT_SECRET_KEY_PREFIX = "botRelayTether.token.";

export function resolveAgentSecretKey(agentName: string): string {
  if (!AGENT_NAME_RE.test(agentName)) {
    throw new Error(
      `invalid agent name "${agentName}" for SecretStorage key — must match ${AGENT_NAME_RE.source}`,
    );
  }
  return `${PER_AGENT_SECRET_KEY_PREFIX}${agentName}`;
}

/**
 * v0.2 — per-agent env-var name for the env fallback when
 * SecretStorage is unreachable.
 *
 * `my-agent`     → `RELAY_AGENT_TOKEN_MY_AGENT`
 * `pod.alpha`    → `RELAY_AGENT_TOKEN_POD_ALPHA`
 * `agent1`       → `RELAY_AGENT_TOKEN_AGENT1`
 *
 * Hyphens + dots in agent names sanitize to underscores because
 * POSIX env var names allow `[A-Za-z_][A-Za-z0-9_]*` only.
 *
 * This is ADDITIVE to the legacy `RELAY_AGENT_TOKEN` env var (the
 * singleton). When a per-agent var is set, it wins; otherwise the
 * singleton stays the fallback so v0.1.3 single-agent setups
 * continue working without operator intervention.
 */
export function resolveAgentTokenEnvVar(agentName: string): string {
  if (!AGENT_NAME_RE.test(agentName)) {
    throw new Error(
      `invalid agent name "${agentName}" for env-var name — must match ${AGENT_NAME_RE.source}`,
    );
  }
  return `RELAY_AGENT_TOKEN_${agentName.replace(/[-.]/g, "_").toUpperCase()}`;
}

/**
 * v0.2 — per-agent token resolution layered on the v0.1.3 R1
 * precedence + SecretStorage-unavailable contract.
 *
 * Precedence (v0.5.0 — vault-first for auto-sync across token rotation):
 *   1. per-agent env var (RELAY_AGENT_TOKEN_<NAME>) — explicit operator override
 *   2. legacy singleton env var (RELAY_AGENT_TOKEN) — explicit override
 *   3. fromVault (the per-instance vault the SessionStart hook keeps CURRENT) —
 *      NEW: this is what ends the manual "Set Agent Token" babysitting. When a
 *      launcher rotates the DB token on relaunch, the hook rewrites the vault
 *      and Tether picks it up on the next (re)connect — no stale SecretStorage.
 *   4. fromSecret (per-agent SecretStorage value) — the old manual copy, now a
 *      fallback below the vault (it was the source of the recurring desync).
 *   5. fromLegacyConfig (settings.json) — ONLY when secretsAvailable === true.
 *
 * The explicit env overrides stay ON TOP so an operator can force a token for
 * emergency/debug even when the vault has a different value.
 *
 * Returns "" when nothing resolves. The caller decides whether to spawn idle,
 * prompt for token, or refuse.
 */
export function resolvePerAgentToken(
  agentName: string,
  fromSecret: string | undefined,
  env: EnvRecord,
  fromLegacyConfig: string | undefined,
  secretsAvailable: boolean,
  fromVault?: string | undefined,
): string {
  const perAgentEnvName = resolveAgentTokenEnvVar(agentName);
  const perAgentEnv = (env[perAgentEnvName] ?? "").trim();
  if (perAgentEnv.length > 0) return perAgentEnv;
  const legacyEnv = (env.RELAY_AGENT_TOKEN ?? "").trim();
  if (legacyEnv.length > 0) return legacyEnv;
  const vault = (fromVault ?? "").trim();
  if (vault.length > 0) return vault;
  const s = (fromSecret ?? "").trim();
  if (s.length > 0) return s;
  if (!secretsAvailable) return "";
  const c = (fromLegacyConfig ?? "").trim();
  if (c.length > 0) return c;
  return "";
}

export function resolveTetherConfig(
  cfg: ConfigGetter,
  env: EnvRecord,
  /**
   * v0.1.3 — value from `context.secrets.get("botRelay.agentToken")`.
   * Highest-priority source for the agent token. Optional so unit
   * tests can omit it (legacy precedence test surface stays clean).
   */
  fromSecret?: string,
  /**
   * v0.1.3 R1 — when false, SecretStorage backend was UNREACHABLE
   * (Linux-without-libsecret, or transient failure). The legacy
   * plaintext fallback is SKIPPED in this case so the migration
   * actually closes the leak instead of silently re-promoting it.
   *
   * Default `true` preserves backward-compat for callers that don't
   * explicitly thread availability — an undefined-secret with
   * `secretsAvailable: true` means "the operator hasn't set one yet,
   * fine to use legacy during migration window."
   */
  secretsAvailable: boolean = true,
  /**
   * v0.5.0 — reads the per-instance vault token for a given agent name (the
   * hook-maintained credential). Injected so this pure resolver stays
   * VSCode/fs-free; production wires `readVaultToken(name, process.env,
   * os.homedir(), log)`. Called AFTER the agent name is resolved so the vault
   * is keyed correctly, and re-invoked on every readConfig — i.e. every
   * (re)connect — so a rotated token auto-syncs with zero manual steps.
   */
  readVault?: (agentName: string) => string | null,
): TetherConfig {
  const endpoint = resolveEndpoint(cfg("endpoint") as string | undefined, env);
  const agentName = resolveString(
    cfg("agentName") as string | undefined,
    env.RELAY_AGENT_NAME,
    "",
  );
  // v0.5.0 — thread the vault token through the shipped precedence. With a
  // valid agent name, route through resolvePerAgentToken (per-agent env >
  // legacy env > vault > SecretStorage > config); without one, the singleton
  // resolveAgentToken applies (no per-agent key, so no vault to read).
  const vaultToken = agentName && AGENT_NAME_RE.test(agentName) ? (readVault?.(agentName) ?? undefined) : undefined;
  const agentToken =
    agentName && AGENT_NAME_RE.test(agentName)
      ? resolvePerAgentToken(
          agentName,
          fromSecret,
          env,
          cfg("agentToken") as string | undefined,
          secretsAvailable,
          vaultToken ?? undefined,
        )
      : resolveAgentToken(
          fromSecret,
          env.RELAY_AGENT_TOKEN,
          cfg("agentToken") as string | undefined,
          secretsAvailable,
        );
  const autoInjectInbox = (cfg("autoInjectInbox") as boolean | undefined) ?? false;
  const notificationLevel =
    (cfg("notificationLevel") as "event" | "summary" | "none" | undefined) ?? "event";
  return { endpoint, agentName, agentToken, autoInjectInbox, notificationLevel };
}
