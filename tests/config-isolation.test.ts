// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Verifies the hermetic-config setupFile (tests/_setup/hermetic-config.ts): a
 * file that does NOT set its own RELAY_CONFIG_PATH is ISOLATED — it sees the
 * private hermetic temp, never the operator's real ~/.bot-relay — so loadConfig()
 * has no dashboard_secret regardless of what the real machine carries. This is
 * the harm side: on a machine where `relay init` has run, this is what stops the
 * real secret from leaking into every server/daemon a test spins up (the ws-401
 * that failed only on the publishing machine).
 */
import { describe, it, expect } from "vitest";
import os from "node:os";

const { loadConfig, resolveDashboardSecret } = await import("../src/config.js");

describe("hermetic config isolation — the setupFile isolates ambient config", () => {
  it("a non-isolating file gets the hermetic temp, not the real ~/.bot-relay", () => {
    const cfgPath = process.env.RELAY_CONFIG_PATH ?? "";
    expect(cfgPath).toContain("bot-relay-hermetic-");
    expect(cfgPath.startsWith(os.tmpdir())).toBe(true);
    // No operator secret leaks in from the real machine — the "unconfigured"
    // posture, deterministically, whether or not this box has run `relay init`.
    expect(process.env.RELAY_DASHBOARD_SECRET).toBeUndefined();
    expect(resolveDashboardSecret(loadConfig())).toBeNull();
  });
});
