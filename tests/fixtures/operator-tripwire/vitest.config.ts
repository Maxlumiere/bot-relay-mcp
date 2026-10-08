// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/** A NESTED run for tests/operator-tripwire.test.ts: the fixtures under the real base, tripwire and run guard. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withOperatorTripwire } from "../../_setup/vitest-tripwire-base.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export default withOperatorTripwire({
  test: {
    root: ROOT,
    include: ["tests/fixtures/operator-tripwire/*.fixture.ts"],
  },
});
