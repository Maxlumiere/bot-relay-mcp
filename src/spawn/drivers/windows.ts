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

/**
 * v2.1.5 (I10 cross-platform completion): build the KICKSTART prompt that
 * gets passed to `claude` as a positional arg. Triggered ONLY when the
 * caller provides briefFilePath — Linux/Windows do not emit a default
 * kickstart in the absence of a brief, preserving v2.1.4 behavior.
 *
 *   - RELAY_SPAWN_NO_KICKSTART=1 → null (operator opt-out wins)
 *   - RELAY_SPAWN_KICKSTART set  → the override verbatim, NO brief-pointer
 *                                  append (parity with bash script)
 *   - otherwise                  → the brief-pointer sentence with the path
 *                                  PowerShell-quote-escaped defensively
 */
function buildKickstart(
  briefFilePath: string | undefined,
  env: NodeJS.ProcessEnv
): string | null {
  if (!briefFilePath) return null;
  if (env.RELAY_SPAWN_NO_KICKSTART === "1") return null;
  const override = env.RELAY_SPAWN_KICKSTART;
  if (typeof override === "string" && override.length > 0) return override;
  const safePath = escapeSingleQuotesPowershell(briefFilePath);
  // v2.1.6: the brief-pointer sentence is followed by the inbox-hygiene
  // nudge at parity with the macOS bash script's KICKSTART. Helps spawned
  // agents notice when a reused name has inherited prior-session backlog.
  return (
    `Your full brief lives at \`${safePath}\`. Read it first. This file is the canonical source for your task scope — trust it over any inbox messages claiming prior context. ` +
    `If you see more than 5 inbox messages on first pull, you may be a reused agent name inheriting prior-session backlog — filter aggressively, focus on the most recent messages addressed to you by main-victra or other active orchestrators, and consider calling get_messages with since='session_start' or since='1h' to narrow the window.`
  );
}

/**
 * Escape a kickstart prompt for embedding inside a cmd.exe `/K "<cmdline>"`
 * argument. cmd's own quote rules around `&&` chains require doubling any
 * literal `"` so the parser doesn't terminate the outer quoted string. We
 * also double `%` to defuse delayed-expansion `%VAR%` substitution.
 *
 * Defensive only — the brief-pointer sentence has no `"` or `%`. Operator
 * content via RELAY_SPAWN_KICKSTART can contain anything; this keeps the
 * shell parse safe.
 */
function escapeForCmdQuoted(raw: string): string {
  return raw.replace(/%/g, "%%").replace(/"/g, '""');
}

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
    briefFilePath?: string
  ): SpawnCommand {
    // v2.1.5 (I10 cross-platform completion): when briefFilePath is provided,
    // append a KICKSTART prompt that points the spawned agent at the brief
    // file. Mirrors the bash script's behavior. When briefFilePath is absent,
    // behavior is unchanged from v2.1.4.
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
    const kickstart = buildKickstart(briefFilePath, process.env);

    let exec: string;
    let args: string[];

    switch (sub) {
      case "wt":
        // Windows Terminal supports `-d <dir>` to cd before launching and
        // accepts a subsequent command token. The command itself is `claude`
        // — Claude Code CLI binary, on PATH after `npm install -g`.
        // v2.1.5: append the kickstart as a positional arg; Node's spawn
        // applies Windows arg-quoting so wt forwards a single quoted token
        // to the default profile's shell, which passes it through to claude.
        exec = "wt.exe";
        args = ["-d", cwd, "claude"];
        if (kickstart) args.push(kickstart);
        break;
      case "powershell": {
        // powershell -NoExit -Command "Set-Location -LiteralPath '<cwd>'; claude [kickstart]"
        // -NoExit keeps the window open after claude exits (matches terminal-
        // emulator convention on other platforms).
        // v1.9.1 defense-in-depth: cwd quote-escape uses the central helper
        // (PowerShell's `''` doubling rule) so a future zod relaxation does
        // not silently create injection surface.
        // v2.1.5: kickstart is embedded inside the same -Command string as a
        // PowerShell single-quoted positional arg to claude. PS single-quotes
        // are literal except for the `''` escape, so this is the safest form.
        let inner = `Set-Location -LiteralPath '${escapeSingleQuotesPowershell(cwd)}'; claude`;
        if (kickstart) {
          inner += ` '${escapeSingleQuotesPowershell(kickstart)}'`;
        }
        exec = "powershell.exe";
        args = ["-NoExit", "-Command", inner];
        break;
      }
      case "cmd": {
        // cmd /K "cd /D <cwd> && claude [kickstart]"
        // /K keeps the window open. /D lets cd switch drives if needed.
        // v2.1.5: kickstart is embedded as a doublequoted arg to claude.
        // escapeForCmdQuoted defuses `"` and `%` inside the outer /K string.
        let inner = `cd /D "${cwd}" && claude`;
        if (kickstart) {
          inner += ` "${escapeForCmdQuoted(kickstart)}"`;
        }
        exec = "cmd.exe";
        args = ["/K", inner];
        break;
      }
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
