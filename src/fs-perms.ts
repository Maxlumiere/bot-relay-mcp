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
import { spawnSync } from "child_process";
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

// ---------------------------------------------------------------------------------------------------------
// PR-D (rulings f885e674 Q6, efb48600 Q12): Windows ACLs. On NTFS a POSIX mode is meaningless, so the relay's
// private files and directories are restricted with an explicit owner-only ACL, and checked by SID (icacls and
// account names are LOCALIZED; SIDs are not). Best-effort like the chmods above: a failure warns, never stops.
// ---------------------------------------------------------------------------------------------------------

/** Well-known SIDs that must hold NO allow ACE on a private relay path: Everyone, Users, Authenticated Users. */
export const FORBIDDEN_SIDS: Readonly<Record<string, string>> = Object.freeze({
  "S-1-1-0": "Everyone",
  "S-1-5-32-545": "BUILTIN\\Users",
  "S-1-5-11": "Authenticated Users",
});

let currentUserSid: string | null | undefined;
/** The current user's SID (whoami /user), or null when it cannot be read. Windows only; cached. */
export function windowsUserSid(): string | null {
  if (currentUserSid !== undefined) return currentUserSid;
  const r = spawnSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf-8", windowsHide: true });
  const m = r.status === 0 ? /"(S-1-[0-9-]+)"\s*$/m.exec(r.stdout ?? "") : null;
  currentUserSid = m ? m[1] : null;
  return currentUserSid;
}

/**
 * Restrict `path` to the current user only on Windows: remove inherited ACEs and grant the user full control
 * (inherited by children for a directory). A no-op elsewhere (the POSIX modes above do the job).
 */
export function restrictToOwnerWindows(path: string, isDir: boolean): void {
  if (process.platform !== "win32") return;
  const sid = windowsUserSid();
  if (!sid) {
    log.warn(`[fs-perms] Could not read the current user's SID: "${path}" keeps its inherited ACL.`);
    return;
  }
  const grant = isDir ? `*${sid}:(OI)(CI)F` : `*${sid}:F`;
  const r = spawnSync("icacls", [path, "/inheritance:r", "/grant:r", grant], { encoding: "utf-8", windowsHide: true });
  if (r.status !== 0) {
    log.warn(`[fs-perms] Could not restrict the ACL of "${path}" (icacls exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
  }
}

/**
 * The allow ACEs on `path`, as SIDs (Windows only; PowerShell Get-Acl, each identity translated to its SID so
 * the answer does not depend on the OS language). Throws when the ACL cannot be read: a check that cannot read
 * must not pass.
 */
export function windowsAllowSids(path: string): string[] {
  const script =
    "$ErrorActionPreference='Stop'; (Get-Acl -LiteralPath $env:RELAY_ACL_PATH).Access | " +
    "Where-Object { $_.AccessControlType -eq 'Allow' } | " +
    "ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }";
  // PSModulePath is DROPPED: inherited from a PowerShell 7 parent it points Windows PowerShell 5.1 at the wrong
  // module tree, and Get-Acl's module then fails to load (MEASURED on windows-2022 CI: CouldNotAutoloadMatchingModule).
  const env: NodeJS.ProcessEnv = { ...process.env, RELAY_ACL_PATH: path };
  delete env.PSModulePath;
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf-8", windowsHide: true, env });
  if (r.status !== 0) throw new Error(`Get-Acl failed for "${path}": ${(r.stderr || "").trim()}`);
  return (r.stdout ?? "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("S-1-"));
}

/**
 * PR-D Q6: why `path` is NOT private, or [] when it is. POSIX: the mode must not exceed `maxMode` (no group or
 * other bits). Windows: no allow ACE for Everyone, Users or Authenticated Users. An unreadable path is a fault.
 */
export function privacyFaults(path: string, maxMode: number): string[] {
  if (process.platform === "win32") {
    let sids: string[];
    try {
      sids = windowsAllowSids(path);
    } catch (err) {
      return [(err as Error).message];
    }
    return sids.filter((s) => s in FORBIDDEN_SIDS).map((s) => `${path}: an allow ACE for ${FORBIDDEN_SIDS[s]} (${s})`);
  }
  let mode: number;
  try {
    mode = fs.statSync(path).mode & 0o777;
  } catch (err) {
    return [`${path}: ${(err as Error).message}`];
  }
  return mode & ~maxMode ? [`${path}: mode 0${mode.toString(8)} is wider than 0${maxMode.toString(8)}`] : [];
}
