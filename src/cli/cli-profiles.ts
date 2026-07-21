// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.17.0 (P3) — `relay cli-profiles` subcommand.
 *
 * Prints the agent-CLI profile registry (src/agent-cli-profiles.ts). `--json`
 * emits it machine-readable so any consumer across the TS/bash boundary can read
 * one source of truth instead of hardcoding `claude`/`codex`. (The hot-path bash
 * PID pattern in _vault-helpers.sh is a hand-maintained mirror kept honest by a
 * drift-guard test, not read live from here.)
 */
import { AGENT_CLI_PROFILES } from "../agent-cli-profiles.js";

export async function run(argv: string[]): Promise<number> {
  const help = argv.includes("--help") || argv.includes("-h");
  if (help) {
    process.stdout.write(
      "Usage: relay cli-profiles [--json]\n\n" +
        "Print the agent-CLI profile registry (the single source of truth for\n" +
        "supported agent CLIs — hooks, launch, wake, liveness pattern).\n" +
        "  (default)  Human-readable summary, one line per profile.\n" +
        "  --json     The full registry as JSON (for scripts / cross-boundary reads).\n",
    );
    return 0;
  }
  if (argv.includes("--json")) {
    process.stdout.write(JSON.stringify(AGENT_CLI_PROFILES, null, 2) + "\n");
    return 0;
  }
  for (const p of AGENT_CLI_PROFILES) {
    const events = p.hookInstall.events.map((e) => e.event).join(",");
    process.stdout.write(
      `${p.id.padEnd(8)} ${p.displayName.padEnd(12)} binary=${p.binary.padEnd(8)} hooks→${p.hookInstall.target} [${events}]\n`,
    );
  }
  return 0;
}
