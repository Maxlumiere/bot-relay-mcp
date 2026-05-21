// bot-relay-mcp — Tether for VSCode
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT

/**
 * v0.1.4 — bundle-correctness drift guard.
 *
 * Asserts properties of the SHIPPED out/extension.js bundle so a future
 * dependency update can't silently re-introduce un-bundled runtime
 * requires (which would break the extension since v0.1.4 ships with no
 * node_modules in the VSIX).
 *
 * Discipline:
 *   - `feedback_test_path_must_match_shipped_path.md`: assertions are
 *     against out/extension.js + out/extension.meta.json — the actual
 *     artifacts that go into the VSIX. Tests run after `npm run bundle`,
 *     not against source.
 *   - `feedback_test_asserts_contract_not_proxy.md`: the contract is
 *     "the bundle has no un-bundled runtime require beyond a safe
 *     allowlist". We parse the metafile esbuild emits (machine-readable
 *     ground truth for esbuild's bundling decisions) rather than
 *     greping the minified bundle text (which would match string-literal
 *     occurrences of `require("...")` like ajv's standalone-code
 *     metadata — see v0.1.4 changelog for the false-positive class).
 */
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXT_ROOT = path.resolve(__dirname, "..");
const BUNDLE = path.join(EXT_ROOT, "out/extension.js");
const BUNDLE_MAP = path.join(EXT_ROOT, "out/extension.js.map");
const META = path.join(EXT_ROOT, "out/extension.meta.json");

// Hard ceiling on bundle size. Pre-v0.1.4 VSIX was 2.84 MB / 2004 files
// — the bundle itself was zero bytes (no bundling happened). Post-v0.1.4
// the bundle replaces node_modules in the VSIX. 800 KB is a generous
// ceiling that flags accidental future bloat (e.g. an extra
// 10-MB transitive dep) without tripping on minor version bumps of the
// existing dep tree. Adjust UP only with a CHANGELOG entry and a
// rationale; never silently raise.
const BUNDLE_SIZE_MAX_BYTES = 800 * 1024;

// External imports we accept at runtime. `vscode` is provided by the
// VSCode extension host. Anything starting with `node:` is a Node.js
// built-in available in the Electron runtime. NOT in this list means:
// must be bundled OR explicitly added to the allowlist with a
// CHANGELOG entry.
const ALLOWED_RUNTIME_EXTERNALS = new Set<string>([
  "vscode",
]);

function isNodeBuiltin(name: string): boolean {
  return name.startsWith("node:");
}

// The esbuild metafile encodes "external: <runtime>" for esbuild's
// own internal helpers — those are inlined into the bundle, not real
// runtime requires. Filter them out before assertion.
function isEsbuildRuntime(name: string): boolean {
  return name === "<runtime>";
}

