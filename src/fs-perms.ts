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
import { tmpdir as osTmpdir } from "os";
import { join as pathJoin } from "path";
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
// PR-D (rulings f885e674 Q6, efb48600 Q12; Codex R1 #2, architect e9ad940d): Windows ACLs. On NTFS a POSIX mode
// is meaningless, so the relay's private files and directories are restricted to an OWNER-ONLY ACL, checked by
// SID (icacls and account names are LOCALIZED; SIDs are not). Owner-only is an ALLOWLIST: the current user, and
// SYSTEM TOLERATED (never granted; the Windows equivalent of root, out of scope on every OS). Every other SID,
// Administrators included, is removed. restrictToOwnerWindows REPORTS what it could not remove; the registration
// secret's chain fails CLOSED on that report (src/mint-secret.ts), the DB and the rest are reported loudly.
// ---------------------------------------------------------------------------------------------------------

/** Display names for well-known SIDs in a fault (the first three are the broadest grants a path can carry). */
export const FORBIDDEN_SIDS: Readonly<Record<string, string>> = Object.freeze({
  "S-1-1-0": "Everyone",
  "S-1-5-32-545": "BUILTIN\\Users",
  "S-1-5-11": "Authenticated Users",
  "S-1-5-32-544": "BUILTIN\\Administrators",
  "S-1-5-32-547": "BUILTIN\\Power Users",
});

/** SYSTEM: tolerated on a private path, never granted by the relay. */
export const SYSTEM_SID = "S-1-5-18";
/** BUILTIN\Administrators: tolerated as an OWNER only (an elevated shell's default owner), never as an ACE. */
export const ADMINISTRATORS_SID = "S-1-5-32-544";

/**
 * An INFO note for an element owned by BUILTIN\Administrators (accepted, created from an elevated shell): the
 * recommended fix. null otherwise, and on every read failure (the fault path reports those). Windows only.
 */
export function windowsOwnerInfo(path: string): string | null {
  try {
    return windowsOwner(path) === ADMINISTRATORS_SID
      ? `${path} is owned by Administrators (created from an elevated shell); recommended: icacls "${path}" /setowner "%USERNAME%"`
      : null;
  } catch {
    return null;
  }
}

let currentUserSid: string | null | undefined;
/** The current user's SID (whoami /user), or null when it cannot be read. Windows only; cached. */
export function windowsUserSid(): string | null {
  if (currentUserSid !== undefined) return currentUserSid;
  const r = spawnSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf-8", windowsHide: true });
  const m = r.status === 0 ? /"(S-1-[0-9-]+)"\s*$/m.exec(r.stdout ?? "") : null;
  currentUserSid = m ? m[1] : null;
  return currentUserSid;
}

const describeSid = (sid: string) => (FORBIDDEN_SIDS[sid] ? `${FORBIDDEN_SIDS[sid]} (${sid})` : sid);

/**
 * Restrict `path` to its owner on Windows: remove inherited ACEs, grant the current user full control (inherited by
 * a directory's children), then REMOVE every other SID still on the DACL (explicit grants and denies survive
 * /inheritance:r), except SYSTEM, and READ IT BACK. Returns the faults that remain ([] = owner-only), each naming
 * the path and the SID; also warns. A no-op elsewhere (the POSIX modes above do the job).
 */
export function restrictToOwnerWindows(path: string, isDir: boolean): string[] {
  if (process.platform !== "win32") return [];
  const sid = windowsUserSid();
  if (!sid) {
    const fault = `${path}: the current user's SID could not be read, so its ACL could not be restricted`;
    log.warn(`[fs-perms] ${fault}.`);
    return [fault];
  }
  const grant = isDir ? `*${sid}:(OI)(CI)F` : `*${sid}:F`;
  const r = spawnSync("icacls", [path, "/inheritance:r", "/grant:r", grant], { encoding: "utf-8", windowsHide: true });
  if (r.status !== 0) {
    const fault = `${path}: icacls could not restrict the ACL (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`;
    log.warn(`[fs-perms] ${fault}`);
    return [fault];
  }
  const faults = (): string[] => {
    try {
      return windowsForeignAllowSids(path).map((f) => `${path}: an allow ACE for ${describeSid(f)} is not the owner's`);
    } catch (err) {
      return [`${path}: ${(err as Error).message}`];
    }
  };
  let foreign: string[];
  try {
    foreign = windowsForeignAllowSids(path);
  } catch (err) {
    const fault = `${path}: ${(err as Error).message}`;
    log.warn(`[fs-perms] ${fault}`);
    return [fault];
  }
  // `/remove *SID` drops that SID's grant AND deny ACEs. An alias the map below does not know cannot be removed by
  // SID: it stays, and is reported as a fault (fail closed where the caller requires owner-only).
  for (const f of foreign) if (/^S-1-[0-9-]+$/.test(f)) spawnSync("icacls", [path, "/remove", `*${f}`], { encoding: "utf-8", windowsHide: true });
  const left = faults();
  if (left.length > 0) log.warn(`[fs-perms] ${left.join("; ")}`);
  return left;
}

