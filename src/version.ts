// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 4a — single source of truth for the relay version.
 *
 * Every other file that needs the version string imports `VERSION` from here.
 * The drift-grep guard in scripts/pre-publish-check.sh fails the publish
 * gate if any /["']\d+\.\d+\.\d+["']/ literal shows up in src/ outside this
 * file — so the only path to rev the version is to bump `package.json`.
 *
 * Read strategy: try the dist-relative path first (production install) and
 * fall back to the cwd-relative path (vitest / tsx / source run). Module
 * load is synchronous — the result is cached in `VERSION` for the process
 * lifetime.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

function readVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "..", "package.json"),      // dist/ + src/ both sit one level under project root
    path.resolve(here, "..", "..", "package.json"), // nested layouts (e.g. dist/src/version.js)
    path.resolve(process.cwd(), "package.json"),   // fallback
  ];
  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, "utf-8");
      const pkg = JSON.parse(raw);
      if (typeof pkg.version === "string" && pkg.version.length > 0) {
        return pkg.version;
      }
    } catch {
      // try next candidate
    }
  }
  throw new Error("Could not read package.json version — install is corrupted.");
}

export const VERSION: string = readVersion();
