// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0047 — the identity of the installed DEPENDENCIES, and this process's
 * snapshot of it, taken when the process starts.
 *
 * THE DEPS ID: the sha256 of
 *   - the bytes of npm's own installed-tree record, node_modules/.package-lock.json
 *     (npm rewrites it on every install, update or removal), and
 *   - the content of EVERY native addon (*.node) under node_modules, found by a
 *     walk that follows symlinks (a cycle, a dangling link or an unreadable entry
 *     is an error): `npm rebuild` changes an addon with no record change.
 * States: KNOWN; UNKNOWN when there is no .package-lock.json (yarn, pnpm, a copied
 * tree: only npm installs are supported, and an unknown install fails the deploy
 * check); ERROR (INCONSISTENT) when the record is not a JSON object or the walk
 * fails. Never throws.
 *
 * THE SNAPSHOT is taken when this module is EVALUATED, and dist/index.js imports
 * it FIRST (ESM evaluates static imports in source order), so a long-lived process
 * (a stdio connector, the daemon) records its dependencies before any of them is
 * loaded. This module imports only node: builtins, so nothing is loaded before it
 * (tests hold both). Known limit, in the safe direction: a native addon loaded
 * lazily later (better-sqlite3 on first DB use) that changed on disk after the
 * snapshot reads STALE, never current. An npm version that reformats an identical
 * tree's record also reads STALE (conservative, accepted).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export type DepsResult =
  | { state: "known"; id: string }
  | { state: "unknown"; reason: string }
  | { state: "error"; reason: string };

const sha256 = (data: string | Buffer): string => crypto.createHash("sha256").update(data).digest("hex");
const why = (err: unknown): string => (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err));

/** The deps id of the install at `installDir` (see the top of this file). Never throws. */
export function computeDepsId(installDir: string): DepsResult {
  const nm = path.join(installDir, "node_modules");
  const recordPath = path.join(nm, ".package-lock.json");
  let record: Buffer;
  try {
    record = fs.readFileSync(recordPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "unknown", reason: `no npm installed-tree record (${recordPath}): only npm installs are supported` };
    }
    return { state: "error", reason: `cannot read ${recordPath} (${why(err)})` };
  }
  try {
    const parsed: unknown = JSON.parse(record.toString("utf-8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { state: "error", reason: `${recordPath} is not a JSON object` };
    }
  } catch {
    return { state: "error", reason: `${recordPath} is not valid JSON` };
  }
  const lines: string[] = [`.package-lock.json\0${sha256(record)}\n`];
  const onPath: string[] = []; // the real directories on the current walk path (a revisit here is a cycle)
  const done = new Set<string>(); // real directories already walked (a revisit elsewhere is a dedupe)
  const walk = (dir: string, rel: string): string | null => {
    let real: string;
    try {
      real = fs.realpathSync(dir);
    } catch (err) {
      return `cannot resolve ${dir} (${why(err)})`;
    }
    if (onPath.includes(real)) return `a symlink cycle at ${dir}`;
    if (done.has(real)) return null;
    done.add(real);
    onPath.push(real);
    let names: string[];
    try {
      names = fs.readdirSync(dir).sort();
    } catch (err) {
      onPath.pop();
      return `cannot list ${dir} (${why(err)})`;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      let st: fs.Stats;
      try {
        st = fs.statSync(full); // follows symlinks: a dangling one is an error
      } catch (err) {
        onPath.pop();
        return `cannot read ${full} (${why(err)})`;
      }
      if (st.isDirectory()) {
        const e = walk(full, r);
        if (e) {
          onPath.pop();
          return e;
        }
      } else if (st.isFile() && name.endsWith(".node")) {
        try {
          lines.push(`${r}\0${sha256(fs.readFileSync(full))}\n`);
        } catch (err) {
          onPath.pop();
          return `cannot read ${full} (${why(err)})`;
        }
      }
    }
    onPath.pop();
    return null;
  };
  const err = walk(nm, "");
  if (err) return { state: "error", reason: err };
  lines.sort();
  return { state: "known", id: sha256(lines.join("")) };
}

function ownInstallDir(): string {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

/** THIS process's dependencies, as installed when it started (evaluated eagerly, first). */
export const DEPS_SNAPSHOT: DepsResult = computeDepsId(ownInstallDir());
