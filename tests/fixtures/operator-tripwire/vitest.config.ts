// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/** A nested run for tests/operator-tripwire.test.ts: ONE fixture under the real tripwire setup. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export default defineConfig({
  test: {
    root: ROOT,
    include: ["tests/fixtures/operator-tripwire/*.fixture.ts"],
    setupFiles: ["./tests/_setup/operator-tripwire.ts"],
  },
});
