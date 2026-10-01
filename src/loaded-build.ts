// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0047 — what THIS process loaded at start, fixed for its whole life.
 *
 *   build_id, commit, dirty, built_at  the stamp this process imported
 *                                      (build-info.ts): its CODE, never recomputed;
 *   deps_id, deps_state                its installed dependencies, snapshotted when
 *                                      the process started (deps-snapshot.ts, the
 *                                      entry's FIRST import): a registry install
 *                                      resolves them after the build, so no stamp
 *                                      could carry them; null unless known (never
 *                                      current);
 *   node                               the node version running it.
 *
 * Every reporter (/health, health_check, whoami, `relay where --json`) reports
 * this value. Nothing re-reads the disk later to answer "what am I running".
 */
import { BUILD_INFO, type BuildInfo } from "./build-info.js";
import { DEPS_SNAPSHOT } from "./deps-snapshot.js";

export interface LoadedBuild extends BuildInfo {
  /** The installed dependencies' id, snapshotted at start (deps-snapshot.ts); null unless known. */
  readonly deps_id: string | null;
  /** known | unknown (not an npm install) | error: never current unless known. */
  readonly deps_state: "known" | "unknown" | "error";
  /** process.version of the node running this process. */
  readonly node: string;
}

export const LOADED_BUILD: LoadedBuild = Object.freeze({
  ...BUILD_INFO,
  deps_id: DEPS_SNAPSHOT.state === "known" ? DEPS_SNAPSHOT.id : null,
  deps_state: DEPS_SNAPSHOT.state,
  node: process.version,
});
