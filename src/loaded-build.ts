// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0047 — what THIS process loaded at start, fixed for its whole life.
 *
 *   build_id, commit, dirty, built_at  the stamp this process imported
 *                                      (build-info.ts): its CODE, never recomputed;
 *   deps_id                            its installed production dependencies,
 *                                      computed ONCE, here, at load (build-id.ts):
 *                                      a registry install resolves them after the
 *                                      build, so no stamp could carry them; null
 *                                      when they could not be read (never current);
 *   node                               the node version running it.
 *
 * Every reporter (/health, health_check, whoami, `relay where --json`) reports
 * this value. Nothing re-reads the disk later to answer "what am I running".
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD_INFO, type BuildInfo } from "./build-info.js";
import { computeDepsId } from "./build-id.js";

export interface LoadedBuild extends BuildInfo {
  /** The installed production dependencies' id, as loaded at start; null when unreadable. */
  readonly deps_id: string | null;
  /** process.version of the node running this process. */
  readonly node: string;
}

function ownInstallDir(): string {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

const deps = computeDepsId(ownInstallDir());

export const LOADED_BUILD: LoadedBuild = Object.freeze({ ...BUILD_INFO, deps_id: deps.ok ? deps.id : null, node: process.version });
