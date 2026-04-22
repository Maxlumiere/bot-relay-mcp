// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.2.2 B3.c — `relay purge-agents [--abandoned-since=N] [--apply]` subcommand.
 *
 * Prunes agents whose last_seen is older than N days (default 7, the same
 * threshold RELAY_AGENT_ABANDON_DAYS uses to promote to
 * `agent_status: "abandoned"` in snapshots). Dry-run by default — `--apply`
 * is required to commit. Audit log receives one entry per deleted agent.
 *
 * Filesystem-gated, same trust boundary as `relay recover` and
 * `relay purge-history`: FS access to the DB IS the operator authority.
 * Messages + tasks referencing the deleted agent are NOT touched (use
 * `relay purge-history` separately if desired — different retention policy).
 */
import os from "os";
import fs from "fs";
import path from "path";
import * as readline from "readline/promises";

interface Args {
  abandonedSinceDays: number;
  apply: boolean;
  yes: boolean;
  dbPath: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    abandonedSinceDays: 7,
    apply: false,
    yes: false,
    dbPath: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--apply") out.apply = true;
    else if (a === "--abandoned-since" || a === "--since") {
      const v = argv[++i];
      if (!v) {
        process.stderr.write("--abandoned-since requires a positive integer (days)\n");
        throw new Error("missing --abandoned-since value");
      }
      const n = parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) {
        process.stderr.write(`--abandoned-since: expected a positive integer of days, got "${v}"\n`);
        throw new Error("invalid --abandoned-since value");
      }
      out.abandonedSinceDays = n;
    } else if (a.startsWith("--abandoned-since=")) {
      const v = a.slice("--abandoned-since=".length);
      const n = parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) {
        process.stderr.write(`--abandoned-since=: expected a positive integer of days, got "${v}"\n`);
        throw new Error("invalid --abandoned-since value");
      }
      out.abandonedSinceDays = n;
    } else if (a === "--db-path") {
      const v = argv[++i];
      if (!v) {
        process.stderr.write("--db-path requires a path argument\n");
        throw new Error("missing --db-path value");
      }
      out.dbPath = v;
    } else {
      process.stderr.write(`Unknown argument: ${a}\n`);
      throw new Error("unknown arg");
    }
  }
  return out;
}

function printUsage(): void {
  process.stdout.write(
    "Usage: relay purge-agents [--abandoned-since=N] [--apply] [--yes] [--db-path PATH]\n\n" +
      "Prunes agent rows whose last_seen is older than N days (default 7 —\n" +
      "matches RELAY_AGENT_ABANDON_DAYS). Dry-run by default; pass --apply to\n" +
      "commit deletions. Messages + tasks are NOT touched (see `relay\n" +
      "purge-history` for that).\n\n" +
      "Options:\n" +
      "  --abandoned-since=N  Days of silence before an agent is eligible for\n" +
      "                       purge. Default: 7.\n" +
      "  --apply              Commit deletions. Without this flag, the command\n" +
      "                       prints the target list and exits (safe default).\n" +
      "  --yes                Skip the interactive confirmation prompt (only\n" +
      "                       relevant with --apply).\n" +
      "  --db-path P          Operate on the DB at P (default: $RELAY_DB_PATH\n" +
      "                       or ~/.bot-relay/relay.db).\n" +
      "  --help               Show this message.\n\n" +
      "Trust model: filesystem access = operator authority.\n"
  );
}

function currentOperator(): string {
  try {
    return os.userInfo().username || "unknown";
  } catch {
    return "unknown";
  }
}

