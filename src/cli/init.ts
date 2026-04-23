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
import { createInstance, generateInstanceId } from "../instance.js";

function defaultBotRelayDir(): string {
  // v2.4.0 Part E — honor RELAY_HOME override (test harnesses + ops
  // sandboxes). When set, it's the bot-relay root directly; in
  // production operators leave it unset and get ~/.bot-relay/.
  if (process.env.RELAY_HOME) return process.env.RELAY_HOME;
  return path.join(os.homedir(), ".bot-relay");
}

function defaultConfigPath(): string {
  return process.env.RELAY_CONFIG_PATH || path.join(defaultBotRelayDir(), "config.json");
}

/**
 * v2.3.0 Part B.1 — profiles shape the defaults, tool visibility, and
 * logging surface. `solo` (the default) is a minimal single-machine
 * setup with channels/webhooks/admin tools hidden. `team` enables the
 * full multi-agent + channels + webhooks surface. `ci` is a minimal
 * stdio-only + warn-level-log profile for CI runners.
 *
 * Frozen list here is authoritative for surface-shaping (see
 * src/server.ts filterToolsByProfile). New profiles = new entry here +
 * bundle list in applyProfileDefaults + test coverage.
 */
export type Profile = "solo" | "team" | "ci";
export const VALID_PROFILES: readonly Profile[] = ["solo", "team", "ci"] as const;

interface ParsedArgs {
  yes: boolean;
  force: boolean;
  installHooks: boolean;
  help: boolean;
  port?: number;
  transport?: string;
  secret?: string;
  profile?: Profile;
  /**
   * v2.4.0 Part E.3 — multi-instance opt-in. When set, init writes to
   * `~/.bot-relay/instances/<id>/config.json` + creates the per-instance
   * directory. Auto-generate a UUID when absent (only in multi-instance
   * mode; single-instance mode stays the default).
   */
  instanceId?: string;
  /** Ask init to create a per-instance setup even if no --instance-id
   *  was passed (auto-generates a UUID). */
  multiInstance?: boolean;
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
    else if (a === "--profile") {
      const v = argv[++i];
      if (!v || !(VALID_PROFILES as readonly string[]).includes(v)) {
        process.stderr.write(`--profile: expected one of ${VALID_PROFILES.join("/")}, got "${v}"\n`);
        throw new Error("invalid --profile");
      }
      out.profile = v as Profile;
    } else if (a.startsWith("--profile=")) {
      const v = a.slice("--profile=".length);
      if (!(VALID_PROFILES as readonly string[]).includes(v)) {
        process.stderr.write(`--profile: expected one of ${VALID_PROFILES.join("/")}, got "${v}"\n`);
        throw new Error("invalid --profile");
      }
      out.profile = v as Profile;
    } else if (a === "--instance-id") {
      const v = argv[++i];
      if (!v) {
        process.stderr.write("--instance-id requires a value\n");
        throw new Error("missing --instance-id value");
      }
      out.instanceId = v;
    } else if (a.startsWith("--instance-id=")) {
      out.instanceId = a.slice("--instance-id=".length);
    } else if (a === "--multi-instance") {
      out.multiInstance = true;
    } else {
      process.stderr.write(`Unknown argument: ${a}\n`);
      throw new Error("unknown arg");
    }
  }
  return out;
}

/**
 * Profile-specific defaults applied on top of the base config. Per the
 * v2.2/v2.3 federation design memo: profiles shape the SURFACE (visible
 * tools, CLI subcommands), not just env defaults.
 *
 * Bundles determine which MCP tools are surfaced (see server.ts). The
 * `tool_visibility` block lets profiles carve further inside a bundle
 * (e.g. a `team` profile could re-enable admin tools that `solo` hid).
 */
export interface ProfileConfig {
  transport: string;
  feature_bundles: string[];
  tool_visibility: { hidden: string[] };
  logging_level: string;
  agent_abandon_days: number;
  dashboard_enabled: boolean;
}

