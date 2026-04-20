// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Windows spawn driver (v1.9).
 *
 * Fallback chain:
 *   1. wt.exe          — Windows Terminal (modern default on Win10 21H2+/Win11)
 *   2. powershell.exe  — PowerShell window (universal, every Windows install)
 *   3. cmd.exe         — Legacy fallback
 *
 * Command construction avoids cmd.exe quoting landmines by NOT using a
 * monolithic command string. Node's child_process.spawn on Windows with
 * shell:false + an args array passes each arg as a discrete CommandLine
 * segment, bypassing cmd.exe's token splitter entirely for wt.exe and
 * powershell.exe. For the cmd.exe fallback, we use `/C` + separate args.
 *
 * Env-var propagation is done via the `env` field of child_process.spawn
 * (does NOT require embedding in the command line — handled in the dispatcher).
 */
import type { SpawnAgentInput } from "../../types.js";
import type { SpawnCommand, SpawnDriver, DriverContext } from "../types.js";
import { buildChildEnv, normalizeCwd, escapeSingleQuotesPowershell } from "../validation.js";

const WINDOWS_SUB_DRIVERS = ["wt", "powershell", "cmd"] as const;
type WindowsSubDriver = (typeof WINDOWS_SUB_DRIVERS)[number];

// Binary names the dispatcher probes for on PATH. hasBinary() is expected to
// strip .exe suffixes if needed for Win32 lookup semantics.
const BINARY_FOR: Record<WindowsSubDriver, string> = {
  wt: "wt.exe",
  powershell: "powershell.exe",
  cmd: "cmd.exe",
};

function pickSubDriver(ctx: DriverContext): WindowsSubDriver | null {
  if (ctx.terminalOverride && (WINDOWS_SUB_DRIVERS as readonly string[]).includes(ctx.terminalOverride)) {
    const sub = ctx.terminalOverride as WindowsSubDriver;
    if (ctx.hasBinary(BINARY_FOR[sub])) return sub;
  }
  for (const sub of WINDOWS_SUB_DRIVERS) {
    if (ctx.hasBinary(BINARY_FOR[sub])) return sub;
  }
  return null;
}

export const windowsDriver: SpawnDriver = {
  name: "windows",
  platform: "win32",

  canHandle(ctx: DriverContext): boolean {
    return pickSubDriver(ctx) !== null;
  },

  buildCommand(
    input: SpawnAgentInput,
    ctx: DriverContext,
    token?: string,
    _briefFilePath?: string
  ): SpawnCommand {
    // v2.1.4 (I10): briefFilePath is accepted for signature parity but not
    // wired. Windows drivers (wt / powershell / cmd) do not inject a KICKSTART
    // prompt today — they just launch claude. Same v2.2 cross-platform
    // harmonization track as the Linux driver.
    void _briefFilePath;
    const sub = pickSubDriver(ctx);
    if (!sub) {
      throw new Error(
        "Windows spawn: no terminal available. wt.exe / powershell.exe / cmd.exe all missing from PATH. Install Windows Terminal (winget install Microsoft.WindowsTerminal) or set RELAY_TERMINAL_APP."
      );
    }

    const cwd = normalizeCwd(input.cwd || process.env.USERPROFILE || "C:\\", "win32");
    // v2.1 Phase 4j: token propagates via process env — wt.exe/powershell.exe/
    // cmd.exe spawn as direct children of child_process.spawn and inherit
    // the env field verbatim, including RELAY_AGENT_TOKEN when set.
    const env = buildChildEnv(input.name, input.role, input.capabilities, "win32", process.env, token);

    let exec: string;
    let args: string[];

    switch (sub) {
      case "wt":
        // Windows Terminal supports `-d <dir>` to cd before launching and
        // accepts a subsequent command token. The command itself is `claude`
        // — Claude Code CLI binary, on PATH after `npm install -g`.
        exec = "wt.exe";
        args = ["-d", cwd, "claude"];
        break;
      case "powershell":
        // powershell -NoExit -Command "Set-Location -LiteralPath '<cwd>'; claude"
        // -NoExit keeps the window open after claude exits (matches terminal-
        // emulator convention on other platforms).
        // v1.9.1 defense-in-depth: cwd quote-escape uses the central helper
        // (PowerShell's `''` doubling rule) so a future zod relaxation does
        // not silently create injection surface.
        exec = "powershell.exe";
        args = ["-NoExit", "-Command", `Set-Location -LiteralPath '${escapeSingleQuotesPowershell(cwd)}'; claude`];
        break;
      case "cmd":
        // cmd /K "cd /D <cwd> && claude"
        // /K keeps the window open. /D lets cd switch drives if needed.
        exec = "cmd.exe";
        args = ["/K", `cd /D "${cwd}" && claude`];
        break;
    }

    return {
      exec,
      args,
      env,
      detached: true,
      platform: "win32",
      driverName: sub,
    };
  },
};
