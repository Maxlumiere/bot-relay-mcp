// bot-relay-mcp — Tether for VSCode
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT

/**
 * v0.1.1 — extension-local vitest config.
 *
 * Without this, vitest walks up the tree and finds the root project's
 * `vitest.config.ts` whose `include: ["tests/**\/*.test.ts"]` excludes
 * our extension-local unit tests at `src/*.test.ts`. The root project's
 * gate runs the drift-guard tests at `tests/v2-6-tether-transport-diagnostics.test.ts`;
 * this config exists so `cd extensions/vscode && npm run test:unit` can
 * pick up `transport-diagnostics.test.ts` (and any future helper unit
 * tests) without touching the root config.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**", "out/**"],
    // v2.15.2 — the VSIX-contents guards (v0-1-4-vsix-contents) shell out to
    // `vsce ls` / `vsce package` via spawnSync (their OWN spawn timeout is
    // 30–60s). vitest's default 5s PER-TEST timeout aborts `vsce package`
    // before it returns on a cold CI runner (observed: V11 timed out at 5000ms
    // on Node 20 while Node 22 squeaked under). Raise the per-test timeout ABOVE
    // the heaviest spawn budget so those subprocess tests get their full window;
    // the ~230 pure-logic tests still finish in milliseconds.
    testTimeout: 90_000,
    hookTimeout: 90_000,
  },
});
