/**
 * Doorbell PR 8, M7: the measurement harness (checks 1-9 of the gate brief), run on demand, never in the default suite
 * (vitest.config.ts excludes tests/m7/**). Real windows, a sandboxed relay home, serial.
 * Run: npx vitest run --config vitest.m7.config.ts   (or tests/m7/run-m7.sh, which prints the report)
 */
import { withOperatorTripwire } from "./tests/_setup/vitest-tripwire-base.mjs";

export default withOperatorTripwire({
  test: {
    globalSetup: ["./tests/global-user-config-tripwire.ts"],
    setupFiles: ["./tests/_setup/hermetic-config.ts", "./tests/_setup/no-fs-on-held-db.ts"],
    include: ["tests/m7/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    fileParallelism: false,
    testTimeout: 180_000,
  },
});
