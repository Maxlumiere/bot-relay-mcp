// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1.6 — `relay purge-history <agent-name>` subcommand.
 *
 * Operator-driven clean slate for reused agent names. Deletes every message
 * + task where the agent is sender or recipient. Preserves the agent row
 * itself (use `relay recover` for that) and the audit_log (forensic record).
 *
 * Complements `relay recover`: recover PRESERVES messages (by design, for
 * cross-session handoff); purge-history DESTROYS them (operator opt-in, for
 * clean-slate onboarding of a reused name).
 *
 * Filesystem-gated: FS access to the DB = operator authority, same trust
 * boundary the daemon itself relies on (same contract as relay recover).
 */
import os from "os";
import fs from "fs";
import path from "path";
import * as readline from "readline/promises";

interface Args {
  name: string | null;
  yes: boolean;
  dryRun: boolean;
  dbPath: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { name: null, yes: false, dryRun: false, dbPath: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--db-path") {
      const v = argv[++i];
      if (!v) {
        process.stderr.write("--db-path requires a path argument\n");
        throw new Error("missing --db-path value");
      }
      out.dbPath = v;
    } else if (!a.startsWith("-") && !out.name) {
      out.name = a;
    } else {
      process.stderr.write(`Unknown argument: ${a}\n`);
      throw new Error("unknown arg");
    }
  }
  return out;
}

function printUsage(): void {
  process.stdout.write(
    "Usage: relay purge-history <agent-name> [--yes] [--dry-run] [--db-path PATH]\n\n" +
      "Deletes every message + task where <agent-name> is sender or recipient.\n" +
      "Use this for reused agent names where prior-session backlog would confuse\n" +
      "a fresh spawn. Does NOT delete the agent row (see `relay recover`) or\n" +
      "audit_log entries (forensic record preserved).\n\n" +
      "Options:\n" +
      "  --yes         Skip the interactive confirmation prompt.\n" +
      "  --dry-run     Show counts that would be deleted, commit nothing.\n" +
      "  --db-path P   Operate on the DB at P (default: $RELAY_DB_PATH or\n" +
      "                ~/.bot-relay/relay.db).\n" +
      "  --help        Show this message.\n\n" +
      "Trust model: filesystem access = operator authority. Complements\n" +
      "`relay recover` — recover preserves messages (cross-session handoff);\n" +
      "purge-history destroys them (clean-slate onboarding).\n"
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
  if (!args.name) {
    process.stderr.write("relay purge-history: missing <agent-name>\n\n");
    printUsage();
    return 1;
  }

  // Apply --db-path before the DB init so initializeDb sees it.
  if (args.dbPath) {
    process.env.RELAY_DB_PATH = args.dbPath;
  }
  const resolvedDbPath = process.env.RELAY_DB_PATH;
  if (args.dbPath && resolvedDbPath) {
    const parent = path.dirname(resolvedDbPath);
    if (parent && parent !== "." && !fs.existsSync(parent)) {
      process.stderr.write(
        `relay purge-history: --db-path parent directory does not exist: ${parent}\n`
      );
      return 2;
    }
  }

  // Mirror `relay recover`'s unknown-DB guard: refuse to operate on a DB
  // that isn't a bot-relay-mcp DB. Probe BEFORE initializeDb so the normal
  // migration flow can't silently turn an unknown DB into a "valid" one.
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
            `relay purge-history: DB at ${resolvedDbPath} is missing bot-relay-mcp schema ` +
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
        `relay purge-history: could not probe DB schema: ${err instanceof Error ? err.message : String(err)}\n`
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
      `relay purge-history: could not open DB: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 2;
  }

  try {
    // Pre-count so the operator sees what they're about to destroy. These
    // counts are also surfaced in the final success message so post-run
    // audit readers can correlate the delete with the operator intent.
    const msgRow = db
      .prepare(
        "SELECT COUNT(*) AS c FROM messages WHERE from_agent = ? OR to_agent = ?"
      )
      .get(args.name, args.name) as { c: number };
    const taskRow = db
      .prepare(
        "SELECT COUNT(*) AS c FROM tasks WHERE from_agent = ? OR to_agent = ?"
      )
      .get(args.name, args.name) as { c: number };

    const agentRow = db
      .prepare("SELECT name FROM agents WHERE name = ?")
      .get(args.name) as { name: string } | undefined;

    process.stdout.write(
      `Purge history for "${args.name}":\n` +
        `  agent row:       ${agentRow ? "exists (will be PRESERVED)" : "not registered (purge will still clear orphan history)"}\n` +
        `  messages:        ${msgRow.c} to delete\n` +
        `  tasks:           ${taskRow.c} to delete\n` +
        `  audit_log:       preserved (forensic record)\n`
    );

    if (msgRow.c === 0 && taskRow.c === 0) {
      process.stdout.write("\nNothing to purge — no messages or tasks reference this agent.\n");
      return 0;
    }

    if (args.dryRun) {
      process.stdout.write(
        `\nDRY RUN — would delete ${msgRow.c} message(s) and ${taskRow.c} task(s). No changes committed.\n`
      );
      return 0;
    }

    if (!args.yes) {
      process.stdout.write(
        `\nDelete ${msgRow.c} message(s) and ${taskRow.c} task(s) where "${args.name}" is sender or recipient?\n` +
          "This CANNOT be undone. The agent row itself is preserved.\n"
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
    const structured = {
      operator,
      target: args.name,
      source: "relay purge-history CLI",
      messages_expected: msgRow.c,
      tasks_expected: taskRow.c,
    };

    const { logAudit, purgeAgentHistory } = await import("../db.js");
    // Wrap purge + audit in a single transaction so the row-count in audit
    // params matches what actually landed. purgeAgentHistory already opens
    // its own transaction — SQLite supports nested txns via savepoints, and
    // better-sqlite3 exposes this through `db.transaction` composition.
    let result: { messages_deleted: number; tasks_deleted: number } = {
      messages_deleted: 0,
      tasks_deleted: 0,
    };
    const tx = db.transaction(() => {
      result = purgeAgentHistory(args.name!);
      logAudit(
        args.name!,
        "purge-history.cli",
        `operator=${operator} target=${args.name} messages=${result.messages_deleted} tasks=${result.tasks_deleted}`,
        true,
        null,
        "cli",
        { ...structured, messages_deleted: result.messages_deleted, tasks_deleted: result.tasks_deleted }
      );
    });
    tx();

    process.stdout.write(
      `\nPurge complete for "${args.name}".\n` +
        `  messages deleted: ${result.messages_deleted}\n` +
        `  tasks deleted:    ${result.tasks_deleted}\n` +
        `  agent row:        preserved\n` +
        `  audit_log entry:  purge-history.cli\n`
    );
    return 0;
  } catch (err) {
    process.stderr.write(
      `relay purge-history failed: ${err instanceof Error ? err.message : String(err)}\n`
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
