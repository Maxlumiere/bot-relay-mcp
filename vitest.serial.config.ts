/**
 * INV-DB-01 slice 2b-ii: the multi-process single-owner measurements (the per-platform lock racer harness, and the
 * black-box K-process test written from the invariant's spec). They spawn racers and real daemons, so they run SERIAL
 * and ALONE, in their own CI step, never inside the parallel suite (vitest.config.ts excludes them).
 * Run: npx vitest run --config vitest.serial.config.ts
 */
import { withOperatorTripwire } from "./tests/_setup/vitest-tripwire-base.mjs";

export default withOperatorTripwire({
  test: {
    globalSetup: ["./tests/global-user-config-tripwire.ts"],
    setupFiles: ["./tests/_setup/hermetic-config.ts", "./tests/_setup/no-fs-on-held-db.ts"],
    include: ["tests/inv-db-01-owner-lock-race.test.ts", "tests/inv-db-01-single-owner-blackbox.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    fileParallelism: false,
    testTimeout: 120_000,
  },
});
