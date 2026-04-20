// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 4o — `relay recover <agent-name>` subcommand.
 *
 * Filesystem-gated lost-token recovery. Clears the agent row + capabilities
 * so the operator can re-bootstrap via register_agent. Messages and tasks
 * addressed to the agent are preserved.
 *
 * Not an MCP tool: the caller by definition cannot authenticate. FS access
 * to ~/.bot-relay/relay.db (0600 behind a 0700 dir per Phase 4c.4) IS the
 * authority — same trust boundary the daemon itself relies on.
 */
import os from "os";
import net from "net";
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
    "Usage: relay recover <agent-name> [--yes] [--dry-run] [--db-path PATH]\n\n" +
      "Clears an agent's registration so the operator can re-bootstrap via\n" +
      "register_agent. Use this when the agent's RELAY_AGENT_TOKEN was lost\n" +
      "(e.g. terminal restart) and the daemon now rejects register_agent with\n" +
      "AUTH_FAILED.\n\n" +
      "Options:\n" +
      "  --yes         Skip the interactive confirmation prompt.\n" +
      "  --dry-run     Show what would be deleted, commit nothing.\n" +
      "  --db-path P   Operate on the DB at P (default: $RELAY_DB_PATH or\n" +
      "                ~/.bot-relay/relay.db).\n" +
      "  --help        Show this message.\n\n" +
      "Trust model: filesystem access = operator authority. Messages and\n" +
      "tasks addressed to the agent are preserved across the reset.\n"
  );
}

/**
 * Best-effort probe: is a relay daemon listening on the expected HTTP port?
 * Returns true when a TCP connection succeeds within 300ms. Any error/timeout
 * is treated as "no running daemon" — this is a warning, not a gate.
 */
