// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * `relay convert-journal --to wasm|native [--db-path PATH] [--json]`: INV-DB-01 slice 4. It converts this instance's DB
 * between the native and the wasm driver, offline, under its single-owner lock, and writes the instance's
 * sqlite_driver (src/convert-journal.ts). Exit: 0 converted (or already converted), 1 refused, 2 usage.
 */
import { convertJournal, CLOSE_EVERYTHING_FIRST, type ConvertTarget } from "../convert-journal.js";

interface Args {
  to: string | null;
  dbPath: string | null;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args | string {
  const out: Args = { to: null, dbPath: null, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--json") out.json = true;
    else if (a === "--to") {
      const v = argv[++i];
      if (!v) return "--to requires wasm or native";
      out.to = v;
    } else if (a === "--db-path") {
      const v = argv[++i];
      if (!v) return "--db-path requires a path";
      out.dbPath = v;
    } else return `unknown argument: ${a}`;
  }
  return out;
}

function usage(requested: boolean): void {
  const text =
    "Usage: relay convert-journal --to wasm|native [--db-path PATH] [--json]\n" +
    "Converts this instance's database between the native and the wasm driver, offline, and sets the instance's\n" +
    "sqlite_driver. " + CLOSE_EVERYTHING_FIRST + "\n";
  (requested ? process.stdout : process.stderr).write(text);
}

export async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === "string") {
    process.stderr.write(`relay convert-journal: ${args}\n\n`);
    usage(false);
    return 2;
  }
  if (args.help) {
    usage(true);
    return 0;
  }
  if (args.to !== "wasm" && args.to !== "native") {
    process.stderr.write(`relay convert-journal: --to must be wasm or native${args.to ? ` (got ${JSON.stringify(args.to)})` : ""}\n\n`);
    usage(false);
    return 2;
  }
  if (args.dbPath) process.env.RELAY_DB_PATH = args.dbPath;
  process.stderr.write(`relay convert-journal: ${CLOSE_EVERYTHING_FIRST}\n`);
  try {
    const r = await convertJournal({ to: args.to as ConvertTarget, ...(args.dbPath ? { dbPath: args.dbPath } : {}) });
    if (args.json) process.stdout.write(JSON.stringify(r) + "\n");
    else {
      process.stdout.write(
        `${r.converted ? "Converted" : "Already converted"}: ${r.dbPath} is now ${r.to} (header ${r.header}, journal ${r.journal}, ` +
          `integrity ${r.integrity}); ${r.configPath} declares sqlite_driver "${r.config}".\n`
      );
    }
    return 0;
  } catch (err) {
    process.stderr.write(`relay convert-journal: ${(err as Error).message}\n`);
    return 1;
  }
}