/**
 * SDDL's two-letter aliases for well-known SIDs (SDDL is not localized). Mapped so the owner-only allowlist compares
 * SIDs only; an alias missing here stays as written, which is never on the allowlist (a fault, never a pass).
 */
const SDDL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  WD: "S-1-1-0",
  CO: "S-1-3-0",
  CG: "S-1-3-1",
  OW: "S-1-3-4",
  NU: "S-1-5-2",
  IU: "S-1-5-4",
  SU: "S-1-5-6",
  AN: "S-1-5-7",
  AU: "S-1-5-11",
  RC: "S-1-5-12",
  SY: "S-1-5-18",
  LS: "S-1-5-19",
  NS: "S-1-5-20",
  BA: "S-1-5-32-544",
  BU: "S-1-5-32-545",
  BG: "S-1-5-32-546",
  PU: "S-1-5-32-547",
  AO: "S-1-5-32-548",
  SO: "S-1-5-32-549",
  PO: "S-1-5-32-550",
  BO: "S-1-5-32-551",
  RE: "S-1-5-32-552",
  RU: "S-1-5-32-554",
  RD: "S-1-5-32-555",
  NO: "S-1-5-32-556",
  AC: "S-1-15-2-1",
});

/**
 * The SIDs of the ALLOW ACEs in an SDDL string's DACL ("D:" part). Each ACE is `(type;flags;rights;obj;inh;sid)`;
 * types A (allow) and OA (object allow) count. An alias in SDDL_ALIASES is mapped to its SID; other aliases are
 * kept as written (they are not among the forbidden ones). Pure: unit-tested on every OS.
 */
export function sddlAllowSids(sddl: string): string[] {
  // STRUCTURED, not a regex over the whole string (MEASURED: a character-class stop at "S" cut the DACL at the first
  // SID or the SY alias): from "D:", skip the DACL's flag letters, then read consecutive "(...)" ACEs and stop at the
  // first character that does not open one (a following "S:" SACL, or the end).
  const text = sddl.replace(/\s+/g, "");
  let i = text.indexOf("D:");
  const aces: string[] = [];
  if (i >= 0) {
    i += 2;
    while (i < text.length && /[A-Z]/.test(text[i]) && text[i] !== "(") i++; // P, AI, AR, ... flags
    while (text[i] === "(") {
      const close = text.indexOf(")", i);
      if (close < 0) break;
      aces.push(text.slice(i + 1, close));
      i = close + 1;
    }
  }
  // ACE TYPES ARE AN ALLOWLIST (Codex R2 #2): the allow types, callback ones included (A, OA, XA, ZA), are read;
  // the deny types are not access grants; ANY other type is unknown and returned as a sentinel that never equals an
  // owner's SID, so the caller fails CLOSED on it (an ACE the parser does not understand is foreign until proven not).
  const out: string[] = [];
  for (const ace of aces) {
    const f = ace.split(";");
    if (f.length < 6) {
      out.push(`UNPARSED-ACE(${ace})`);
      continue;
    }
    if (DENY_ACE_TYPES.has(f[0])) continue;
    if (!ALLOW_ACE_TYPES.has(f[0])) {
      out.push(`UNKNOWN-ACE-TYPE(${f[0]})`);
      continue;
    }
    const sid = f[5];
    out.push(SDDL_ALIASES[sid] ?? sid);
  }
  return out;
}

const ALLOW_ACE_TYPES: ReadonlySet<string> = new Set(["A", "OA", "XA", "ZA"]);
const DENY_ACE_TYPES: ReadonlySet<string> = new Set(["D", "OD", "XD", "ZD"]);

