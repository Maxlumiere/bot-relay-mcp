// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Spawn dispatcher (v1.9).
 *
 * Single entry point. Selects a driver based on:
 *   1. RELAY_TERMINAL_APP env var (allowlist-gated) — explicit override
 *   2. process.platform auto-detect
 *   3. Per-platform fallback chain (inside each driver)
 *
 * Dispatcher is the ONLY code path that calls child_process.spawn. Drivers
 * are pure — they only BUILD commands. This keeps tests trivial (mock the
 * dispatcher-level spawn, assert on the command object drivers produce).
 *
 * RELAY_SPAWN_DRY_RUN=1 — emits the command to stdout instead of launching.
 * Matches the bash script's existing convention. Test harness relies on this.
 */
import { spawn as cpSpawn } from "child_process";
import { execSync } from "child_process";
import type { SpawnAgentInput } from "../types.js";
import { log } from "../logger.js";
import { resolveTerminalOverride } from "./validation.js";
import type { DriverContext, SpawnCommand, SpawnDriver, SupportedPlatform } from "./types.js";
import { macosDriver } from "./drivers/macos.js";
import { linuxDriver } from "./drivers/linux.js";
import { windowsDriver } from "./drivers/windows.js";

const DRIVERS: Record<SupportedPlatform, SpawnDriver> = {
  darwin: macosDriver,
  linux: linuxDriver,
  win32: windowsDriver,
};

/**
 * Probe whether a binary resolves on PATH. Uses `command -v` (POSIX) or
 * `where` (Windows). Wrapped in try/catch because both exit non-zero on miss.
 */
export function defaultHasBinary(name: string): boolean {
  try {
    const probe = process.platform === "win32" ? `where "${name}"` : `command -v -- ${JSON.stringify(name)}`;
    execSync(probe, { stdio: "ignore", shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh" });
    return true;
  } catch {
    return false;
  }
}

/** Default driver context uses real PATH probing + env var resolution. */
export function defaultDriverContext(
  platform: SupportedPlatform = (process.platform as SupportedPlatform)
): DriverContext {
  const raw = process.env.RELAY_TERMINAL_APP;
  const override = resolveTerminalOverride(raw, platform);
  if (raw && !override) {
    log.warn(
      `[spawn] RELAY_TERMINAL_APP="${raw}" not valid on ${platform} — falling back to auto-detect. Valid for ${platform}: ${Array.from(
        {
          darwin: ["iterm2", "terminal"],
          linux: ["gnome-terminal", "konsole", "xterm", "tmux"],
          win32: ["wt", "powershell", "cmd"],
        }[platform] ?? []
      ).join(", ")}.`
    );
  }
  return {
    hasBinary: defaultHasBinary,
    terminalOverride: override,
  };
}

/** Result shape returned to the caller (src/tools/spawn.ts). */
export interface SpawnDispatchResult {
  ok: boolean;
  driverName: string;
  platform: string;
  /** On dry-run, the literal command that WOULD have launched. */
  dryRunCommand?: { exec: string; args: string[] };
  /** On failure, a user-actionable error message. */
  error?: string;
}

/**
 * Build-only path — used by tests to assert on the command object without
 * actually spawning. Throws if no driver can handle the current platform.
 *
 * v2.1 Phase 4j: optional `token` is the parent-issued RELAY_AGENT_TOKEN
 * threaded to the driver. Ignored if undefined; drivers set RELAY_AGENT_TOKEN
 * in the child env only when a valid-shape token is present.
 */
export function buildSpawnCommand(
  input: SpawnAgentInput,
  token?: string,
  ctx?: DriverContext,
  platformTag: SupportedPlatform | NodeJS.Platform = process.platform,
  briefFilePath?: string
): SpawnCommand {
  const platform = platformTag as SupportedPlatform;
  const effectiveCtx = ctx ?? defaultDriverContext(platform);
  const driver = DRIVERS[platform];
  if (!driver) {
    throw new Error(
      `Unsupported platform: "${platform}". bot-relay-mcp spawn supports darwin, linux, win32.`
    );
  }
  if (!driver.canHandle(effectiveCtx)) {
    // Each driver's buildCommand throws a more specific message; invoke it
    // so the caller sees the exact "no emulator found" / "binary missing" text.
    // canHandle returning false + buildCommand throwing is intentional — the
    // driver knows its fallback chain best.
    return driver.buildCommand(input, effectiveCtx, token, briefFilePath);
  }
  return driver.buildCommand(input, effectiveCtx, token, briefFilePath);
}

/**
 * Full spawn path: build the command, honor RELAY_SPAWN_DRY_RUN, else
 * child_process.spawn(detached, stdio ignored, unref).
 *
 * v2.1 Phase 4j: optional `token` threaded to buildSpawnCommand.
 */
export function spawnAgent(
  input: SpawnAgentInput,
  token?: string,
  ctx?: DriverContext,
  platformTag: SupportedPlatform | NodeJS.Platform = process.platform,
  briefFilePath?: string
): SpawnDispatchResult {
  let cmd: SpawnCommand;
  try {
    cmd = buildSpawnCommand(input, token, ctx, platformTag, briefFilePath);
  } catch (err) {
    return {
      ok: false,
      driverName: "<none>",
      platform: String(platformTag),
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (process.env.RELAY_SPAWN_DRY_RUN === "1") {
    // Emit to STDERR (never stdout — would corrupt stdio MCP JSON-RPC stream;
    // see tests/no-stdout-writes.test.ts). The bash script's separate dry-run
    // writes to its own subprocess stdout, unaffected by this line.
    log.info(`[spawn dry-run] CMD=${cmd.exec} ${cmd.args.join(" ")}`);
    return {
      ok: true,
      driverName: cmd.driverName,
      platform: cmd.platform,
      dryRunCommand: { exec: cmd.exec, args: cmd.args },
    };
  }

  try {
    const child = cpSpawn(cmd.exec, cmd.args, {
      detached: cmd.detached,
      stdio: "ignore",
      env: cmd.env,
    });
    child.unref();
    return {
      ok: true,
      driverName: cmd.driverName,
      platform: cmd.platform,
    };
  } catch (err) {
    return {
      ok: false,
      driverName: cmd.driverName,
      platform: cmd.platform,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