async function daemonListening(host: string, port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const sock = net.createConnection({ host, port });
    const done = (val: boolean) => {
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(val);
    };
    sock.setTimeout(300);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
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
    process.stderr.write("relay recover: missing <agent-name>\n\n");
    printUsage();
    return 1;
  }
  // Apply --db-path BEFORE initializeDb reads the env.
  if (args.dbPath) {
    process.env.RELAY_DB_PATH = args.dbPath;
  }

  // Fail fast if the parent dir doesn't exist — initializeDb would otherwise
  // create it under whatever mode the default gives us, which confuses the
  // "bad --db-path" contract in tests and docs. `path.dirname` handles both
  // POSIX `/` and Windows `\` separators (audit LOW #1).
  const resolvedDbPath = process.env.RELAY_DB_PATH;
  if (args.dbPath && resolvedDbPath) {
    const parent = path.dirname(resolvedDbPath);
    if (parent && parent !== "." && !fs.existsSync(parent)) {
      process.stderr.write(
        `relay recover: --db-path parent directory does not exist: ${parent}\n`
      );
      return 2;
    }
  }

  // Audit LOW #2: refuse to operate on a DB that isn't a bot-relay-mcp DB.
  // Probe BEFORE initializeDb so `CREATE TABLE IF NOT EXISTS` migrations
  // can't silently turn an unknown DB into a "valid" one. Only check when
  // the file already exists — if it doesn't, let initializeDb create a
  // fresh schema and the normal "not registered" path handles the lookup.
  if (resolvedDbPath && fs.existsSync(resolvedDbPath)) {
    try {
      const Better = (await import("better-sqlite3")).default;
      const probe = new Better(resolvedDbPath, { readonly: true, fileMustExist: true });
      try {
        const tables = probe
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('agents','agent_capabilities','audit_log')"
          )
          .all() as { name: string }[];
        if (tables.length !== 3) {
          const present = tables.map((t) => t.name).sort().join(", ") || "(none)";
          process.stderr.write(
            `relay recover: DB at ${resolvedDbPath} is missing bot-relay-mcp schema ` +
              `(expected tables: agents, agent_capabilities, audit_log; found: ${present}). ` +
              `Refusing to operate on an unknown DB.\n`
          );
          return 2;
        }
      } finally {
        probe.close();
      }
    } catch (err) {
      process.stderr.write(
        `relay recover: could not probe DB schema: ${err instanceof Error ? err.message : String(err)}\n`
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
      `relay recover: could not open DB: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 2;
  }

  try {
    const row = db
      .prepare(
        "SELECT name, role, capabilities, last_seen, token_hash, created_at FROM agents WHERE name = ?"
      )
      .get(args.name) as
      | {
          name: string;
          role: string;
          capabilities: string;
          last_seen: string;
          token_hash: string | null;
          created_at: string;
        }
      | undefined;

    if (!row) {
      process.stdout.write(
        `Agent "${args.name}" is not registered — nothing to recover.\n` +
          "Run register_agent to bootstrap a fresh identity.\n"
      );
      return 0;
    }

    let capsArr: string[] = [];
    try {
      capsArr = JSON.parse(row.capabilities || "[]");
      if (!Array.isArray(capsArr)) capsArr = [];
    } catch {
      capsArr = [];
    }

    process.stdout.write(`Found registration for "${row.name}":\n`);
    process.stdout.write(`  role:         ${row.role}\n`);
    process.stdout.write(
      `  capabilities: ${capsArr.length > 0 ? capsArr.join(", ") : "(none)"}\n`
    );
    process.stdout.write(`  last_seen:    ${row.last_seen}\n`);
    process.stdout.write(`  created_at:   ${row.created_at}\n`);
    process.stdout.write(
      `  token_hash:   ${row.token_hash ? "present" : "null (pre-v1.7 legacy row)"}\n`
    );

    // Best-effort daemon warning.
    const host = process.env.RELAY_HTTP_HOST || "127.0.0.1";
    const port = parseInt(process.env.RELAY_HTTP_PORT || "3777", 10);
    if (await daemonListening(host, port)) {
      process.stdout.write(
        `\nWARNING: relay daemon appears to be running on ${host}:${port}.\n` +
          "Recovery is safe at the SQLite layer (WAL allows concurrent writers),\n" +
          "but if this agent is currently connected it should disconnect before\n" +
          "re-registering to avoid a register/DELETE race.\n"
      );
    }

    if (args.dryRun) {
      process.stdout.write(
        `\nDRY RUN — would DELETE agents row "${row.name}" and ${capsArr.length} capability row(s).\n` +
          "Messages and tasks addressed to this agent would be preserved.\n" +
          "No changes committed.\n"
      );
      return 0;
    }

    if (!args.yes) {
      process.stdout.write(
        `\nClear registration for "${row.name}" and allow fresh re-bootstrap?\n` +
          "This will DELETE the agent row + capabilities but PRESERVE messages and tasks.\n"
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
      target: row.name,
      source: "relay recover CLI",
      dry_run: false,
    };

    // v2.1 Phase 7q: route the agents + agent_capabilities deletes through
    // the sanctioned `teardownAgent` helper. The audit entry still happens
    // in the same wrapping transaction so recover is either fully applied
    // (row gone + audit written) or fully absent (neither — on throw).
    const { logAudit, teardownAgent } = await import("../db.js");
    const tx = db.transaction(() => {
      teardownAgent(row.name, "recover");
      logAudit(
        row.name,
        "recovery.cli",
        `operator=${operator} target=${row.name}`,
        true,
        null,
        "cli",
        structured
      );
    });
    tx();

    process.stdout.write(
      `\nRecovery complete for "${row.name}". To re-register:\n\n` +
        "  1. In the agent's Claude Code terminal (or MCP client), call:\n" +
        "       register_agent({\n" +
        `         name: "${row.name}",\n` +
        `         role: "${row.role}",\n` +
        `         capabilities: ${JSON.stringify(capsArr)}\n` +
        "       })\n\n" +
        "  2. Capture the agent_token from the response.\n\n" +
        "  3. Save it so it survives terminal restarts:\n" +
        "       export RELAY_AGENT_TOKEN=<token-from-response>\n" +
        "       # To persist, add the line to your shell rc file.\n\n" +
        `Messages and tasks addressed to "${row.name}" are preserved and will be delivered\n` +
        "on the next get_messages / get_tasks call after re-register.\n"
    );
    return 0;
  } catch (err) {
    process.stderr.write(
      `relay recover failed: ${err instanceof Error ? err.message : String(err)}\n`
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
