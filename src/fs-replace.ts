// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * THE atomic replace (rename src over dst), shared: Windows cannot replace a file another process holds open (a
 * reader, an antivirus or indexer scanning the directory), and reports it as EPERM, EACCES or EBUSY. On Windows ONLY
 * those are retried, briefly and bounded ([25, 50, 100, 200] ms); then the LAST error is rethrown, tagged
 * `windowsOpenFile`, so each caller keeps its own NAMED refusal. POSIX never retries: EACCES there is a real
 * permission fault. No copy is ever made over the target (a crash mid-copy would leave it torn).
 * One implementation for every record writer that replaces by rename (restore's DB swap, the wasm persist, the owner
 * endpoint record, the doorbell holder file).
 */
import fs from "fs";

export const WINDOWS_REPLACE_WAITS_MS: readonly number[] = [25, 50, 100, 200];
const WINDOWS_OPEN_FILE_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

export interface ReplaceDeps {
  platform?: NodeJS.Platform;
  rename?: (from: string, to: string) => void;
  sleep?: (ms: number) => void;
}
const blockFor = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
let testDeps: ReplaceDeps | null = null;
/** TESTS ONLY (the __test prefix; tests/fs-replace-test-seam-tripwire.test.ts fails if any other src/ file names
 * it): the deps every call uses when it passes none (a Windows-shaped failing rename on any OS). */
export function __testSetReplaceDeps(deps: ReplaceDeps | null): void {
  testDeps = deps;
}

/** The final error of a refused replace: the original error, tagged. */
export type ReplaceError = NodeJS.ErrnoException & { windowsOpenFile: boolean };

export function renameReplacingWithWindowsRetry(from: string, to: string, deps?: ReplaceDeps): void {
  const d = deps ?? testDeps ?? {};
  const platform = d.platform ?? process.platform;
  const rename = d.rename ?? ((a: string, b: string) => fs.renameSync(a, b));
  const sleep = d.sleep ?? blockFor;
  const waits = WINDOWS_REPLACE_WAITS_MS; // used only for an open file ON WINDOWS (openOnWindows below)
  for (let i = 0; ; i++) {
    try {
      rename(from, to);
      return;
    } catch (err) {
      const e = err as ReplaceError;
      const openOnWindows = platform === "win32" && WINDOWS_OPEN_FILE_CODES.has(e.code ?? "");
      if (openOnWindows && i < waits.length) {
        sleep(waits[i]!);
        continue;
      }
      if (e && typeof e === "object") e.windowsOpenFile = openOnWindows;
      throw e;
    }
  }
}
