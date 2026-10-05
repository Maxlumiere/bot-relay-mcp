// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Swallows a REFUSED connect to an operator port: the tripwire must still fail it (afterEach). The
 * port is the outer test's canary, made an operator port by being this run's AMBIENT
 * RELAY_HTTP_PORT (the setup treats the shell's port as the operator's), and handed over in
 * TRIPWIRE_FIXTURE_PORT because the setup replaces RELAY_HTTP_PORT with its safe default.
 */
import { it } from "vitest";
import http from "node:http";

it("swallows a refused connect to an operator port", async () => {
  const port = Number(process.env.TRIPWIRE_FIXTURE_PORT);
  if (!Number.isInteger(port) || port <= 0) throw new Error("TRIPWIRE_FIXTURE_PORT not set");
  await new Promise<void>((resolve) => {
    try {
      http.get({ host: "127.0.0.1", port, path: "/health" }, () => resolve()).on("error", () => resolve());
    } catch {
      resolve();
    }
  });
});
