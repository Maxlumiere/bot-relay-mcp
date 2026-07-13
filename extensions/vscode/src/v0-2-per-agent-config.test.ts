// bot-relay-mcp — Tether for VSCode
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT

/**
 * v0.2 — per-agent SecretStorage key + env-var resolution tests.
 *
 * Pure-function precedence rule, no VSCode boot. Mirrors v0.1.3's
 * config test discipline (`v0-1-3-secret-storage.test.ts`).
 */
import { describe, it, expect } from "vitest";
import {
  AGENT_NAME_RE,
  PER_AGENT_SECRET_KEY_PREFIX,
  resolveAgentSecretKey,
  resolveAgentTokenEnvVar,
  resolvePerAgentToken,
} from "./config.js";

describe("v0.2 — resolveAgentSecretKey", () => {
  it("(C1) builds the key from the agent name", () => {
    expect(resolveAgentSecretKey("build-agent")).toBe(
      `${PER_AGENT_SECRET_KEY_PREFIX}build-agent`,
    );
  });

  it("(C2) supports all three name shapes the relay accepts", () => {
    expect(resolveAgentSecretKey("worker1")).toBe(`${PER_AGENT_SECRET_KEY_PREFIX}worker1`);
    expect(resolveAgentSecretKey("pod.alpha")).toBe(`${PER_AGENT_SECRET_KEY_PREFIX}pod.alpha`);
    expect(resolveAgentSecretKey("a_b.c-1")).toBe(`${PER_AGENT_SECRET_KEY_PREFIX}a_b.c-1`);
  });

  it("(C3) rejects names outside the allowlist", () => {
    expect(() => resolveAgentSecretKey("bad name")).toThrow(/invalid agent name/);
    expect(() => resolveAgentSecretKey("")).toThrow(/invalid agent name/);
    expect(() => resolveAgentSecretKey("../foo")).toThrow(/invalid agent name/);
    expect(() => resolveAgentSecretKey("foo$bar")).toThrow(/invalid agent name/);
  });

  it("(C4) rejects names longer than 64 chars", () => {
    expect(() => resolveAgentSecretKey("a".repeat(65))).toThrow(/invalid agent name/);
  });

  it("(C5) AGENT_NAME_RE matches the relay's allowlist exactly", () => {
    // Source: hooks/_vault-helpers.sh resolve_relay_token_path
    expect(AGENT_NAME_RE.source).toBe("^[A-Za-z0-9_.-]{1,64}$");
  });
});

describe("v0.2 — resolveAgentTokenEnvVar", () => {
  it("(C6) converts hyphens + dots to underscores and uppercases", () => {
    expect(resolveAgentTokenEnvVar("build-agent")).toBe("RELAY_AGENT_TOKEN_BUILD_AGENT");
    expect(resolveAgentTokenEnvVar("pod.alpha")).toBe("RELAY_AGENT_TOKEN_POD_ALPHA");
    expect(resolveAgentTokenEnvVar("foo_bar")).toBe("RELAY_AGENT_TOKEN_FOO_BAR");
    expect(resolveAgentTokenEnvVar("a.b-c_d")).toBe("RELAY_AGENT_TOKEN_A_B_C_D");
  });

  it("(C7) preserves digits", () => {
    expect(resolveAgentTokenEnvVar("agent1")).toBe("RELAY_AGENT_TOKEN_AGENT1");
    expect(resolveAgentTokenEnvVar("w-99")).toBe("RELAY_AGENT_TOKEN_W_99");
  });

  it("(C8) rejects invalid names", () => {
    expect(() => resolveAgentTokenEnvVar("bad name")).toThrow(/invalid agent name/);
  });
});

describe("v0.2 — resolvePerAgentToken precedence", () => {
  const NAME = "build-agent";
  const PER_AGENT_ENV = "RELAY_AGENT_TOKEN_BUILD_AGENT";

  it("(C9) v0.5.0 precedence ladder — per-agent env > legacy env > VAULT > SecretStorage > config", () => {
    // Full ladder set → the explicit per-agent env override wins.
    expect(
      resolvePerAgentToken(
        NAME,
        "from-secret-storage",
        { [PER_AGENT_ENV]: "from-per-agent-env", RELAY_AGENT_TOKEN: "from-singleton-env" },
        "from-legacy-config",
        true,
        "from-vault",
      ),
    ).toBe("from-per-agent-env");
    // No per-agent env → legacy singleton env wins.
    expect(
      resolvePerAgentToken(NAME, "from-secret-storage", { RELAY_AGENT_TOKEN: "from-singleton-env" }, "from-legacy-config", true, "from-vault"),
    ).toBe("from-singleton-env");
    // No env → the VAULT beats the (stale) SecretStorage copy. THIS is the fix:
    // the hook-maintained vault token wins over the manually-set secret.
    expect(resolvePerAgentToken(NAME, "from-secret-storage", {}, "from-legacy-config", true, "from-vault")).toBe("from-vault");
    // No env, no vault → SecretStorage (back-compat fallback).
    expect(resolvePerAgentToken(NAME, "from-secret-storage", {}, "from-legacy-config", true, undefined)).toBe("from-secret-storage");
    // Only legacy config (secretsAvailable) → config.
    expect(resolvePerAgentToken(NAME, undefined, {}, "from-legacy-config", true, undefined)).toBe("from-legacy-config");
  });

  it("(C10) falls through to per-agent env when secret is empty", () => {
    const t = resolvePerAgentToken(
      NAME,
      "",
      { [PER_AGENT_ENV]: "from-per-agent-env", RELAY_AGENT_TOKEN: "from-singleton-env" },
      "from-legacy-config",
      true,
    );
    expect(t).toBe("from-per-agent-env");
  });

  it("(C11) falls through to singleton env when per-agent env is empty", () => {
    const t = resolvePerAgentToken(
      NAME,
      undefined,
      { RELAY_AGENT_TOKEN: "from-singleton-env" },
      "from-legacy-config",
      true,
    );
    expect(t).toBe("from-singleton-env");
  });

  it("(C12) falls through to legacy config only when SecretStorage IS available (R1 contract)", () => {
    const t = resolvePerAgentToken(NAME, undefined, {}, "from-legacy-config", true);
    expect(t).toBe("from-legacy-config");
  });

  it("(C13) REFUSES legacy config when SecretStorage is unreachable (R1 contract)", () => {
    const t = resolvePerAgentToken(NAME, undefined, {}, "from-legacy-config", false);
    expect(t).toBe("");
  });

  it("(C14) returns empty string when nothing resolves", () => {
    expect(resolvePerAgentToken(NAME, undefined, {}, undefined, true)).toBe("");
  });

  it("(C15) trims whitespace-only values to empty before precedence check", () => {
    // Secret is whitespace → falls through to per-agent env.
    const t = resolvePerAgentToken(
      NAME,
      "   ",
      { [PER_AGENT_ENV]: "actual-token" },
      undefined,
      true,
    );
    expect(t).toBe("actual-token");
  });

  it("(C16) different agent names route to different env vars", () => {
    const t1 = resolvePerAgentToken(
      "agent-a",
      undefined,
      { RELAY_AGENT_TOKEN_AGENT_A: "token-a", RELAY_AGENT_TOKEN_AGENT_B: "token-b" },
      undefined,
      true,
    );
    const t2 = resolvePerAgentToken(
      "agent-b",
      undefined,
      { RELAY_AGENT_TOKEN_AGENT_A: "token-a", RELAY_AGENT_TOKEN_AGENT_B: "token-b" },
      undefined,
      true,
    );
    expect(t1).toBe("token-a");
    expect(t2).toBe("token-b");
  });
});
