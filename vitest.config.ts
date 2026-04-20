/**
 * v2.1 Phase 5b — vitest config.
 *
 * Default `npx vitest run` excludes the load/chaos/cross-version files
 * because they spawn subprocesses, produce load, or take 30-60s each.
 * They ARE included in `scripts/pre-publish-check.sh --full` (required
 * before npm publish).
 *
 * Dev loops + CI get the fast default run. Publish gets the full gate.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: [
      "node_modules/**",
      "dist/**",
      // v2.1 Phase 5b — opt-in via explicit path on `--full`.
      "tests/load-smoke.test.ts",
      "tests/chaos.test.ts",
      "tests/cross-version.test.ts",
    ],
    // v2.1 Phase 8 (CI-fix): CI disk + network are meaningfully slower than
    // local macOS. Webhook-firing tests, HTTP-probe tests, and file-IO-heavy
    // tests occasionally cross the 5s default. Dev loops stay at 5s (catches
    // real perf regressions); CI gets 15s headroom.
    testTimeout: process.env.CI ? 15000 : 5000,
  },
});
