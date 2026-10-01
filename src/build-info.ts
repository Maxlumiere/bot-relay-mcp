// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0047 — the build this process LOADED.
 *
 * This file is a placeholder. `npm run build` replaces its compiled form,
 * `dist/build-info.js`, with the stamp (scripts/write-build-info.mjs): the CODE ID
 * of the build (package.json and dist/**, build-id.ts) and, for humans, the commit,
 * whether the tree was dirty, and when it was built. A tsc-only build keeps this
 * placeholder, which is not in the stamp format and whose `build_id` ("unbuilt")
 * never equals any build.
 *
 * It is imported statically (through loaded-build.ts, which adds the dependencies
 * and the node version), so it is fixed when the module graph loads, together with
 * the code it describes. Nothing reads git, package.json or dist/ later to answer
 * "what am I running": the disk is exactly what diverges from a running process.
 * This module imports nothing (a test holds that).
 */
export interface BuildInfo {
  /** The build's CODE ID (package.json and dist/, 64 hex), or "unbuilt". */
  readonly build_id: string;
  /** The git commit it was built from, or null outside a git checkout. */
  readonly commit: string | null;
  /** Whether that tree had uncommitted changes, or null when unknown. */
  readonly dirty: boolean | null;
  /** When it was built (ISO), or null for the placeholder. */
  readonly built_at: string | null;
}

export const BUILD_INFO: BuildInfo = Object.freeze({ build_id: "unbuilt", commit: null, dirty: null, built_at: null });
