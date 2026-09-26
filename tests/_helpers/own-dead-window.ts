// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * ADR-0042 R1 test helper. A connector may end a session only when the row is
 * anchored to ITS OWN parent window AND that anchor is positively dead. Tests of
 * the ending path set up exactly that: the row anchored to a provably dead pid,
 * and the same anchor as this process's detected parent. Their assertions are
 * unchanged; they now arrange the one situation in which ending is allowed.
 */
import { getDb } from "../../src/db.js";
import { getOwnHostId } from "../../src/liveness.js";
import { _setDetectedAgentProcessForTests } from "../../src/transport/stdio.js";

export const OWN_DEAD_ANCHOR = { pid: 2_147_483_645, startedAt: "Mon Sep 15 10:00:00 2026" };

/** Anchor `name`'s row to the dead own-window anchor, and make it this connector's parent. */
export function ownDeadWindow(name: string): typeof OWN_DEAD_ANCHOR {
  getDb()
    .prepare("UPDATE agents SET agent_pid = ?, agent_pid_start = ?, host_id = ? WHERE name = ?")
    .run(OWN_DEAD_ANCHOR.pid, OWN_DEAD_ANCHOR.startedAt, getOwnHostId(), name);
  _setDetectedAgentProcessForTests({ pid: OWN_DEAD_ANCHOR.pid, startedAt: OWN_DEAD_ANCHOR.startedAt } as never);
  return OWN_DEAD_ANCHOR;
}
