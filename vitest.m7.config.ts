/**
 * Doorbell PR 8, M7: the measurement harness (checks 1-9 of the gate brief), run on demand, never in the default suite
 * (vitest.config.ts excludes tests/m7/**). Real windows, a sandboxed relay home, serial.
 * Run only through tests/m7/run-m7.sh (its refusals run before anything is written; it prints the report).
 */
import { withOperatorTripwire } from "./tests/_setup/vitest-tripwire-base.mjs";
import { isolationFault } from "./tests/m7/isolation.mjs";

// ISOLATION FIRST (Codex #446 R2, ruling 0c3deae0): evaluated at config load, before any global setup or setup file
// creates a temp dir. Read-only. A temp root inside the real (passwd) home refuses the run here.
const m7Fault = process.env.M7_RUNNER === "1" ? isolationFault() : null;
if (m7Fault) throw new Error(`m7: refusing: ${m7Fault}`);

export default withOperatorTripwire({
  test: {
    globalSetup: ["./tests/global-user-config-tripwire.ts"],
    // The hook budget tripwire too (as in the default and full configs): a PostToolUse/Stop spawn outside a seamed
    // copy, or on the real clock outside runHookRealBudget, is refused. The isolation check above still runs first.
    setupFiles: ["./tests/_setup/hermetic-config.ts", "./tests/_setup/no-fs-on-held-db.ts", "./tests/_setup/hook-budget-tripwire.ts"],
    include: ["tests/m7/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    fileParallelism: false,
    testTimeout: 180_000,
  },
});
