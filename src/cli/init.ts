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
import { fileURLToPath } from "url";
import { withDeadline } from "../http-deadline.js";
import { execFileSync } from "child_process";
import readline from "readline/promises";
import { ensureSecureDir, ensureSecureFile } from "../fs-perms.js";
import { createInstance, generateInstanceId, resolveActiveInstanceId } from "../instance.js";
import { getConfigPath } from "../config.js";
import {
  readJsonSafe,
  atomicWriteJson,
  reconcileRelayConfig,
  upsertMcpServer,
  upsertSessionStartHook,
  quoteForHookCommand,
  canQuoteForHookCommand,
  migrateRawHookCommand,
} from "./config-merge.js";
import { installDaemon, type InstallDeps, type HealthProbe } from "./launchd.js";

function defaultBotRelayDir(): string {
  // v2.4.0 Part E — honor RELAY_HOME override (test harnesses + ops sandboxes).
  // NAME COLLISION WARNING (#240): RELAY_HOME = where relay STATE lives
  // (relay.db, config.json, instances/, marker/, wake-coverage). It is NOT the
  // same knob as RELAY_CLAUDE_HOME (Claude Code config — see claudeHome() below);
  // neither implies the other. To sandbox relay state in a test/ops run set
  // RELAY_HOME (or real HOME); RELAY_CLAUDE_HOME does NOT redirect this path.
  if (process.env.RELAY_HOME) return process.env.RELAY_HOME;
  return path.join(os.homedir(), ".bot-relay");
}

function defaultConfigPath(): string {
  return process.env.RELAY_CONFIG_PATH || path.join(defaultBotRelayDir(), "config.json");
}

/** v2.16.0 — Claude Code config locations. RELAY_CLAUDE_HOME overrides the
 *  home root (test harnesses) so init never touches a developer's real files.
 *  NAME COLLISION WARNING (#240): RELAY_CLAUDE_HOME = where Claude Code's config
 *  lives (~/.claude.json, ~/.claude/). It is NOT the relay-state knob — that is
 *  RELAY_HOME (see defaultBotRelayDir() above). The names collide; neither
 *  implies the other. Setting RELAY_CLAUDE_HOME does NOT sandbox ~/.bot-relay, so
 *  a harness that sets only it still reaches the live relay DB + :3777 daemon. */
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

/**
 * Module URL → repo root, via fileURLToPath. The previous form —
 * `new URL(import.meta.url).pathname` — returns a PERCENT-ENCODED path, so an
 * install living under a directory with a space wrote
 * `.../Claude%20AI/.../dist/index.js` into ~/.claude.json: a path that does
 * not exist, i.e. a config entry that silently kills every relay session
 * spawned from it (the "%20 fossil" chased across nine days, 2026-07-23).
 * Exported for the decoding regression in tests/user-config-write-guard.test.ts.
 */
export function moduleRootFromUrl(moduleUrl: string): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..", "..");
}

/** Resolve the install root (repo dir) + the two abs paths the operator's
 *  Claude config needs to point at. */
