// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Spawn driver abstraction (v1.9 cross-platform).
 *
 * A SpawnDriver builds the platform-specific command that launches a new
 * Claude Code terminal pre-configured as a relay agent. Each driver is pure
 * on the build side (no child_process call) — the dispatcher is the single
 * code path that actually spawns. This makes mock tests trivial.
 */
import type { SpawnAgentInput } from "../types.js";

export interface SpawnCommand {
  /** Executable to invoke (absolute path or binary name resolvable on PATH). */
  exec: string;
  /** Argument vector passed to the executable. */
  args: string[];
  /** Minimal environment map merged into the child process. NOT the whole process.env. */
  env: Record<string, string>;
  /** Whether the child should detach from the parent process group. */
  detached: boolean;
  /** Platform this command targets. Used for error messages + audit. */
  platform: "darwin" | "linux" | "win32";
  /** Driver identifier used in the response note + for RELAY_TERMINAL_APP override. */
  driverName: string;
}

export interface DriverContext {
  /** Called by the driver to ask "is this binary on PATH?" — mockable in tests. */
  hasBinary: (name: string) => boolean;
  /** Resolved RELAY_TERMINAL_APP override (already allowlist-gated), or null. */
  terminalOverride: string | null;
}

export interface SpawnDriver {
  /** Canonical name, used as the allowlist value for RELAY_TERMINAL_APP. */
  readonly name: string;
  /** Target platform tag matching process.platform. */
  readonly platform: "darwin" | "linux" | "win32";
  /**
   * Whether this driver can handle the given context (typically: are my
   * required binaries installed?). Called by the dispatcher to walk the
   * per-platform fallback chain.
   */
  canHandle(ctx: DriverContext): boolean;
  /**
   * Construct the command that launches Claude Code with the agent env set.
   * Pure — no side effects. Input is already zod-validated at the MCP boundary.
   *
   * v2.1 Phase 4j: optional `token` is the parent-issued RELAY_AGENT_TOKEN for
   * the new agent. Drivers thread it into buildChildEnv; macOS additionally
   * embeds it as a CLI arg so the shell wrapper can export it into the
   * osascript-spawned window (which does not inherit child_process.spawn env).
   *
   * v2.1.4 (I10): optional `briefFilePath` is the absolute path to a durable
   * task brief the spawned agent should read FIRST. macOS passes it as arg 6
   * to bin/spawn-agent.sh; Linux/Windows drivers ignore (no KICKSTART wired
   * on those platforms — documented limitation).
   */
  buildCommand(
    input: SpawnAgentInput,
    ctx: DriverContext,
    token?: string,
    briefFilePath?: string
  ): SpawnCommand;
}

export type SupportedPlatform = "darwin" | "linux" | "win32";
