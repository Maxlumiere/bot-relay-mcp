// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

// bin/relay's exit point. The ONE implementation is src/exit-after-flush.ts (also used by `relay watch`'s signal exit):
// this file only re-exports it, so there is no second copy.
export { exitAfterFlush } from "../dist/exit-after-flush.js";
