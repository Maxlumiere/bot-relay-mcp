// bot-relay-mcp — Tether for VSCode
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT

/**
 * v0.1.3 [HIGH F10] unit tests — SecretStorage migration decision logic
 * + new agent-token precedence in resolveTetherConfig.
 *
 * Hermes deep-review (synthesized in review-Victra msg `2b903f9b`)
 * flagged v0.1.2 stored the agent token in plaintext `settings.json`
 * via `workspace.getConfiguration("bot-relay.tether").get("agentToken")`.
 * v0.1.3 switches to VSCode SecretStorage (OS keychain on macOS,
 * Credential Vault on Windows, libsecret on Linux) and auto-migrates
 * any existing plaintext value on first activation.
 *
 * Pure-function tests (no VSCode stub) — they exercise:
 *   - decideMigrationAction: the branch matrix for "should we migrate".
 *   - resolveTetherConfig: the new SecretStorage > env > legacy config
 *     precedence for agentToken.
 *
 * The VSCode side effects (context.secrets.store, cfg.update,
 * showWarningMessage) live in extension.ts:migrateAgentTokenToSecretStorage
 * and are covered indirectly by the structural drift guard at
 * tests/v2-7-1-tether-secret-storage.test.ts (which scans the source for
 * the wiring contract).
 */
import { describe, it, expect } from "vitest";
import { resolveTetherConfig, decideMigrationAction, type TetherConfig } from "./config.js";

// --- decideMigrationAction matrix ---

describe("v0.1.3 — decideMigrationAction (the pure migration-decision helper)", () => {
  it("hasSecret=true → noop (already migrated or set via 'Set Token')", () => {
    expect(decideMigrationAction(true, "anything")).toEqual({ action: "noop", tokenToStore: null });
    expect(decideMigrationAction(true, undefined)).toEqual({ action: "noop", tokenToStore: null });
    expect(decideMigrationAction(true, "")).toEqual({ action: "noop", tokenToStore: null });
  });

  it("hasSecret=false + legacy config empty → noop (fresh install, nothing to migrate)", () => {
    expect(decideMigrationAction(false, "")).toEqual({ action: "noop", tokenToStore: null });
    expect(decideMigrationAction(false, "   ")).toEqual({ action: "noop", tokenToStore: null });
    expect(decideMigrationAction(false, undefined)).toEqual({ action: "noop", tokenToStore: null });
  });

  it("hasSecret=false + legacy config has value → migrate (the load-bearing case)", () => {
    expect(decideMigrationAction(false, "tok_abc123")).toEqual({ action: "migrate", tokenToStore: "tok_abc123" });
  });

  it("trims whitespace before deciding (paste artifacts can't bypass migration)", () => {
    expect(decideMigrationAction(false, "  tok_xyz  ")).toEqual({ action: "migrate", tokenToStore: "tok_xyz" });
    // pure-whitespace value counts as empty → noop
    expect(decideMigrationAction(false, "\t\n  ")).toEqual({ action: "noop", tokenToStore: null });
  });
});

// --- resolveTetherConfig agentToken precedence ---

/** Build a config getter that returns the provided string for `agentToken` and empty for everything else. */
function cfgWith(legacyToken: string): (key: string) => string | boolean | undefined {
  return (key) => (key === "agentToken" ? legacyToken : undefined);
}

describe("v0.1.3 — resolveTetherConfig agentToken precedence (SecretStorage > env > legacy config)", () => {
  it("SecretStorage value wins over everything", () => {
    const r: TetherConfig = resolveTetherConfig(
      cfgWith("tok_from_legacy_config"),
      { RELAY_AGENT_TOKEN: "tok_from_env" },
      "tok_from_secretstorage",
    );
    expect(r.agentToken).toBe("tok_from_secretstorage");
  });

  it("env wins when SecretStorage absent (or undefined)", () => {
    const r1 = resolveTetherConfig(
      cfgWith("tok_from_legacy_config"),
      { RELAY_AGENT_TOKEN: "tok_from_env" },
      undefined,
    );
    expect(r1.agentToken).toBe("tok_from_env");

    // empty-string SecretStorage value is also treated as "not set" so
    // the operator who clears the secret (via Set Token with empty
    // input) can still fall back to env.
    const r2 = resolveTetherConfig(
      cfgWith("tok_from_legacy_config"),
      { RELAY_AGENT_TOKEN: "tok_from_env" },
      "",
    );
    expect(r2.agentToken).toBe("tok_from_env");
  });

  it("legacy config wins when SecretStorage + env both absent (migration window)", () => {
    const r = resolveTetherConfig(cfgWith("tok_from_legacy_config"), {}, undefined);
    expect(r.agentToken).toBe("tok_from_legacy_config");
  });

  it("empty everywhere → empty string (idle config)", () => {
    const r = resolveTetherConfig(cfgWith(""), {}, undefined);
    expect(r.agentToken).toBe("");
  });

  it("3rd-arg omitted entirely → behaves like pre-v0.1.3 (env > legacy config)", () => {
    // Backward-compat shape — old call sites that don't pass fromSecret
    // continue to work and fall back through env → legacy.
    const r = resolveTetherConfig(
      cfgWith("tok_legacy"),
      { RELAY_AGENT_TOKEN: "tok_env" },
    );
    expect(r.agentToken).toBe("tok_env");
  });

  it("whitespace-only values at every layer are treated as empty (no accidental space-token)", () => {
    const r = resolveTetherConfig(
      cfgWith("  "),
      { RELAY_AGENT_TOKEN: "\t\n" },
      "   ",
    );
    expect(r.agentToken).toBe("");
  });
});

// --- Other config fields untouched ---

describe("v0.1.3 — non-token config resolution unchanged from v0.1.2", () => {
  it("endpoint + agentName + autoInjectInbox + notificationLevel resolve as before", () => {
    const r = resolveTetherConfig(
      (key) => {
        if (key === "endpoint") return "http://10.0.0.1:9999";
        if (key === "agentName") return "alice";
        if (key === "autoInjectInbox") return true;
        if (key === "notificationLevel") return "summary";
        return undefined;
      },
      { RELAY_AGENT_TOKEN: "tok_env" },
      "tok_secret",
    );
    expect(r.endpoint).toBe("http://10.0.0.1:9999");
    expect(r.agentName).toBe("alice");
    expect(r.autoInjectInbox).toBe(true);
    expect(r.notificationLevel).toBe("summary");
    // Token still routes through the new precedence.
    expect(r.agentToken).toBe("tok_secret");
  });
});
