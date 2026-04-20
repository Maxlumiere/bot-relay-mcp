// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 4h — `relay backup` subcommand (absorbs the standalone
 * bin/relay-backup from Phase 2c).
 *
 * Thin wrapper over exportRelayState. Arg parsing + exit-code contract live
 * here; the actual snapshot logic stays in src/backup.ts.
 */
import { exportRelayState } from "../backup.js";

function parseArgs(argv: string[]): { output: string | null; help: boolean } {
  const out: { output: string | null; help: boolean } = { output: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--output" || a === "-o") {
      out.output = argv[++i];
    } else if (a === "--help" || a === "-h") {
      out.help = true;
    } else {
      process.stderr.write(`Unknown argument: ${a}\n`);
      throw new Error("unknown arg");
    }
  }
  return out;
}

export async function run(argv: string[]): Promise<number> {
  let args;
  try {
    args = parseArgs(argv);
  } catch {
    return 1;
  }
  if (args.help) {
    process.stdout.write(
      "Usage: relay backup [--output PATH]\n\n" +
        "Creates a consistent tar.gz snapshot of the relay DB + config.\n" +
        "Default destination: ~/.bot-relay/backups/relay-backup-<iso>.tar.gz\n"
    );
    return 0;
  }
  try {
    const result = await exportRelayState({ destinationPath: args.output ?? undefined });
    process.stdout.write(
      `Backup written: ${result.archive_path} (${result.bytes} bytes, schema_version=${result.schema_version})\n`
    );
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`relay backup failed: ${msg}\n`);
    return 1;
  }
}
