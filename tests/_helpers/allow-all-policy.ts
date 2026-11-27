// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * TESTS ONLY (doorbell PR 8a, ruling e0217654): a standing check that allows every sender. It exists only here:
 * src/ holds no allow-all policy and decideWake takes its policy explicitly (tests/doorbell-pr8a-policy.test.ts
 * scans src/ for any runtime reference).
 */
import type { StandingCheck } from "../../src/wake-policy.js";

export const ALLOW_ALL: StandingCheck = () => "allowed";
export const ALLOW_ALL_POLICY = { standing: ALLOW_ALL, pairWakesPerHour: 4 } as const;
