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
 * PATH also decides what the privacy check believes (a planted `whoami` can report any SID). The same held on POSIX
 * (MEASURED 20 Oct, tests/sec-22-posix-system-binaries.test.ts): a planted `ps` forged the start token that decides
 * "the same process", a planted `lsof` a listener or a cwd, a planted `sysctl` the awake clock.
 *
 * THE RULE: one map per OS, from a tool to its absolute path(s), never PATH.
 *   - Windows: %SystemRoot%\System32\{whoami,icacls,reg}.exe and the Windows PowerShell 5.1 powershell.exe. SystemRoot
 *     is VALIDATED (drive-rooted, absolute; the exe there is a regular file). Changing SystemRoot is a same-user act
 *     (the stated same-user boundary).
 *   - macOS: ONE system path per tool (the SIP-protected /bin, /usr/bin, /usr/sbin).
 *   - Linux: a CLOSED list of FHS directories per tool (/usr/bin, /bin, /usr/sbin, /sbin), the first that passes.
 *   - POSIX, every candidate is TRUST-CHECKED (assertTrustedSystemFile): it and every directory above it, on its own
 *     path and on its realpath, are owned by root and not writable by group or other; the file is a regular file.
 * Otherwise this THROWS a named SystemBinaryError, never a silent fallback to PATH (ruled 20 Oct: FAIL CLOSED on a
 * non-FHS host such as NixOS or Guix; no config opt-in, not even a trust-checked PATH lookup, because a root-installed
 * GNU tool breaks the PARSE, as Homebrew's ps did). tests/sec-22-system-binaries.test.ts fails CI on a subprocess in
 * src/ started by a bare name outside its reasoned allowlist.
 */
import fs from "fs";
import path from "path";
import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "child_process";

/**
 * A system tool could not be located at a trusted absolute path. What each caller does with it (Codex #336 R2 NEW-4:
 * stated per caller, not promised for all): fs-perms' runSystem turns it into a FAILED run carrying this message, and
 * the SID / owner / ACL checks, the registration secret and the pair file then refuse; DB startup continues with a
 * REPORTED privacy degradation (db.ts, by design); liveness's runner reads it as "" (no output), and the reason is not
 * reported there: machineGuid() is then null on darwin/win32 (every agent treated as cross-host), and a start-time read
 * is "unreadable", which agentProcessState() then TRUSTS PID-liveness on (an inherited residual: an unreadable start
 * counts as alive; never "gone", so no signal and no cleanup: INV-LIVE-01); the awake clock reads null; the deploy gate
 * and the fleet view report the tool's failure as their own; `relay backup` refuses before it writes anything.
 */
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
  tar: ["System32", "tar.exe"],
} as const;

/** The FHS directories a Linux system tool may come from: a CLOSED list (ruled 20 Oct). */
const FHS_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] as const;
const fhs = (tool: string): readonly string[] => FHS_DIRS.map((d) => `${d}/${tool}`);

/** Each POSIX tool's trusted absolute path(s), per OS. A tool absent for an OS has no trusted path there. */
const POSIX_TOOLS = {
  darwin: {
    ps: ["/bin/ps"],
    ioreg: ["/usr/sbin/ioreg"],
    sysctl: ["/usr/sbin/sysctl"],
    launchctl: ["/bin/launchctl"],
    plutil: ["/usr/bin/plutil"],
    lsof: ["/usr/sbin/lsof"],
    tar: ["/usr/bin/tar"],
  },
  linux: {
    ps: fhs("ps"),
    lsof: fhs("lsof"),
    tar: fhs("tar"),
  },
} as const satisfies Record<string, Record<string, readonly string[]>>;

export type WindowsToolName = keyof typeof WINDOWS_TOOLS;
export type PosixToolName = keyof (typeof POSIX_TOOLS)["darwin"] | keyof (typeof POSIX_TOOLS)["linux"];
export type SystemBinaryName = WindowsToolName | PosixToolName;

/** The filesystem calls the trust check makes: a seam for tests (a root-owned or writable file cannot be planted). */
export interface TrustFs {
  lstatSync(p: string): { uid: number; mode: number; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean };
  realpathSync(p: string): string;
}
const nodeFs: TrustFs = { lstatSync: (p) => fs.lstatSync(p), realpathSync: (p) => fs.realpathSync(p) };

/** Why a path cannot be stat'ed, in the ruled words ("missing" for ENOENT / ENOTDIR). */
function statFailure(err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR" ? "missing" : `unreadable (${code ?? (err as Error)?.message ?? "unknown error"})`;
}

