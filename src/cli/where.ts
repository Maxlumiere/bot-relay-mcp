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
 * --expect-db PATH exits 0 only when the resolution names that same DB (compared
 * by real path): a one-environment check. The full pre-restart check, which also
 * proves WHICH environment and WHICH open DB, is `relay deploy-gate`.
 *
 * --fields prints the same answer for a SHELL (the hooks): exactly six lines,
 * kind, db_path, exists, reason, warning, vault_dir (empty lines where a field
 * does not apply), read with plain `read -r`. It is fail-closed: a resolved PATH
 * containing a line break cannot be split across lines, so it is refused as the
 * error kind, and so is one with any other control character (C0 or DEL); a
 * control character in a reason or warning becomes a space.
 *
 * --env-keys prints the environment variables the resolver reads (one per line;
 * a JSON array with --json) and exits 0: the ONLY keys the deploy gate passes on
 * from a running daemon, and the only ones it prints.
 *
 * Exit: 0 = resolved (and matches --expect-db, when given) · 1 = the resolver
 * reported a fault, or --expect-db does not match · 2 = usage error.
 */
import fs from "fs";
import path from "path";
import { BUILD_INFO } from "../build-info.js";

interface Args {
  json: boolean;
  dbPath: string | null;
  expectDb: string | null;
  envKeys: boolean;
  fields: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { json: false, dbPath: null, expectDb: null, envKeys: false, fields: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--env-keys") args.envKeys = true;
    else if (a === "--fields") args.fields = true;
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
    "Usage: relay where [--json | --fields] [--db-path P] [--expect-db PATH]\n" +
    "       relay where --env-keys [--json]\n\n" +
    "Which relay DB this environment resolves to (the one strict resolver, ADR-0048).\n" +
    "Read-only. --expect-db PATH exits 1 unless the resolution names that DB (for\n" +
    "the full pre-restart check, see relay deploy-gate).\n" +
    "--fields prints six lines for a shell: kind, db_path, exists, reason, warning, vault_dir.\n" +
    "--env-keys lists the environment variables the resolver reads.\n\n" +
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
  const { resolveInstance, serializeResolution, RESOLVER_ENV_KEYS, RESOLVER_REVISION } = await import("../instance.js");
  if (args.envKeys) {
    process.stdout.write(args.json ? JSON.stringify(RESOLVER_ENV_KEYS) + "\n" : RESOLVER_ENV_KEYS.join("\n") + "\n");
    return 0;
  }
  let r = resolveInstance(args.dbPath ? { dbPath: args.dbPath } : {});
  if (args.fields && r.kind !== "error" && /[\r\n]/.test(r.dbPath)) {
    r = { kind: "error", reason: "the resolved DB path contains a line break, which a line-per-field answer cannot carry: refused" };
  } else if (args.fields && r.kind !== "error" && /[\x00-\x1f\x7f]/.test(r.dbPath)) {
    r = { kind: "error", reason: "the resolved DB path contains a control character, which a shell must never be handed as a path: refused" };
  }
  const vaultDir = r.kind === "error" ? null : path.join(path.dirname(r.dbPath), "agents");

  if (args.fields) {
    const oneLine = (v: string | undefined) => (v ?? "").replace(/[\x00-\x1f\x7f]+/g, " ");
    const lines =
      r.kind === "error"
        ? ["error", "", "", oneLine(r.reason), "", ""]
        : [r.kind, r.dbPath, String(r.exists), "", r.kind === "flat" ? oneLine(r.warning) : "", vaultDir ?? ""];
    process.stdout.write(lines.join("\n") + "\n");
  } else if (args.json) {
    process.stdout.write(JSON.stringify({ resolution: serializeResolution(r), vault_dir: vaultDir, resolver_revision: RESOLVER_REVISION, build: BUILD_INFO }) + "\n");
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
