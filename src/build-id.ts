// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0047 — the identity of what a long-lived relay process LOADS AT START.
 *
 * THE BOUNDARY: the identity covers exactly what a daemon or stdio connector loads
 * when it starts and keeps for its whole life, and nothing that runs fresh per
 * call (see docs/deployment.md, "Build identity"):
 *   IN   dist/** and package.json (it shapes module loading, and version.ts reads
 *        it), as the CODE ID; the installed production dependencies, as the DEPS ID.
 *   OUT  hooks/*.sh and bin/relay: they run fresh on every call, so they cannot be
 *        stale, and hashing them would demand needless window restarts.
 *
 * CODE ID: the sha256 of the sorted list of (path, sha256 of the bytes) for
 * package.json and every regular file under dist/. The stamp, dist/build-info.js,
 * enters as ONE CONSTANT entry: its identity is its exact template (checkInstall
 * refuses a stamp that is not byte-identical to the regenerated template), and its
 * values are its own id and three human-only fields. So the build step, which hashes
 * before it writes the stamp, and a later check agree, and an identical-output
 * rebuild gets the same id.
 *
 * DEPS ID: npm's own installed-tree record (node_modules/.package-lock.json) plus
 * every native addon under node_modules (deps-snapshot.ts, which also takes this
 * process's snapshot at start). Never a lockfile, never a per-package walk.
 *
 * ONE implementation: the build step stamps with the compiled form of this file,
 * a process computes its deps id once at load with it (loaded-build.ts), and a
 * render-time check recomputes with it. It never answers "what am I running" for
 * a live process by re-reading the disk.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { computeDepsId } from "./deps-snapshot.js";

/** The value the unstamped placeholder carries: never equal to any build. */
export const UNBUILT = "unbuilt";
/** The stamp file, relative to the install. */
const STAMP = "dist/build-info.js";

const sha256 = (data: string | Buffer): string => crypto.createHash("sha256").update(data).digest("hex");
const why = (err: unknown): string => (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err));

export interface StampInfo {
  build_id: string;
  commit: string | null;
  dirty: boolean | null;
  built_at: string | null;
}

/** THE stamp, byte for byte. The build step writes exactly this; checkInstall accepts exactly this. */
export function renderStamp(info: StampInfo): string {
  const ordered = { build_id: info.build_id, commit: info.commit, dirty: info.dirty, built_at: info.built_at };
  return `export const BUILD_INFO = Object.freeze(${JSON.stringify(ordered)});\n`;
}

/**
 * Parse a stamp file STRICTLY: it must be byte-identical to renderStamp() of its
 * own values, with the four fields in order and well-typed. A comment, extra code,
 * a second export, a truncation or any other spelling is refused.
 */
export function parseStamp(text: string): { ok: true; info: StampInfo } | { ok: false; reason: string } {
  const m = /^export const BUILD_INFO = Object\.freeze\((\{[^\n]*\})\);\n$/.exec(text);
  if (!m) return { ok: false, reason: "the stamp is not in the one stamp format" };
  let v: unknown;
  try {
    v = JSON.parse(m[1]);
  } catch {
    return { ok: false, reason: "the stamp's value is not valid JSON" };
  }
  const o = v as Record<string, unknown>;
  const info: StampInfo = {
    build_id: o.build_id as string,
    commit: o.commit as string | null,
    dirty: o.dirty as boolean | null,
    built_at: o.built_at as string | null,
  };
  const well =
    v !== null && typeof v === "object" && !Array.isArray(v) &&
    Object.keys(o).join(",") === "build_id,commit,dirty,built_at" &&
    typeof info.build_id === "string" && /^([0-9a-f]{64}|unbuilt)$/.test(info.build_id) &&
    (info.commit === null || (typeof info.commit === "string" && /^[0-9a-f]{40}$/.test(info.commit))) &&
    (info.dirty === null || typeof info.dirty === "boolean") &&
    (info.built_at === null || typeof info.built_at === "string");
  if (!well || renderStamp(info) !== text) return { ok: false, reason: "the stamp is not byte-identical to its template" };
  return { ok: true, info };
}

/** The constant manifest entry the stamp contributes: its template with every value blanked. */
const STAMP_ENTRY = `${STAMP}\0${sha256(renderStamp({ build_id: "", commit: null, dirty: null, built_at: null }))}\n`;

