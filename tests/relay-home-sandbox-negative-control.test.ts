// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * NEGATIVE CONTROL for the relay-state sandbox (issue #240).
 *
 * The fix is a single setupFile (tests/_setup/relay-home-sandbox.ts) that redirects
 * `HOME` — and thus `os.homedir()` and every default relay-state path — at a
 * throwaway, so no test reaches the operator's real ~/.bot-relay + live :3777
 * daemon. "Adding a setupFile and seeing green" is not proof — a suite that no
 * longer reaches the live daemon and one that merely got lucky look identical. This
 * test makes the sandbox OBSERVABLE and REQUIRED: it asserts the ACTUAL resolver
 * (getDbPath) resolves UNDER the sandbox tmp, never a real user home. Remove the
 * setupFile from vitest.config.ts and every assertion below reddens (HOME becomes
 * the real user/CI home, which is not under os.tmpdir()) — so the next refactor
 * cannot quietly reopen the reach-through.
 *
 * It sets NO HOME / RELAY_HOME / RELAY_DB_PATH of its own: it must observe the
 * DEFAULT the harness provides, not an override.
 */
import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { getDbPath } from "../src/db.js";
import { resolveWakeCoverageStatusPath } from "../src/wake-coverage-status.js";

const TMP = path.resolve(os.tmpdir());
const underTmp = (p: string) => path.resolve(p).startsWith(TMP + path.sep) || path.resolve(p) === TMP;

describe("#240 — the suite CANNOT see the real ~/.bot-relay (relay-state sandbox)", () => {
  it("HOME is redirected by the harness to a sandbox under os.tmpdir()", () => {
    const home = process.env.HOME;
    expect(home, "HOME must be set by tests/_setup/relay-home-sandbox.ts").toBeTruthy();
    // Load-bearing: a real user/CI home (/Users/*, /home/*) is NOT under tmpdir.
    // If the setupFile is removed, HOME is the real home and this reddens.
    expect(
      underTmp(home!),
      `HOME (${home}) must be a sandbox under os.tmpdir() (${TMP}) — the real home is not`,
    ).toBe(true);
    // os.homedir() must agree (it honors $HOME on POSIX) — the reach-through root.
    expect(underTmp(os.homedir()), `os.homedir() (${os.homedir()}) must be sandboxed`).toBe(true);
  });

  it("the ACTUAL DB resolver (getDbPath) points under the sandbox, never a real home", () => {
    // No RELAY_DB_PATH override here → getDbPath() resolves via the per-instance
    // path under os.homedir(). If the sandbox is gone, this lands under the
    // operator's real ~/.bot-relay and the assertion fails.
    const dbPath = getDbPath();
    expect(
      underTmp(dbPath),
      `getDbPath() resolved to ${dbPath}, OUTSIDE the sandbox tmp — the harness is not isolating relay state`,
    ).toBe(true);
  });

  it("the wake-coverage sink is under the sandbox, off any real home", () => {
    expect(
      underTmp(resolveWakeCoverageStatusPath()),
      `wake-coverage sink (${resolveWakeCoverageStatusPath()}) must be under the sandbox tmp`,
    ).toBe(true);
  });
});
