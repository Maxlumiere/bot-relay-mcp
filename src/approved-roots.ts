// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0048 — the ONE approved-roots containment rule. The instance resolver, the
 * daemon's post-open re-check, backup destinations and config validation all use
 * it; the roots list exists nowhere else (a tripwire test holds that).
 *
 * The rule, on REAL paths (a symlinked parent cannot escape it):
 *   1. lexical normalisation of the INPUT first (path.resolve): no `.` or `..`
 *      survives in the path the caller will open;
 *   2. walk it DOWN one component at a time from the filesystem root, each prefix
 *      through the kernel's realpath (`realpathSync.native`, which also returns
 *      the on-disk CASE, so a case-insensitive volume compares correctly);
 *   3. a component that is ENOENT to realpath but EXISTS to lstat is a dangling
 *      SYMLINK, never an absence: its target is spliced into the walk (kernel
 *      order, no lexical `..` collapse; at most 40 hops), so a link to a missing
 *      file OUTSIDE the roots is judged by where a create would land;
 *   4. only an lstat ENOENT is an absence: the missing tail is appended to the
 *      real prefix (a `..` after it is refused, it cannot be placed);
 *   5. any other error (EACCES, EIO, ELOOP, ENOTDIR) is a failure, never a guess;
 *   6. the result must sit under the realpath of an approved root (the home
 *      directory, /tmp, /private/tmp, /var/folders; on macOS /tmp and /var are
 *      themselves symlinks).
 * `exists` is a POSITIVE fact from the same walk: true only when every component
 * resolved; any other error is a failure.
 *
 * SHARED roots (/tmp, /private/tmp) are world-writable, so another local user can
 * pre-plant a component there. Below a shared root (ssh StrictModes style) the
 * root must carry the sticky bit, and every EXISTING component, the file
 * included, must be owned by the current uid or root and not group- or
 * other-writable; otherwise the path is refused. The per-user roots (the home
 * directory, /var/folders) are unaffected. Threat model: accidental faults,
 * misconfiguration and CROSS-USER interference are in scope; a same-user
 * adversary racing the daemon is not.
 */
import fs from "fs";
import os from "os";
import path from "path";

/** The world-writable approved roots, before realpath (subject to the ownership rule). */
const SHARED_ROOT_BASES = ["/tmp", "/private/tmp"];

/** The approved roots, before realpath. The ONLY place this list is written. */
function approvedRootBases(): string[] {
  return [os.homedir(), ...SHARED_ROOT_BASES, "/var/folders"];
}

/** The shared roots as REAL paths (on macOS /tmp is /private/tmp). */
function sharedRootsReal(): string[] {
  const out = new Set<string>();
  for (const base of SHARED_ROOT_BASES) {
    try {
      out.add(fs.realpathSync.native(base));
    } catch {
      /* absent on this machine */
    }
  }
  return [...out];
}

/**
 * Why `realPath` (a real path under an approved root) fails the shared-root
 * ownership rule, or null when it passes or is not below a shared root. Every
 * stat fault is a failure, never assumed safe.
 */
function sharedRootFault(realPath: string): string | null {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === null) return null; // no POSIX ownership model (Windows)
  const root = sharedRootsReal().find((r) => realPath.startsWith(r + path.sep));
  if (!root) return null;
  const inspect = (p: string): fs.Stats | "absent" | string => {
    try {
      return fs.lstatSync(p);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return code === "ENOENT" ? "absent" : `cannot inspect ${p} (${code ?? String(err)})`;
    }
  };
  const rootSt = inspect(root);
  if (typeof rootSt === "string") return rootSt === "absent" ? `the shared directory ${root} is missing` : rootSt;
  if (!(rootSt.mode & 0o1000)) {
    return `${root} is a shared directory without the sticky bit: another user could replace your files there. Use a path under your home directory.`;
  }
  let cur = root;
  for (const part of realPath.slice(root.length + 1).split(path.sep)) {
    cur = path.join(cur, part);
    const st = inspect(cur);
    if (st === "absent") break; // the rest does not exist yet: created by you
    if (typeof st === "string") return st;
    if (st.isSymbolicLink()) return `${cur} changed into a symlink while it was being checked`;
    if (st.uid !== uid && st.uid !== 0) {
      return `${cur} is owned by uid ${st.uid}, not you (uid ${uid}): under the shared ${root}, another user could control it. Use a path under your home directory.`;
    }
    if (st.mode & 0o022) {
      return `${cur} is group- or other-writable (mode 0${(st.mode & 0o777).toString(8)}): under the shared ${root}, another user could replace it. Remove that write permission, or use a path under your home directory.`;
    }
  }
  return null;
}

