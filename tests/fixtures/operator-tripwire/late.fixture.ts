// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Run NESTED by tests/operator-tripwire.test.ts, ALONE. Its only test PASSES: it starts a node child that
 * reaches the operator port only AFTER the test (and its afterEach) finished, so no per-test check can
 * see it. The run must still FAIL: the child's refusal is a file in the run's violations directory, and
 * the run guard's teardown fails on it (the catch-proof backstop).
 */
import { it, afterAll } from "vitest";
import { spawn } from "node:child_process";

let exited: Promise<unknown> = Promise.resolve();
it("passes, leaving a child that reaches the operator port later", () => {
  const port = Number(process.env.TRIPWIRE_FIXTURE_PORT);
  const child = spawn(process.execPath, ["-e", `setTimeout(() => fetch("http://127.0.0.1:${port}/").catch(() => {}).finally(() => process.exit(0)), 400)`], { stdio: "ignore" });
  exited = new Promise((r) => child.on("exit", r));
});
// Not a tripwire check: it only keeps the run open until the child has acted, so the outcome is
// deterministic (the test's own afterEach already ran, and saw nothing).
afterAll(() => exited, 20_000);
