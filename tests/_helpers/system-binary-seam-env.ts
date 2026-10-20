// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * The env that loads the test-only system-tool seam (system-binary-seam.cjs) into a CHILD process and maps absolute
 * tool paths to test scripts. NODE_OPTIONS splits on whitespace, and a checkout path may hold a space ("Claude AI":
 * MEASURED 20 Oct, the preload never loaded), so the seam is byte-copied ONCE into a fresh space-free temp dir and
 * required from there.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), "system-binary-seam.cjs");
let copy: string | undefined;

/** The space-free path of this run's byte copy of the seam. */
export function systemBinarySeamPath(): string {
  if (!copy) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-seam-"));
    copy = path.join(dir, "system-binary-seam.cjs");
    fs.copyFileSync(SOURCE, copy);
    if (/\s/.test(copy)) throw new Error(`system-binary seam: the temp path has whitespace (${copy}); NODE_OPTIONS would split it`);
  }
  return copy;
}

/** NODE_OPTIONS (the inherited options plus the seam) and the map, for a child's env. Values may be any string (tests). */
export function systemBinarySeamEnv(map: Record<string, string> | string, baseNodeOptions = process.env.NODE_OPTIONS ?? ""): { NODE_OPTIONS: string; RELAY_TEST_SYSTEM_BINARY_SEAM: string } {
  return {
    NODE_OPTIONS: `${baseNodeOptions} --require ${systemBinarySeamPath()}`.trim(),
    RELAY_TEST_SYSTEM_BINARY_SEAM: typeof map === "string" ? map : JSON.stringify(map),
  };
}
