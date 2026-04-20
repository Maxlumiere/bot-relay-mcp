// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 4c.4 — filesystem-perm helpers.
 *
 * All three operations (ensureSecureDir, ensureSecureFile, checkAndWarnPermissive)
 * are best-effort. They wrap fs.chmodSync / fs.statSync in try/catch and emit
 * `log.warn` on failure. Chmod failures are NEVER fatal — they happen on
 * filesystems that don't honor POSIX modes (FAT32, NTFS without WSL, some
 * Docker bind mounts), and the relay must keep starting regardless.
 *
 * Windows note: fs.chmodSync on native Windows is effectively a no-op for
 * world-access bits (NTFS uses ACLs, not POSIX modes). The chmod call does
 * not throw — it just doesn't change what the tests would check. Tests
 * skip on win32; the code path is harmless on it.
 */

import fs from "fs";
import { log } from "./logger.js";

/** Chmod an existing file to the requested mode. Best-effort; log.warn on failure. */
export function ensureSecureFile(path: string, mode: number): void {
  try {
    fs.chmodSync(path, mode);
  } catch (err) {
    log.warn(
      `[fs-perms] Could not chmod "${path}" to 0${mode.toString(8)}: ${err instanceof Error ? err.message : String(err)}. Continuing — the relay does not require this chmod to function, but file perms may be more open than intended.`
    );
  }
}

/**
 * Ensure a directory exists and has the requested mode. Creates recursively
 * if missing. Best-effort chmod — same semantics as ensureSecureFile.
 */
export function ensureSecureDir(path: string, mode: number): void {
  try {
    if (!fs.existsSync(path)) {
      fs.mkdirSync(path, { recursive: true, mode });
    }
    fs.chmodSync(path, mode);
  } catch (err) {
    log.warn(
      `[fs-perms] Could not secure directory "${path}" at 0${mode.toString(8)}: ${err instanceof Error ? err.message : String(err)}. Continuing.`
    );
  }
}

/**
 * Check an existing file's mode; log.warn if it's more permissive than
 * `maxMode`. Does NOT chmod — some files (e.g. user-owned config.json) are
 * operator-managed and silent auto-chmod would be surprising.
 *
 * Skips silently on Windows (POSIX mode bits are meaningless on NTFS).
 */
export function checkAndWarnPermissive(path: string, maxMode: number): void {
  if (process.platform === "win32") return;
  try {
    if (!fs.existsSync(path)) return;
    const mode = fs.statSync(path).mode & 0o777;
    // "More permissive" = any bit set in mode but not in maxMode.
    if ((mode & ~maxMode) !== 0) {
      log.warn(
        `[fs-perms] "${path}" has mode 0${mode.toString(8)}, wider than recommended 0${maxMode.toString(8)}. ` +
        `Run: chmod ${maxMode.toString(8)} "${path}"`
      );
    }
  } catch (err) {
    log.warn(
      `[fs-perms] Could not stat "${path}": ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