/** The OWNER token of an SDDL owner string ("O:BA", "O:S-1-5-…"), aliases mapped to SIDs; null when absent. */
export function sddlOwner(sddl: string): string | null {
  const m = /O:([A-Z]{2}|S-1-[0-9-]+)/.exec(sddl.replace(/\s+/g, ""));
  return m ? (SDDL_ALIASES[m[1]] ?? m[1]) : null;
}

/**
 * The security-descriptor OWNER of `path` (Windows only), as a SID or an unmapped alias. Read with PURE .NET from
 * Windows PowerShell (no module: MEASURED, Get-Acl's module would not load when launched from Node). icacls cannot
 * print the owner, and its /save output is the DACL only. Throws when it cannot be read (a check that cannot read
 * must not pass).
 */
export function windowsOwner(path: string): string {
  const script =
    "$ErrorActionPreference='Stop';" +
    "$s=[System.Security.AccessControl.FileSecurity]::new($env:RELAY_OWNER_PATH,[System.Security.AccessControl.AccessControlSections]::Owner);" +
    "[Console]::Out.WriteLine($s.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Owner))";
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf-8",
    windowsHide: true,
    env: { ...process.env, RELAY_OWNER_PATH: path },
  });
  const owner = r.status === 0 ? sddlOwner(r.stdout ?? "") : null;
  if (!owner) throw new Error(`the owner of "${path}" could not be read (powershell exit ${r.status}): ${(r.stderr || r.stdout || "").trim().slice(0, 200)}`);
  return owner;
}

/**
 * Why `path`'s OWNER is not acceptable (Windows only), or null. Accepted owners (architect, Codex R2 #1 as refined):
 * the current user (its SID, or the spelling icacls uses for it), SYSTEM, and BUILTIN\Administrators. The last two
 * are tolerated for the same reason: a local admin can take ownership of and read anything anyway, so such an owner
 * grants no capability that principal lacks (out of scope, like root). Any OTHER owner (another user, a domain
 * group, an unknown SID) is a fault naming the owner and the exact fix; ownership is NEVER taken automatically.
 * The DACL allowlist is separate and unchanged: an ACE granting Administrators is still removed or refused.
 */
export function windowsOwnerFault(path: string): string | null {
  const user = windowsUserSid();
  if (!user) return `${path}: the current user's SID could not be read`;
  let owner: string;
  try {
    owner = windowsOwner(path);
  } catch (err) {
    return `${path}: ${(err as Error).message}`;
  }
  if (owner === user || owner === windowsOwnerSddlToken() || owner === SYSTEM_SID || owner === ADMINISTRATORS_SID) return null;
  return `${path}: owned by ${describeSid(owner)}, not by this user or SYSTEM; fix it with: icacls "${path}" /setowner "%USERNAME%"`;
}

/**
 * The allow ACEs on `path`, as SIDs (Windows only). `icacls <path> /save <file>` writes the ACL as SDDL, which is
 * language-independent (account names and icacls's display are localized; SIDs and SDDL are not). MEASURED on
 * windows-2022 CI: PowerShell's Get-Acl could not load its module when launched from Node, with or without
 * PSModulePath, so PowerShell is not used. Throws when the ACL cannot be read: a check that cannot read must not pass.
 */
