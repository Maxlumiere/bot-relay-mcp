/**
 * v2.1 Phase 5b — vitest config for `--full` pre-publish runs.
 *
 * Runs EVERYTHING the default config runs + the opt-in files (load-smoke,
 * chaos, cross-version). Selected via `--config vitest.full.config.ts`
 * by `scripts/pre-publish-check.sh --full`.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
  },
});
