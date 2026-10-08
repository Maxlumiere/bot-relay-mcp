/**
 * v2.1 Phase 5b — vitest config for `--full` pre-publish runs.
 *
 * Runs EVERYTHING the default config runs + the opt-in files (load-smoke,
 * chaos, cross-version). Selected via `--config vitest.full.config.ts`
 * by `scripts/pre-publish-check.sh --full`.
 */
import { withOperatorTripwire } from "./tests/_setup/vitest-tripwire-base.mjs";

// The SAME protection as the default run (Codex #305 R1 P1 #1: this config used to run load-smoke, chaos
// and cross-version with no private HOME and no tripwire), and the same hermetic config + user-config guard.
export default withOperatorTripwire({
  test: {
    globalSetup: ["./tests/global-user-config-tripwire.ts"],
    setupFiles: ["./tests/_setup/hermetic-config.ts"],
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
  },
});
