// bot-relay-mcp — Tether for VSCode
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT

/**
 * v0.1.4 — esbuild bundle config.
 *
 * Why bundle: pre-v0.1.4 the published VSIX was 2.84 MB / 2004 files,
 * 1994 of which lived in node_modules. vsce warned at publish time.
 * Bundling rolls @modelcontextprotocol/sdk and its tree into a single
 * out/extension.js, .vscodeignore drops node_modules/**, and the VSIX
 * collapses to ~hundreds of KB / a handful of files.
 *
 * Architectural calls (Q1-Q3 from the brief, locked here):
 *   Q1 source maps:  YES — Tether is a small extension; debug
 *                    friendliness > marginal VSIX size cost. esbuild
 *                    emits `out/extension.js.map` next to the bundle.
 *   Q2 minify:       YES for the prod bundle. Source maps survive
 *                    minification so stack traces still resolve.
 *   Q3 target:       node20. VSCode 1.85+ runs Electron with Node 20+;
 *                    targeting older Node would just bloat the output
 *                    with unneeded transpilation.
 *
 * format: cjs — VSCode loads `main` via `require()`. The TS source uses
 *   ESM-style imports (per tsconfig module: Node16) but the bundle MUST
 *   be CJS at the wire layer.
 *
 * external: ["vscode"] — VSCode provides this at runtime via its
 *   extension host's module loader. Bundling it would either fail
 *   (it's not a real npm package) or shadow the host's API surface.
 */
import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const watch = process.argv.includes("--watch");
const production = !process.argv.includes("--dev");

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [resolve(__dirname, "src/extension.ts")],
  outfile: resolve(__dirname, "out/extension.js"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["vscode"],
  sourcemap: true,
  // Production builds minify; --dev keeps the output readable for local
  // iteration (no minification, no symbol mangling).
  minify: production,
  // Keep names readable in source maps even under minification.
  keepNames: true,
  logLevel: "info",
  // Emit a metafile so the bundle-correctness test can introspect the
  // actual external imports + bundled inputs without re-greping the
  // minified output (which would also match string-literal occurrences
  // of `require("...")` like ajv's standalone-code metadata).
  metafile: true,
};

async function writeMetafile(result) {
  if (!result.metafile) return;
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(resolve(__dirname, "out"), { recursive: true });
  await writeFile(
    resolve(__dirname, "out/extension.meta.json"),
    JSON.stringify(result.metafile, null, 2),
    "utf-8",
  );
}

// Clean out/ before bundling so stale tsc artifacts from prior
// `npm run compile` runs can't leak into the VSIX. Pre-v0.1.4 the
// extension was built with tsc and out/*.js + out/*.js.map all shipped;
// post-v0.1.4 only out/extension.js + out/extension.js.map ship. If we
// leave the tsc stragglers (config.js, format.js, transport-
// diagnostics.js, their maps) on disk, vsce includes them and V10 in
// tests/v0-1-4-vsix-contents.test.ts fails on file count.
async function cleanOutDir() {
  const { rm } = await import("node:fs/promises");
  await rm(resolve(__dirname, "out"), { recursive: true, force: true });
}

if (watch) {
  // Watch mode keeps incremental rebuilds cheap; cleaning would defeat
  // the purpose. Watch is for local dev only — gate uses non-watch.
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("[esbuild] watching…");
} else {
  await cleanOutDir();
  const result = await esbuild.build(options);
  await writeMetafile(result);
}
