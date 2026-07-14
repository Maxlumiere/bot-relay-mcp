// bot-relay-mcp — Tether for VSCode
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT

/**
 * v0.1.4 — VSIX-contents drift guard.
 *
 * Closes the regression class where a future .vscodeignore drift (or a
 * dropped exclusion) silently re-ships node_modules/** or src/** into
 * the marketplace VSIX, undoing the v0.1.4 size reduction.
 *
 * Asserts:
 *   - vsce's file list matches the v0.1.4 contract (exact set of files)
 *   - node_modules/** NOT present (esbuild inlined it)
 *   - src/** NOT present (TS source lives in the repo, not the VSIX)
 *   - LICENSE + README + CHANGELOG present (marketplace requires them)
 *   - out/extension.js + out/extension.js.map present (the bundle + map)
 *   - extension.meta.json NOT present (test-only, excluded from VSIX)
 *
 * Test path matches the shipped path: this test runs
 * the real `vsce` against the real package directory. Mocking the
 * file list would defeat the drift-guard purpose.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXT_ROOT = path.resolve(__dirname, "..");
const VSCE_BIN = path.join(EXT_ROOT, "node_modules", ".bin", "vsce");

interface VsceLsResult {
  files: string[];
  raw: string;
}

function runVsceLs(): VsceLsResult {
  // `--no-dependencies` skips vsce's `npm list --production --parseable
  // --depth=99999` dependency scan. Under npm 11 (Node 24, the environment the
  // relay pre-publish gate runs in) that scan EXITS 1 on a false-positive
  // ELSPROBLEMS — the qs/form-data `overrides` mark call-bind-apply-helpers /
  // get-intrinsic "invalid" though the installed versions satisfy their ranges
  // (npm 20/22 in CI accept it, which is why CI stays green). The extension is
  // esbuild-BUNDLED, so runtime deps never ship in the VSIX anyway — skipping
  // the scan changes nothing about the packaged file list this guard asserts.
  const r = spawnSync(VSCE_BIN, ["ls", "--no-dependencies"], {
    cwd: EXT_ROOT,
    encoding: "utf-8",
    timeout: 30_000,
  });
  if (r.status !== 0) {
    throw new Error(`vsce ls failed (exit ${r.status}): ${r.stderr}`);
  }
  return {
    files: r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
    raw: r.stdout,
  };
}

describe("v0.1.4 — VSIX contents drift guard", () => {
  it("(V1) vsce ls completes and reports a non-empty file list", () => {
    const { files } = runVsceLs();
    expect(files.length).toBeGreaterThan(0);
    expect(files.length).toBeLessThan(50); // cap at 50 — anything more means node_modules leaked back in
  });

  it("(V2) bundle + source map are in the VSIX", () => {
    const { files } = runVsceLs();
    expect(files).toContain("out/extension.js");
    expect(files).toContain("out/extension.js.map");
  });

  it("(V3) marketplace required files are in the VSIX", () => {
    const { files } = runVsceLs();
    // vsce maps repo CHANGELOG.md → changelog.md inside the archive,
    // README.md → readme.md, LICENSE → LICENSE.txt. The `ls` output
    // uses the SOURCE paths (CHANGELOG.md etc), which is what we
    // care about for the contract. The marketplace-side renames are
    // vsce's responsibility.
    expect(files).toContain("package.json");
    expect(files).toContain("README.md");
    expect(files).toContain("LICENSE");
    expect(files).toContain("CHANGELOG.md");
  });

  it("(V4) node_modules NOT in the VSIX (esbuild inlined the runtime deps)", () => {
    const { files } = runVsceLs();
    const leaked = files.filter((f) => f.startsWith("node_modules/"));
    expect(
      leaked,
      `node_modules leaked into VSIX: ${JSON.stringify(leaked.slice(0, 10))}${leaked.length > 10 ? `… (+${leaked.length - 10} more)` : ""}`,
    ).toEqual([]);
  });

  it("(V5) src/** NOT in the VSIX (source lives in the repo, not the package)", () => {
    const { files } = runVsceLs();
    const leaked = files.filter((f) => f.startsWith("src/"));
    expect(leaked, `src/ leaked into VSIX: ${JSON.stringify(leaked)}`).toEqual([]);
  });

  it("(V6) build-config files NOT in the VSIX", () => {
    const { files } = runVsceLs();
    const forbidden = [
      "tsconfig.json",
      "esbuild.config.mjs",
      "vitest.config.ts",
      "vitest.config.js",
      "package-lock.json",
    ];
    for (const f of forbidden) {
      expect(files, `${f} must not ship in the VSIX`).not.toContain(f);
    }
  });

  it("(V7) extension.meta.json NOT in the VSIX (test-only artifact)", () => {
    const { files } = runVsceLs();
    expect(files, "out/extension.meta.json is test-only — must not ship").not.toContain(
      "out/extension.meta.json",
    );
  });

  it("(V8) only marketplace-surface markdown ships in the VSIX", () => {
    const { files } = runVsceLs();
    // The only top-level markdown the marketplace needs is README + CHANGELOG.
    // Any other *.md (developer-facing docs, notes, etc.) must stay out.
    const allowedMd = new Set(["README.md", "CHANGELOG.md"]);
    const strayMd = files.filter((f) => f.endsWith(".md") && !allowedMd.has(f));
    expect(strayMd, `stray markdown leaked into VSIX: ${JSON.stringify(strayMd)}`).toEqual([]);
  });

  it("(V9) prior VSIX artifacts NOT bundled into a new VSIX", () => {
    const { files } = runVsceLs();
    const leaked = files.filter((f) => f.endsWith(".vsix"));
    expect(leaked, `prior VSIX leaked into new VSIX: ${JSON.stringify(leaked)}`).toEqual([]);
  });

  it("(V10) total file count is at most a small number — under 10 for v0.1.4", () => {
    const { files } = runVsceLs();
    // v0.1.4 ships exactly: package.json, README.md, LICENSE, CHANGELOG.md,
    // out/extension.js, out/extension.js.map. That's 6 source-side files
    // (vsce adds [Content_Types].xml + extension.vsixmanifest at the
    // archive level). The ls output covers only the source-side files.
    // Asserting ≤10 leaves headroom for one or two future additions
    // (e.g. an icon) without becoming a noisy gate.
    expect(
      files.length,
      `unexpected file count in VSIX: ${files.length}. Files: ${JSON.stringify(files)}`,
    ).toBeLessThanOrEqual(10);
  });

  // (V11) — Codex R0 P2 finding closure. V1-V10 cap file COUNT
  // (≤10) and the bundle-correctness B2 caps `out/extension.js` BYTES
  // (≤800 KB). Neither asserted PACKAGED VSIX BYTES end-to-end. A
  // future regression (source-map growth, an icon, a doc, a transitive
  // dep pulling in a large dependency that survives tree-shake) could
  // push the VSIX over 800 KB while file count stays ≤10 and the
  // bundle stays under its own cap.
  //
  // This test runs `vsce package --out <tmp.vsix>`, measures the
  // packaged archive bytes, and asserts the 800 KB hard ceiling
  // codex flagged as the operative limit. The current artifact (357,
  // 908 bytes — verified in this run) sits well under, leaving room
  // for measured growth.
  //
  // Raising VSIX_BYTE_CEILING_HARD is OK with a CHANGELOG entry + a
  // documented reason. Lowering it silently is also fine. Tripping it
  // without an explanation is the drift the test exists to surface.
  it("(V11) packaged VSIX size is under the 800 KB hard ceiling", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `v014-vsix-size-${process.pid}-`));
    const outVsix = path.join(tmpDir, "size-probe.vsix");
    try {
      const r = spawnSync(
        VSCE_BIN,
        // `--no-dependencies` for the same npm-11 reason as runVsceLs: vsce
        // package runs the same dependency scan that EXITS 1 on the
        // false-positive ELSPROBLEMS under Node 24. The bundled VSIX contents
        // (and therefore the byte ceiling this test measures) are unchanged.
        ["package", "--skip-license", "--no-dependencies", "--out", outVsix],
        {
          cwd: EXT_ROOT,
          encoding: "utf-8",
          timeout: 60_000,
        },
      );
      expect(r.status, `vsce package failed (exit ${r.status}): ${r.stderr}`).toBe(0);
      expect(fs.existsSync(outVsix), `expected packaged vsix at ${outVsix}`).toBe(true);
      const bytes = fs.statSync(outVsix).size;

      const VSIX_BYTE_CEILING_HARD = 800 * 1024; // 800 KB — codex P2 ceiling
      const VSIX_BYTE_STRETCH_GOAL = 500 * 1024; // 500 KB — brief stretch (advisory)

      expect(
        bytes,
        `packaged VSIX is ${bytes} bytes, exceeds hard ceiling ${VSIX_BYTE_CEILING_HARD}. ` +
          `Either trim what ships (most likely: out/extension.js.map at ~1 MB is shipped by Q1=YES) ` +
          `or raise VSIX_BYTE_CEILING_HARD with a CHANGELOG entry justifying the new size.`,
      ).toBeLessThan(VSIX_BYTE_CEILING_HARD);

      // Advisory only — log if we drift over the 500 KB stretch but
      // do not fail. Codex's preference: 500 KB stays as reported
      // evidence, not a hard cap.
      if (bytes >= VSIX_BYTE_STRETCH_GOAL) {
        // eslint-disable-next-line no-console
        console.warn(
          `[V11 advisory] packaged VSIX is ${bytes} bytes — exceeds the 500 KB stretch goal. ` +
            `Current hard ceiling is ${VSIX_BYTE_CEILING_HARD}; consider trimming before bumping the ceiling.`,
        );
      }
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });
});