export function windowsAllowSids(path: string): string[] {
  const tmp = pathJoin(osTmpdir(), `relay-acl-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sddl`);
  try {
    const r = spawnSync("icacls", [path, "/save", tmp], { encoding: "utf-8", windowsHide: true });
    if (r.status !== 0) throw new Error(`icacls /save failed for "${path}" (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
    const raw = fs.readFileSync(tmp);
    // icacls writes UTF-16LE (with or without a BOM): the file's lines are the path, then its SDDL.
    const text = raw.toString(raw[0] === 0xff && raw[1] === 0xfe ? "utf16le" : raw.includes(0) ? "utf16le" : "utf8").replace(/^\uFEFF/, "");
    const sddl = text.split(/\r?\n/).find((l) => /D:/.test(l));
    if (!sddl) throw new Error(`icacls /save for "${path}" produced no DACL`);
    return sddlAllowSids(sddl);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * The allow-ACE SIDs on `path` that are NEITHER the current user NOR SYSTEM (Windows only): [] = owner-only.
 * Throws when the ACL or the user's SID cannot be read: a check that cannot read must not pass.
 */
export function windowsForeignAllowSids(path: string): string[] {
  const owner = windowsUserSid();
  if (!owner) throw new Error("the current user's SID could not be read");
  const ownerToken = windowsOwnerSddlToken();
  return windowsAllowSids(path).filter((s) => s !== owner && s !== ownerToken && s !== SYSTEM_SID);
}

let ownerSddlToken: string | null | undefined;
/**
 * How icacls WRITES the current user in SDDL. Usually the SID itself, but a domain-relative account gets an ALIAS
 * (MEASURED on windows-2022: the runner's user is the machine's built-in Administrator, RID 500, which SDDL writes
 * as "LA"; every owner-only path then read as "an allow ACE for LA"). An alias cannot be mapped to a SID without
 * the machine's domain SID, so it is PROBED: a private temp file is restricted to this user's SID alone, saved as
 * SDDL, and its one ACE's token is the user's spelling. null when the probe fails or is ambiguous: only the SID
 * itself then counts as the owner (fail closed). Windows only; cached for the process.
 */
/** What the owner probe saw (Windows; for faults and the CI diagnostic). */
export let windowsOwnerProbeNote = "not probed";
export function windowsOwnerSddlToken(): string | null {
  if (ownerSddlToken !== undefined) return ownerSddlToken;
  const sid = windowsUserSid();
  if (!sid) {
    windowsOwnerProbeNote = "the user's SID could not be read";
    return (ownerSddlToken = null);
  }
  const dir = fs.mkdtempSync(pathJoin(osTmpdir(), "relay-owner-probe-"));
  try {
    const probe = pathJoin(dir, "probe");
    fs.writeFileSync(probe, "");
    const r = spawnSync("icacls", [probe, "/inheritance:r", "/grant:r", `*${sid}:F`], { encoding: "utf-8", windowsHide: true });
    // A new file can carry EXPLICIT (non-inherited) ACEs that /inheritance:r keeps: MEASURED on windows-2022, the
    // probe still read [S-1-5-18, S-1-5-32-544, LA]. Remove every SID-spelled ACE that is not the user's, then the
    // one token left is the user's spelling.
    const before = r.status === 0 ? windowsAllowSids(probe) : [];
    for (const t of before) if (/^S-1-[0-9-]+$/.test(t) && t !== sid) spawnSync("icacls", [probe, "/remove", `*${t}`], { encoding: "utf-8", windowsHide: true });
    const tokens = r.status === 0 ? windowsAllowSids(probe) : [];
    ownerSddlToken = tokens.length === 1 ? tokens[0] : null;
    windowsOwnerProbeNote =
      r.status !== 0 ? `icacls exit ${r.status}: ${(r.stderr || r.stdout || "").trim()}` : `user ${sid} written as [${tokens.join(", ")}] (before removing the others: [${before.join(", ")}])`;
  } catch (err) {
    ownerSddlToken = null;
    windowsOwnerProbeNote = `probe failed: ${(err as Error).message}`;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return ownerSddlToken;
}

/**
 * PR-D Q6: why `path` is NOT private, or [] when it is. POSIX: the mode must not exceed `maxMode` (no group or
 * other bits). Windows (Codex R1 #2): owner-only, an allowlist: any allow ACE for a SID other than the current
 * user or SYSTEM is a fault, Administrators included. An unreadable path is a fault.
 */
export function privacyFaults(path: string, maxMode: number): string[] {
  if (process.platform === "win32") {
    let sids: string[];
    try {
      sids = windowsForeignAllowSids(path);
    } catch (err) {
      return [`${path}: ${(err as Error).message}`];
    }
    const ownerFault = windowsOwnerFault(path);
    return [...sids.map((s) => `${path}: an allow ACE for ${describeSid(s)} is not the owner's`), ...(ownerFault ? [ownerFault] : [])];
  }
  let mode: number;
  try {
    mode = fs.statSync(path).mode & 0o777;
  } catch (err) {
    return [`${path}: ${(err as Error).message}`];
  }
  return mode & ~maxMode ? [`${path}: mode 0${mode.toString(8)} is wider than 0${maxMode.toString(8)}`] : [];
}
