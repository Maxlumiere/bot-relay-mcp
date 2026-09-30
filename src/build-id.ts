// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0047 — the identity of a BUILD, from its content.
 *
 * `build_id` is the sha256 of the sorted list of (relative path, sha256 of the
 * bytes) of every regular file under an install's `dist/`, except the stamp files
 * (`dist/build-info.*`, which cannot hash themselves). The dependency lock is in
 * it through `dist/.build-lock` (the lock's sha256, written by the build step), so
 * an install that ships no lock, like one from the npm registry, still has one
 * well-defined id. An identical-output rebuild gives the same id: it is not a
 * deploy.
 *
 * ONE implementation: the build step (scripts/write-build-info.mjs) stamps with
 * the compiled form of this file, and a render-time check recomputes with it, so
 * the two cannot drift. It is NEVER used to answer "what am I running": a process
 * reports the stamp it loaded (build-info.ts), and this module only says what an
 * install on disk now holds.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** The stamp files: `dist/build-info.js` and what tsc emits beside it. */
const STAMP_FILE = /^build-info\./;
/** The value the unstamped placeholder carries: never equal to any build. */
export const UNBUILT = "unbuilt";

const sha256 = (data: string | Buffer): string => crypto.createHash("sha256").update(data).digest("hex");
const why = (err: unknown): string => (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err));

export type BuildIdResult = { ok: true; build_id: string } | { ok: false; reason: string };

/** The content hash of `distDir` (see the top of this file). Never throws. */
export function computeBuildId(distDir: string): BuildIdResult {
  const entries: string[] = [];
  const walk = (dir: string, rel: string): string | null => {
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return `cannot list ${dir} (${why(err)})`;
    }
    for (const d of names) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        const e = walk(full, r);
        if (e) return e;
      } else if (d.isFile()) {
        if (!rel && STAMP_FILE.test(d.name)) continue;
        try {
          entries.push(`${r}\0${sha256(fs.readFileSync(full))}\n`);
        } catch (err) {
          return `cannot read ${full} (${why(err)})`;
        }
      } else {
        // A symlink (or anything else) is content the build does not own: refused, never followed.
        return `${full} is not a regular file or directory`;
      }
    }
    return null;
  };
  const err = walk(distDir, "");
  if (err) return { ok: false, reason: err };
  if (entries.length === 0) return { ok: false, reason: `${distDir} holds no build` };
  entries.sort();
  return { ok: true, build_id: sha256(entries.join("")) };
}

/** sha256 of `installDir/package-lock.json`, or null when the install ships none. Throws on any other read error. */
export function lockDigest(installDir: string): string | null {
  try {
    return sha256(fs.readFileSync(path.join(installDir, "package-lock.json")));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** The build_id an install's stamp file names on disk (the loaded value is build-info.ts, never this). */
function readStampedId(installDir: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(installDir, "dist", "build-info.js"), "utf-8");
  } catch {
    return null;
  }
  const m = /["']?build_id["']?\s*:\s*["']([^"']*)["']/.exec(text);
  return m ? m[1] : null;
}

export interface InstallCheck {
  /** True only when the stamp equals the content AND (when the install ships a lock) the lock is the one built against. */
  consistent: boolean;
  /** The build_id the stamp on disk names (UNBUILT for the placeholder), or null when there is none. */
  stamped: string | null;
  /** The recomputed content hash, or null when the content could not be read. */
  content: string | null;
  reason: string;
}

/**
 * What an install on disk holds, recomputed from its CONTENT: the reference a
 * running process is compared with. Never throws. Inconsistent (always with a
 * remedy) when the stamp does not match the content (a tsc-only rebuild, a hand
 * edit, no stamp) or the shipped lock changed since the build.
 */
export function checkInstall(installDir: string): InstallCheck {
  const content = computeBuildId(path.join(installDir, "dist"));
  const stamped = readStampedId(installDir);
  if (!content.ok) return { consistent: false, stamped, content: null, reason: `the install's content cannot be read: ${content.reason}` };
  const fail = (reason: string): InstallCheck => ({ consistent: false, stamped, content: content.build_id, reason: `${reason}: rebuild with npm run build` });
  if (stamped === null) return fail(`${installDir} has no build stamp`);
  if (stamped !== content.build_id) {
    return fail(`the build stamp (${stamped.slice(0, 12)}) does not match the content (${content.build_id.slice(0, 12)})`);
  }
  let lock: string | null;
  try {
    lock = lockDigest(installDir);
  } catch (err) {
    return fail(`the dependency lock cannot be read (${why(err)})`);
  }
  if (lock !== null) {
    let built = "";
    try {
      built = fs.readFileSync(path.join(installDir, "dist", ".build-lock"), "utf-8").trim();
    } catch {
      /* no record of the lock the build used */
    }
    if (built !== lock) return fail(`package-lock.json changed since the build (built against ${built.slice(0, 12) || "no recorded lock"})`);
  }
  return { consistent: true, stamped, content: content.build_id, reason: "the stamp matches the content" };
}
