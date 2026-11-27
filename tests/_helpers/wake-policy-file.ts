// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Doorbell PR 8a: suites that arm a real `--until-wake` watch need a wake policy in the instance directory (no
 * policy means no wakes). This writes one that opts the named agents in, each wakeable by any registered sender
 * (the one wildcard), at the PR 7 rate (4 per pair per hour): the behaviour those suites measured before 8a.
 */
import fs from "fs";
import path from "path";

export function installOpenPolicy(instanceDir: string, agents: readonly string[], pairWakesPerHour = 4): string {
  const p = path.join(instanceDir, "doorbell-policy.json");
  fs.mkdirSync(instanceDir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ version: 1, optIn: [...agents], wake: agents.map((to) => ({ from: "*", to })), pairWakesPerHour }), { mode: 0o600 });
  fs.chmodSync(p, 0o600);
  return p;
}
