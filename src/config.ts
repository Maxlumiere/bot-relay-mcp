// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

import fs from "fs";
import path from "path";
import os from "os";
import { validateKeyringStrict } from "./encryption.js";
import { resolveInstanceConfigPath } from "./instance.js";

export interface RelayConfig {
  transport: "stdio" | "http" | "both";
  http_port: number;
  http_host: string;
  webhook_timeout_ms: number;
  api_allowlist: string[];
  /**
   * If set, HTTP requests must include "Authorization: Bearer <secret>" (or
   * "X-Relay-Secret: <secret>"). First entry is the primary/preferred secret;
   * subsequent entries are accepted during rotation grace.
   */
  http_secret: string | null;
  /**
   * Additional accepted secrets during a rotation window. Audit log tags which
   * secret index was used so operators can see who is still on the old secret.
   */
  http_secrets_previous: string[];
  /** Messages per agent per hour. 0 disables the limit. */
  rate_limit_messages_per_hour: number;
  /** Tasks posted per agent per hour. 0 disables. */
  rate_limit_tasks_per_hour: number;
  /** Spawn calls per agent per hour. 0 disables. */
  rate_limit_spawns_per_hour: number;
  /**
   * CIDR blocks of trusted reverse proxies. When the direct socket peer IP
   * falls in one of these, X-Forwarded-For is honored (leftmost-untrusted hop).
   * When this list is empty (DEFAULT), X-Forwarded-For is IGNORED completely
   * and rate limits key on the direct peer IP only — prevents spoofing.
   */
  trusted_proxies: string[];
  /**
   * Allowed browser Origins for the dashboard and /api/snapshot (CORS).
   * Defaults cover local dev: http://localhost and http://127.0.0.1 on any port.
   * A request with an Origin header NOT in this list returns 403. Non-browser
   * callers (no Origin header) are always allowed. /health is always exempt.
   * Glob supported: a trailing "*" after a scheme+host matches any port/path.
   */
  allowed_dashboard_origins: string[];
}

export const DEFAULT_CONFIG: RelayConfig = {
  transport: "stdio",
  http_port: 3777,
  http_host: "127.0.0.1",
  webhook_timeout_ms: 5000,
  api_allowlist: [],
  http_secret: null,
  http_secrets_previous: [],
  rate_limit_messages_per_hour: 1000,
  rate_limit_tasks_per_hour: 200,
  rate_limit_spawns_per_hour: 50,
  trusted_proxies: [],
  allowed_dashboard_origins: [
    "http://localhost",
    "http://localhost:*",
    "http://127.0.0.1",
    "http://127.0.0.1:*",
  ],
};

function getConfigPath(): string {
  // v2.4.0 Codex HIGH #2 patch — split-brain config in multi-instance
  // mode. Pre-patch: RELAY_DB_PATH resolved per-instance but config
  // stayed flat, so active instance 'work' with per-instance
  // http_port=2222 still used the flat config's http_port=1111.
  // Fix: consult resolveInstanceConfigPath() (mirrors the DB path
  // resolution) before falling back to the flat layout.
  //   RELAY_CONFIG_PATH      → always wins (explicit operator override)
  //   instance_id active     → ~/.bot-relay/instances/<id>/config.json
  //   otherwise              → legacy ~/.bot-relay/config.json
  if (process.env.RELAY_CONFIG_PATH) return process.env.RELAY_CONFIG_PATH;
  return resolveInstanceConfigPath();
}

export class InvalidConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidConfigError";
  }
}

/**
 * v2.2.1 L2 (Codex audit): return the set of keys actually present in the
 * config file (if any). Used by `src/cli.ts applyCliToEnv` to label
 * config-file-won values as source="config" in the startup log instead of
 * mislabeling them as "default". Returns empty set when no file exists or
 * parse fails — safe to treat as "no keys overridden at the file layer."
 */
export function readConfigFileKeys(): Set<string> {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) return new Set();
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") return new Set(Object.keys(obj));
  } catch {
    /* swallow; caller treats empty set as no-file-override */
  }
  return new Set();
}

