// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.16.0 (gate 9) — macOS launchd keep-alive supervisor for the relay HTTP
 * daemon. Generated + bootstrapped by the one-command installer (`relay init`).
 *
 * COLLISION-SAFE BY DESIGN (gate-9 constraint). Before writing/loading a plist,
 * the installer probes the target port AND `launchctl list`:
 *   - If :3777 is ALREADY served by a relay (any label) → SKIP. This is the
 *     adoption path: ":3777 already serves this relay" — never double-load
 *     (two agents on the same port fight and one dies). The existing operator
 *     setup (e.g. a differently-labeled hand-authored LaunchAgent) is left
 *     untouched.
 *   - If :3777 is held by a FOREIGN process → SKIP + warn (don't stomp it).
 *   - If a bot-relay LaunchAgent is loaded under ANY label but not answering →
 *     SKIP (reconcile, don't add a second).
 *   - Otherwise → install the canonical plist + bootstrap it.
 *
 * The DECISION is a pure function (`decideDaemonAction`) over probe results, so
 * the mandatory collision test drives it without a real daemon. The actual
 * `fetch` + `launchctl` + fs are injected.
 *
 * macOS-first: this module is only invoked on darwin. Linux/Windows service
 * supervision is "coming, not gated" for this release (doctor reports it).
 * TOKEN-BLIND: no token/DB access anywhere here.
 */
import path from "path";
import os from "os";

/** Public-clean canonical LaunchAgent label. Deliberately generic — NEVER a
 *  private/persona name (a stranger's machine gets this). */
export const CANONICAL_LABEL = "com.bot-relay.daemon";

/** Substring that identifies ANY bot-relay LaunchAgent, regardless of the
 *  operator's chosen label prefix (e.g. a hand-authored `com.acme.bot-relay`).
 *  Label-agnostic on purpose (gate-9 constraint 3). */
const RELAY_LABEL_HINT = "bot-relay";

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface PlistOptions {
  label: string;
  nodePath: string;
  distEntry: string;
  workingDir: string;
  port: number;
  transport: string;
  logPath: string;
}

/** Build a launchd LaunchAgent plist (RunAtLoad + KeepAlive) — pure. */
export function buildLaunchdPlist(o: PlistOptions): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(o.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(o.nodePath)}</string>
    <string>${xmlEscape(o.distEntry)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(o.workingDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>RELAY_TRANSPORT</key>
    <string>${xmlEscape(o.transport)}</string>
    <key>RELAY_HTTP_PORT</key>
    <string>${xmlEscape(String(o.port))}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(o.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(o.logPath)}</string>
</dict>
</plist>
`;
}

/** `~/Library/LaunchAgents/<label>.plist` (home overridable for tests). */
export function plistPathFor(label: string, home: string = os.homedir()): string {
  return path.join(home, "Library", "LaunchAgents", `${label}.plist`);
}

/**
 * Parse `launchctl list` output → labels of loaded bot-relay agents (any
 * label containing "bot-relay"). Columns are: PID  Status  Label.
 */
export function parseLoadedRelayLabels(launchctlListOutput: string): string[] {
  const out: string[] = [];
  for (const line of launchctlListOutput.split("\n")) {
    const cols = line.trim().split(/\s+/);
    const label = cols[cols.length - 1];
    if (label && label.toLowerCase().includes(RELAY_LABEL_HINT)) out.push(label);
  }
  return out;
}

export type HealthClass = "relay" | "foreign" | "none";

/**
 * Classify a /health probe of the target port:
 *   - "relay"   — reachable AND the body is our relay's health shape
 *                 (status:"ok" + version + protocol_version).
 *   - "foreign" — reachable but NOT relay-shaped (someone else on the port).
 *   - "none"    — unreachable (probe failed / non-2xx).
 */
export function classifyHealthProbe(ok: boolean, body: unknown): HealthClass {
  if (!ok) return "none";
  const b = body as { status?: unknown; version?: unknown; protocol_version?: unknown } | null;
  if (b && b.status === "ok" && typeof b.version === "string" && typeof b.protocol_version === "string") {
    return "relay";
  }
  return "foreign";
}

export type DaemonAction = "install" | "skip-relay-present" | "skip-foreign-port" | "skip-agent-loaded";

export interface DaemonDecision {
  action: DaemonAction;
  /** Human-readable reason for stdout / audit. */
  reason: string;
  /** Loaded relay labels observed (for operator visibility). */
  existingLabels: string[];
}

/**
 * Pure collision decision. install ONLY when the port is free AND no bot-relay
 * LaunchAgent is already loaded. Every other case SKIPS (never double-loads).
 */
export function decideDaemonAction(input: {
  healthClass: HealthClass;
  loadedRelayLabels: string[];
  port: number;
}): DaemonDecision {
  const { healthClass, loadedRelayLabels, port } = input;
  if (healthClass === "relay") {
    return {
      action: "skip-relay-present",
      reason:
        `:${port} is already served by a bot-relay daemon` +
        (loadedRelayLabels.length ? ` (LaunchAgent: ${loadedRelayLabels.join(", ")})` : "") +
        ` — leaving the existing supervisor in place (no double-load).`,
      existingLabels: loadedRelayLabels,
    };
  }
  if (healthClass === "foreign") {
    return {
      action: "skip-foreign-port",
      reason: `:${port} is held by a non-relay process — not installing a daemon that would fight for the port. Free the port or set a different http_port, then re-run.`,
      existingLabels: loadedRelayLabels,
    };
  }
  // Port is free. But if a bot-relay agent is already loaded under any label,
  // don't add a second — reconcile by leaving it (it may be starting/stopped).
  if (loadedRelayLabels.length > 0) {
    return {
      action: "skip-agent-loaded",
      reason: `a bot-relay LaunchAgent is already loaded (${loadedRelayLabels.join(", ")}) — not adding a second. Manage it with launchctl, or bootout that label first if you want the canonical one.`,
      existingLabels: loadedRelayLabels,
    };
  }
  return { action: "install", reason: "no relay on the port and no bot-relay LaunchAgent loaded — installing the canonical daemon.", existingLabels: [] };
}

export interface InstallDeps {
  /** GET the health endpoint. Returns {ok, body}. Rejection → treated as none. */
  fetchHealth: (port: number) => Promise<{ ok: boolean; body: unknown }>;
  /** Run `launchctl list` and return stdout (or "" on failure). */
  launchctlList: () => string;
  /** Run `launchctl bootstrap gui/<uid> <plistPath>` (or kickstart). */
  bootstrap: (plistPath: string, label: string) => void;
  /** Write the plist file (atomic). */
  writePlist: (plistPath: string, contents: string) => void;
  /** Diagnostic sink. */
  log: (line: string) => void;
}

export interface InstallResult {
  decision: DaemonDecision;
  installed: boolean;
  plistPath: string | null;
}

/**
 * Probe → decide → (maybe) install. The ONLY path that writes a plist or calls
 * bootstrap is `action === "install"`. Every skip path touches nothing.
 */
export async function installDaemon(
  opts: Omit<PlistOptions, "label">,
  deps: InstallDeps,
  home: string = os.homedir(),
  label: string = CANONICAL_LABEL,
): Promise<InstallResult> {
  let healthClass: HealthClass = "none";
  try {
    const { ok, body } = await deps.fetchHealth(opts.port);
    healthClass = classifyHealthProbe(ok, body);
  } catch {
    healthClass = "none";
  }
  const loadedRelayLabels = parseLoadedRelayLabels(deps.launchctlList());
  const decision = decideDaemonAction({ healthClass, loadedRelayLabels, port: opts.port });

  if (decision.action !== "install") {
    deps.log(`daemon: ${decision.reason}`);
    return { decision, installed: false, plistPath: null };
  }

  const target = plistPathFor(label, home);
  const plist = buildLaunchdPlist({ ...opts, label });
  deps.writePlist(target, plist);
  deps.bootstrap(target, label);
  deps.log(`daemon: installed + bootstrapped ${label} → ${target}`);
  return { decision, installed: true, plistPath: target };
}