/**
 * The trust check, ONE function for every POSIX tool: `p` is returned only when the file at `p` exists, is owned by
 * root, and (through its realpath) is a regular file owned by root and not writable by group or other, and every
 * directory above `p` AND above its realpath is owned by root and not writable by group or other (a symlink in the
 * chain is judged by its owner, its target by the realpath walk). Anything else THROWS a SystemBinaryError
 * "<path>: <why>" (why = missing / not a regular file / not owned by root / writable by group or other at <path>).
 */
export function assertTrustedSystemFile(p: string, fsApi: TrustFs = nodeFs): string {
  const fail = (why: string): never => {
    throw new SystemBinaryError(`${p}: ${why}`);
  };
  const lstat = (x: string) => {
    try {
      return fsApi.lstatSync(x);
    } catch (err) {
      return fail(x === p ? statFailure(err) : `${x} ${statFailure(err)}`);
    }
  };
  const owned = (x: string, st: { uid: number; mode: number; isSymbolicLink(): boolean }) => {
    if (st.uid !== 0) fail(`not owned by root (${x} is owned by uid ${st.uid})`);
    if (!st.isSymbolicLink() && st.mode & 0o022) fail(`writable by group or other at ${x} (mode 0${(st.mode & 0o7777).toString(8)})`);
  };
  /** Every directory above `x`, up to the root. */
  const ancestors = (x: string) => {
    for (let d = path.posix.dirname(x); ; d = path.posix.dirname(d)) {
      owned(d, lstat(d));
      if (d === "/") return;
    }
  };
  if (!path.posix.isAbsolute(p)) fail("not an absolute path");
  owned(p, lstat(p)); // the file (or the link) itself, first: "missing" names the candidate
  ancestors(p);
  let real: string;
  try {
    real = fsApi.realpathSync(p);
  } catch (err) {
    return fail(`its target is ${statFailure(err)}`);
  }
  const st = lstat(real);
  if (!st.isFile()) fail(`not a regular file (${real})`);
  owned(real, st);
  if (real !== p) ancestors(real);
  return p;
}

/**
 * The absolute path of a system tool, validated, for this platform. Throws SystemBinaryError (named, with every reason)
 * when there is no trusted path: Windows, a missing or invalid SystemRoot or a missing exe; POSIX, no candidate passes
 * assertTrustedSystemFile (each candidate is named with why). `env`, `platform` and `fsApi` are seams for tests;
 * production passes none.
 */
export function systemBinary(
  name: SystemBinaryName,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
  fsApi: TrustFs = nodeFs,
): string {
  if (platform === "win32") return windowsBinary(name, env);
  const table = (POSIX_TOOLS as Record<string, Record<string, readonly string[]>>)[platform];
  const candidates = table?.[name];
  if (!candidates) {
    const why = name in WINDOWS_TOOLS ? "it is a Windows tool" : `it has no trusted system path on ${platform}`;
    throw new SystemBinaryError(`cannot locate the system ${name}: ${why} (this is ${platform}; SEC-22: never through PATH)`);
  }
  const rejected: string[] = [];
  for (const c of candidates) {
    try {
      return assertTrustedSystemFile(c, fsApi);
    } catch (err) {
      if (!(err instanceof SystemBinaryError)) throw err;
      rejected.push(err.message);
    }
  }
  const hostClass = platform === "linux" ? "no FHS system binary: NixOS/Guix-style host?" : `not at its ${platform} system path`;
  throw new SystemBinaryError(`cannot locate the system ${name}: ${rejected.join("; ")}; ${hostClass} (SEC-22: never through PATH)`);
}

/** SystemRoot, VALIDATED (drive-rooted, absolute): the one place both the exe path and the clean env take it from. */
function validSystemRoot(name: SystemBinaryName, env: Record<string, string | undefined>): string {
  // process.env is case-insensitive on Windows; a plain object (a test's env) is not.
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? Object.entries(env).find(([k]) => k.toLowerCase() === "systemroot")?.[1];
  if (!root || !/^[A-Za-z]:\\/.test(root) || !path.win32.isAbsolute(root)) {
    throw new SystemBinaryError(`cannot locate the system ${name}: SystemRoot invalid (${JSON.stringify(root ?? null)}; expected a drive-rooted path such as C:\\Windows)`);
  }
  return root;
}

function windowsBinary(name: SystemBinaryName, env: Record<string, string | undefined>): string {
  if (!(name in WINDOWS_TOOLS)) throw new SystemBinaryError(`cannot locate the system ${name}: it is not a Windows tool (SEC-22: never through PATH)`);
  const root = validSystemRoot(name, env);
  const exe = path.win32.join(root, ...WINDOWS_TOOLS[name as WindowsToolName]);
  let st: fs.Stats | undefined;
  try {
    st = fs.statSync(exe, { throwIfNoEntry: false });
  } catch {
    st = undefined;
  }
  if (!st || !st.isFile()) throw new SystemBinaryError(`cannot locate the system ${name}: ${exe} is not a regular file`);
  return exe;
}

