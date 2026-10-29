// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/** Run by tests/full-suite-check.test.ts: the whole suite is skipped (vitest still exits 0). */
import { describe, it, expect } from "vitest";

describe.skip("skipped", () => {
  it("one", () => expect(1).toBe(1));
  it("two", () => expect(2).toBe(2));
  it("three", () => expect(3).toBe(3));
});