export function loadConfig(): RelayConfig {
  const configPath = getConfigPath();
  let fileConfig: Partial<RelayConfig> = {};

  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      fileConfig = JSON.parse(raw);
    } catch (err) {
      // Note: config.ts cannot import logger.ts (circular risk via tests).
      // process.stderr.write is direct and equivalent.
      process.stderr.write(`[config] Failed to parse ${configPath}: ${String(err)}\n`);
    }
    // v2.1 Phase 4c.4: config.json may contain http_secret, previous-secret
    // rotation values, and references to RELAY_ENCRYPTION_KEY. If the file is
    // more open than 0600 the operator should know — but the file is
    // operator-managed so we do NOT chmod it; a warn is the right signal.
    // Skip on Windows (NTFS has no POSIX mode bits).
    if (process.platform !== "win32") {
      try {
        const mode = fs.statSync(configPath).mode & 0o777;
        if ((mode & ~0o600) !== 0) {
          process.stderr.write(
            `[config] ${configPath} has mode 0${mode.toString(8)}, wider than recommended 0600. ` +
            `Run: chmod 600 "${configPath}"\n`
          );
        }
      } catch {
        // stat failure is non-fatal; we already loaded the config.
      }
    }
  }

  // Environment variables override file config
  const envTransport = process.env.RELAY_TRANSPORT as RelayConfig["transport"] | undefined;
  const envPort = process.env.RELAY_HTTP_PORT ? parseInt(process.env.RELAY_HTTP_PORT, 10) : undefined;
  const envHost = process.env.RELAY_HTTP_HOST;
  const envSecret = process.env.RELAY_HTTP_SECRET;
  const envPrevSecrets = process.env.RELAY_HTTP_SECRET_PREVIOUS
    ? process.env.RELAY_HTTP_SECRET_PREVIOUS.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  const envProxies = process.env.RELAY_TRUSTED_PROXIES
    ? process.env.RELAY_TRUSTED_PROXIES.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  return {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    ...(envTransport && ["stdio", "http", "both"].includes(envTransport) ? { transport: envTransport } : {}),
    ...(envPort && !isNaN(envPort) ? { http_port: envPort } : {}),
    ...(envHost ? { http_host: envHost } : {}),
    ...(envSecret ? { http_secret: envSecret } : {}),
    ...(envPrevSecrets ? { http_secrets_previous: envPrevSecrets } : {}),
    ...(envProxies ? { trusted_proxies: envProxies } : {}),
  };
}

/**
 * v2.0 final (#18): validate config + env at startup with clear aggregate
 * errors. Runs BEFORE we open the DB or bind the port so misconfigurations
 * fail fast with readable messages instead of opaque runtime failures.
 *
 * Intended to be called from src/index.ts after loadConfig() but before any
 * initialization side effects.
 */
/**
 * v2.0.1 (Codex MEDIUM 4): strict numeric env parsing. parseInt("3000abc")
 * returns 3000 silently — we want to reject any non-pure-integer input.
 * Reads the env var raw, trims whitespace, and requires the numeric round-trip
 * to equal the input. Returns the parsed number or `{ invalid: raw }`.
 */
function parseStrictInt(raw: string): { value: number } | { invalid: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { invalid: raw };
  if (!/^-?\d+$/.test(trimmed)) return { invalid: raw };
  const n = parseInt(trimmed, 10);
  if (!Number.isFinite(n)) return { invalid: raw };
  return { value: n };
}

