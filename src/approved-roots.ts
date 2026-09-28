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
 */
import fs from "fs";
import os from "os";
import path from "path";

/** The approved roots, before realpath. The ONLY place this list is written. */
function approvedRootBases(): string[] {
  return [os.homedir(), "/tmp", "/private/tmp", "/var/folders"];
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
  return { ok: true, absPath, realPath, exists };
}
