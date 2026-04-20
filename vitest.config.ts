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
  },
});
