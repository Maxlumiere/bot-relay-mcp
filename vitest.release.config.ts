// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The RELEASE SECURITY GATE's suite: the security invariants (security/invariants.json), checked against an
 * INSTALLED package. `RELAY_RELEASE_TGZ` names a tarball; the global setup installs it once into a scratch prefix,
 * and every test starts that install's own daemon, CLI and hooks in a sandboxed HOME. Never the source tree: the
 * setup refuses to run without a tarball. Run it through scripts/release-invariants.mjs (the verdict, the known-bad
 * control, the report); `npx vitest run --config vitest.release.config.ts` alone runs the tests.
 */
import { withOperatorTripwire } from "./tests/_setup/vitest-tripwire-base.mjs";

export default withOperatorTripwire({
  test: {
    globalSetup: ["./tests/global-user-config-tripwire.ts", "./tests/release/global-setup.ts"],
    include: ["tests/release/**/*.release.ts"],
    exclude: ["node_modules/**", "dist/**"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
