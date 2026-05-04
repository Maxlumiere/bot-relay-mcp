// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.6.0 — `relay mint-token <name>` subcommand.
 *
 * Operator-side credential issuance for external CLI agents (Codex 5.5,
 * Cursor, future LLM clients) whose safety monitors block the
 * register_agent → use-token sequence inside a single response.
 *
 * Per `memory/feedback_codex_5_5_safety_blocks_register.md`: minting a
 * token outside the agent's process and exporting it as
 * `RELAY_AGENT_TOKEN` lets the agent authenticate on its first MCP call
 * without ever invoking register_agent itself, sidestepping the safety
 * pattern-match.
 *
 * Filesystem-gated like `relay recover`: the operator's read/write
 * access to the per-instance DB IS the authority — same trust boundary
 * the daemon relies on.
 */
import os from "os";
import net from "net";
import path from "path";
import fs from "fs";

interface Args {
  name: string | null;
  role: string;
  capabilities: string[];
  description: string | null;
  force: boolean;
  json: boolean;
  dbPath: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    name: null,
    role: "agent",
    capabilities: [],
    description: null,
    force: false,
    json: false,
    dbPath: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      out.help = true;
    } else if (a === "--force") {
      out.force = true;
    } else if (a === "--json") {
      out.json = true;
    } else if (a === "--role") {
      const v = argv[++i];
      if (!v) {
        process.stderr.write("--role requires a value\n");
        throw new Error("missing --role value");
      }
      out.role = v;
    } else if (a === "--capabilities") {
      const v = argv[++i];
      if (v === undefined) {
        process.stderr.write("--capabilities requires a comma-separated list\n");
        throw new Error("missing --capabilities value");
      }
      out.capabilities = v
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else if (a === "--description") {
      const v = argv[++i];
      if (v === undefined) {
        process.stderr.write("--description requires a value\n");
        throw new Error("missing --description value");
      }
      out.description = v;
    } else if (a === "--db-path") {
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
    "Usage: relay mint-token <name> [--role <role>] [--capabilities <c1,c2,...>]\n" +
      "                          [--description <text>] [--force] [--json]\n" +
      "                          [--db-path <path>]\n\n" +
      "Mint an agent token directly via filesystem access. Use this when an\n" +
      "external CLI client (e.g. Codex 5.5, Cursor) cannot run register_agent\n" +
      "in its own session because its safety monitor blocks the\n" +
      "register-then-use sequence as a credential handoff. The minted token\n" +
      "is exported into the agent's environment BEFORE the CLI launches; the\n" +
      "agent authenticates via env on its first MCP call without ever\n" +
      "invoking register_agent.\n\n" +
      "Behavior:\n" +
      "  - New name: INSERT a fresh agent row with role + caps from flags.\n" +
      "  - Existing name + --force: rotate token (caps PRESERVED per\n" +
      "    immutability rule; session_id cleared; agent_status=offline).\n" +
      "  - Existing name without --force: refused with a clear error.\n\n" +
      "Options:\n" +
      "  --role <role>           Role to record (default: \"agent\"). Mint-only;\n" +
      "                          ignored on --force rotate.\n" +
      "  --capabilities <list>   Comma-separated capability names. Mint-only;\n" +
      "                          ignored on --force rotate per the\n" +
      "                          caps-immutable-after-first-mint discipline.\n" +
      "  --description <text>    Optional human-readable description.\n" +
      "  --force                 Allow rotating the token of an existing agent.\n" +
      "                          Destructive: the prior token stops authenticating\n" +
      "                          on next MCP call. Caps + role are preserved.\n" +
      "  --json                  Emit structured JSON to stdout instead of the\n" +
      "                          human-readable block. Useful for CI scripts.\n" +
      "  --db-path PATH          Operate on the DB at PATH. Default: per-instance\n" +
      "                          DB (resolveInstanceDbPath) or $RELAY_DB_PATH.\n" +
      "  --help                  Show this message.\n\n" +
      "Trust model: filesystem access to the relay DB = operator authority.\n" +
      "The plaintext token is shown ONCE; the relay stores only a bcrypt hash.\n"
  );
}