export function validateConfigAndEnv(config: RelayConfig): void {
  const errors: string[] = [];

  // Transport
  if (!["stdio", "http", "both"].includes(config.transport)) {
    errors.push(`RELAY_TRANSPORT must be one of 'stdio' | 'http' | 'both' (got '${config.transport}')`);
  }

  // Port
  if (!Number.isInteger(config.http_port) || config.http_port < 1 || config.http_port > 65535) {
    errors.push(`http_port must be an integer in [1, 65535] (got ${config.http_port})`);
  }

  // Host
  if (typeof config.http_host !== "string" || config.http_host.length === 0) {
    errors.push(`http_host must be a non-empty string (got '${config.http_host}')`);
  }

  // Webhook timeout
  if (!Number.isInteger(config.webhook_timeout_ms) || config.webhook_timeout_ms < 1) {
    errors.push(`webhook_timeout_ms must be a positive integer (got ${config.webhook_timeout_ms})`);
  }

  // HTTP secret — if set, must be at least 32 chars (security floor)
  if (config.http_secret !== null && config.http_secret !== undefined) {
    if (typeof config.http_secret !== "string" || config.http_secret.length < 32) {
      errors.push(`RELAY_HTTP_SECRET must be at least 32 characters for adequate entropy (got length ${config.http_secret?.length ?? 0})`);
    }
  }

  // Encryption key — shallow pre-check for the single-key legacy path. Kept
  // for parity with pre-7p error messaging; the authoritative check below
  // (validateKeyringStrict) covers every source.
  if (process.env.RELAY_ENCRYPTION_KEY) {
    try {
      const buf = Buffer.from(process.env.RELAY_ENCRYPTION_KEY, "base64");
      if (buf.length !== 32) {
        errors.push(`RELAY_ENCRYPTION_KEY must decode to exactly 32 bytes (AES-256). Got ${buf.length} bytes.`);
      }
    } catch {
      errors.push(`RELAY_ENCRYPTION_KEY must be valid base64.`);
    }
  }

  // v2.1 Phase 7p MED #2: eager keyring validation. Enforces the documented
  // "reject at startup" contract for multi-source configs, malformed JSON,
  // unreadable path files, and bad key sizes across ALL three keyring
  // sources (KEYRING / KEYRING_PATH / legacy KEY). Pre-fix the check was
  // lazy in loadKeyring() and getKeyringInfo() swallowed errors, letting
  // ambiguous configs boot successfully and fail silently on the first
  // encrypted-column write.
  try {
    validateKeyringStrict();
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  // Log level
  const logLevel = (process.env.RELAY_LOG_LEVEL || "").toLowerCase();
  if (logLevel && !["debug", "info", "warn", "error"].includes(logLevel)) {
    errors.push(`RELAY_LOG_LEVEL must be one of 'debug' | 'info' | 'warn' | 'error' (got '${process.env.RELAY_LOG_LEVEL}')`);
  }

  // v2.0.1 (Codex MEDIUM 4): strict integer env parsing. parseInt("3000abc")
  // used to accept garbage-suffixed values silently. These env vars now
  // require pure integer input.
  const integerEnvVars: Record<string, { min: number; max?: number }> = {
    RELAY_HTTP_PORT: { min: 1, max: 65535 },
    RELAY_MAX_PAYLOAD_BYTES: { min: 1 },
    RELAY_HEALTH_REASSIGN_GRACE_MINUTES: { min: 0 },
    RELAY_HEALTH_SCAN_LIMIT: { min: 0 },
    RELAY_AUTO_ASSIGN_LIMIT: { min: 0 },
    RELAY_WEBHOOK_RETRY_BATCH_SIZE: { min: 0 },
    RELAY_WEBHOOK_CLAIM_LEASE_SECONDS: { min: 1 },
    RELAY_BUSY_TTL_MINUTES: { min: 1 },
    RELAY_HOOK_MAX_MESSAGES: { min: 1 },
    // v2.1 Phase 4c.2: audit-log retention + piggyback interval
    RELAY_AUDIT_LOG_RETENTION_DAYS: { min: 0, max: 3650 },
    RELAY_AUDIT_LOG_PURGE_INTERVAL: { min: 1, max: 1_000_000 },
  };
  for (const [name, bounds] of Object.entries(integerEnvVars)) {
    const raw = process.env[name];
    if (raw === undefined || raw === "") continue;
    const parsed = parseStrictInt(raw);
    if ("invalid" in parsed) {
      errors.push(`${name} must be a pure integer (got '${raw}')`);
      continue;
    }
    if (parsed.value < bounds.min) {
      errors.push(`${name} must be >= ${bounds.min} (got ${parsed.value})`);
    }
    if (bounds.max !== undefined && parsed.value > bounds.max) {
      errors.push(`${name} must be <= ${bounds.max} (got ${parsed.value})`);
    }
  }

  // v2.0.1 (Codex MEDIUM 4): validate RELAY_DB_PATH up front so misconfig
  // fails at startup, not on first tool call.
  if (process.env.RELAY_DB_PATH) {
    const rawPath = process.env.RELAY_DB_PATH;
    try {
      const resolved = path.resolve(rawPath);
      const approvedRoots = [os.homedir(), "/tmp", "/private/tmp", "/var/folders"].map((r) => path.resolve(r));
      const underApproved = approvedRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
      if (!underApproved) {
        errors.push(`RELAY_DB_PATH '${rawPath}' resolves to '${resolved}', which is outside approved roots (${approvedRoots.join(", ")})`);
      }
    } catch (err) {
      errors.push(`RELAY_DB_PATH '${rawPath}' could not be resolved: ${String(err)}`);
    }
  }

  // Rate limits
  if (config.rate_limit_messages_per_hour < 0) errors.push(`rate_limit_messages_per_hour must be >= 0`);
  if (config.rate_limit_tasks_per_hour < 0) errors.push(`rate_limit_tasks_per_hour must be >= 0`);
  if (config.rate_limit_spawns_per_hour < 0) errors.push(`rate_limit_spawns_per_hour must be >= 0`);

  if (errors.length > 0) {
    throw new InvalidConfigError(
      `Invalid relay configuration (${errors.length} problem${errors.length === 1 ? "" : "s"}):\n` +
      errors.map((e) => `  - ${e}`).join("\n")
    );
  }
}
