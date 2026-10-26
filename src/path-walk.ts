// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * THE path walk: where a path ACTUALLY lands, resolved the way the kernel resolves it, ONE component at a time. The
 * one implementation for every security check that has to know "which file is this really" (the SEC-22 system-binary
 * trust check, the config-write guard). Two copies of this rule drift (ADR-0015 L4), so do not write a third.
 *
 * WHY NOT path.resolve + realpath: path.resolve collapses `..` LEXICALLY, before any symlink is followed. With
 * `alias -> real/sub`, `alias/../x` is `real/x` to the kernel and `./x` to path.resolve. And realpath returns only the
 * END of the chain: it loses every link it passed through, so a check that must judge each hop cannot.
 *
 * THE CONTRACT:
 *   - Each component is lstat'ed. A symlink is followed by readlink: a relative target against the directory holding
 *     the link, an absolute one from its own root. POSIX: a `..` steps up from the REAL directory reached so far
 *     (open(2)); Windows: `..` is lexical (see WINDOWS).
 *   - At most `maxLinks` (40, Linux's MAXSYMLINKS) links are followed in one walk; one more is a "loop".
 *   - Every entry the walk passes through (each root, directory, link and file, including those inside a link's
 *     target) is returned in order, with where it led (`resolved`): a check judges every hop, not the endpoint.
 *   - Fail CLOSED with a named PathWalkError: "loop", "not-a-directory" (a component below a non-directory),
 *     "unreadable" (lstat or readlink failed for any reason but absence), "missing" (absent, when absence is not
 *     allowed), "unsupported" (a path form the walk does not resolve; see Windows).
 *   - MISSING TAIL (allowMissing): from the first absent component on, nothing can be a link, so the rest is taken
 *     lexically, where a create-the-parents writer would land; a `..` cancels a missing name, and one that climbs
 *     back out of the missing part resumes the real walk from the existing directory.
 *   - A trailing separator requires the path to end at a directory, as open(2) does, and so does a link TARGET ending
 *     in a separator. A `.` or `..` is LOOKED UP, the dot kept in the spelling, so a directory without search
 *     permission fails as the kernel fails ("unreadable"), never skipped over.
 *
 * WINDOWS (stated per form, not implied):
 *   - `..` is resolved LEXICALLY, before any junction or link is followed: the Win32 layer normalizes a path
 *     (GetFullPathName) before the filesystem sees it. MEASURED on windows-2022 (d727efc): reading `<junction>\..\x`
 *     returned the file beside the junction, not the one beside its target. So the walk normalizes a Windows path
 *     first, then walks it. A \\?\ path is not normalized by Windows, so one holding `.` or `..` is "unsupported".
 *   - A LINK TARGET is checked like the input (every rule here). Windows substitutes a relative target lexically
 *     against the link's directory, which no native test pins, so a target holding `.` or `..` is "unsupported":
 *     refused, never emulated.
 *   - A component whose meaning Win32 changes while \\?\ takes it literally is "unsupported", in the input and in a
 *     target: a trailing period or space (the Win32 API trims it, as Microsoft documents; node's own fs does NOT:
 *     MEASURED on windows-2022 (6e9cc36), reading `x.` through node is ENOENT; so two programs can disagree on what
 *     the same spelling opens, and the walk refuses it rather than pick one), a reserved device name
 *     (CON, NUL, COM1.txt ...), and `name:stream` (an alternate data stream of `name`).
 *   - A drive-absolute path (C:\x) and a UNC path (\\server\share\x) are walked. Junctions are followed exactly like
 *     symlinks: node's lstat reports a junction as a symbolic link and readlink returns its target.
 *   - A \\?\C:\ or \\?\UNC\server\share\ prefix (a link target may carry one) is rewritten to its plain form; any
 *     other device path (\\?\Volume{...}, \\.\) is "unsupported".
 *   - A drive-RELATIVE path (C:x) and a root-relative one (\x) are "unsupported": they depend on per-drive state.
 *   - An 8.3 short name (a component with ~<digit>, e.g. RUNNER~1) is expanded to its long name through the OS's own
 *     resolver (realpath.native: GetFinalPathNameByHandle), which must name an entry of the SAME directory, else
 *     "unsupported".
 *
 * COMPARING (comparePaths): THREE-valued, and no case rule is guessed. Two paths are walked (a missing tail allowed).
 *   - Their deepest EXISTING entries are different files (dev + inode) → "different". Whatever the volumes' case or
 *     normalization rules are, the kernel already applied them when it looked those names up.
 *   - The same file, and identical missing tails → "same".
 *   - The same file, and missing tails that differ ONLY by case or Unicode form → "inconclusive". Whether they would
 *     collide is decided by the directory they would be created in, and nothing here measures that (Codex #357 R1
 *     #2: a whole-path case probe answers wrong across a mount boundary). A security caller picks its own safe
 *     direction for "inconclusive" (a write guard treats it as protected).
 *   - Otherwise → "different".
 *   Two names for one file (a hard link) compare "same": the over-report direction.
 */
import fs from "fs";
import path from "path";

/** The stat fields the walk and its callers read. */
export interface WalkStat {
  uid: number;
  mode: number;
  dev: number;
  ino: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** The filesystem calls the walk makes: a seam for tests (a root-owned link, a UNC share or a junction cannot always be planted). */
export interface WalkFs {
  lstatSync(p: string): WalkStat;
  readlinkSync(p: string): string;
  /** The OS's own canonical spelling (Windows: expands 8.3 short names). Only called for a short-name component. */
  realpathNativeSync(p: string): string;
}

const nodeFs: WalkFs = {
  lstatSync: (p) => fs.lstatSync(p),
  readlinkSync: (p) => fs.readlinkSync(p),
  realpathNativeSync: (p) => fs.realpathSync.native(p),
};

export type PathWalkReason = "loop" | "not-a-directory" | "unreadable" | "missing" | "unsupported";

export class PathWalkError extends Error {
  constructor(
    readonly reason: PathWalkReason,
    /** The path (as the walk spelled it) where it stopped. */
    readonly at: string,
    detail: string,
  ) {
    super(`${at}: ${reason} (${detail})`);
    this.name = "PathWalkError";
  }
}

/** One entry the walk passed through: its spelling, its lstat, and the real path it led to. */
export interface WalkEntry {
  path: string;
  stat: WalkStat;
  /** For a link, where its whole target resolved to; for anything else, the entry itself. */
  resolved: string;
}

export interface WalkResult {
  /** Where the path lands. With a missing tail, the existing directory joined with the missing names. */
  real: string;
  /** The deepest EXISTING directory (or file) the walk reached: `real` without the missing names. */
  existing: string;
  /** Its lstat (never a link's): the identity (dev + ino) comparePaths judges by. */
  existingStat: WalkStat;
  /** The absent names after `existing`, in order (empty when the whole path exists). */
  missing: string[];
  /** Every entry passed through, in walk order, roots included. */
  entries: WalkEntry[];
}

export interface WalkOptions {
  fs?: WalkFs;
  platform?: NodeJS.Platform;
  /** The directory a relative path is taken from. Default process.cwd() (the physical working directory). */
  cwd?: string;
  /** Accept an absent tail (see MISSING TAIL). Default false: the first absent component is "missing". */
  allowMissing?: boolean;
  /** Default 40. */
  maxLinks?: number;
}

export const MAX_LINKS = 40;

const SHORT_NAME = /~\d/;

function pathApi(platform: NodeJS.Platform): typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

/** Rewrite a Windows \\?\ prefix to the plain form; any other device path is unsupported. */
function plainWindowsPath(p: string): string {
  const s = p.replace(/\//g, "\\");
  if (/^\\\\\?\\[A-Za-z]:\\/.test(s)) return s.slice(4);
  if (/^\\\\\?\\UNC\\/i.test(s)) return `\\\\${s.slice(8)}`;
  if (/^\\\\[?.]\\/.test(s)) throw new PathWalkError("unsupported", p, "a Windows device path other than \\\\?\\<drive>:\\ or \\\\?\\UNC\\");
  return s;
}

/** Win32 device names, which a Win32 path maps to the device whatever the directory or extension. */
const WIN_RESERVED = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(?:\.[^.]*)?$/i;

/**
 * A Windows component the walk will not walk: one whose meaning Win32 changes (a trailing period or space is trimmed,
 * a reserved name is a device, `name:stream` is an alternate data stream of `name`) while \\?\ takes it literally.
 * Native semantics are not pinned for any of them, so each FAILS CLOSED (Codex #357 R1 #3).
 */
function checkWindowsComponent(c: string, at: string): void {
  if (c === "." || c === "..") return;
  if (/[. ]$/.test(c)) throw new PathWalkError("unsupported", at, `the component ${JSON.stringify(c)} ends in a period or a space (the Win32 API trims it; node does not)`);
  if (c.includes(":")) throw new PathWalkError("unsupported", at, `the component ${JSON.stringify(c)} names an alternate data stream`);
  if (WIN_RESERVED.test(c)) throw new PathWalkError("unsupported", at, `the component ${JSON.stringify(c)} is a reserved device name`);
}

/** Split an ABSOLUTE path into its root and components. Windows: only a drive-absolute or UNC root. */
function splitRoot(p: string, platform: NodeJS.Platform): { root: string; parts: string[] } {
  if (platform !== "win32") {
    return { root: "/", parts: p.split("/").filter(Boolean) };
  }
  const s = plainWindowsPath(p);
  const { root } = path.win32.parse(s);
  const drive = /^[A-Za-z]:\\$/.test(root);
  const unc = /^\\\\[^\\]+\\[^\\]+\\?$/.test(root);
  if (!drive && !unc) {
    throw new PathWalkError("unsupported", p, "a drive-relative or root-relative Windows path: it depends on per-drive state");
  }
  const normRoot = drive ? `${root[0].toUpperCase()}:\\` : root.endsWith("\\") ? root : `${root}\\`;
  const parts = s.slice(root.length).split(/\\+/).filter(Boolean);
  for (const c of parts) checkWindowsComponent(c, p);
  return { root: normRoot, parts };
}

/** A \\?\ path is passed to the filesystem unnormalized: one holding `.` or `..` is unsupported. */
function refuseExtendedDots(p: string, at: string): void {
  if (/^\\\\[?.]\\/.test(p.replace(/\//g, "\\")) && /(?:^|[\\/])\.\.?(?:[\\/]|$)/.test(p.slice(4))) {
    throw new PathWalkError("unsupported", at, "a \\\\?\\ path holding . or ..: Windows passes it to the filesystem unnormalized");
  }
}

function isAbsoluteFor(p: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return p.startsWith("/");
  return path.win32.isAbsolute(p);
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException)?.code;
}

type Token = string | { end: number };

/**
 * Walk `p` to where it lands (see THE CONTRACT). Throws PathWalkError, never a raw fs error.
 */
export function walkPath(p: string, opts: WalkOptions = {}): WalkResult {
  const platform = opts.platform ?? process.platform;
  const fsApi = opts.fs ?? nodeFs;
  const maxLinks = opts.maxLinks ?? MAX_LINKS;
  const P = pathApi(platform);
  if (typeof p !== "string" || p.length === 0 || p.includes("\0")) {
    throw new PathWalkError("unsupported", String(p), "not a non-empty path string");
  }
  if (platform === "win32" && /^[A-Za-z]:(?![\\/])/.test(p)) {
    throw new PathWalkError("unsupported", p, "a drive-relative Windows path: it depends on per-drive state");
  }
  // POSIX: never normalized first, `..` is resolved against the real directory reached so far. Windows: normalized
  // LEXICALLY first, because that is what the OS does (see WINDOWS).
  let abs = isAbsoluteFor(p, platform) ? p : `${opts.cwd ?? process.cwd()}${P.sep}${p}`;
  if (platform === "win32") {
    refuseExtendedDots(abs, p);
    abs = path.win32.normalize(abs);
  }
  const trailingSep = platform === "win32" ? /[\\/]$/.test(abs) : abs.endsWith("/");

  const entries: WalkEntry[] = [];
  const lstat = (at: string): WalkStat | null => {
    try {
      return fsApi.lstatSync(at);
    } catch (err) {
      const code = errCode(err);
      if (code === "ENOENT") return null;
      if (code === "ENOTDIR") throw new PathWalkError("not-a-directory", at, "a component below a non-directory");
      throw new PathWalkError("unreadable", at, `lstat failed: ${code ?? (err as Error)?.message ?? "unknown error"}`);
    }
  };
  let curStat: WalkStat | undefined;
  const enterRoot = (root: string): string => {
    const st = lstat(root);
    if (!st) throw new PathWalkError("missing", root, "the root does not exist");
    entries.push({ path: root, stat: st, resolved: root });
    curStat = st;
    return root;
  };
  /** Look up a `.` or `..` in `cur` for real, the dot kept in the spelling: it needs search permission (Codex #357 R1 #5). */
  const lookDot = (dot: "." | ".."): WalkStat => {
    const spelled = cur.endsWith(P.sep) ? `${cur}${dot}` : `${cur}${P.sep}${dot}`;
    const st = lstat(spelled);
    if (!st) throw new PathWalkError("unreadable", spelled, "a dot lookup found nothing");
    return st;
  };

  const { root, parts } = splitRoot(abs, platform);
  let cur = enterRoot(root);
  let curIsDir = true;
  const missing: string[] = [];
  let links = 0;
  // A stack: the next component is popped from the end. A link's target is pushed in front of the rest, followed by
  // an end marker that records where the whole target resolved to.
  const stack: Token[] = parts.slice().reverse();
  if (trailingSep && parts.length) stack.unshift(".");

  const here = () => (missing.length ? P.join(cur, ...missing) : cur);

  while (stack.length) {
    const t = stack.pop() as Token;
    if (typeof t !== "string") {
      entries[t.end].resolved = here();
      continue;
    }
    if (missing.length) {
      // Below an absent name: nothing exists, nothing is a link.
      if (t === ".") continue;
      if (t === "..") missing.pop();
      else missing.push(t);
      continue;
    }
    if (!curIsDir) throw new PathWalkError("not-a-directory", cur, `"${t}" follows a non-directory`);
    if (t === ".") {
      curStat = lookDot(".");
      continue;
    }
    if (t === "..") {
      curStat = lookDot("..");
      cur = P.dirname(cur); // cur is real, so this is the PHYSICAL parent (the root's parent is the root)
      continue;
    }
    let entry = P.join(cur, t);
    const st = lstat(entry);
    if (!st) {
      if (!opts.allowMissing) throw new PathWalkError("missing", entry, "does not exist");
      missing.push(t);
      continue;
    }
    if (st.isSymbolicLink()) {
      if (++links > maxLinks) throw new PathWalkError("loop", entry, `more than ${maxLinks} symbolic links`);
      let target: string;
      try {
        target = fsApi.readlinkSync(entry);
      } catch (err) {
        throw new PathWalkError("unreadable", entry, `readlink failed: ${errCode(err) ?? (err as Error)?.message ?? "unknown error"}`);
      }
      const index = entries.push({ path: entry, stat: st, resolved: "" }) - 1;
      stack.push({ end: index });
      // A target ending in a separator must reach a directory (POSIX ENOTDIR; Codex #357 R1 #4): a "." looked up
      // after its last component, before its end marker.
      if (platform === "win32" ? /[\\/]$/.test(target) : target.endsWith("/")) stack.push(".");
      let tparts: string[];
      if (isAbsoluteFor(target, platform)) {
        if (platform === "win32" && /^[\\/](?![\\/])/.test(target)) {
          throw new PathWalkError("unsupported", entry, "a root-relative Windows link target");
        }
        if (platform === "win32") refuseExtendedDots(target, entry);
        const split = splitRoot(target, platform);
        cur = enterRoot(split.root);
        curIsDir = true;
        tparts = split.parts;
      } else {
        if (platform === "win32" && /^[A-Za-z]:/.test(target)) {
          throw new PathWalkError("unsupported", entry, "a drive-relative Windows link target");
        }
        tparts = target.split(platform === "win32" ? /[\\/]+/ : /\/+/).filter(Boolean);
        if (platform === "win32") for (const c of tparts) checkWindowsComponent(c, entry);
      }
      // Windows substitutes a relative target LEXICALLY against the link's directory; no native test here pins that,
      // so a Windows target holding `.` or `..` is refused, never emulated (Codex #357 R1 #1).
      if (platform === "win32" && tparts.some((c) => c === "." || c === "..")) {
        throw new PathWalkError("unsupported", entry, "a Windows link target holding . or .. (its substitution is not measured)");
      }
      for (let i = tparts.length - 1; i >= 0; i--) stack.push(tparts[i]);
      continue;
    }
    if (platform === "win32" && SHORT_NAME.test(t)) {
      let long: string;
      try {
        long = plainWindowsPath(fsApi.realpathNativeSync(entry));
      } catch (err) {
        if (err instanceof PathWalkError) throw err;
        throw new PathWalkError("unsupported", entry, `an 8.3 short name the OS could not expand: ${errCode(err) ?? "unknown error"}`);
      }
      if (path.win32.dirname(long).toLowerCase() !== cur.toLowerCase()) {
        throw new PathWalkError("unsupported", entry, `an 8.3 short name that expands outside its directory (${long})`);
      }
      entry = path.win32.join(cur, path.win32.basename(long));
    }
    entries.push({ path: entry, stat: st, resolved: entry });
    cur = entry;
    curStat = st;
    curIsDir = st.isDirectory();
  }
  return { real: here(), existing: cur, existingStat: curStat as WalkStat, missing: missing.slice(), entries };
}

export type Comparison = "same" | "different" | "inconclusive";

const fold = (s: string) => s.normalize("NFC").toLowerCase();

/**
 * Do two paths land on the same file? THREE-valued (see COMPARING): "same" / "different" / "inconclusive". Each walk
 * allows a missing tail; every other walk failure throws.
 */
export function comparePaths(a: string, b: string, opts: Omit<WalkOptions, "allowMissing"> = {}): Comparison {
  const wa = walkPath(a, { ...opts, allowMissing: true });
  const wb = walkPath(b, { ...opts, allowMissing: true });
  if (wa.existingStat.dev !== wb.existingStat.dev || wa.existingStat.ino !== wb.existingStat.ino) return "different";
  if (wa.missing.length !== wb.missing.length) return "different";
  let inconclusive = false;
  for (let i = 0; i < wa.missing.length; i++) {
    if (wa.missing[i] === wb.missing[i]) continue;
    if (fold(wa.missing[i]) !== fold(wb.missing[i])) return "different";
    inconclusive = true; // equal but for case or Unicode form: whether they collide is the directory's, unmeasured
  }
  return inconclusive ? "inconclusive" : "same";
}