export function applyProfileDefaults(profile: Profile): ProfileConfig {
  switch (profile) {
    case "team":
      return {
        transport: "http",
        feature_bundles: ["core", "channels", "webhooks", "admin", "managed-agents"],
        tool_visibility: { hidden: [] },
        logging_level: "info",
        agent_abandon_days: 7,
        dashboard_enabled: true,
      };
    case "ci":
      return {
        transport: "stdio",
        feature_bundles: ["core"],
        tool_visibility: { hidden: [] },
        logging_level: "warn",
        agent_abandon_days: 1,
        dashboard_enabled: false,
      };
    case "solo":
    default:
      return {
        transport: "stdio",
        feature_bundles: ["core"],
        tool_visibility: { hidden: [] },
        logging_level: "info",
        agent_abandon_days: 30,
        dashboard_enabled: true,
      };
  }
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
        "  --secret STRING    HTTP secret (random 32-byte base64 if omitted).\n" +
        "  --profile X        solo (default) | team | ci. Shapes tool visibility,\n" +
        "                     feature bundles, logging level, and abandon threshold.\n" +
        "                     See docs/profiles.md.\n" +
        "  --instance-id ID   v2.4.0: create a per-instance setup at\n" +
        "                     ~/.bot-relay/instances/<id>/ instead of the flat\n" +
        "                     layout. Implies multi-instance mode. See\n" +
        "                     docs/multi-instance.md.\n" +
        "  --multi-instance   v2.4.0: opt into multi-instance mode without naming\n" +
        "                     the id — auto-generates a UUID.\n"
    );
    return 0;
  }

  // v2.4.0 Part E.3 — resolve the active instance_id up-front so the
  // config path resolves into the per-instance subdir when multi-
  // instance mode is chosen. Single-instance legacy mode (no flag)
  // keeps ~/.bot-relay/config.json unchanged.
  let effectiveInstanceId: string | null = null;
  if (args.instanceId) {
    effectiveInstanceId = args.instanceId;
  } else if (args.multiInstance) {
    effectiveInstanceId = generateInstanceId();
  }
  let configPath = defaultConfigPath();
  let perInstanceDir: string | null = null;
  if (effectiveInstanceId) {
    perInstanceDir = path.join(defaultBotRelayDir(), "instances", effectiveInstanceId);
    configPath = path.join(perInstanceDir, "config.json");
  }
  if (fs.existsSync(configPath) && !args.force) {
    process.stderr.write(
      `relay init: ${configPath} already exists. Re-run with --force to overwrite, or edit the file directly.\n`
    );
    return 1;
  }

  // v2.3.0 Part B.1 — profile defaults. Applied BEFORE flag overrides so
  // explicit --transport / --port still win. `solo` is the default when
  // neither --profile nor a prompt-time answer is provided.
  const profile: Profile = args.profile ?? "solo";
  const profileDefaults = applyProfileDefaults(profile);
  let transport = args.transport ?? profileDefaults.transport;
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
  // v2.4.0 Part E.3 — when an instance_id was passed (or auto-generated
  // via --multi-instance), create the per-instance subdir + metadata
  // BEFORE the config write. createInstance is idempotent; safe across
  // --force re-runs.
  if (effectiveInstanceId && perInstanceDir) {
    ensureSecureDir(path.join(defaultBotRelayDir(), "instances"), 0o700);
    ensureSecureDir(perInstanceDir, 0o700);
    createInstance(effectiveInstanceId, "relay-init");
  }
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
    // v2.3.0 Part B: profile + surface-shape fields. Consumed by
    // src/server.ts filterToolsByProfile (tools/list filter) and by
    // src/config.ts for operator-visible defaults.
    profile,
    feature_bundles: profileDefaults.feature_bundles,
    tool_visibility: profileDefaults.tool_visibility,
    logging_level: profileDefaults.logging_level,
    agent_abandon_days: profileDefaults.agent_abandon_days,
    dashboard_enabled: profileDefaults.dashboard_enabled,
    // v2.4.0 Part E: record the instance_id in the config so auditors
    // can tell which instance a given config file belongs to. null in
    // single-instance legacy mode.
    instance_id: effectiveInstanceId ?? null,
  };
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  ensureSecureFile(configPath, 0o600);

  process.stdout.write(`\n✓ Wrote ${configPath} (mode 0600)\n`);
  process.stdout.write(`✓ Generated HTTP secret (32 bytes, base64url)\n`);
  if (effectiveInstanceId) {
    process.stdout.write(
      `✓ Per-instance setup: ${effectiveInstanceId}\n` +
      `  Run this instance with RELAY_INSTANCE_ID=${effectiveInstanceId} or\n` +
      `  \`relay use-instance ${effectiveInstanceId}\` to make it active.\n`
    );
  }
  process.stdout.write(`\n`);

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
