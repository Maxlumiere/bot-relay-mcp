// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * #182 — Node 20 dropped; better-sqlite3 13 (native) requires Node >= 22.
 *
 * The point of this file is that the MANIFEST MUST NOT LIE: `engines.node`, the
 * runtime floor (`MIN_NODE_MAJOR`), the better-sqlite3 pin, and the CI matrices
 * must all say the same thing. If any one of them advertises support the others
 * do not have, an install on that runtime fails at native compile with a confusing
 * error instead of a clean, named refusal — the exact "delivers less than it
 * claims, and nothing says so" class this change exists to remove.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { MIN_NODE_MAJOR, nodeVersionError } from "../src/node-version.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("#182 — Node version floor (>=22)", () => {
  it("refuses Node 20 with a CLEAN message that NAMES the requirement (22)", () => {
    const err = nodeVersionError("20.19.0");
    expect(err).not.toBeNull();
    expect(err).toMatch(/Node\.js 22\+/); // names the requirement
    expect(err).toContain("20.19.0"); // and what they actually have
    expect(err).toMatch(/nodejs\.org|nvm/); // and how to fix it
  });

  it("refuses older majors too (18)", () => {
    expect(nodeVersionError("18.20.0")).toMatch(/Node\.js 22\+/);
  });

  it("accepts Node 22 and 24 (returns null — no false refusal)", () => {
    expect(nodeVersionError("22.0.0")).toBeNull();
    expect(nodeVersionError("24.13.0")).toBeNull();
  });

  it("the manifest does not lie: engines / runtime floor / bsq3 pin / CI matrices ALL agree on >=22", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
    expect(pkg.engines.node).toBe(">=22.0.0");
    expect(MIN_NODE_MAJOR).toBe(22);
    // better-sqlite3 on a 13.x line — the native dependency that forces the floor.
    expect(pkg.dependencies["better-sqlite3"]).toMatch(/^\^?13\./);
    // No CI job may test Node 20 any more, or its green would certify an
    // unsupported configuration.
    for (const wf of ["ci.yml", "native-build.yml"]) {
      const y = fs.readFileSync(path.join(ROOT, ".github", "workflows", wf), "utf-8");
      const m = y.match(/node:\s*\[([^\]]*)\]/);
      expect(m, `${wf} must have a node matrix`).not.toBeNull();
      expect(m![1], `${wf} node matrix must NOT include Node 20`).not.toMatch(/['"]20['"]/);
      expect(m![1], `${wf} node matrix must include Node 22`).toMatch(/['"]22['"]/);
    }
  });
});
