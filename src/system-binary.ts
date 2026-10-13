// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * SEC-22: every security- or liveness-relevant subprocess is invoked by an ABSOLUTE trusted path, never resolved
 * through PATH.
 *
 * THE DEFECT (MEASURED on a windows-2022 runner, 13 Oct): the owner-only checks ran `whoami /user` BY NAME. Under Git
 * Bash, PATH starts with Git's usr/bin, whose GNU coreutils `whoami` answers "extra operand '/user'": the relay could
 * not read its own SID, so it refused its own registration secret (no new HTTP registration). A program found first on
 * PATH also decides what the privacy check believes (a planted `whoami` can report any SID).
 *
 * THE RULE: one map per OS, from a tool to its absolute path. Windows: %SystemRoot%\System32\{whoami,icacls,reg}.exe and
 * the Windows PowerShell 5.1 powershell.exe. SystemRoot is VALIDATED (drive-rooted, absolute; the exe there is a
 * regular file); otherwise this THROWS a named SystemBinaryError, never a silent fallback to PATH. Changing SystemRoot
 * is a same-user act (the stated same-user boundary). tests/sec-22-system-binaries.test.ts fails CI on a subprocess
 * in src/ started by a bare name outside its reasoned allowlist.
 *
 * POSIX (ps, lsof, sysctl, ioreg, launchctl) is the same class and a NAMED follow-up: those sites are on that
 * allowlist, each saying so.
 */
import fs from "fs";
import path from "path";

/** A system tool could not be located at its trusted absolute path: the caller fails CLOSED with this message. */
export class SystemBinaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SystemBinaryError";
  }
}

/** Each Windows tool, relative to %SystemRoot%. */
const WINDOWS_TOOLS = {
  whoami: ["System32", "whoami.exe"],
  icacls: ["System32", "icacls.exe"],
  reg: ["System32", "reg.exe"],
  powershell: ["System32", "WindowsPowerShell", "v1.0", "powershell.exe"],
} as const;

export type SystemBinaryName = keyof typeof WINDOWS_TOOLS;

/**
 * The absolute path of a Windows system tool, validated. Throws SystemBinaryError (named, with the reason) when
 * SystemRoot is missing, not a drive-rooted absolute path, or the tool there is not a regular file. `env` and
 * `platform` are seams for tests; production passes neither.
 */
export function systemBinary(
  name: SystemBinaryName,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") throw new SystemBinaryError(`cannot locate the system ${name}: it is a Windows tool (this is ${platform})`);
  // process.env is case-insensitive on Windows; a plain object (a test's env) is not.
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? Object.entries(env).find(([k]) => k.toLowerCase() === "systemroot")?.[1];
  if (!root || !/^[A-Za-z]:\\/.test(root) || !path.win32.isAbsolute(root)) {
    throw new SystemBinaryError(`cannot locate the system ${name}: SystemRoot invalid (${JSON.stringify(root ?? null)}; expected a drive-rooted path such as C:\\Windows)`);
  }
  const exe = path.win32.join(root, ...WINDOWS_TOOLS[name]);
  let st: fs.Stats | undefined;
  try {
    st = fs.statSync(exe, { throwIfNoEntry: false });
  } catch {
    st = undefined;
  }
  if (!st || !st.isFile()) throw new SystemBinaryError(`cannot locate the system ${name}: ${exe} is not a regular file`);
  return exe;
}
