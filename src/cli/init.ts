// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 4h / v2.16.0 gate 9 — `relay init` one-command installer.
 *
 * v2.16.0 turns init from "write config.json (refuse-on-exist)" into the single
 * idempotent macOS install path (the #1 adoption gate): it RECONCILES the relay
 * config + the operator's Claude Code config and stands up the daemon —
 * everything a stranger needs, safe to re-run:
 *   1. ~/.bot-relay/config.json  — reconcile (PRESERVE http_secret + instance_id
 *      + operator edits; add only missing defaults). Records a default agent
 *      name (--agent) the SessionStart hook falls back to.
 *   2. ~/.claude.json            — deep-merge the bot-relay stdio mcpServers entry.
 *   3. ~/.claude/settings.json   — deep-merge the SessionStart hook (dedup by
 *      command path; preserve unrelated hooks).
 *   4. macOS launchd             — install + bootstrap a KeepAlive daemon plist,
 *      SKIPPING if :3777 is already served by any relay (collision-safe).
 *
 * TOKEN-BLIND BY CONSTRUCTION (gate-9 invariant): init NEVER mints, rotates,
 * registers, recovers, or writes/deletes a token or touches the agents
 * token-hash column / the vault. It imports NO token/db module. Agent identity
 * is established by the
 * already-token-safe SessionStart hook on first launch (vault-first read;
 * register captures the minted token → writes the vault). So init/deploy/bounce
 * can never desync a live agent's credential.
 *
 * Idempotent: every step reconciles (structural merge, atomic write + .bak) and
 * is a strict no-op on a second run. macOS-first; other platforms print manual
 * daemon guidance (not gated).
 */
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { execFileSync } from "child_process";
import readline from "readline/promises";
import { ensureSecureDir, ensureSecureFile } from "../fs-perms.js";
import { createInstance, generateInstanceId } from "../instance.js";
import {
  readJsonSafe,
  atomicWriteJson,
  reconcileRelayConfig,
  upsertMcpServer,
  upsertSessionStartHook,
} from "./config-merge.js";
import { installDaemon, type InstallDeps } from "./launchd.js";

function defaultBotRelayDir(): string {
  // v2.4.0 Part E — honor RELAY_HOME override (test harnesses + ops sandboxes).
  if (process.env.RELAY_HOME) return process.env.RELAY_HOME;
  return path.join(os.homedir(), ".bot-relay");
}

function defaultConfigPath(): string {
  return process.env.RELAY_CONFIG_PATH || path.join(defaultBotRelayDir(), "config.json");
}

/** v2.16.0 — Claude Code config locations. RELAY_CLAUDE_HOME overrides the
 *  home root (test harnesses) so init never touches a developer's real files. */
function claudeHome(): string {
  return process.env.RELAY_CLAUDE_HOME || os.homedir();
}
function claudeJsonPath(): string {
  return path.join(claudeHome(), ".claude.json");
}
function claudeSettingsPath(): string {
  return path.join(claudeHome(), ".claude", "settings.json");
}

export type Profile = "solo" | "team" | "ci";
export const VALID_PROFILES: readonly Profile[] = ["solo", "team", "ci"] as const;

interface ParsedArgs {
  yes: boolean;
  force: boolean;
  help: boolean;
  port?: number;
  transport?: string;
  secret?: string;
  profile?: Profile;
  instanceId?: string;
  multiInstance?: boolean;
  /** v2.16.0 — default agent name the SessionStart hook falls back to. */
  agent?: string;
  /** v2.16.0 — opt-outs for the install steps (default: do everything). */
  skipHooks: boolean;
  skipDaemon: boolean;
  skipMcp: boolean;
  /** v2.16.0 — legacy behavior: write config.json only, no install steps. */
  configOnly: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    yes: false,
    force: false,
    help: false,
    skipHooks: false,
    skipDaemon: false,
    skipMcp: false,
    configOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--force") out.force = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--port") out.port = parseInt(argv[++i], 10);
    else if (a === "--transport") out.transport = argv[++i];
    else if (a === "--secret") out.secret = argv[++i];
    else if (a === "--agent") out.agent = argv[++i];
    else if (a.startsWith("--agent=")) out.agent = a.slice("--agent=".length);
    else if (a === "--skip-hooks") out.skipHooks = true;
    else if (a === "--skip-daemon") out.skipDaemon = true;
    else if (a === "--skip-mcp") out.skipMcp = true;
    else if (a === "--config-only") out.configOnly = true;
    // --install-hooks retained as an accepted no-op: hooks now install by
    // default, so the old opt-in flag is harmless (back-compat for scripts).
    else if (a === "--install-hooks") {
      /* no-op — default behavior now */
    } else if (a === "--profile") {
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

/** Resolve the install root (repo dir) + the two abs paths the operator's
 *  Claude config needs to point at. */
function installPaths(): { root: string; distEntry: string; hookScript: string } {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
  return {
    root,
    distEntry: path.join(root, "dist", "index.js"),
    hookScript: path.join(root, "hooks", "check-relay.sh"),
  };
}

/** v2.16.0 — deep-merge the bot-relay stdio mcpServers entry into ~/.claude.json. */
export function installMcpServer(distEntry: string, jsonPath: string = claudeJsonPath()): { changed: boolean } {
  const existing = readJsonSafe(jsonPath);
  const entry = { type: "stdio", command: "node", args: [distEntry] };
  const { root, changed } = upsertMcpServer(existing, "bot-relay", entry);
  if (changed) atomicWriteJson(jsonPath, root, 0o600);
  return { changed };
}

/** v2.16.0 — deep-merge the SessionStart hook into ~/.claude/settings.json. */
export function installHook(hookScript: string, settingsPath: string = claudeSettingsPath()): { changed: boolean } {
  const existing = readJsonSafe(settingsPath);
  const { root, changed } = upsertSessionStartHook(existing, {
    matcher: "startup|resume",
    command: hookScript,
    timeout: 10,
  });
  if (changed) atomicWriteJson(settingsPath, root, 0o600);
  return { changed };
}

/** Real launchd deps — the only place init shells out to launchctl / fetch. */
function realDaemonDeps(log: (l: string) => void): InstallDeps {
  return {
    fetchHealth: async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      return { ok: res.ok, body: res.ok ? await res.json() : null };
    },
    launchctlList: () => {
      try {
        return execFileSync("launchctl", ["list"], { encoding: "utf-8" });
      } catch {
        return "";
      }
    },
    bootstrap: (plistPath, label) => {
      const uid = process.getuid?.() ?? 0;
      try {
        execFileSync("launchctl", ["bootstrap", `gui/${uid}`, plistPath], { stdio: "ignore" });
      } catch {
        /* may already be bootstrapped (we only reach here on action=install) */
      }
      try {
        execFileSync("launchctl", ["kickstart", "-k", `gui/${uid}/${label}`], { stdio: "ignore" });
      } catch {
        /* best-effort start */
      }
    },
    writePlist: (plistPath, contents) => {
      const dir = path.dirname(plistPath);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, `.${path.basename(plistPath)}.tmp.${crypto.randomBytes(4).toString("hex")}`);
      fs.writeFileSync(tmp, contents, { mode: 0o644 });
      fs.renameSync(tmp, plistPath);
    },
    log,
  };
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
      "Usage: relay init [--yes] [--agent NAME] [--force] [--config-only]\n" +
        "                  [--skip-hooks] [--skip-daemon] [--skip-mcp]\n" +
        "                  [--port N] [--transport stdio|http|both] [--secret STRING]\n" +
        "                  [--profile solo|team|ci] [--instance-id ID | --multi-instance]\n\n" +
        "One-command setup. Reconciles ~/.bot-relay/config.json, ~/.claude.json\n" +
        "(mcpServers), ~/.claude/settings.json (SessionStart hook), and on macOS a\n" +
        "launchd KeepAlive daemon. Idempotent — safe to re-run. NEVER touches agent\n" +
        "tokens (identity is established by the SessionStart hook on first launch).\n\n" +
        "Options:\n" +
        "  --yes              Non-interactive — accept defaults.\n" +
        "  --agent NAME       Default agent name the SessionStart hook falls back to\n" +
        "                     (an explicit RELAY_AGENT_NAME or spawn manifest wins).\n" +
        "  --force            Reset config.json to defaults (regenerates the secret).\n" +
        "  --config-only      Write config.json only (legacy behavior).\n" +
        "  --skip-hooks       Don't touch ~/.claude/settings.json.\n" +
        "  --skip-daemon      Don't install the launchd daemon.\n" +
        "  --skip-mcp         Don't touch ~/.claude.json.\n" +
        "  --port N           HTTP port (default 3777).\n" +
        "  --transport X      stdio | http | both.\n" +
        "  --secret STRING    HTTP secret (random 32-byte base64 if omitted, on first init).\n" +
        "  --profile X        solo (default) | team | ci.\n" +
        "  --instance-id ID / --multi-instance   per-instance setup.\n"
    );
    return 0;
  }

  // Resolve the active instance_id + config path.
  let effectiveInstanceId: string | null = null;
  if (args.instanceId) effectiveInstanceId = args.instanceId;
  else if (args.multiInstance) effectiveInstanceId = generateInstanceId();
  let configPath = defaultConfigPath();
  let perInstanceDir: string | null = null;
  if (effectiveInstanceId) {
    perInstanceDir = path.join(defaultBotRelayDir(), "instances", effectiveInstanceId);
    configPath = path.join(perInstanceDir, "config.json");
  }

  const existingConfig = readJsonSafe(configPath);
  const isFreshConfig = existingConfig === null || args.force;

  // Profile + defaults. On a FRESH config we prompt/apply defaults; on a re-run
  // (existing config) we reconcile silently, preserving the operator's values.
  const profile: Profile = args.profile ?? (existingConfig?.profile as Profile) ?? "solo";
  const profileDefaults = applyProfileDefaults(profile);
  let transport = args.transport ?? profileDefaults.transport;
  let port = args.port ?? 3777;
  let secret = args.secret ?? crypto.randomBytes(32).toString("base64url");

  if (isFreshConfig && !args.yes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      process.stdout.write("\n=== relay init ===\n\n");
      transport = await promptWithDefault(rl, "Transport (stdio/http/both)", transport);
      const portStr = await promptWithDefault(rl, "HTTP port", String(port));
      port = parseInt(portStr, 10) || 3777;
      const secAns = await rl.question(`HTTP secret (ENTER = generate random 32-byte base64): `);
      if (secAns.trim()) secret = secAns.trim();
    } finally {
      rl.close();
    }
  }

  if (!["stdio", "http", "both"].includes(transport)) {
    process.stderr.write(`Invalid transport "${transport}" — must be stdio, http, or both.\n`);
    return 1;
  }

  // ---- 1. config.json (reconcile) ------------------------------------------
  ensureSecureDir(defaultBotRelayDir(), 0o700);
  if (effectiveInstanceId && perInstanceDir) {
    ensureSecureDir(path.join(defaultBotRelayDir(), "instances"), 0o700);
    ensureSecureDir(perInstanceDir, 0o700);
    createInstance(effectiveInstanceId, "relay-init");
  }
  const defaults: Record<string, unknown> = {
    transport,
    http_port: port,
    http_host: "127.0.0.1",
    http_secret: secret,
    webhook_timeout_ms: 5000,
    rate_limit_messages_per_hour: 1000,
    rate_limit_tasks_per_hour: 200,
    rate_limit_spawns_per_hour: 50,
    trusted_proxies: [],
    profile,
    feature_bundles: profileDefaults.feature_bundles,
    tool_visibility: profileDefaults.tool_visibility,
    logging_level: profileDefaults.logging_level,
    agent_abandon_days: profileDefaults.agent_abandon_days,
    dashboard_enabled: profileDefaults.dashboard_enabled,
    instance_id: effectiveInstanceId ?? null,
  };
  // --force resets to defaults; otherwise reconcile PRESERVES existing values
  // (http_secret + instance_id + operator edits) and adds only missing keys.
  const reconciled = args.force
    ? { root: { ...defaults }, changed: true }
    : reconcileRelayConfig(existingConfig, defaults);
  // --agent explicitly sets/updates the hook's default agent name (override).
  if (args.agent) reconciled.root.default_agent_name = args.agent;
  atomicWriteJson(configPath, reconciled.root, 0o600);
  ensureSecureFile(configPath, 0o600);
  process.stdout.write(
    `✓ config: ${configPath} ${existingConfig === null ? "(created)" : "(reconciled — secret preserved)"}\n`,
  );
  if (args.agent) process.stdout.write(`✓ default agent name: ${args.agent}\n`);

  if (args.configOnly) {
    process.stdout.write(`\nDone (config only). Your HTTP secret is in ${configPath}.\n`);
    return 0;
  }

  const { distEntry, hookScript } = installPaths();

  // ---- 2. ~/.claude.json — mcpServers deep-merge ---------------------------
  if (!args.skipMcp) {
    const r = installMcpServer(distEntry);
    process.stdout.write(
      `✓ ~/.claude.json: bot-relay mcpServers ${r.changed ? "written" : "already present (no change)"}\n`,
    );
  }

  // ---- 3. ~/.claude/settings.json — SessionStart hook deep-merge -----------
  if (!args.skipHooks) {
    const r = installHook(hookScript);
    process.stdout.write(
      `✓ ~/.claude/settings.json: SessionStart hook ${r.changed ? "merged" : "already present (no change)"}\n`,
    );
  }

  // ---- 4. macOS launchd daemon (collision-safe) ----------------------------
  // RELAY_SKIP_DAEMON=1 is a belt-and-suspenders guard so test/CI harnesses
  // never shell out to real launchctl even under --transport both.
  if (!args.skipDaemon && process.env.RELAY_SKIP_DAEMON !== "1") {
    const wantsHttp = transport === "http" || transport === "both";
    if (process.platform === "darwin" && wantsHttp) {
      const { root } = installPaths();
      const res = await installDaemon(
        {
          nodePath: process.execPath,
          distEntry,
          workingDir: root,
          port,
          transport,
          logPath: path.join(os.tmpdir(), `relay-${port}.log`),
        },
        realDaemonDeps((l) => process.stdout.write(`  ${l}\n`)),
      );
      process.stdout.write(
        res.installed
          ? `✓ launchd daemon installed + started (KeepAlive) on :${port}\n`
          : `• launchd daemon: ${res.decision.reason}\n`,
      );
    } else if (process.platform !== "darwin") {
      process.stdout.write(
        `• daemon: launchd supervision is macOS-only for now (Linux/Windows coming). ` +
          `Start it manually: RELAY_TRANSPORT=http node ${distEntry}\n`,
      );
    }
  }

  // ---- Next steps -----------------------------------------------------------
  process.stdout.write(
    `\nNext:\n` +
      `  • Open a new Claude Code terminal — the SessionStart hook registers your\n` +
      `    agent + delivers mail automatically (set RELAY_AGENT_NAME, or it uses the\n` +
      `    default agent name above).\n` +
      `  • For hands-free wake on new mail, install Tether:\n` +
      `      code --install-extension lumiere-ventures.bot-relay-tether\n` +
      `    then set bot-relay.tether.autoInjectInbox=true (endpoint http://127.0.0.1:${port}).\n` +
      `\nDone. Re-running \`relay init\` is always safe.\n`,
  );
  return 0;
}
