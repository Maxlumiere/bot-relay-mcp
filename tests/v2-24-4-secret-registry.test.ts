// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * PR C — redact-by-VALUE registry, IDENTITY-KEYED. A secret is scrubbed wherever
 * it sits because the process knows the VALUE (it minted it, keyed to the owning
 * principal, or ingested it at boot), not because someone listed the field name.
 * The registry is bounded by PRINCIPALS, not mint volume, so a live agent's
 * current token never silently ages out. Caveats asserted: length floor, rotation
 * window, and layered-on-top-of the anchor/field rules.
 */
import { describe, it, expect, beforeEach } from "vitest";

const {
  registerIdentitySecret,
  registerConfigSecret,
  redactRegisteredValues,
  _resetSecretRegistryForTests,
  _identityCountForTests,
} = await import("../src/secret-registry.js");
const { redactSecrets } = await import("../src/logger.js");

beforeEach(() => _resetSecretRegistryForTests());

describe("v2.24.4 — identity-keyed redact-by-value registry (PR C)", () => {
  it("redacts a registered value under an ARBITRARY field name AND as a bare substring", () => {
    const secret = "S3cr3t-value-that-is-long-enough-000000";
    registerIdentitySecret("agent-x", secret);
    expect(redactRegisteredValues(`{"surprise_field":"${secret}"}`)).not.toContain(secret);
    expect(redactRegisteredValues(`connecting with ${secret} now`)).not.toContain(secret);
    expect(redactRegisteredValues(`{"surprise_field":"${secret}"}`)).toContain("***");
  });

  it("LENGTH FLOOR — short values do not register (no ***-noise in ordinary text)", () => {
    registerIdentitySecret("agent-x", "short");
    registerConfigSecret("short");
    expect(redactRegisteredValues("short appears in ordinary text")).toBe("short appears in ordinary text");
  });

  it("IDENTITY-KEYED — a live principal's current token is NEVER evicted by mint VOLUME elsewhere", () => {
    const liveToken = "live-agent-current-token-000000-aaaa";
    registerIdentitySecret("agent-alpha", liveToken);
    // Mint tokens for 1000 OTHER principals — far past any flat FIFO cap. Under the
    // old volume-bounded FIFO, agent-alpha's token would have been silently dropped.
    for (let i = 0; i < 1000; i++) {
      registerIdentitySecret("agent-" + i, "other-token-padding-value-" + String(i).padStart(6, "0"));
    }
    expect(redactRegisteredValues(`token=${liveToken}`)).not.toContain(liveToken);
    expect(_identityCountForTests()).toBeGreaterThan(1000);
  });

  it("ROTATION WINDOW — a principal's previous token stays covered after a rotation", () => {
    const t1 = "principal-token-one-000000-aaaaaa";
    const t2 = "principal-token-two-000000-bbbbbb";
    registerIdentitySecret("agent-r", t1);
    registerIdentitySecret("agent-r", t2); // rotate: t2 current, t1 in the grace window
    const scrubbed = redactRegisteredValues(`old=${t1} new=${t2}`);
    expect(scrubbed).not.toContain(t1);
    expect(scrubbed).not.toContain(t2);
  });

  it("LAYERED — the logger scrubs a registered value by VALUE under an unlisted field; the field rules still fire", () => {
    const token = "minted-agent-token-registered-000000";
    registerIdentitySecret("agent-x", token);
    expect(redactSecrets(`{"weird_unlisted_field":"${token}"}`)).not.toContain(token); // by VALUE
    expect(redactSecrets(`{"agent_token":"${"b".repeat(40)}"}`)).toContain('"agent_token":"***"'); // by field name
  });
});