function installPaths(rootOverride?: string): { root: string; distEntry: string; hookScript: string } {
  // rootOverride is a TEST seam for the atomicity controls. It is NOT reachable
  // from the CLI (bin/relay calls `run(rest)` with no second argument, and nothing
  // in argv/env/config sets it), and it structurally CANNOT bypass the preflight —
  // it feeds the very `hookScript` value the preflight validates. (It is not
  // justified by "a real module URL can't contain a newline": codex disproved that
  // by running the shipped CLI from a checkout whose directory name has one. The
  // seam exists so the control can exercise that real shape deterministically, not
  // because the shape is impossible.) Production passes nothing → the module dir.
  const root = rootOverride ?? moduleRootFromUrl(import.meta.url);
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

/** v2.16.0 — deep-merge the SessionStart hook into ~/.claude/settings.json.
 * v2.23.0 (codex #139): QUOTE the command (quoteForHookCommand) so a spaced
 * install root yields an unambiguous, precisely-ownable hook — and MIGRATE a
 * prior RAW (unquoted) literal of this exact root to the quoted form, so the
 * ambiguous shape drains out of the installed base instead of being carried
 * forever. Migration is exact-literal, never a classifier (see config-merge). */
export function installHook(hookScript: string, settingsPath: string = claudeSettingsPath()): { changed: boolean } {
  const existing = readJsonSafe(settingsPath);
  const canonical = quoteForHookCommand(hookScript);
  const migrated = migrateRawHookCommand(existing, hookScript, canonical);
  const { root, changed } = upsertSessionStartHook(migrated.root, {
    matcher: "startup|resume",
    command: canonical,
    timeout: 10,
  });
  const anyChange = migrated.changed || changed;
  if (anyChange) atomicWriteJson(settingsPath, root, 0o600);
  return { changed: anyChange };
}

/**
 * Probe :port/health, DISCRIMINATING "unreachable" (fetch rejects with an
 * unambiguous ECONNREFUSED → the port is genuinely free) from
 * "reachable-but-unreadable" (a response came back but the body is empty /
 * non-JSON, the status is non-2xx, a 3xx, or the body stalls). Exported so the
 * fail-closed behavior is tested through the REAL `res.json()` adapter — the
 * harm lives in the adapter, not a stub.
 *
 * FAIL CLOSED by ENUMERATING SUCCESS (audit HIGH #3): "the port is free" is a
 * POSITIVE determination (ECONNREFUSED alone), never the default for "anything
 * went wrong." Everything else — a 3xx (redirect:"manual", not followed to a
 * dead target and misread as free), a reset, a timeout/abort, a DNS failure, an
 * unknown error — is reachable:true → unreadable → refuse.
 *
 * The abort timer spans BOTH `fetch` AND `res.json()` in ONE try/finally (codex
 * round-4 P1: clearing it after fetch left the body read unbounded, so a server
 * that sends headers then STALLS its body hung init forever). An abort mid-body
 * rejects res.json() → parseable:false → unreadable.
 *
 * CROSS-PLATFORM verification (stated precisely): the claim "Node normalizes the
 * OS connection-refused error to code 'ECONNREFUSED' (incl. Windows
 * WSAECONNREFUSED)" is from Node docs. These probeHealth tests EXECUTE on Linux
 * Node 20 + 22 in CI (the matrix runs the full suite) and on Node 24.13.0 via
 * codex; macOS is local-only (the CI macOS job is scoped to the launchd guard,
 * not the full suite). WINDOWS IS NOT EXECUTED ANYWHERE — there is no Windows
 * runner in .github/workflows — that is the one OPEN gap. ACCEPTED fails-closed
 * residuals (all → refuse, the safe direction): a loopback firewall that DROPs
 * instead of REJECTs (no RST → runs to the abort deadline), EACCES,
 * EADDRNOTAVAIL — if loopback itself is broken, refusing to install is correct.
 */
export async function probeHealth(port: number): Promise<HealthProbe> {
  const timeoutMs = Math.max(1, parseInt(process.env.RELAY_HEALTH_PROBE_TIMEOUT_MS || "3000", 10));
  // NOT A BUG FIX — behaviour here was already correct, and deliberately so: the
  // timer stayed live across the body read (see the note below), which MEASURES
  // as bounded on Node v24.13.0. This is converted to the owned-deadline helper
  // to remove a dependency on undici honouring abort mid-body, which was not
  // verified on Node 20 — the version `engines` allows and CI exercises.
  try {
    return await withDeadline(timeoutMs, `health probe on 127.0.0.1:${port}`, async (signal) => {
      let res: Response;
      try {
        res = await fetch(`http://127.0.0.1:${port}/health`, { redirect: "manual", signal });
      } catch (err) {
        const code =
          (err as { cause?: { code?: string }; code?: string } | null)?.cause?.code ??
          (err as { code?: string } | null)?.code;
        if (code === "ECONNREFUSED") {
          return { reachable: false, ok: false, parseable: false, body: null }; // ONLY this proves the port is free
        }
        return { reachable: true, ok: false, parseable: false, body: null }; // reset/timeout/abort/DNS/unknown → fail closed
      }
      // The body read is inside the same deadline — a server that sends headers
      // then stalls is refused here instead of hanging forever.
      let body: unknown = null;
      let parseable = true;
      try {
        body = await res.json();
      } catch {
        parseable = false; // malformed OR aborted-mid-body → unreadable → refuse
      }
      return { reachable: true, ok: res.ok, parseable, body };
    });
  } catch {
    // Deadline elapsed. FAIL CLOSED, identical to the previous abort path: a
    // timeout must never report the port free, because only ECONNREFUSED proves
    // that. Returning here (rather than letting the rejection escape) preserves
    // probeHealth's contract — it answers, it does not throw.
    return { reachable: true, ok: false, parseable: false, body: null };
  }
}

/** Real launchd deps — the only place init shells out to launchctl / fetch. */
function realDaemonDeps(log: (l: string) => void): InstallDeps {
  return {
    fetchHealth: probeHealth,
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

export async function run(argv: string[], rootOverride?: string): Promise<number> {
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
  //
  // P1 (2026-07): init MUST write the config to the SAME path the daemon
  // RESOLVES, or a secret it writes is invisible to the running daemon while init
  // still reports success (the dashboard_secret-not-read defect on an
  // instance-scoped install). The daemon resolves via getConfigPath() →
  // RELAY_CONFIG_PATH, then the ~/.bot-relay/active-instance symlink, then the
  // flat legacy path. The pre-fix code defaulted to the FLAT path unless
  // --instance-id / --multi-instance was passed, so a plain `relay init` on a
  // machine with an active-instance symlink wrote a config the daemon never read.
  // One predicate for both sides (ADR-0015 L4).
  let effectiveInstanceId: string | null = null;
  let configPath: string;
  let perInstanceDir: string | null = null;
  if (args.instanceId || args.multiInstance) {
    // Explicit: CREATE / target a specific instance. This branch scaffolds the
    // instance dir below (createInstance) and owns its config path.
    effectiveInstanceId = args.instanceId ?? generateInstanceId();
    perInstanceDir = path.join(defaultBotRelayDir(), "instances", effectiveInstanceId);
    configPath = path.join(perInstanceDir, "config.json");
  } else {
    // No explicit flag: reconcile the ACTIVE install exactly as the daemon sees
    // it. getConfigPath() honours the active-instance symlink, so init lands in
    // the instance dir the daemon actually reads (or the flat path when there is
    // no active instance). effectiveInstanceId is captured for messaging + the
    // write-target check below; perInstanceDir stays null — the instance dir
    // already exists (getConfigPath only resolves to one that does), so we do NOT
    // re-scaffold it.
    configPath = getConfigPath();
    effectiveInstanceId = resolveActiveInstanceId();
  }

  const existingConfig = readJsonSafe(configPath);
  const isFreshConfig = existingConfig === null || args.force;

  // Profile + defaults. On a FRESH config we prompt/apply defaults; on a re-run
  // (existing config) we reconcile silently, preserving the operator's values.
  const profile: Profile = args.profile ?? (existingConfig?.profile as Profile) ?? "solo";
  const profileDefaults = applyProfileDefaults(profile);
  let transport = args.transport ?? profileDefaults.transport;
  let port = args.port ?? 3777;
  // v2.16.0 — a LOCAL (loopback) install needs NO http_secret: the daemon's
  // assertBindSafety (src/transport/http.ts) treats a 127.0.0.1 bind as
  // local-only-safe, and a transport secret would 401 the SessionStart hook's
  // register — breaking the "just works" loop (per-agent tokens + gate-11
  // from-verification still protect identity). Generate/keep one ONLY when the
  // operator explicitly passes --secret (e.g. for a non-loopback / team bind,
  // where assertBindSafety requires it at daemon start).
  let secret = args.secret ?? "";

  if (isFreshConfig && !args.yes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      process.stdout.write("\n=== relay init ===\n\n");
      transport = await promptWithDefault(rl, "Transport (stdio/http/both)", transport);
      const portStr = await promptWithDefault(rl, "HTTP port", String(port));
      port = parseInt(portStr, 10) || 3777;
      // v2.24 P1: this is the TRANSPORT secret (agent messaging). A 127.0.0.1
      // bind is loopback-safe for TRANSPORT without one (assertBindSafety) — but
      // ADR-0006 retired "local is trusted" for OPERATOR actions: the dashboard /
      // operator endpoints ALWAYS require the separate dashboard_secret (generated
      // below), loopback or not. The prompt must not imply blanket local trust.
      const secAns = await rl.question(
        `HTTP transport secret (ENTER = none — a loopback bind needs none for agent transport; ` +
          `operator/dashboard auth is a SEPARATE, always-required secret set up automatically. ` +
          `Set this only for a non-loopback / team bind): `,
      );
      if (secAns.trim()) secret = secAns.trim();
    } finally {
      rl.close();
    }
  }

  if (!["stdio", "http", "both"].includes(transport)) {
    process.stderr.write(`Invalid transport "${transport}" — must be stdio, http, or both.\n`);
    return 1;
  }

  // PREFLIGHT — MUST run before ANY filesystem action (codex #139 P1 atomicity,
  // rounds 6 & 10). Everything below touches the disk (ensureSecureDir creates
  // $RELAY_HOME, createInstance scaffolds an instance dir, atomicWriteJson writes
  // config/mcp/hook). If the hook command is unquotable (a newline/CR install
  // root) we REFUSE — and a refusal that has already created $RELAY_HOME or an
  // instance dir is a PARTIAL COMMIT that makes "nothing was written" a LIE (codex
  // caught exactly this by diffing the whole tree, not just config.json). THE
  // RULE: nothing that CREATES a filesystem artefact may run before this decision.
  // installPaths is pure path math. Only gate when a hook will actually be written
  // (--config-only / --skip-hooks never call quoteForHookCommand).
  const { distEntry, hookScript } = installPaths(rootOverride);
  if (!args.configOnly && !args.skipHooks && !canQuoteForHookCommand(hookScript)) {
    process.stderr.write(
      `relay init: refusing — the install path contains a newline/CR: ${JSON.stringify(hookScript)}. ` +
        `No safe single-line SessionStart hook command exists for it, so nothing was written. Reinstall from a ` +
        `path without control characters, or re-run with --config-only / --skip-hooks to install without the hook.\n`,
    );
    return 1;
  }

  // ---- 1. config.json (reconcile) ------------------------------------------
  ensureSecureDir(defaultBotRelayDir(), 0o700);
  if (effectiveInstanceId && perInstanceDir) {
    ensureSecureDir(path.join(defaultBotRelayDir(), "instances"), 0o700);
    ensureSecureDir(perInstanceDir, 0o700);
    createInstance(effectiveInstanceId, "relay-init");
  }
  // ADR-0006 (a) — secret-by-default. Operator-power endpoints are authed
  // regardless of network position (ADR-0006 b), which requires an operator
  // secret to ALWAYS exist. This is a dedicated DASHBOARD secret — a DIFFERENT
  // principal from http_secret (the agent transport credential), so one secret
  // never authorizes both. Only for an HTTP-serving install; a stdio-only daemon
  // exposes no dashboard. Generated in-memory (crypto.randomBytes touches no
  // disk) and written in the atomicWriteJson step below, which runs AFTER the
  // preflight refusal — so the "nothing written on refusal" atomicity invariant
  // holds. reconcileRelayConfig PRESERVES an existing dashboard_secret and only
  // fills it when missing: re-runs never rotate it, and a legacy install gets one
  // added on its next `relay init`.
  const httpEnabled = transport === "http" || transport === "both";
  const generatedDashboardSecret = crypto.randomBytes(32).toString("base64url");
  const defaults: Record<string, unknown> = {
    transport,
    http_port: port,
    http_host: "127.0.0.1",
    // v2.16.0 — OMIT http_secret for a local (loopback) install. The config
    // validator rejects a present-but-short secret ("must be >= 32 chars"), and
    // the daemon treats a 127.0.0.1 bind as local-safe WITHOUT one; a transport
    // secret would 401 the SessionStart hook's register. Written only when the
    // operator explicitly passes --secret (non-loopback / team bind).
    ...(secret ? { http_secret: secret } : {}),
    // ADR-0006 (a): operator/dashboard secret, generated by default for HTTP
    // installs. reconcile preserves an existing one (never rotates on re-run).
    ...(httpEnabled ? { dashboard_secret: generatedDashboardSecret } : {}),
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

  // ADR-0006 (a): announce a NEWLY-generated dashboard/operator secret. Printed
  // only when this run actually created it (reconcile returned OUR generated
  // value, i.e. none existed before) — never on a re-run that preserved one.
  const writtenDashboardSecret =
    typeof reconciled.root.dashboard_secret === "string" ? reconciled.root.dashboard_secret : null;
  if (writtenDashboardSecret !== null && writtenDashboardSecret === generatedDashboardSecret) {
    process.stdout.write(
      `\n🔑 Dashboard / operator secret generated (ADR-0006):\n` +
        `   ${generatedDashboardSecret}\n` +
        `   Stored in ${configPath}. Operator actions (kill-agent / wake-agent /\n` +
        `   set-status / focus-terminal / …) and the dashboard require it.\n` +
        `   Present via \`Authorization: Bearer <secret>\`, \`?auth=<secret>\`, or the\n` +
        `   \`relay_dashboard_auth\` cookie. Override with RELAY_DASHBOARD_SECRET.\n\n`,
    );
  }

  const explicitInstance = !!(args.instanceId || args.multiInstance);

  // ---- P1 env-only-instance guard: init resolved the FLAT config, but if
  // instances/ exist with no active-instance symlink, a daemon launched with
  // RELAY_INSTANCE_ID in its ENV is reading an instance config this shell cannot
  // discover (getConfigPath has no env here). Rather than silently write a flat
  // config the daemon ignores, WARN. When a symlink DOES exist, getConfigPath
  // already resolved to the instance above — this only fires on the env-only gap.
  if (
    !explicitInstance &&
    !process.env.RELAY_CONFIG_PATH &&
    path.resolve(configPath) === path.resolve(defaultConfigPath())
  ) {
    let instanceDirs: string[] = [];
    try {
      instanceDirs = fs
        .readdirSync(path.join(defaultBotRelayDir(), "instances"), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      /* no instances/ dir → none */
    }
    if (instanceDirs.length > 0) {
      process.stdout.write(
        `\n⚠️  Wrote the FLAT config, but instance dir(s) exist (${instanceDirs.join(", ")}) with no ` +
          `active-instance symlink. A daemon launched with RELAY_INSTANCE_ID set reads an instance config ` +
          `this write will NOT reach. Run \`relay use-instance <id>\` to set the symlink, then re-run init.\n`,
      );
    }
  }

  // ---- P1 verify-after-write: is the config we wrote the one the daemon READS?
  // Writing a credential and printing success WITHOUT confirming it is readable
  // at the daemon's resolved path is the exact defect this closes (init wrote the
  // flat path, the instance-scoped daemon read elsewhere, success printed). We
  // verify at the FILESYSTEM — the path the daemon reads on its NEXT start — not
  // against the running daemon, which loads config only at boot and would
  // false-alarm on a correct write until it is restarted.
  const daemonResolvedPath = getConfigPath();
  const sameAsDaemon = path.resolve(daemonResolvedPath) === path.resolve(configPath);
  if (httpEnabled) {
    const readback = readJsonSafe(daemonResolvedPath) as Record<string, unknown> | null;
    const secretReadable =
      sameAsDaemon &&
      readback !== null &&
      typeof readback.dashboard_secret === "string" &&
      (readback.dashboard_secret as string).length >= 32;
    if (!secretReadable) {
      if (!explicitInstance) {
        // The common `relay init`: configPath IS getConfigPath() by construction,
        // so a miss here means the write genuinely did not land — never a benign
        // "different instance". Fail loud; do NOT let the success line stand.
        process.stderr.write(
          `\n✗ VERIFY FAILED: wrote ${configPath}, but the daemon's dashboard_secret is not readable at ` +
            `its resolved path ${daemonResolvedPath}. Operator actions would 401. The write did not land as ` +
            `expected — do NOT trust the success line above.\n`,
        );
        return 1;
      }
      // Explicit --instance-id / --multi-instance: configuring a NON-active
      // instance is legitimate (set up now, activate later). Not fatal — but say
      // plainly the running daemon will not read it until it is made active.
      process.stdout.write(
        `\n⚠️  Not the ACTIVE instance: the daemon resolves ${daemonResolvedPath}, not ${configPath}. ` +
          `The dashboard_secret set here will NOT take effect until you run ` +
          `\`relay use-instance ${effectiveInstanceId}\` and restart the daemon.\n`,
      );
    } else {
      process.stdout.write(`✓ verified: the daemon resolves this config at ${daemonResolvedPath}\n`);
    }
  }

  if (args.configOnly) {
    process.stdout.write(`\nDone (config only). Your HTTP secret is in ${configPath}.\n`);
    return 0;
  }

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
      const { root } = installPaths(rootOverride);
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
      if (res.decision.versionDrift) {
        // LOUD (audit HIGH #3): the running daemon is STALE. Never auto-restart
        // (it would cut every agent on this host mid-session — ADR-0005); tell
        // the operator exactly what to run. This replaces the prior
        // "leaving the existing supervisor in place" line that reassured
        // falsely after an upgrade that had not taken effect.
        const d = res.decision.versionDrift;
        process.stdout.write(
          `\n⚠️  DAEMON VERSION DRIFT — the running daemon is STALE.\n` +
            `     running:   ${d.running}\n` +
            `     installed: ${d.installed}\n` +
            `   The upgrade will NOT take effect until the daemon is restarted.\n` +
            `   Run:  relay restart\n\n`,
        );
      } else if (res.decision.action === "skip-unreadable") {
        // LOUD + FAIL-CLOSED (audit HIGH #3): something answered on the port but
        // we could not read its health — we did NOT install (a competing daemon
        // would be worse). The operator must investigate; we never report clean.
        process.stdout.write(`\n⚠️  DAEMON STATE UNKNOWN — refusing to change it.\n   ${res.decision.reason}\n\n`);
      } else {
        process.stdout.write(
          res.installed
            ? `✓ launchd daemon installed + started (KeepAlive) on :${port}\n`
            : `• launchd daemon: ${res.decision.reason}\n`,
        );
      }
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
