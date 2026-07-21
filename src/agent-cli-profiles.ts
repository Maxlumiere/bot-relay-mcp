// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.17.0 (P3) — the agent-CLI profile registry: ONE declarative source of truth
 * for every place the code branched on `claude` / `codex`. Consumed by
 * `generate-hooks` (hookInstall), `liveness.ts` (processPattern), and — via
 * `relay cli-profiles --json` — available to the bash hooks. The bash PID-finder
 * pattern (`hooks/_vault-helpers.sh`) stays a hand-maintained MIRROR kept in sync
 * by a drift-guard test (NOT read on the per-hook hot path).
 *
 * Adding a CLI = ONE entry here (+ at most one Tether adapter in P4 if it needs
 * bespoke terminal escaping). Ship `claude` + `codex` only.
 *
 * INVARIANT: profiles NEVER carry host_id / machine-GUID derivation. That stays
 * in the single shared helper (`relay_machine_guid` / `host-identity.ts`) so
 * every CLI's `host_id` is byte-identical — the federation-safety invariant from
 * `check-relay.sh:347` (brief §3). A per-CLI host_id would silently break
 * Tether's host-scoped PID binding.
 *
 * SCOPE: `launch` is consumed by LLM-agnostic spawn (P2); `wake` by the
 * data-driven Tether adapter (P4). Both are POPULATED here now (a stable contract
 * to avoid schema churn) and get a STRUCTURAL well-formedness test in P3; their
 * BEHAVIOR is exercised in P2 / P4.
 */

/** A single lifecycle hook entry for `generate-hooks`. */
export interface HookEvent {
  /** Lifecycle event name as the CLI expects it. */
  event: "SessionStart" | "PostToolUse" | "Stop";
  /** Event matcher (CLI-specific grammar). */
  matcher: string;
  /** Repo-relative path to the hook script (resolved to absolute at emit time). */
  script: string;
  /** Claude settings.json hooks carry a numeric timeout. */
  timeout?: number;
  /** Codex config.toml hooks carry a statusMessage. */
  statusMessage?: string;
}

/** How `generate-hooks` renders + where a profile installs its hooks. */
export interface HookInstall {
  /** Human-facing install target path (documentation / --help). */
  target: string;
  /** Output renderer. */
  format: "claude-settings-json" | "codex-config-toml";
  /** The hook events this CLI installs. Codex is register-only (SessionStart). */
  events: HookEvent[];
}

/** How LLM-agnostic spawn (P2) builds the launch command. Consumed in P2. */
export interface LaunchSpec {
  /**
   * How the spawn driver invokes this CLI (P2):
   *  - "binary":   run `binary` directly with `flags` + a positional kickstart
   *                (Claude Code — the historical spawn path, unchanged).
   *  - "launcher": run `launcherScript` (a repo-relative POSIX launcher) that
   *                self-configures the agent's identity + relay handshake, then
   *                execs the CLI (Codex → bin/codex-relay: the cold-start
   *                host_shell_pids handshake AT LAUNCH, per 2.16.4). Driven
   *                generically by the driver — no per-CLI branch.
   */
  strategy: "binary" | "launcher";
  /** For strategy "launcher": repo-relative launcher path (resolved to absolute
   *  by the driver). null for "binary". */
  launcherScript: string | null;
  /** How a positional startup prompt is passed, or null if the CLI takes it bare. */
  kickstartArg: string | null;
  /** Permission / effort / title flag names the spawn driver fills. */
  flags: string[];
  /** The flag that sets the terminal/agent title, or null. */
  titleFlag: string | null;
}

/** Tether adapter inputs (P4). Consumed in P4. */
export interface WakeSpec {
  /** Text injected to wake the agent, or null if the CLI has no injected-prompt wake. */
  wakeText: string | null;
  /** Submit keystroke after injection. */
  submitKey: "\r" | "\n";
  /** Terminal write method. */
  submitMethod: "sendSequence" | "sendText";
  /**
   * true when the CLI self-continues WITHOUT Tether (e.g. a native stop-block
   * loop). Codex is FALSE: its self-wake poller was removed in 2.16.4; it wakes
   * via Tether + bin/codex-relay.
   */
  nativeSelfWake: boolean;
}

