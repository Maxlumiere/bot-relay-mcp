// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/** Run by tests/full-suite-check.test.ts: one assertion fails. */
import { it, expect } from "vitest";

it("one", () => expect(1).toBe(1));
it("two", () => expect(2).toBe(2));
it("three fails", () => expect(3).toBe(4));