/** The approved roots as REAL paths (a root that does not exist is skipped). */
export function approvedRootsReal(): string[] {
  const out = new Set<string>();
  for (const base of approvedRootBases()) {
    try {
      out.add(fs.realpathSync.native(path.resolve(base)));
    } catch {
      /* a root that does not exist on this machine contains nothing */
    }
  }
  return [...out];
}

/** True when `realPath` (already a realpath) is an approved root or inside one. */
export function isUnderApprovedRoot(realPath: string): boolean {
  return approvedRootsReal().some((root) => realPath === root || realPath.startsWith(root + path.sep));
}

export type Containment =
  | { ok: true; absPath: string; realPath: string; exists: boolean }
  | { ok: false; reason: string };

/** At most this many symlink hops in one walk (the kernel's own MAXSYMLINKS order). */
const MAX_SYMLINK_HOPS = 40;

type Placed = { ok: true; realPath: string; exists: boolean } | { ok: false; reason: string };

/** Where the kernel would put `absPath`: the walk described at the top of this file. */
function placeReal(absPath: string): Placed {
  const why = (err: unknown) => (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err));
  const parts = (p: string) => p.split(path.sep).filter((c) => c !== "");
  let cur = path.parse(absPath).root;
  const queue = parts(absPath.slice(cur.length));
  let hops = 0;
  while (queue.length) {
    const c = queue.shift() as string;
    if (c === ".") continue;
    if (c === "..") {
      cur = path.dirname(cur); // cur is already real, so its parent is the kernel's `..`
      continue;
    }
    const next = path.join(cur, c);
    try {
      cur = fs.realpathSync.native(next);
      continue;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, reason: `cannot resolve ${next} (${why(err)})` };
    }
    let st: fs.Stats;
    try {
      st = fs.lstatSync(next);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, reason: `cannot inspect ${next} (${why(err)})` };
      // A POSITIVE absence: the missing tail lands under the real prefix.
      const rest = [c, ...queue].filter((x) => x !== ".");
      if (rest.includes("..")) return { ok: false, reason: `cannot place ${absPath}: a ".." follows the missing component ${next}` };
      return { ok: true, realPath: path.join(cur, ...rest), exists: false };
    }
    if (!st.isSymbolicLink()) return { ok: false, reason: `cannot resolve ${next} (ENOENT on an existing non-symlink)` };
    if (++hops > MAX_SYMLINK_HOPS) return { ok: false, reason: `cannot resolve ${absPath} (ELOOP: more than ${MAX_SYMLINK_HOPS} symlinks)` };
    let target: string;
    try {
      target = fs.readlinkSync(next);
    } catch (err) {
      return { ok: false, reason: `cannot read the symlink ${next} (${why(err)})` };
    }
    // A dangling symlink is NOT an absence: follow its target, in kernel order.
    if (path.isAbsolute(target)) cur = path.parse(target).root;
    queue.unshift(...parts(target));
  }
  return { ok: true, realPath: cur, exists: true };
}

/**
 * Containment of `p` on real paths, plus whether it exists. Never throws.
 */
export function checkContainment(p: string): Containment {
  const absPath = path.resolve(p);
  const placed = placeReal(absPath);
  if (!placed.ok) return placed;
  const { realPath, exists } = placed;
  if (!isUnderApprovedRoot(realPath)) {
    return {
      ok: false,
      reason:
        `${absPath} resolves to ${realPath}, which is outside the approved roots (${approvedRootsReal().join(", ")}). ` +
        `Use a path under your home directory or a temp directory.`,
    };
  }
  const shared = sharedRootFault(realPath);
  if (shared) return { ok: false, reason: shared };
  return { ok: true, absPath, realPath, exists };
}