export interface AgentCliProfile {
  /** Stable id (also the RELAY_AGENT_* llm value + the Tether `llm` tag). */
  id: string;
  /** Launch binary name. */
  binary: string;
  /** Human-facing name (used in generate-hooks section labels). */
  displayName: string;
  /**
   * Basename-match token for the liveness PID finder + `_vault-helpers.sh` pat.
   * A plain regex-safe alternation token (no anchors) — the consumers wrap it.
   */
  processPattern: string;
  hookInstall: HookInstall;
  launch: LaunchSpec;
  wake: WakeSpec;
}

// CLI-PROFILE-ALLOWLIST: this registry is the ONE place the `claude`/`codex`
// profile identifiers live. Every other src/ file reads from here.
const CLAUDE: AgentCliProfile = {
  id: "claude",
  binary: "claude",
  displayName: "Claude Code",
  processPattern: "claude",
  hookInstall: {
    target: "~/.claude/settings.json",
    format: "claude-settings-json",
    events: [
      { event: "SessionStart", matcher: "startup|resume", script: "hooks/check-relay.sh", timeout: 10 },
      { event: "PostToolUse", matcher: "*", script: "hooks/post-tool-use-check.sh", timeout: 5 },
      { event: "Stop", matcher: "*", script: "hooks/stop-check.sh", timeout: 5 },
    ],
  },
  launch: {
    strategy: "binary", // run `claude` directly (the historical spawn path).
    launcherScript: null,
    kickstartArg: null, // Claude takes the startup prompt as a bare positional arg.
    flags: ["--permission-mode", "--effort", "--name"],
    titleFlag: "--name",
  },
  wake: {
    wakeText: null, // Claude has an `inbox` convention; Tether submits a bare newline.
    submitKey: "\r",
    submitMethod: "sendSequence",
    nativeSelfWake: false,
  },
};

const CODEX: AgentCliProfile = {
  id: "codex",
  binary: "codex",
  displayName: "Codex CLI",
  processPattern: "codex",
  hookInstall: {
    target: "~/.codex/config.toml",
    format: "codex-config-toml",
    // Register-only: NO Stop / PostToolUse (the codex-stop.sh poller was removed
    // in 2.16.4; Codex wakes via Tether + bin/codex-relay).
    events: [
      {
        event: "SessionStart",
        matcher: "startup|resume",
        script: "hooks/codex/codex-session-start.sh",
        statusMessage: "Registering with bot-relay",
      },
    ],
  },
  launch: {
    // Codex launches via bin/codex-relay — it pre-registers the Tether PID
    // handshake (host_shell_pids) FROM THE SHELL before exec'ing codex with the
    // `-c` MCP identity override, so a SPAWNED codex is Tether-bindable at pure
    // launch (the 2.16.4 cold-start property). The spawn driver runs the
    // launcher generically off `strategy`; no per-CLI branch.
    strategy: "launcher",
    launcherScript: "bin/codex-relay",
    kickstartArg: null,
    flags: ["-c"],
    titleFlag: null,
  },
  wake: {
    // Codex has no `inbox` convention — Tether injects an explicit instruction.
    wakeText: "Check your bot-relay inbox: call get_messages and act on anything pending.",
    submitKey: "\r",
    submitMethod: "sendSequence",
    nativeSelfWake: false,
  },
};

/** All supported profiles. Ship `claude` + `codex` only (schema is extensible). */
export const AGENT_CLI_PROFILES: readonly AgentCliProfile[] = [CLAUDE, CODEX];

/** Look up a profile by id (case-insensitive), or undefined. */
export function getAgentCliProfile(id: string): AgentCliProfile | undefined {
  const key = id.toLowerCase();
  return AGENT_CLI_PROFILES.find((p) => p.id === key);
}

/**
 * Regex-source alternation of every profile's processPattern (no anchors) — e.g.
 * "claude|codex". Consumers wrap it (liveness anchors + case-insensitive; the
 * bash PID finder ORs in the runtime hosts node|bun|deno).
 */
export function profileProcessPatternSource(): string {
  return AGENT_CLI_PROFILES.map((p) => p.processPattern).join("|");
}
