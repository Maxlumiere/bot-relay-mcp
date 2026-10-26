// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * RED STAND-IN (replaced by the fix commit): the repo's CURRENT canonicalization, src/cli/config-merge.ts canonicalize()
 * verbatim (path.resolve, then realpath the deepest existing ancestor, then re-append the tail), behind the API the walk
 * will have. tests/path-walk.test.ts states the walk's contract; this shows today's canonicalization does not meet it.
 * No production code imports this module.
 */
import fs from "fs";
import path from "path";

export interface WalkStat {
  uid: number;
  mode: number;
  dev: number;
  ino: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}
export interface WalkFs {
  lstatSync(p: string): WalkStat;
  readlinkSync(p: string): string;
  realpathNativeSync(p: string): string;
}
export type PathWalkReason = "loop" | "not-a-directory" | "unreadable" | "missing" | "unsupported";
export class PathWalkError extends Error {
  constructor(
    readonly reason: PathWalkReason,
    readonly at: string,
    detail: string,
  ) {
    super(`${at}: ${reason} (${detail})`);
    this.name = "PathWalkError";
  }
}
export interface WalkEntry {
  path: string;
  stat: WalkStat;
  resolved: string;
}
export interface WalkResult {
  real: string;
  existing: string;
  missing: string[];
  entries: WalkEntry[];
}
export interface WalkOptions {
  fs?: WalkFs;
  platform?: NodeJS.Platform;
  cwd?: string;
  allowMissing?: boolean;
  maxLinks?: number;
}
export const MAX_LINKS = 40;

/** config-merge.ts canonicalize(), verbatim. */
function canonicalize(p: string): string {
  let base = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(base);
      return tail.length ? path.join(real, ...tail.slice().reverse()) : real;
    } catch {
      const parent = path.dirname(base);
      if (parent === base) return path.resolve(p); // nothing on the path exists
      tail.push(path.basename(base));
      base = parent;
    }
  }
}

export function walkPath(p: string, _opts: WalkOptions = {}): WalkResult {
  const real = canonicalize(p);
  return { real, existing: real, missing: [], entries: [] };
}

export function caseInsensitiveAt(_dir: string, _fsApi?: WalkFs): boolean {
  return false;
}

export interface PathKey {
  real: string;
  folded: boolean;
  key: string;
}
export function pathKey(p: string, opts: Omit<WalkOptions, "allowMissing"> = {}): PathKey {
  const real = walkPath(p, opts).real;
  return { real, folded: false, key: real };
}
export function sameKey(a: PathKey, b: PathKey): boolean {
  return a.key === b.key;
}
export function samePath(a: string, b: string, opts: Omit<WalkOptions, "allowMissing"> = {}): boolean {
  return sameKey(pathKey(a, opts), pathKey(b, opts));
}