/**
 * The CLEAN-BASE environment a system tool runs with (SEC-22 clause (ii), ruled 21 Oct): never the caller's env. The
 * class this closes is "a trusted binary resolving another program or options from the caller's env" (GNU tar's -z
 * finds gzip on PATH and reads TAR_OPTIONS; GZIP, the user's PATH and locale reach the same way), so NOTHING of the
 * caller's env is copied:
 *   - POSIX: PATH = this OS's trusted system directories only (the ones the tool map draws from), LC_ALL=C (ps and lsof
 *     output is parsed);
 *   - Windows: SystemRoot (the validated one systemBinary resolves with), and nothing else unless MEASURED as needed
 *     by a tool (WINDOWS_TOOL_ENV).
 * A call site that needs a variable NAMES it (`named`), and it is added on top: e.g. TZ for a start token, or the path
 * powershell reads through $env:. A named variable may not replace PATH (POSIX) or SystemRoot (Windows).
 */
export function systemEnv(
  name: SystemBinaryName,
  named: Readonly<Record<string, string>> = {},
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const base: Record<string, string> =
    platform === "win32"
      ? { SystemRoot: validSystemRoot(name, env), ...(WINDOWS_TOOL_ENV[name as WindowsToolName] ?? {}) }
      : { PATH: (platform === "darwin" ? DARWIN_PATH : FHS_DIRS).join(":"), LC_ALL: "C" };
  for (const k of Object.keys(named)) {
    if (k.toUpperCase() === "PATH" || k.toLowerCase() === "systemroot") throw new SystemBinaryError(`${k} cannot be named for ${name}: the clean base sets it (SEC-22)`);
  }
  return { ...base, ...named };
}

/** The darwin system directories (the SIP-protected ones the darwin map draws from). */
const DARWIN_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] as const;

/** Per Windows tool, any variable beyond SystemRoot it is MEASURED to need on windows-2022 (none so far). */
const WINDOWS_TOOL_ENV: Partial<Record<WindowsToolName, Record<string, string>>> = {};

/** Options a system tool may be given: never `env` (systemEnv builds it), never `shell`, never `argv0`. */
export type SystemSpawnOptions = Omit<SpawnSyncOptionsWithStringEncoding, "env" | "shell" | "argv0"> & { named?: Readonly<Record<string, string>> };

/**
 * Run a system tool by its TRUSTED ABSOLUTE PATH (systemBinary), never by name and never through a shell (a shell
 * finds programs by name), with the CLEAN-BASE env (systemEnv) and argv0 = the tool's name (a multi-call binary such as
 * BusyBox dispatches on it). A tool that cannot be located is a FAILED run carrying the named reason (status null, the
 * reason as stderr and as `error`), the same shape as a tool that fails to start, so every caller's existing failure
 * path handles it; never a fallback to PATH. The ONE place a SystemBinaryError becomes a failed spawnSync result.
 */
export function spawnSystem(name: SystemBinaryName, args: string[], opts: SystemSpawnOptions): SpawnSyncReturns<string> {
  const { named, ...rest } = opts;
  try {
    return spawnSync(systemBinary(name), args, { ...rest, env: systemEnv(name, named), argv0: name, shell: false });
  } catch (err) {
    if (!(err instanceof SystemBinaryError)) throw err;
    return { pid: 0, output: [], stdout: "", stderr: err.message, status: null, signal: null, error: err };
  }
}

/**
 * execFileSync's contract on spawnSystem's path (execFileSync itself takes no argv0): the same trusted path, clean-base
 * env and argv0. Returns stdout; THROWS when the tool cannot be located (the SystemBinaryError), fails to start or
 * times out (its error), or exits non-zero or on a signal (an Error naming the status and stderr), as execFileSync does.
 */
export function execSystem(name: SystemBinaryName, args: string[], opts: Omit<SystemSpawnOptions, "encoding"> = {}): string {
  const r = spawnSystem(name, args, { ...opts, encoding: "utf-8" });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw Object.assign(new Error(`${name} ${args.join(" ")} failed (status=${r.status}, signal=${r.signal}): ${(r.stderr ?? "").trim().slice(0, 500)}`), {
      status: r.status,
      signal: r.signal,
      stdout: r.stdout,
      stderr: r.stderr,
    });
  }
  return r.stdout ?? "";
}
