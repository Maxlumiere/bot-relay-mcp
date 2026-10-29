// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/** Run by tests/full-suite-check.test.ts: the file fails to collect (a file-level failure, no test runs). */
import { it } from "vitest";

throw new Error("collection failure (planted)");
it("never collected", () => undefined);
