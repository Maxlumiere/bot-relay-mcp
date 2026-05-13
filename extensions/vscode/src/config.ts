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
 * v0.1.3 (Hermes deep-review flagged plaintext storage; migration is
 * auto-run in `extension.ts:activate` on first launch). Any operator
 * who still has a value in legacy config (during the migration window)
 * falls back through env, then legacy-config, then empty.
 *
 * Precedence: SecretStorage > env (RELAY_AGENT_TOKEN) > legacy config.
 */
function resolveAgentToken(
  fromSecret: string | undefined,
  fromEnv: string | undefined,
  fromLegacyConfig: string | undefined,
): string {
  const s = (fromSecret ?? "").trim();
  if (s.length > 0) return s;
  const e = (fromEnv ?? "").trim();
  if (e.length > 0) return e;
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

export function resolveTetherConfig(
  cfg: ConfigGetter,
  env: EnvRecord,
  /**
   * v0.1.3 — value from `context.secrets.get("botRelay.agentToken")`.
   * Highest-priority source for the agent token. Optional so unit
   * tests can omit it (legacy precedence test surface stays clean).
   */
  fromSecret?: string,
): TetherConfig {
  const endpoint = resolveEndpoint(cfg("endpoint") as string | undefined, env);
  const agentName = resolveString(
    cfg("agentName") as string | undefined,
    env.RELAY_AGENT_NAME,
    "",
  );
  const agentToken = resolveAgentToken(
    fromSecret,
    env.RELAY_AGENT_TOKEN,
    cfg("agentToken") as string | undefined,
  );
  const autoInjectInbox = (cfg("autoInjectInbox") as boolean | undefined) ?? false;
  const notificationLevel =
    (cfg("notificationLevel") as "event" | "summary" | "none" | undefined) ?? "event";
  return { endpoint, agentName, agentToken, autoInjectInbox, notificationLevel };
}
