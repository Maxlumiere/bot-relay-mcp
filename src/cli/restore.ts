// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 4h — `relay restore` subcommand (absorbs the standalone
 * bin/relay-restore from Phase 2c).
 */
import { importRelayState } from "../backup.js";

function parseArgs(argv: string[]): { path: string | null; force: boolean; help: boolean } {
  const out: { path: string | null; force: boolean; help: boolean } = {
    path: null,
    force: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force" || a === "-f") {
      out.force = true;
    } else if (a === "--help" || a === "-h") {
      out.help = true;
    } else if (!out.path && !a.startsWith("-")) {
      out.path = a;
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
      "Usage: relay restore PATH [--force]\n\n" +
        "Restores the relay DB from a tar.gz snapshot.\n\n" +
        "Options:\n" +
        "  --force    Proceed even if the daemon is running or schema is older.\n"
    );
    return 0;
  }
  if (!args.path) {
    process.stderr.write("Usage: relay restore PATH [--force]\n");
    return 1;
  }
  try {
    const result = await importRelayState(args.path, { force: args.force });
    process.stdout.write(
      `Restore complete. schema_version=${result.schema_version}, previous DB saved to: ${
        result.previous_backup_path || "(none — no prior DB)"
      }\n`
    );
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`relay restore failed: ${msg}\n`);
    return 1;
  }
}
