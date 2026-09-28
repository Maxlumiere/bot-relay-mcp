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
 *   1. lexical normalisation first (path.resolve): no `.` or `..` survives;
 *   2. walk up to the deepest EXISTING ancestor, climbing ONLY on ENOENT; any
 *      other error (EACCES, EIO, ELOOP, ENOTDIR) is a failure, never a guess;
 *   3. realpath(that ancestor) + the remaining segments must sit under the
 *      realpath of an approved root (the home directory, /tmp, /private/tmp,
 *      /var/folders; on macOS /tmp and /var are themselves symlinks).
 * `exists` is a POSITIVE fact from the same walk: true only when the full path
 * itself resolved; ENOENT on it is false; any other error is a failure.
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
      out.add(fs.realpathSync(path.resolve(base)));
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

/**
 * Containment of `p` on real paths, plus whether it exists. Never throws.
 */
export function checkContainment(p: string): Containment {
  const absPath = path.resolve(p);
  const rest: string[] = [];
  let cur = absPath;
  let real: string | null = null;
  for (;;) {
    try {
      real = fs.realpathSync(cur);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        return { ok: false, reason: `cannot resolve ${cur} (${code ?? (err instanceof Error ? err.message : String(err))})` };
      }
      const parent = path.dirname(cur);
      if (parent === cur) return { ok: false, reason: `no existing ancestor of ${absPath}` };
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
  const realPath = rest.length ? path.join(real, ...rest) : real;
  if (!isUnderApprovedRoot(realPath)) {
    return {
      ok: false,
      reason:
        `${absPath} resolves to ${realPath}, which is outside the approved roots (${approvedRootsReal().join(", ")}). ` +
        `Use a path under your home directory or a temp directory.`,
    };
  }
  return { ok: true, absPath, realPath, exists: rest.length === 0 };
}
