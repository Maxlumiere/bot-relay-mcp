#!/usr/bin/env node
// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

// The doorbell job's entrypoint (`dist/doorbell.js`; registered in src/entrypoints.ts).
// ADR-0047: the deps snapshot FIRST, so the build this process reports is the one it loaded.
import "./deps-snapshot.js";
import { runDoorbell } from "./doorbell-run.js";

runDoorbell(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`DOORBELL_FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  },
);
