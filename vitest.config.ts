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
  // READ-ONLY / SYMLINKED CHECKOUT (e.g. an isolated audit tree): Vite fails to
  // start because it writes `.vite-temp` under node_modules. The PROVEN fix is to
  // run with `--configLoader runner`, which skips the config bundle entirely:
  //   npx vitest run --configLoader runner <file>
  // NB: `VITEST_CACHE_DIR` alone does NOT fix it — Vite bundles this config file
  // BEFORE cacheDir can take effect (verified by codex, #139). We still honor it
  // (unset → Vite default, no change to normal runs) as a secondary lever.
  cacheDir: process.env.VITEST_CACHE_DIR || undefined,
  test: {
    // 2026-07-23 worktree-clobber fix: fail any run that modifies the REAL
    // ~/.claude.json / ~/.claude/settings.json / ~/.bot-relay/config.json.
    globalSetup: ["./tests/global-user-config-tripwire.ts"],
    // Hermetic config isolation for EVERY test file (runs in-worker before each
    // file's module code): points RELAY_CONFIG_PATH at a private temp and clears
    // ambient operator secrets, so no test reads the operator's real
    // ~/.bot-relay/config.json or inherits a real dashboard secret. Closes the
    // "suite only ever ran the no-config posture" defect (green in secret-free CI,
    // ws-401/403 on a machine that has run `relay init`) from ONE site. A test that
    // sets its own RELAY_CONFIG_PATH at its module top overrides it (asserted in
    // tests/config-isolation.test.ts). Scoped to config+secrets, NOT RELAY_HOME.
    // hermetic-config isolates CONFIG + SECRETS; relay-home-sandbox isolates
    // relay STATE by redirecting HOME (→ os.homedir() → every default ~/.bot-relay
    // path: the DB, the wake-coverage sink, the CLI) so no test reaches the
    // operator's real ~/.bot-relay + live :3777 daemon (issue #240). HOME, not
    // RELAY_HOME — the latter breaks tests that assert the RELAY_HOME-absent
    // resolver. Guarded by tests/relay-home-sandbox-negative-control.test.ts.
    setupFiles: [
      "./tests/_setup/hermetic-config.ts",
      "./tests/_setup/relay-home-sandbox.ts",
    ],
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
