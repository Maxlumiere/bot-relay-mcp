// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * A FIXTURE's start token: the token liveness.processStartedAt reads for a live pid, or a throw. A
 * fixture that seeds an anchor needs a real start; an unreadable or gone one is a broken precondition,
 * never a value to store (INV-LIVE-01: processStartedAt has no null form).
 */
import { processStartedAt, type StartTokenForm } from "../../src/liveness.js";

export function startToken(pid: number, form: StartTokenForm = "utc"): string {
  const r = processStartedAt(pid, undefined, form);
  if (r.kind !== "start") throw new Error(`fixture: no start token for pid ${pid} (${r.kind}${r.kind === "unreadable" ? `: ${r.why}` : ""})`);
  return r.start;
}