/**
 * Best-effort probe: is a relay daemon listening on the expected HTTP port?
 * Mirrors the helper in cli/recover.ts. 300ms TCP connect attempt.
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
    process.stderr.write("relay mint-token: missing <name>\n\n");
    printUsage();
    return 1;
  }
  // Apply --db-path BEFORE initializeDb reads RELAY_DB_PATH. When omitted,
  // the daemon's own resolver (resolveInstanceDbPath) picks the active
  // per-instance DB OR falls back to ~/.bot-relay/relay.db in single-
  // instance mode — exact same path the live daemon uses.
  if (args.dbPath) {
    process.env.RELAY_DB_PATH = args.dbPath;
  } else if (!process.env.RELAY_DB_PATH) {
    try {
      const { resolveInstanceDbPath } = await import("../instance.js");
      process.env.RELAY_DB_PATH = resolveInstanceDbPath();
    } catch {
      /* fall back to db.ts's default */
    }
  }

  const resolvedDbPath = process.env.RELAY_DB_PATH;
  if (args.dbPath && resolvedDbPath) {
    const parent = path.dirname(resolvedDbPath);
    if (parent && parent !== "." && !fs.existsSync(parent)) {
      process.stderr.write(
        `relay mint-token: --db-path parent directory does not exist: ${parent}\n`
      );
      return 2;
    }
  }

  // Daemon-running advisory. mint-token writes to the same per-instance DB
  // the daemon reads; SQLite WAL mode handles concurrent writes safely. WARN
  // (not refuse) per the v2.6 brief Item 3.7 lock — refusing would break the
  // common case (operator onboards a new external CLI agent while the
  // daemon serves existing agents normally).
  const host = process.env.RELAY_HTTP_HOST || "127.0.0.1";
  const port = parseInt(process.env.RELAY_HTTP_PORT || "3777", 10);
  const daemonUp = await daemonListening(host, port);
  if (daemonUp && !args.json) {
    process.stderr.write(
      `\n⚠ Daemon currently running on ${host}:${port}. Token mint applied to live DB.\n` +
        "  The new token is effective immediately for new MCP calls.\n" +
        "  Existing sessions using the old token will start failing on next call.\n" +
        "  If this rotation was intended for an active session, the agent process\n" +
        "  must be restarted with the new RELAY_AGENT_TOKEN before its next call.\n\n"
    );
  }

  let db: any;
  try {
    const { initializeDb, getDb } = await import("../db.js");
    await initializeDb();
    db = getDb();
  } catch (err) {
    process.stderr.write(
      `relay mint-token: could not open DB: ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 2;
  }

  try {
    const { mintAgentToken, logAudit } = await import("../db.js");

    let result: { agent: { id: string; name: string }; plaintext_token: string; created: boolean };
    try {
      result = mintAgentToken(args.name, args.role, args.capabilities, {
        description: args.description,
        force: args.force,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`relay mint-token: ${msg}\n`);
      // Audit the refusal too — security-sensitive op deserves a paper trail
      // even when refused.
      try {
        const operator = currentOperator();
        logAudit(
          args.name,
          "agent.token_minted",
          `operator=${operator} target=${args.name} force=${args.force} success=false`,
          false,
          msg,
          "cli",
          {
            operator,
            target: args.name,
            force: args.force,
            success: false,
            error: msg,
          }
        );
      } catch {
        /* best-effort */
      }
      return 2;
    }

    const operator = currentOperator();
    logAudit(
      args.name,
      "agent.token_minted",
      `operator=${operator} target=${args.name} ${
        result.created ? "created=true" : "rotated=true"
      } force=${args.force}`,
      true,
      null,
      "cli",
      {
        operator,
        target: args.name,
        created: result.created,
        rotated: !result.created,
        force: args.force,
        agent_id: result.agent.id,
      }
    );

    if (args.json) {
      const out = {
        success: true,
        token: result.plaintext_token,
        name: result.agent.name,
        agent_id: result.agent.id,
        created: result.created,
        force: args.force,
        env_block: `RELAY_AGENT_NAME=${result.agent.name}\nRELAY_AGENT_TOKEN=${result.plaintext_token}`,
      };
      process.stdout.write(JSON.stringify(out) + "\n");
      return 0;
    }

    process.stdout.write(
      `\n✓ ${result.created ? "Minted token for new agent" : "Rotated token for existing agent"} ` +
        `"${result.agent.name}"\n\n` +
        "Token (shown ONCE — store it now):\n\n" +
        `  ${result.plaintext_token}\n\n` +
        "Set in your CLI's environment before launching:\n\n" +
        `  export RELAY_AGENT_NAME=${result.agent.name}\n` +
        `  export RELAY_AGENT_TOKEN=${result.plaintext_token}\n\n` +
        "See docs/agents/external-cli-setup.md for the full setup walkthrough\n" +
        "and token storage best practices.\n"
    );
    return 0;
  } catch (err) {
    process.stderr.write(
      `relay mint-token failed: ${err instanceof Error ? err.message : String(err)}\n`
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
