// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.4.0 Part E.3 — `relay use-instance <id>` CLI subcommand.
 *
 * kubectl-style context switch: writes `~/.bot-relay/active-instance`
 * pointing at the chosen instance so subsequent `relay` CLI calls
 * (doctor, backup, recover, purge-agents, etc.) operate on that
 * instance without needing `RELAY_INSTANCE_ID` every time.
 *
 * The daemon still respects `RELAY_INSTANCE_ID` if set at launch — the
 * active-instance symlink is a CLI convenience, not an override for
 * running daemons.
 */
import { setActiveInstance, readInstance, resolveActiveInstanceId } from "../instance.js";

function printUsage(): void {
  process.stdout.write(
    "Usage: relay use-instance <instance-id>\n\n" +
      "Sets the active bot-relay instance for subsequent CLI calls.\n" +
      "Writes ~/.bot-relay/active-instance pointing at the chosen id.\n\n" +
      "Options:\n" +
      "  --help   Show this message.\n\n" +
      "See also: relay list-instances, relay init --instance-id.\n"
  );
}

export async function run(argv: string[]): Promise<number> {
  let id: string | null = null;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      printUsage();
      return 0;
    }
    if (arg.startsWith("--")) {
      process.stderr.write(`relay use-instance: unknown argument "${arg}"\n\n`);
      printUsage();
      return 1;
    }
    if (!id) id = arg;
    else {
      process.stderr.write("relay use-instance: accepts exactly one <instance-id> positional arg\n\n");
      printUsage();
      return 1;
    }
  }
  if (!id) {
    process.stderr.write("relay use-instance: missing <instance-id>\n\n");
    printUsage();
    return 1;
  }
  const meta = readInstance(id);
  if (!meta) {
    process.stderr.write(
      `relay use-instance: instance "${id}" not found. ` +
      `Run \`relay list-instances\` to see available ids, ` +
      `or \`relay init --instance-id=${id}\` to create it.\n`,
    );
    return 2;
  }
  setActiveInstance(id);
  const confirmed = resolveActiveInstanceId();
  process.stdout.write(
    `Active instance set to "${id}" (label: ${meta.label ?? "-"}, ` +
    `first seen on ${meta.daemon_version_first_seen}).\n`,
  );
  if (confirmed !== id) {
    process.stderr.write(
      "WARNING: resolveActiveInstanceId() returned " + confirmed +
      " after set — filesystem semantics may be unusual.\n",
    );
  }
  return 0;
}
