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
 * pre-plant a component there. When the walk TOUCHES a shared root at any point
 * (ssh StrictModes style), EVERY component it traversed, before and after the
 * shared root, each symlink itself and every component on a link's target side,
 * the file included, must be owned by the current uid or root and (except a
 * symlink, whose mode bits mean nothing) not group- or other-writable, and the
 * shared root itself must carry the sticky bit; otherwise the path is refused. A
 * walk that never touches a shared root (the home directory, /var/folders) is
 * unaffected. Threat model: accidental faults,
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

/** One component the walk passed through: where it sits (canonical parent) and its lstat. */
interface Traversed {
  path: string;
  st: fs.Stats;
}

/**
 * Why the walk fails the shared-root ownership rule, or null when it passes or
 * never touched a shared root. Judged on the lstat the walk itself took of each
 * component (one observation per component).
 */
function sharedRootFault(traversed: Traversed[]): string | null {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === null) return null; // no POSIX ownership model (Windows)
  const shared = sharedRootsReal();
  const isRoot = (p: string) => shared.includes(p);
  const touched = traversed.some((t) => isRoot(t.path) || shared.some((r) => t.path.startsWith(r + path.sep)));
  if (!touched) return null;
  for (const { path: p, st } of traversed) {
    if (isRoot(p)) {
      if (!(st.mode & 0o1000)) {
        return `${p} is a shared directory without the sticky bit: another user could replace your files there. Use a path under your home directory.`;
      }
      continue;
    }
    if (st.uid !== uid && st.uid !== 0) {
      return `${p} is owned by uid ${st.uid}, not you (uid ${uid}): on a path through a shared directory, another user could control it. Use a path under your home directory.`;
    }
    if (!st.isSymbolicLink() && st.mode & 0o022) {
      return `${p} is group- or other-writable (mode 0${(st.mode & 0o777).toString(8)}): on a path through a shared directory, another user could replace it. Remove that write permission, or use a path under your home directory.`;
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

type Placed = { ok: true; realPath: string; exists: boolean; traversed: Traversed[] } | { ok: false; reason: string };

/** Where the kernel would put `absPath`: the walk described at the top of this file. */
function placeReal(absPath: string): Placed {
  const why = (err: unknown) => (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err));
  const parts = (p: string) => p.split(path.sep).filter((c) => c !== "");
  let cur = path.parse(absPath).root;
  const queue = parts(absPath.slice(cur.length));
  const traversed: Traversed[] = [];
  let hops = 0;
  while (queue.length) {
    const c = queue.shift() as string;
    if (c === ".") continue;
    if (c === "..") {
      cur = path.dirname(cur); // cur is already real, so its parent is the kernel's `..`
      continue;
    }
    const next = path.join(cur, c);
    // Every component is lstat'ed HERE, so a symlink is seen as itself (the
    // ownership rule judges the link, not only where it leads).
    let st: fs.Stats;
    try {
      st = fs.lstatSync(next);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, reason: `cannot inspect ${next} (${why(err)})` };
      // A POSITIVE absence: the missing tail lands under the real prefix.
      const rest = [c, ...queue].filter((x) => x !== ".");
      if (rest.includes("..")) return { ok: false, reason: `cannot place ${absPath}: a ".." follows the missing component ${next}` };
      return { ok: true, realPath: path.join(cur, ...rest), exists: false, traversed };
    }
    if (st.isSymbolicLink()) {
      traversed.push({ path: next, st });
      if (++hops > MAX_SYMLINK_HOPS) return { ok: false, reason: `cannot resolve ${absPath} (ELOOP: more than ${MAX_SYMLINK_HOPS} symlinks)` };
      let target: string;
      try {
        target = fs.readlinkSync(next);
      } catch (err) {
        return { ok: false, reason: `cannot read the symlink ${next} (${why(err)})` };
      }
      // A symlink (dangling or not) is followed in kernel order: its target is
      // spliced into the walk, never collapsed lexically.
      if (path.isAbsolute(target)) cur = path.parse(target).root;
      queue.unshift(...parts(target));
      continue;
    }
    // A real component. cur is symlink-free, so the kernel's realpath only
    // canonicalises its spelling (the on-disk CASE on a case-insensitive volume).
    try {
      cur = fs.realpathSync.native(next);
    } catch (err) {
      return { ok: false, reason: `cannot resolve ${next} (${why(err)})` };
    }
    traversed.push({ path: cur, st });
  }
  return { ok: true, realPath: cur, exists: true, traversed };
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
  const shared = sharedRootFault(placed.traversed);
  if (shared) return { ok: false, reason: shared };
  return { ok: true, absPath, realPath, exists };
}
