// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Runtime Node-version floor — a CLEAN refusal that names the requirement.
 *
 * #182 (2026-09): raised 18 → 22 alongside `better-sqlite3` 13 (a NATIVE module
 * that requires Node >= 22) and the `engines.node` ">=22.0.0" bump. Node 20 went
 * EOL 2026-04-30. Without this floor, an install/launch on Node 20 fails at native
 * compile with a confusing error; this refuses first, naming the required major —
 * so the manifest, the CI matrix, and the runtime all say the same thing.
 *
 * Kept in its own side-effect-free module so it is unit-testable without importing
 * `index.ts` (which runs `main()` on import).
 */
export const MIN_NODE_MAJOR = 22;

/** Returns the refusal message (naming MIN_NODE_MAJOR) if `nodeVersion` is below the floor, else null. */
export function nodeVersionError(nodeVersion: string): string | null {
  const major = parseInt(nodeVersion.split(".")[0], 10);
  if (isNaN(major) || major < MIN_NODE_MAJOR) {
    return (
      `bot-relay-mcp requires Node.js ${MIN_NODE_MAJOR}+ (you have ${nodeVersion}).\n` +
      `Install a newer Node from https://nodejs.org/ or use nvm.\n`
    );
  }
  return null;
}
