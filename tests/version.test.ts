// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 4a — guards the single source of truth.
 *
 * Asserts that the exported `VERSION` constant matches `package.json.version`.
 * If these ever drift, the drift-grep guard in pre-publish-check.sh catches
 * hardcoded literals — this test catches the upstream case where version.ts's
 * candidate-path resolution silently falls through to a wrong package.json or
 * an "unknown" sentinel.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_PATH = path.resolve(__dirname, "..", "package.json");

const { VERSION } = await import("../src/version.js");

describe("v2.1 Phase 4a — src/version.ts", () => {
  it("VERSION matches package.json.version (single source of truth)", () => {
    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf-8"));
    expect(pkg.version).toBeTruthy();
    expect(VERSION).toBe(pkg.version);
  });

  it("VERSION is a well-formed semver string", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
  });
});
