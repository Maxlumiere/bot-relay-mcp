// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * SUITE-WIDE USER-CONFIG TRIPWIRE (2026-07-23 worktree-clobber fix, layer 3).
 *
 * Snapshots the operator's REAL user-scope config files before the test run
 * and fails the run if any of them changed by the end. This is the
 * observation-level backstop behind the two by-construction guards (the
 * atomicWriteJson chokepoint and the RELAY_CLAUDE_HOME sandbox in the
 * init-exercising tests): those stop relay code from clobbering; this catches
 * ANY test writing these files by ANY means — fs.writeFileSync, a shelled
 * subprocess, a dependency — including code that doesn't exist yet.
 *
 * Why it must FAIL the run rather than warn: today's root cause survived nine
 * days precisely because the clobber was silent and every suite run was green.
 * A guard that cannot fail is decoration.
 *
 * Honest limitation: it keys on file CONTENT at setup/teardown, so a change
 * made by something else on the machine during the run (another agent editing
 * ~/.claude.json mid-suite) also trips it. That is rare, the message says
 * exactly what to check, and a false alarm here costs one re-run — the
 * failure it exists to catch cost twelve days.
 */
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";

function protectedFiles(): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".claude.json"),
    path.join(home, ".claude", "settings.json"),
    path.join(home, ".bot-relay", "config.json"),
  ];
}

function fingerprint(file: string): string {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return "ABSENT"; // missing file is a state too — creating it is a change
  }
}

export default function setup(): () => void {
  const before = new Map(protectedFiles().map((f) => [f, fingerprint(f)]));
  return function teardown(): void {
    const changed = protectedFiles().filter((f) => fingerprint(f) !== before.get(f));
    if (changed.length > 0) {
      const msg =
        `[user-config-tripwire] the test run MODIFIED real user config: ${changed.join(", ")}.\n` +
        `A test wrote outside its sandbox (the 2026-07-23 worktree-clobber class — see ` +
        `tests/user-config-write-guard.test.ts). Find the writer and give it RELAY_CLAUDE_HOME / ` +
        `RELAY_CONFIG_PATH sandboxes. If YOU edited these files while the suite ran, re-run to confirm.`;
      // BOTH channels, deliberately: vitest logs a teardown throw as "error
      // during close" but still exits 0 (proven during NC2 on 2026-07-23), so
      // the throw alone is decoration. Setting process.exitCode here is what
      // actually fails `npm test` / CI; the throw keeps the loud red banner.
      process.exitCode = 1;
      throw new Error(msg);
    }
  };
}