export type IdResult = { ok: true; id: string } | { ok: false; reason: string };

/** The CODE ID of an install: package.json and dist/** (see the top of this file). Never throws. */
export function computeCodeId(installDir: string): IdResult {
  const entries: string[] = [STAMP_ENTRY];
  try {
    entries.push(`package.json\0${sha256(fs.readFileSync(path.join(installDir, "package.json")))}\n`);
  } catch (err) {
    return { ok: false, reason: `cannot read ${path.join(installDir, "package.json")} (${why(err)})` };
  }
  const walk = (dir: string, rel: string): string | null => {
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return `cannot list ${dir} (${why(err)})`;
    }
    for (const d of names) {
      const r = `${rel}/${d.name}`;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        const e = walk(full, r);
        if (e) return e;
      } else if (d.isFile()) {
        if (r === STAMP) continue;
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
  const err = walk(path.join(installDir, "dist"), "dist");
  if (err) return { ok: false, reason: err };
  if (entries.length < 3) return { ok: false, reason: `${installDir}/dist holds no build` };
  entries.sort();
  return { ok: true, id: sha256(entries.join("")) };
}

export interface InstallCheck {
  /** True only when the stamp is exactly its template, names the code on disk, and the dependencies are readable, twice alike. */
  consistent: boolean;
  /** The build_id the stamp on disk names (UNBUILT for the placeholder), or null when there is no valid stamp. */
  stamped: string | null;
  /** The recomputed CODE ID, or null when the content could not be read. */
  content: string | null;
  /** The recomputed DEPS ID, or null when it is unknown or could not be read. */
  deps: string | null;
  /** known | unknown (no npm installed-tree record: supported installers only) | error. */
  deps_state: "known" | "unknown" | "error";
  reason: string;
}

function observeOnce(installDir: string): InstallCheck {
  const code = computeCodeId(installDir);
  let stamp: ReturnType<typeof parseStamp>;
  try {
    stamp = parseStamp(fs.readFileSync(path.join(installDir, STAMP), "utf-8"));
  } catch (err) {
    stamp = { ok: false, reason: `no build stamp (${why(err)})` };
  }
  const deps = computeDepsId(installDir);
  const stamped = stamp.ok ? stamp.info.build_id : null;
  const content = code.ok ? code.id : null;
  const depsId = deps.state === "known" ? deps.id : null;
  const fail = (reason: string): InstallCheck => ({ consistent: false, stamped, content, deps: depsId, deps_state: deps.state, reason: `${reason}: rebuild with npm run build` });
  if (!code.ok) return fail(`the install's code cannot be read: ${code.reason}`);
  if (!stamp.ok) return fail(`the build stamp is refused: ${stamp.reason}`);
  if (stamp.info.build_id !== code.id) {
    return fail(`the build stamp (${stamp.info.build_id.slice(0, 12)}) does not match the code (${code.id.slice(0, 12)})`);
  }
  if (deps.state === "error") return fail(`the installed dependencies cannot be identified: ${deps.reason}`);
  // UNKNOWN is not an inconsistency of the build: it is an install the deps id cannot
  // describe (not npm). The board shows it as UNKNOWN, and the deploy check fails it.
  const tail = deps.state === "unknown" ? `; the dependencies are UNKNOWN: ${deps.reason}` : "";
  return { consistent: true, stamped, content, deps: depsId, deps_state: deps.state, reason: `the stamp matches the code${tail}` };
}

/**
 * What an install on disk holds, recomputed from its CONTENT: the reference a
 * running process is compared with. Never throws. OBSERVED TWICE (the deploy-gate
 * pattern): an install that changes while it is being checked, e.g. a compile
 * racing the check, is inconsistent rather than a false pass.
 */
export function checkInstall(installDir: string, opts: { afterFirstObservation?: () => void } = {}): InstallCheck {
  const a = observeOnce(installDir);
  opts.afterFirstObservation?.();
  const b = observeOnce(installDir);
  if (a.stamped !== b.stamped || a.content !== b.content || a.deps !== b.deps || a.deps_state !== b.deps_state || a.consistent !== b.consistent) {
    return { ...b, consistent: false, reason: "the install changed while it was being checked: check again once the build is finished" };
  }
  return b;
}
