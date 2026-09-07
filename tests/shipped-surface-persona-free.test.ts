// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * SHIPPED-CONTENT GUARD test — the npm tarball must not carry internal personas,
 * codenames, or the maintainer's name/home path.
 *
 * The scanner (scripts/check-shipped-content.mjs) packs the package, EXTRACTS the
 * tarball, and scans what actually ships — NOT the source tree (a source scan
 * reports clean while dist/*.js still carries comment strings). This file drives
 * it and, per the discipline that a guard which has only ever passed has never
 * been tested, demonstrates BOTH directions: a dirty package fails, a clean one
 * passes. Scope: the TARBALL only — internal names in src/ developer comments
 * are out of scope by design.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPatterns, scanDir, scanPackedTarball } from "../scripts/shipped-content-guard.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const patterns = loadPatterns();

function fixtureDir(files: Record<string, string>): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "shipfix-"));
  const pkg = path.join(d, "package");
  fs.mkdirSync(pkg, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(pkg, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return pkg;
}

describe("shipped-content guard — the npm tarball, not the source tree", () => {
  it("the pattern file loads a non-empty forbidden set", () => {
    expect(patterns.length).toBeGreaterThanOrEqual(10);
  });

  it("the REAL npm tarball is clean of every forbidden pattern", () => {
    const offenders = scanPackedTarball(ROOT, patterns);
    expect(
      offenders,
      offenders.map((o) => `${o.file}:${o.line} matches /${o.pattern}/ — ${o.text}`).join("\n"),
    ).toEqual([]);
  });

  it("CONTROL (must fail) — a tarball containing 'victra' is caught, with file:line", () => {
    const pkg = fixtureDir({
      "dist/db.js": "'use strict';\n// pre-ship catch (victra) — a shipped comment\nmodule.exports = {};\n",
      "README.md": "# clean\n",
    });
    const offenders = scanDir(pkg, patterns);
    expect(offenders.length).toBeGreaterThan(0);
    const hit = offenders.find((o) => o.pattern === "victra");
    expect(hit?.file).toBe("dist/db.js");
    expect(hit?.line).toBe(2); // names the exact line, not "personal reference found"
    fs.rmSync(path.dirname(pkg), { recursive: true, force: true });
  });

  it("CONTROL (must pass) — a genuinely clean tarball is not flagged (guard is not always-fail)", () => {
    const pkg = fixtureDir({
      "dist/db.js": "'use strict';\nmodule.exports = { transportArchitecture: 'ok' };\n",
      "docs/transport-architecture.md": "# Transport architecture\nThe architecture is fine.\n", // \\barchitect\\b must NOT match "architecture"
      "README.md": "# bot-relay-mcp by Maxlumiere\n", // \\bMaxime\\b must NOT match "Maxlumiere"
    });
    expect(scanDir(pkg, patterns)).toEqual([]);
    fs.rmSync(path.dirname(pkg), { recursive: true, force: true });
  });
});
