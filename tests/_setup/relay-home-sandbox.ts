// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Hermetic RELAY-STATE isolation — a vitest `setupFiles` module (issue #240).
 *
 * WHY (the gap this closes): the harness isolated CONFIG + SECRETS
 * (tests/_setup/hermetic-config.ts) but deliberately scoped OUT relay STATE. So a
 * test that forgot its own RELAY_DB_PATH/RELAY_HOME resolved `getDbPath()` ->
 * `resolveInstanceDbPath()` -> `instanceRoot()` -> `os.homedir()/.bot-relay` and
 * reached the operator's REAL relay DB + the live :3777 daemon while believing it
 * was sandboxed — the reach-through behind #240. The wake-coverage sink and the
 * `relay` CLI resolve the same way.
 *
 * REDIRECT `HOME`, NOT `RELAY_HOME`. `os.homedir()` honors `$HOME` on POSIX, so
 * redirecting HOME closes the reach-through at its ROOT — every default relay-state
 * path derives from `os.homedir()`, so ONE lever covers the DB, the wake-coverage
 * sink, and the CLI at once. Crucially it leaves `RELAY_HOME`/`RELAY_DB_PATH`
 * ABSENT, which some tests REQUIRE: `instance-resolution-assert.test.ts` sets its
 * own `HOME` per-test and exercises the homedir-fallback resolver with RELAY_HOME
 * unset (the "nine-day bug" refusal path). An earlier cut of this file forced
 * `RELAY_HOME` and broke exactly those 7 tests — the wall hermetic-config's
 * "deliberately NOT RELAY_HOME" scope note warns about. HOME is the SAME lever
 * #226 used for the hook tests and that instance-resolution-assert uses on itself.
 *
 * setupFiles, NOT globalSetup: vitest `globalSetup` runs in the main process and
 * its process.env mutations do NOT reliably propagate to worker threads/forks — a
 * sandbox covering only some workers fails intermittently and gets mis-blamed on
 * flakiness. A setupFile runs IN each worker at module top.
 *
 * OVERRIDE CONTRACT (asserted in tests/relay-home-sandbox-negative-control.test.ts):
 * HOME is set at MODULE TOP, so a test that sets its own HOME — at its module top
 * OR in a beforeEach (which runs after this module) — WINS. Spawn tests that pass
 * an explicit child env are unaffected.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// One throwaway home per worker, under os.tmpdir() (/var/folders or /tmp), which
// db.ts's APPROVED_ROOTS already permits. os.homedir() now resolves here, so the
// default `~/.bot-relay` for every un-overridden test is a sandbox, not the real
// operator home. RELAY_HOME is intentionally NOT set.
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "bot-relay-home-"));
process.env.HOME = sandboxHome;