export async function run(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch {
    return 1;
  }
  if (args.help) {
    printUsage();
    return 0;
  }

  if (args.dbPath) {
    process.env.RELAY_DB_PATH = args.dbPath;
  }
  const resolvedDbPath = process.env.RELAY_DB_PATH;
  if (args.dbPath && resolvedDbPath) {
    const parent = path.dirname(resolvedDbPath);
    if (parent && parent !== "." && !fs.existsSync(parent)) {
      process.stderr.write(
        `relay purge-agents: --db-path parent directory does not exist: ${parent}\n`
      );
      return 2;
    }
  }

  if (resolvedDbPath && fs.existsSync(resolvedDbPath)) {
    try {
      const Better = (await import("better-sqlite3")).default;
      const probe = new Better(resolvedDbPath, { readonly: true, fileMustExist: true });
      try {
        const tables = probe
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('agents','messages','tasks')"
          )
          .all() as { name: string }[];
        if (tables.length !== 3) {
          const present = tables.map((t) => t.name).sort().join(", ") || "(none)";
          process.stderr.write(
            `relay purge-agents: DB at ${resolvedDbPath} is missing bot-relay-mcp schema ` +
              `(expected tables: agents, messages, tasks; found: ${present}). ` +
              `Refusing to operate on an unknown DB.\n`
          );
          return 2;
        }
      } finally {
        probe.close();
      }
    } catch (err) {
      process.stderr.write(
        `relay purge-agents: could not probe DB schema: ${err instanceof Error ? err.message : String(err)}\n`
      );
      return 2;
    }
  }

  let db: any;
  try {
    const { initializeDb, getDb } = await import("../db.js");
    await initializeDb();
    db = getDb();
  } catch (err) {
    process.stderr.write(
      `relay purge-agents: could not open DB: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 2;
  }

  try {
    const cutoffIso = new Date(Date.now() - args.abandonedSinceDays * 24 * 60 * 60 * 1000).toISOString();
    const { listAgentsOlderThan } = await import("../db.js");
    const candidates = listAgentsOlderThan(cutoffIso).map((r) => ({
      name: r.name,
      role: r.role,
      last_seen: r.last_seen,
      agent_status: r.agent_status ?? "idle",
    }));

    if (candidates.length === 0) {
      process.stdout.write(
        `No agents have last_seen older than ${args.abandonedSinceDays} day(s) (cutoff ${cutoffIso}).\n`
      );
      return 0;
    }

    process.stdout.write(
      `Agents eligible for purge (last_seen < ${cutoffIso}, ${args.abandonedSinceDays}-day threshold):\n`
    );
    for (const c of candidates) {
      process.stdout.write(
        `  - ${c.name.padEnd(32)}  role=${c.role.padEnd(18)} last_seen=${c.last_seen} stored_status=${c.agent_status}\n`
      );
    }
    process.stdout.write(`\n${candidates.length} agent row(s) match.\n`);

    if (!args.apply) {
      process.stdout.write(
        `\nDRY RUN — no deletions. Pass --apply to commit.\n` +
        `Messages and tasks referencing these agents are NOT deleted (use ` +
        `\`relay purge-history <name>\` per-agent if desired).\n`
      );
      return 0;
    }

    if (!args.yes) {
      process.stdout.write(
        `\nDelete ${candidates.length} agent row(s)? Messages + tasks preserved. This CANNOT be undone.\n`
      );
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const ans = (await rl.question("[y/N]: ")).trim().toLowerCase();
        if (ans !== "y" && ans !== "yes") {
          process.stdout.write("Aborted — no changes made.\n");
          return 1;
        }
      } finally {
        rl.close();
      }
    }

    const operator = currentOperator();
    const { logAudit, deleteAgentIfAbandoned } = await import("../db.js");

    let deleted = 0;
    const tx = db.transaction(() => {
      for (const c of candidates) {
        const landed = deleteAgentIfAbandoned(c.name, cutoffIso);
        if (landed) {
          deleted += 1;
          logAudit(
            c.name,
            "purge-agents.cli",
            `operator=${operator} target=${c.name} last_seen=${c.last_seen} threshold_days=${args.abandonedSinceDays}`,
            true,
            null,
            "cli",
            {
              operator,
              target: c.name,
              role: c.role,
              last_seen: c.last_seen,
              threshold_days: args.abandonedSinceDays,
              source: "relay purge-agents CLI",
            }
          );
        }
      }
    });
    tx();

    process.stdout.write(
      `\nPurge complete. ${deleted} agent row(s) deleted. Audit entries tagged purge-agents.cli.\n`
    );
    return 0;
  } catch (err) {
    process.stderr.write(
      `relay purge-agents failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 2;
  } finally {
    try {
      const { closeDb } = await import("../db.js");
      closeDb();
    } catch {
      /* ignore */
    }
  }
}
