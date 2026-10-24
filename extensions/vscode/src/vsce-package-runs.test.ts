// bot-relay-mcp — Tether for VSCode
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT

/**
 * `vsce package` RUNS under the `@azure/msal-node` 7.1.0 security override (GHSA-xcx6-jx8p-x3h5).
 *
 * The override sits OUTSIDE its dependent's declared range: `@azure/identity` (via `@vscode/vsce`) declares msal-node
 * `^6.0.0`. The pin was approved on condition that CI proves the packaging path still works under it. This test
 * runs the REAL `vsce package` (its prepublish included) into a temp directory, and first proves the msal-node that
 * `@azure/identity` resolves IS 7.1.0, so a green run is a run under the override, never a vacuous one.
 *
 * NOT covered, by design (stated in SECURITY.md and docs/openvsx-publishing.md): `vsce publish --azure-credential`,
 * the only path that calls `@azure/identity`. It needs a real Microsoft Entra ID sign-in.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VSCE_BIN = path.join(EXT_ROOT, "node_modules", ".bin", "vsce");

describe("vsce package under the @azure/msal-node 7.1.0 override", () => {
  it("the msal-node that @azure/identity resolves is the overridden 7.1.0", () => {
    const fromIdentity = createRequire(createRequire(path.join(EXT_ROOT, "package.json")).resolve("@azure/identity"));
    // Walk up from msal-node's resolved entry to its own package.json (its exports map need not expose package.json).
    let dir = path.dirname(fromIdentity.resolve("@azure/msal-node"));
    let pkg: { name?: string; version?: string } = {};
    for (; dir !== path.dirname(dir); dir = path.dirname(dir)) {
      const f = path.join(dir, "package.json");
      if (fs.existsSync(f) && (pkg = JSON.parse(fs.readFileSync(f, "utf-8"))).name === "@azure/msal-node") break;
    }
    expect(pkg.name).toBe("@azure/msal-node");
    expect(pkg.version).toBe("7.1.0");
  });

  it("vsce package completes and writes a .vsix", () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "tether-vsce-package-"));
    try {
      const vsix = path.join(out, "tether.vsix");
      // --no-dependencies: the same reason as the VSIX-contents guard (an npm 11 false-positive ELSPROBLEMS in vsce's
      // dependency scan); the extension is esbuild-bundled, so no dependency ships either way.
      const r = spawnSync(VSCE_BIN, ["package", "--no-dependencies", "--out", vsix], { cwd: EXT_ROOT, encoding: "utf-8", timeout: 180_000 });
      expect(r.status, `vsce package exit ${r.status}: ${r.stderr}\n${r.stdout}`).toBe(0);
      expect(fs.statSync(vsix).size).toBeGreaterThan(0);
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  }, 200_000);
});