describe("v0.1.4 — bundle correctness", () => {
  beforeAll(() => {
    if (!fs.existsSync(BUNDLE)) {
      throw new Error(
        `Bundle missing at ${BUNDLE}. Run 'npm run bundle' before tests.`,
      );
    }
    if (!fs.existsSync(META)) {
      throw new Error(
        `Metafile missing at ${META}. esbuild.config.mjs should write it.`,
      );
    }
  });

  it("(B1) bundle exists at out/extension.js with non-trivial size", () => {
    const stat = fs.statSync(BUNDLE);
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBeGreaterThan(50_000); // sanity floor — empty bundle would slip past elsewhere
  });

  it("(B2) bundle size is under the regression ceiling (800 KB)", () => {
    const stat = fs.statSync(BUNDLE);
    expect(
      stat.size,
      `bundle size ${stat.size} exceeds ceiling ${BUNDLE_SIZE_MAX_BYTES}. Either reduce deps or raise the ceiling with a CHANGELOG note.`,
    ).toBeLessThan(BUNDLE_SIZE_MAX_BYTES);
  });

  it("(B3) source map is shipped alongside the bundle (Q1=YES)", () => {
    expect(fs.existsSync(BUNDLE_MAP), "out/extension.js.map missing").toBe(true);
    const stat = fs.statSync(BUNDLE_MAP);
    expect(stat.size).toBeGreaterThan(10_000);
  });

  it("(B4) bundle's runtime externals are only in the allowlist (vscode + node:* built-ins)", () => {
    const meta = JSON.parse(fs.readFileSync(META, "utf-8"));
    const externals = new Set<string>();
    for (const input of Object.values<{ imports?: { path: string; external?: boolean }[] }>(
      meta.inputs,
    )) {
      if (!input.imports) continue;
      for (const imp of input.imports) {
        if (!imp.external) continue;
        if (isEsbuildRuntime(imp.path)) continue;
        externals.add(imp.path);
      }
    }
    const unexpected = [...externals].filter(
      (e) => !ALLOWED_RUNTIME_EXTERNALS.has(e) && !isNodeBuiltin(e),
    );
    expect(
      unexpected,
      `unexpected runtime externals: ${JSON.stringify(unexpected)}. Either add to ALLOWED_RUNTIME_EXTERNALS (with CHANGELOG entry + rationale) or fix the bundle so the dep is inlined.`,
    ).toEqual([]);
    // Positive assertion: `vscode` IS external (would be wrong to bundle it).
    expect(externals.has("vscode"), "vscode must be marked external — the VSCode host provides it").toBe(true);
  });

  it("(B5) MCP SDK is inlined — paths under node_modules/@modelcontextprotocol/sdk appear as bundled inputs", () => {
    const meta = JSON.parse(fs.readFileSync(META, "utf-8"));
    const sdkInputs = Object.keys(meta.inputs).filter((p) =>
      p.includes("@modelcontextprotocol/sdk"),
    );
    expect(
      sdkInputs.length,
      "MCP SDK has no inputs in metafile — bundle did not inline the SDK",
    ).toBeGreaterThan(0);
  });

  it("(B6) extension source modules all appear as bundle inputs (no dead-code surprise)", () => {
    const meta = JSON.parse(fs.readFileSync(META, "utf-8"));
    const srcInputs = Object.keys(meta.inputs).filter((p) =>
      p.startsWith("src/") && p.endsWith(".ts") && !p.endsWith(".test.ts"),
    );
    // src/extension.ts entrypoint + config + format + transport-diagnostics
    expect(srcInputs.sort()).toEqual([
      "src/config.ts",
      "src/extension.ts",
      "src/format.ts",
      "src/transport-diagnostics.ts",
    ]);
  });

  it("(B7) bundle is CJS and exports activate/deactivate when loaded via require()", async () => {
    const body = fs.readFileSync(BUNDLE, "utf-8");
    // CJS bundles start with "use strict". Top-level ESM `export` would
    // surface here as a bundle-config error.
    expect(body.startsWith('"use strict"')).toBe(true);

    // CONTRACT ASSERTION: the VSCode extension host calls
    // require("<main>") and expects an object with activate +
    // deactivate functions. We exercise exactly that load shape by
    // intercepting Module._resolveFilename + Module._load for "vscode"
    // and then require()-ing the bundle from disk. Text-grep would be
    // a proxy (minified output may use Object.defineProperty +
    // name-keep wrappers that don't emit literal `exports.activate`).
    //
    // Why require() instead of vm.runInContext: the MCP SDK pulls in
    // pkce-challenge which has `import("node:crypto")` for the
    // Node-vs-browser switch. vm.runInContext with dynamic imports
    // requires --experimental-vm-modules + a callback flag we can't
    // count on across Node versions. require() handles dynamic
    // imports natively because the loaded module's import() is just
    // Node's own.
    const { createRequire } = await import("node:module");
    const Module = (await import("node:module")).default as {
      _resolveFilename: (req: string, parent: unknown) => string;
      _load: (req: string, parent: unknown, isMain: boolean) => unknown;
    };
    const origResolve = Module._resolveFilename;
    const origLoad = Module._load;
    // Minimal vscode mock — activate is not invoked by this test, so
    // the mock just needs to satisfy any top-level `vscode.X` lookups
    // that occur during module-eval (there are none in the current
    // bundle, but a Proxy makes that future-proof).
    const vscodeMock: unknown = new Proxy(
      {},
      {
        get: (_t, _k) =>
          new Proxy(() => undefined, {
            get: () => undefined,
          }),
      },
    );
    try {
      Module._resolveFilename = function patchedResolve(
        request: string,
        parent: unknown,
      ): string {
        if (request === "vscode") return "vscode";
        return origResolve.call(this, request, parent);
      };
      Module._load = function patchedLoad(
        request: string,
        parent: unknown,
        isMain: boolean,
      ): unknown {
        if (request === "vscode") return vscodeMock;
        return origLoad.call(this, request, parent, isMain);
      };
      // Bust the require cache for the bundle so this test is
      // re-runnable in watch mode.
      const reqLocal = createRequire(__filename);
      const resolved = reqLocal.resolve(BUNDLE);
      delete (reqLocal as unknown as { cache: Record<string, unknown> }).cache?.[resolved];
      const loaded = reqLocal(BUNDLE) as { activate?: unknown; deactivate?: unknown };
      expect(typeof loaded.activate, "bundle does not export activate()").toBe("function");
      expect(typeof loaded.deactivate, "bundle does not export deactivate()").toBe("function");
    } finally {
      Module._resolveFilename = origResolve;
      Module._load = origLoad;
    }
  });
});
