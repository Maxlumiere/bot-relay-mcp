// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * `relay where` — WHICH relay DB this environment resolves to, as the ONE strict
 * resolver sees it (ADR-0048, src/instance.ts resolveInstance). Read-only: it
 * opens nothing and writes nothing.
 *
 * --json prints the CLOSED result from the SAME serializer `relay pending --json`
 * embeds (a contract test holds the two equal), plus the vault directory, which
 * always lives beside the DB.
 *
 * --expect-db PATH is the DEPLOY GATE: exit 0 only when the resolution names that
 * same DB (compared by real path). Run it with the NEW build under the RUNNING
 * daemon's environment before restarting the daemon onto the new build: if it
 * names a different DB, the restart would put the daemon on the wrong mailbox.
 *
 * Exit: 0 = resolved (and matches --expect-db, when given) · 1 = the resolver
 * reported a fault, or --expect-db does not match · 2 = usage error.
 */
import fs from "fs";
import path from "path";

interface Args {
  json: boolean;
  dbPath: string | null;
  expectDb: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { json: false, dbPath: null, expectDb: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--db-path" || a === "--expect-db") {
      const v = argv[++i];
      if (!v) throw new Error(`${a} requires a path`);
      if (a === "--db-path") args.dbPath = v;
      else args.expectDb = v;
    } else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

function usage(requested = false): void {
  const text =
    "Usage: relay where [--json] [--db-path P] [--expect-db PATH]\n\n" +
    "Which relay DB this environment resolves to (the one strict resolver, ADR-0048).\n" +
    "Read-only. --expect-db PATH exits 1 unless the resolution names that DB (the\n" +
    "deploy gate: run it with the new build under the running daemon's environment).\n\n" +
    "Exit: 0 = resolved (and matched) · 1 = a resolver fault, or no match · 2 = usage.\n";
  if (requested) process.stdout.write(text);
  else process.stderr.write(text);
}

/** Real path when it exists, else the absolute path: the comparison key for --expect-db. */
function sameFileKey(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

export async function run(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`relay where: ${err instanceof Error ? err.message : String(err)}\n\n`);
    usage();
    return 2;
  }
  if (args.help) {
    usage(true);
    return 0;
  }
  const { resolveInstance, serializeResolution } = await import("../instance.js");
  const r = resolveInstance(args.dbPath ? { dbPath: args.dbPath } : {});
  const vaultDir = r.kind === "error" ? null : path.join(path.dirname(r.dbPath), "agents");

  if (args.json) {
    process.stdout.write(JSON.stringify({ resolution: serializeResolution(r), vault_dir: vaultDir }) + "\n");
  } else if (r.kind === "error") {
    process.stdout.write(`[RELAY] instance resolution FAILED: ${r.reason}\n`);
  } else {
    const who = r.kind === "instance" ? `instance ${r.id} (${r.basis})` : r.kind === "flat" ? "flat layout" : `explicit DB (${r.basis})`;
    process.stdout.write(`[RELAY] ${who}: ${r.dbPath}${r.exists ? "" : " (does not exist yet)"}\n`);
    if (r.kind === "flat" && r.warning) process.stdout.write(`[RELAY] WARNING: ${r.warning}\n`);
  }

  if (r.kind === "error") {
    process.stderr.write(`WHERE_FAILED: ${r.reason}\n`);
    return 1;
  }
  if (args.expectDb) {
    const got = sameFileKey(r.dbPath);
    const want = sameFileKey(args.expectDb);
    if (got !== want) {
      process.stderr.write(`WHERE_MISMATCH: this environment resolves to ${got}, not the expected ${want}\n`);
      return 1;
    }
    process.stderr.write(`WHERE_MATCH: ${got}\n`);
  }
  return 0;
}
