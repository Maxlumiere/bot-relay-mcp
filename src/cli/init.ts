// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 4h — `relay init` subcommand.
 *
 * Interactive first-run setup. Writes ~/.bot-relay/config.json (0600), creates
 * ~/.bot-relay/ (0700), prints copy-paste-ready MCP server entry for
 * ~/.claude.json.
 *
 * Non-interactive mode via --yes: defaults only, no prompts, HTTP transport,
 * port 3777, random 32-byte base64 HTTP secret, hooks NOT auto-installed
 * (explicit opt-in via --install-hooks).
 *
 * Idempotent: refuses if ~/.bot-relay/config.json exists unless --force.
 */
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import readline from "readline/promises";
import { ensureSecureDir, ensureSecureFile } from "../fs-perms.js";

function defaultBotRelayDir(): string {
  return path.join(os.homedir(), ".bot-relay");
}

function defaultConfigPath(): string {
  return process.env.RELAY_CONFIG_PATH || path.join(defaultBotRelayDir(), "config.json");
}

interface ParsedArgs {
  yes: boolean;
  force: boolean;
  installHooks: boolean;
  help: boolean;
  port?: number;
  transport?: string;
  secret?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { yes: false, force: false, installHooks: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--force") out.force = true;
    else if (a === "--install-hooks") out.installHooks = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--port") out.port = parseInt(argv[++i], 10);
    else if (a === "--transport") out.transport = argv[++i];
    else if (a === "--secret") out.secret = argv[++i];
    else {
      process.stderr.write(`Unknown argument: ${a}\n`);
      throw new Error("unknown arg");
    }
  }
  return out;
}

async function promptWithDefault(rl: readline.Interface, q: string, def: string): Promise<string> {
  const ans = await rl.question(`${q} [${def}]: `);
  return ans.trim() || def;
}

export async function run(argv: string[]): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch {
    return 1;
  }
  if (args.help) {
    process.stdout.write(
      "Usage: relay init [--yes] [--force] [--install-hooks] [--port N] [--transport stdio|http|both] [--secret STRING]\n\n" +
        "Interactive first-run setup. Writes ~/.bot-relay/config.json (0600).\n\n" +
        "Options:\n" +
        "  --yes              Non-interactive — accept defaults, generate random secret.\n" +
        "  --force            Overwrite an existing config.json.\n" +
        "  --install-hooks    Also install Claude Code hooks to ~/.claude/settings.json.\n" +
        "  --port N           HTTP port (default 3777).\n" +
        "  --transport X      stdio | http | both (default both).\n" +
        "  --secret STRING    HTTP secret (random 32-byte base64 if omitted).\n"
    );
    return 0;
  }

  const configPath = defaultConfigPath();
  if (fs.existsSync(configPath) && !args.force) {
    process.stderr.write(
      `relay init: ${configPath} already exists. Re-run with --force to overwrite, or edit the file directly.\n`
    );
    return 1;
  }

  let transport = args.transport ?? "both";
  let port = args.port ?? 3777;
  let secret = args.secret ?? crypto.randomBytes(32).toString("base64url");
  let wantHooks = args.installHooks;

  if (!args.yes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      process.stdout.write("\n=== relay init (interactive) ===\n\n");
      transport = await promptWithDefault(rl, "Transport (stdio/http/both)", transport);
      const portStr = await promptWithDefault(rl, "HTTP port", String(port));
      port = parseInt(portStr, 10) || 3777;
      const secAns = await rl.question(`HTTP secret (ENTER = generate random 32-byte base64): `);
      if (secAns.trim()) secret = secAns.trim();
      const hooksAns = await rl.question(`Install Claude Code hooks now? (y/N): `);
      wantHooks = /^y/i.test(hooksAns.trim());
    } finally {
      rl.close();
    }
  }

  // Validate transport.
  if (!["stdio", "http", "both"].includes(transport)) {
    process.stderr.write(`Invalid transport "${transport}" — must be stdio, http, or both.\n`);
    return 1;
  }

  // Set up directory + write config.json.
  ensureSecureDir(defaultBotRelayDir(), 0o700);
  const cfg = {
    transport,
    http_port: port,
    http_host: "127.0.0.1",
    http_secret: secret,
    webhook_timeout_ms: 5000,
    rate_limit_messages_per_hour: 1000,
    rate_limit_tasks_per_hour: 200,
    rate_limit_spawns_per_hour: 50,
    trusted_proxies: [],
  };
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  ensureSecureFile(configPath, 0o600);

  process.stdout.write(`\n✓ Wrote ${configPath} (mode 0600)\n`);
  process.stdout.write(`✓ Generated HTTP secret (32 bytes, base64url)\n\n`);

  // MCP server entry hint.
  const installRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
  const distEntry = path.join(installRoot, "dist", "index.js");
  process.stdout.write(`Add to your ~/.claude.json under "mcpServers":\n\n`);
  process.stdout.write(
    JSON.stringify(
      { "bot-relay": { type: "stdio", command: "node", args: [distEntry] } },
      null,
      2
    ) + "\n\n"
  );

  if (wantHooks) {
    // Delegate to generate-hooks --full → write to ~/.claude/settings.json
    // (merging if it already exists is out of scope for init; operators
    // who want merge should run generate-hooks manually).
    const { run: genHooks } = await import("./generate-hooks.js");
    process.stdout.write(`Generating hook fragment for ~/.claude/settings.json...\n`);
    const origWrite = process.stdout.write.bind(process.stdout);
    let captured = "";
    (process.stdout as any).write = (chunk: any) => {
      captured += String(chunk);
      return true;
    };
    try {
      await genHooks([]);
    } finally {
      (process.stdout as any).write = origWrite;
    }
    process.stdout.write(`Merge this fragment into ~/.claude/settings.json:\n${captured}\n`);
  } else {
    process.stdout.write(`(Skipping hook install — run 'relay generate-hooks' later to produce a fragment.)\n`);
  }

  process.stdout.write(`\nDone. Your HTTP secret is in ${configPath}.\n`);
  return 0;
}
